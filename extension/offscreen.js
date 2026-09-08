// offscreen.js — runs inside the MV3 offscreen document, which has DOM/canvas access
// that the background service worker doesn't. This is the actual local vision model.
//
// Model: "Ultra-Light-Fast-Generic-Face-Detector-1MB" (version-RFB-320), ONNX export.
// Input:  1x3x240x320 float32, normalized (pixel - 127) / 128
// Output: scores [1,4420,2] (background/face softmax), boxes [1,4420,4] (raw SSD regression)
// Decoding requires the anchor "priors" this network was trained with — priors.json was
// generated to match this exact config (strides [8,16,32,64], min_boxes per stride).
//
// CHANGES vs previous version:
//   * Tries WebGPU first, falls back to WASM, and reports which backend is live so the
//     background log can show it (roadmap A8).
//   * SCORE_THRESHOLD lowered from 0.7 to 0.45. Previously the model pre-filtered at 0.7,
//     which meant the privacy gate's confidence floors (0.60 balanced / 0.30 permissive)
//     could never fire — they were unreachable dead code. Filtering now happens in the
//     gate, where the policy dial actually controls it.
//   * Coordinates returned are pixel coordinates *within the crop that was passed in*.
//     background.js relies on this contract; do not change it without changing the caller.

const INPUT_W = 320;
const INPUT_H = 240;
const CENTER_VARIANCE = 0.1;
const SIZE_VARIANCE = 0.2;
const SCORE_THRESHOLD = 0.45; // the privacy gate applies the real policy threshold
const IOU_THRESHOLD = 0.5;

let session = null;
let priors = null;
let activeBackend = null;

async function init() {
  if (!session) {
    // Try WebGPU first; probe it with a dummy tensor to ensure shader/kernel compatibility,
    // and cleanly fall back to WASM SIMD if WebGPU fails.
    try {
      const probeSession = await ort.InferenceSession.create("models/face_detector.onnx", {
        executionProviders: ["webgpu"],
      });
      const dummyTensor = new ort.Tensor("float32", new Float32Array(1 * 3 * INPUT_H * INPUT_W), [1, 3, INPUT_H, INPUT_W]);
      await probeSession.run({ input: dummyTensor });
      session = probeSession;
      activeBackend = "webgpu";
    } catch (e) {
      console.warn("[offscreen] WebGPU not supported for this model, falling back to WASM:", e.message);
      try {
        session = await ort.InferenceSession.create("models/face_detector.onnx", {
          executionProviders: ["wasm"],
        });
        activeBackend = "wasm";
      } catch (e2) {
        console.error("[offscreen] VISION_MODEL_UNAVAILABLE: WASM fallback failed:", e2.message);
        activeBackend = "unavailable";
        throw new Error("VISION_MODEL_UNAVAILABLE: " + e2.message);
      }
    }
  }
  if (!priors) {
    priors = await (await fetch("models/priors.json")).json();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PREFLIGHT_CHECK") {
    (async () => {
      try {
        const ocradDefined = typeof OCRAD !== "undefined";
        await init();
        const onnxLoaded = session !== null && priors !== null;
        sendResponse({
          ok: ocradDefined && onnxLoaded,
          ocradDefined,
          onnxLoaded,
          backend: activeBackend,
        });
      } catch (err) {
        sendResponse({
          ok: false,
          ocradDefined: typeof OCRAD !== "undefined",
          onnxLoaded: false,
          backend: activeBackend || "unavailable",
          error: err.message,
        });
      }
    })();
    return true;
  }
  if (msg.type === "GET_OFFSCREEN_MEMORY") {
    let heap = 0;
    if (typeof performance !== "undefined" && performance.memory) {
      heap = performance.memory.usedJSHeapSize || 0;
    }
    sendResponse({
      ok: true,
      backend: activeBackend,
      memory: { usedJSHeapSize: heap, time: Date.now() }
    });
    return true;
  }
  if (msg.type === "DETECT_FACES") {
    const dataUrl = msg.imageDataUrl || msg.dataUrl;
    detectFaces(dataUrl)
      .then((result) => sendResponse({ ...result, ok: true, backend: activeBackend }))
      .catch((err) =>
        sendResponse({
          ok: false,
          faces: [],
          timings: { inferenceMs: 0 },
          backend: activeBackend,
          error: err.message,
          degradedCode: err.message.includes("VISION_MODEL_UNAVAILABLE") ? "VISION_MODEL_UNAVAILABLE" : "FACE_DETECTION_FAILED",
        })
      );
    return true; // async response
  }
  if (msg.type === "OCR_EXTRACT") {
    const dataUrl = msg.imageDataUrl || msg.dataUrl;
    const candidates = msg.candidates || [];
    const dpr = msg.dpr || 1;
    extractOcr(dataUrl, candidates, dpr)
      .then((result) => sendResponse({ ...result, ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          regions: [],
          timings: { ocrMs: 0 },
          error: err.message,
          degradedCode: err.message.includes("OCR_UNAVAILABLE") ? "OCR_UNAVAILABLE" : "OCR_FAILED",
        })
      );
    return true; // async response
  }
});

