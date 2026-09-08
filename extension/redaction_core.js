/**
 * redaction_core.js — Pure Core Redaction & Geometry Utilities for Kaappan
 *
 * Clean UMD module with zero DOM or chrome API dependencies.
 * Exported pure functions:
 *  - calculateIoU()
 *  - calculateOverlapArea()
 *  - toDevice() / toCss()
 *  - calculateRedactionPadding()
 *  - fuseRegions()
 *  - sampleGatePixels()
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RedactionCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const REDACTION_PADDING_PX = 8;
  const IOU_UNION_THRESHOLD = 0.25;
  const CONTAINMENT_THRESHOLD = 0.6;

  function calculateOverlapArea(rectA, rectB) {
    if (!rectA || !rectB) return 0;
    const x1 = Math.max(rectA.x, rectB.x);
    const y1 = Math.max(rectA.y, rectB.y);
    const x2 = Math.min(rectA.x + rectA.width, rectB.x + rectB.width);
    const y2 = Math.min(rectA.y + rectA.height, rectB.y + rectB.height);

    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
  }

  function calculateIoU(rectA, rectB) {
    if (!rectA || !rectB) return 0;
    const overlap = calculateOverlapArea(rectA, rectB);
    if (overlap <= 0) return 0;

    const areaA = (rectA.width || 0) * (rectA.height || 0);
    const areaB = (rectB.width || 0) * (rectB.height || 0);
    const union = areaA + areaB - overlap;

    return union > 0 ? overlap / union : 0;
  }

  function toDevice(r, dpr = 1) {
    if (!r) return r;
    const scale = dpr || 1;
    return {
      ...r,
      x: Math.round(r.x * scale),
      y: Math.round(r.y * scale),
      width: Math.round(r.width * scale),
      height: Math.round(r.height * scale),
      kind: r.kind || "dom",
    };
  }

  function toCss(r, dpr = 1) {
    if (!r) return r;
    const scale = dpr || 1;
    return {
      ...r,
      x: Math.round(r.x / scale),
      y: Math.round(r.y / scale),
      width: Math.round(r.width / scale),
      height: Math.round(r.height / scale),
      kind: r.kind || "dom",
    };
  }

  function calculateRedactionPadding(r, paddingPx = REDACTION_PADDING_PX, maxWidth = Infinity, maxHeight = Infinity) {
    if (!r) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.max(0, Math.floor(r.x - paddingPx));
    const y = Math.max(0, Math.floor(r.y - paddingPx));
    const w = Math.min(maxWidth - x, Math.ceil(r.width + paddingPx * 2));
    const h = Math.min(maxHeight - y, Math.ceil(r.height + paddingPx * 2));
    return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
  }

  function fuseRegions(domRegions = [], visionFaces = []) {
    const regions = [];

    for (const r of domRegions || []) {
      regions.push({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        confidence: 1.0,
        source: r.kind === "regex-text" ? "regex" : (r.source || (r.kind ? "dom" : "dom")),
      });
    }

    for (const f of visionFaces || []) {
      regions.push({
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        confidence: typeof f.score === "number" ? f.score : 0.9,
        source: f.source || "vision",
      });
    }

    const merged = [];
    const used = new Set();

    for (let i = 0; i < regions.length; i++) {
      if (used.has(i)) continue;
      let curr = { ...regions[i] };
      // Track the weakest evidence in the merge as well as the strongest — a merged
      // box is only as trustworthy as its least certain contributor.
      let minConf = curr.confidence;
      used.add(i);

      for (let j = i + 1; j < regions.length; j++) {
        if (used.has(j)) continue;
        const b = regions[j];
        const iou = calculateIoU(curr, b);
        const inter = calculateOverlapArea(curr, b);
        const minArea = Math.min(curr.width * curr.height, b.width * b.height);
        const containment = minArea > 0 ? inter / minArea : 0;
        if (iou > IOU_UNION_THRESHOLD || containment > CONTAINMENT_THRESHOLD) {
          const x1 = Math.min(curr.x, b.x);
          const y1 = Math.min(curr.y, b.y);
          const x2 = Math.max(curr.x + curr.width, b.x + b.width);
          const y2 = Math.max(curr.y + curr.height, b.y + b.height);
          curr = {
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1,
            confidence: Math.max(curr.confidence, b.confidence),
            source: `${curr.source}+${b.source}`,
          };
          minConf = Math.min(minConf, b.confidence);
          used.add(j);
        }
      }
      curr.minConfidence = minConf;
      merged.push(curr);
    }
    return merged;
  }

  function sampleGatePixels(getPixelColorFn, imageWidth, imageHeight, deviceRegions) {
    if (!getPixelColorFn || typeof getPixelColorFn !== "function") {
      return { ok: false, reason: "Malformed or unreadable pixel buffer", sampled: 0, degradedCode: "GATE_CHECK_FAILED" };
    }
    if (!imageWidth || !imageHeight || imageWidth <= 0 || imageHeight <= 0) {
      return { ok: false, reason: "Zero-size or invalid pixel buffer dimensions", sampled: 0, degradedCode: "GATE_CHECK_FAILED" };
    }

    if (!deviceRegions || deviceRegions.length === 0) {
      return { ok: true, reason: "No sensitive regions to verify", sampled: 0 };
    }

    let sampled = 0;
    for (const r of deviceRegions) {
      const pts = [
        { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        { x: r.x + 2, y: r.y + 2 },
        { x: r.x + r.width - 2, y: r.y + 2 },
        { x: r.x + 2, y: r.y + r.height - 2 },
        { x: r.x + r.width - 2, y: r.y + r.height - 2 },
      ];

      for (const raw of pts) {
        const px = Math.round(raw.x);
        const py = Math.round(raw.y);
        if (px < 0 || py < 0 || px >= imageWidth || py >= imageHeight) continue;

        let rgba;
        try {
          rgba = getPixelColorFn(px, py);
        } catch (e) {
          return {
            ok: false,
            reason: `Pixel verification could not run (${e.message}) — refusing to transmit unverified frame`,
            sampled,
            degradedCode: "GATE_CHECK_FAILED",
          };
        }
        if (!rgba) continue;
        sampled++;

        if (rgba.r > 15 || rgba.g > 15 || rgba.b > 15) {
          return {
            ok: false,
            reason: `Unmasked pixel at (${px},${py}) inside a region marked sensitive (RGB ${rgba.r},${rgba.g},${rgba.b})`,
            sampled,
            unmaskedPoint: { px, py, rgb: rgba },
          };
        }
      }
    }

    if (sampled === 0) {
      return {
        ok: false,
        reason: "Could not sample any region pixels — region geometry does not match the screenshot",
        sampled: 0,
      };
    }

    return { ok: true, sampled };
  }

  return {
    REDACTION_PADDING_PX,
    IOU_UNION_THRESHOLD,
    CONTAINMENT_THRESHOLD,
    calculateOverlapArea,
    calculateIoU,
    toDevice,
    toCss,
    calculateRedactionPadding,
    fuseRegions,
    sampleGatePixels,
  };
});