async function detectFaces(dataUrl) {
  const t0 = performance.now();
  await init();
  const t1 = performance.now();

  const inputObj = await preprocess(dataUrl);
  const t2 = performance.now();

  const feeds = { input: inputObj.tensor };
  let out;
  try {
    out = await session.run(feeds);
  } catch (runErr) {
    if (activeBackend !== "wasm") {
      console.warn(`[offscreen] ${activeBackend} inference run failed, switching to WASM:`, runErr);
      session = await ort.InferenceSession.create("models/face_detector.onnx", {
        executionProviders: ["wasm"],
      });
      activeBackend = "wasm";
      out = await session.run(feeds);
    } else {
      throw runErr;
    }
  }
  const t3 = performance.now();

  const scores = out.scores.data; // Float32Array, [4420*2]
  const boxes = out.boxes.data;   // Float32Array, [4420*4]

  // Decode back into the pixel space of the image we were handed.
  const detections = decode(scores, boxes, inputObj.origWidth, inputObj.origHeight);
  const final = nms(detections, inputObj.origWidth, inputObj.origHeight);
  const t4 = performance.now();

  return {
    faces: final, // [{x, y, width, height, score}] in pixel coords of the supplied image
    sourceWidth: inputObj.origWidth,
    sourceHeight: inputObj.origHeight,
    timings: {
      modelLoadMs: Math.round(t1 - t0),
      preprocessMs: Math.round(t2 - t1),
      inferenceMs: Math.round(t3 - t2),
      postprocessMs: Math.round(t4 - t3),
      totalMs: Math.round(t4 - t0),
    },
  };
}

async function preprocess(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const origWidth = bitmap.width;
  const origHeight = bitmap.height;

  const scale = Math.min(INPUT_W / origWidth, INPUT_H / origHeight);
  const renderW = origWidth * scale;
  const renderH = origHeight * scale;
  const offsetX = (INPUT_W - renderW) / 2;
  const offsetY = (INPUT_H - renderH) / 2;

  const canvas = new OffscreenCanvas(INPUT_W, INPUT_H);
  const ctx = canvas.getContext("2d");

  // Neutral gray padding to letterbox non-4:3 crops
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, INPUT_W, INPUT_H);
  ctx.drawImage(bitmap, offsetX, offsetY, renderW, renderH);

  const { data } = ctx.getImageData(0, 0, INPUT_W, INPUT_H); // RGBA, HWC, uint8

  // -> CHW float32, normalized (px - 127) / 128
  const chw = new Float32Array(3 * INPUT_H * INPUT_W);
  const plane = INPUT_H * INPUT_W;
  for (let i = 0; i < plane; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    chw[i] = (r - 127) / 128;
    chw[plane + i] = (g - 127) / 128;
    chw[plane * 2 + i] = (b - 127) / 128;
  }

  const tensor = new ort.Tensor("float32", chw, [1, 3, INPUT_H, INPUT_W]);
  bitmap.close?.();
  return { tensor, origWidth, origHeight };
}

// Raw SSD regression -> corner-form boxes in source pixel coords, undoing letterboxing.
function decode(scores, boxes, origWidth, origHeight) {
  const results = [];
  const numPriors = priors.length;

  const scale = Math.min(INPUT_W / origWidth, INPUT_H / origHeight);
  const renderW = origWidth * scale;
  const renderH = origHeight * scale;
  const offsetX = (INPUT_W - renderW) / 2;
  const offsetY = (INPUT_H - renderH) / 2;

  for (let i = 0; i < numPriors; i++) {
    const faceScore = scores[i * 2 + 1]; // index 1 = "face" class
    if (faceScore < SCORE_THRESHOLD) continue;

    const [px, py, pw, ph] = priors[i];
    const dx = boxes[i * 4], dy = boxes[i * 4 + 1], dw = boxes[i * 4 + 2], dh = boxes[i * 4 + 3];

    const cx = dx * CENTER_VARIANCE * pw + px;
    const cy = dy * CENTER_VARIANCE * ph + py;
    const w = Math.exp(dw * SIZE_VARIANCE) * pw;
    const h = Math.exp(dh * SIZE_VARIANCE) * ph;

    // normalized -> pixel coords on the 320x240 letterboxed canvas
    const x1_canvas = (cx - w / 2) * INPUT_W;
    const y1_canvas = (cy - h / 2) * INPUT_H;
    const x2_canvas = (cx + w / 2) * INPUT_W;
    const y2_canvas = (cy + h / 2) * INPUT_H;

    // canvas coords -> ORIGINAL image pixel coords
    const x1 = (x1_canvas - offsetX) / scale;
    const y1 = (y1_canvas - offsetY) / scale;
    const x2 = (x2_canvas - offsetX) / scale;
    const y2 = (y2_canvas - offsetY) / scale;

    results.push({ x1, y1, x2, y2, score: faceScore });
  }
  return results;
}

// Standard greedy hard-NMS, then clamp to image bounds.
function nms(boxes, maxW, maxH) {
  boxes.sort((a, b) => b.score - a.score);
  let remaining = boxes;
  const kept = [];
  while (remaining.length) {
    const best = remaining.shift();
    kept.push(best);
    remaining = remaining.filter((b) => iou(best, b) < IOU_THRESHOLD);
  }
  return kept
    .map((b) => {
      const x1 = Math.max(0, Math.min(b.x1, maxW));
      const y1 = Math.max(0, Math.min(b.y1, maxH));
      const x2 = Math.max(0, Math.min(b.x2, maxW));
      const y2 = Math.max(0, Math.min(b.y2, maxH));
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, score: b.score };
    })
    .filter((b) => b.width > 1 && b.height > 1);
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter);
}

// Hard startup assertion for OCRAD availability under MV3 CSP
if (typeof OCRAD === "undefined") {
  console.error("[offscreen] OCR_UNAVAILABLE: OCRAD failed to initialize or load in offscreen document.");
} else {
  console.log("[offscreen] OCRAD initialized successfully under MV3 CSP.");
}

async function extractOcr(dataUrl, candidates = [], dpr = 1) {
  const t0 = performance.now();
  if (typeof OCRAD === "undefined") {
    console.error("[offscreen] OCR_UNAVAILABLE: OCRAD engine is not defined.");
    throw new Error("OCR_UNAVAILABLE");
  }
  if (!dataUrl) {
    return { regions: [], timings: { ocrMs: 0 } };
  }

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });

  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = img.naturalWidth || img.width;
  fullCanvas.height = img.naturalHeight || img.height;
  const fullCtx = fullCanvas.getContext("2d", { willReadFrequently: true });
  fullCtx.drawImage(img, 0, 0);

  const results = [];

  for (const cand of candidates) {
    const pxX = Math.round(cand.x * dpr);
    const pxY = Math.round(cand.y * dpr);
    const pxW = Math.round(cand.width * dpr);
    const pxH = Math.round(cand.height * dpr);

    if (pxW <= 0 || pxH <= 0 || pxX >= fullCanvas.width || pxY >= fullCanvas.height) continue;
    const cropW = Math.min(pxW, fullCanvas.width - pxX);
    const cropH = Math.min(pxH, fullCanvas.height - pxY);

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
    cropCtx.drawImage(fullCanvas, pxX, pxY, cropW, cropH, 0, 0, cropW, cropH);

    try {
      const text = OCRAD(cropCanvas);
      if (text && text.trim().length > 0) {
        results.push({
          rect: { x: cand.x, y: cand.y, width: cand.width, height: cand.height },
          pixelRect: { x: pxX, y: pxY, width: cropW, height: cropH },
          text: text.trim(),
          kind: cand.kind || "canvas-ocr",
        });
      }
    } catch (e) {
      console.warn("[offscreen] OCR on crop failed:", e.message);
    }
  }

  const ocrMs = Math.round(performance.now() - t0);
  return {
    regions: results,
    timings: { ocrMs },
  };
}
