// viewer.js — Redaction Transparency Viewer Controller (SIH26171)

let stepsData = [];
let currentStepIdx = 0;
let currentMode = "slider"; // "slider" | "sideBySide"
let hoveredRegion = null;
let pollTimer = null;

const emptyView = document.getElementById("emptyView");
const sliderContainer = document.getElementById("sliderContainer");
const sideBySideContainer = document.getElementById("sideBySideContainer");

const origImg = document.getElementById("origImg");
const redactedImg = document.getElementById("redactedImg");
const redactedLayer = document.getElementById("redactedLayer");
const sliderHandle = document.getElementById("sliderHandle");
const sliderCanvas = document.getElementById("sliderCanvas");

const sideOrigImg = document.getElementById("sideOrigImg");
const sideRedactedImg = document.getElementById("sideRedactedImg");
const sideOrigCanvas = document.getElementById("sideOrigCanvas");
const sideRedactedCanvas = document.getElementById("sideRedactedCanvas");

const stepSelect = document.getElementById("stepSelect");
const prevStep = document.getElementById("prevStep");
const nextStep = document.getElementById("nextStep");
const refreshBtn = document.getElementById("refreshBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

const btnSlider = document.getElementById("btnSlider");
const btnSideBySide = document.getElementById("btnSideBySide");

const regionList = document.getElementById("regionList");
const regionCountBadge = document.getElementById("regionCountBadge");
const summaryText = document.getElementById("summaryText");
const timingText = document.getElementById("timingText");

async function fetchData() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_COMPARISON_DATA" });
    const newSteps = (res && res.steps) || [];
    const prevLen = stepsData.length;
    stepsData = newSteps;

    renderStepSelect();
    if (stepsData.length > 0) {
      if (prevLen !== stepsData.length && currentStepIdx === prevLen - 1) {
        currentStepIdx = stepsData.length - 1;
      }
      if (currentStepIdx >= stepsData.length) currentStepIdx = stepsData.length - 1;
      if (currentStepIdx < 0) currentStepIdx = 0;
      displayStep(currentStepIdx);
    } else {
      showEmpty();
    }
  } catch (err) {
    if (stepsData.length === 0) {
      showEmpty("Waiting for agent task to capture on-device steps...");
    }
  }
}

function showEmpty(msg) {
  emptyView.style.display = "block";
  sliderContainer.style.display = "none";
  sideBySideContainer.style.display = "none";
  if (msg) emptyView.querySelector("p").textContent = msg;
  regionList.innerHTML = "";
  regionCountBadge.textContent = "0 regions";
  summaryText.textContent = "No data.";
  timingText.textContent = "";
  stepSelect.innerHTML = "<option>No steps recorded</option>";
  prevStep.disabled = true;
  nextStep.disabled = true;
}

function renderStepSelect() {
  stepSelect.innerHTML = "";
  stepsData.forEach((s, idx) => {
    const opt = document.createElement("option");
    opt.value = idx;
    opt.textContent = `Step ${s.step || idx + 1} — ${(s.regions || []).length} regions (${s.gateStatus || "passed"})`;
    stepSelect.appendChild(opt);
  });
  stepSelect.value = currentStepIdx;
  prevStep.disabled = currentStepIdx <= 0;
  nextStep.disabled = currentStepIdx >= stepsData.length - 1;
}

function displayStep(idx) {
  if (!stepsData[idx]) return;
  currentStepIdx = idx;
  const s = stepsData[idx];

  emptyView.style.display = "none";
  if (currentMode === "slider") {
    sliderContainer.style.display = "inline-block";
    sideBySideContainer.style.display = "none";
  } else {
    sliderContainer.style.display = "none";
    sideBySideContainer.style.display = "flex";
  }

  // Load images
  origImg.src = s.originalDataUrl;
  redactedImg.src = s.redactedDataUrl;
  sideOrigImg.src = s.originalDataUrl;
  sideRedactedImg.src = s.redactedDataUrl;

  stepSelect.value = idx;
  prevStep.disabled = idx <= 0;
  nextStep.disabled = idx >= stepsData.length - 1;

  summaryText.textContent = s.summary || `Step ${s.step || idx + 1}: ${(s.regions || []).length} regions redacted.`;
  const totMs = s.timings ? s.timings.totalMs : 0;
  const visMs = s.timings ? s.timings.visionInferenceMs : 0;
  timingText.textContent = `Total: ${totMs}ms | Vision: ${visMs}ms | Gate: ${s.gateStatus || "passed"}`;

  // Populate region list
  regionList.innerHTML = "";
  const numRegions = (s.regions || []).length;
  regionCountBadge.textContent = `${numRegions} region${numRegions === 1 ? "" : "s"}`;

  (s.regions || []).forEach((r, rIdx) => {
    const div = document.createElement("div");
    div.className = "region-item";
    const src = (r.source || "dom").toLowerCase();
    const srcType = src.includes("vision") ? "vision" : src.includes("regex") ? "regex" : "dom";
    const confStr = r.confidence != null ? Math.round(r.confidence * 100) + "%" : "100%";

    div.innerHTML = `
      <div class="region-item-row">
        <strong>Region #${rIdx + 1}</strong>
        <span class="source-badge source-${srcType}">${srcType}</span>
      </div>
      <div class="region-item-row" style="color: #8b949e;">
        <span>${Math.round(r.width)}×${Math.round(r.height)}px at (${Math.round(r.x)}, ${Math.round(r.y)})</span>
        <span>Conf: ${confStr}</span>
      </div>
    `;

    div.addEventListener("mouseenter", () => {
      div.classList.add("active");
      hoveredRegion = r;
      drawHighlights();
    });
    div.addEventListener("mouseleave", () => {
      div.classList.remove("active");
      hoveredRegion = null;
      drawHighlights();
    });

    regionList.appendChild(div);
  });

  origImg.onload = () => {
    syncSliderDimensions();
    drawHighlights();
  };
  sideOrigImg.onload = () => {
    syncSliderDimensions();
    drawHighlights();
  };
}

function syncSliderDimensions() {
  const dispW = origImg.clientWidth || 600;
  const dispH = origImg.clientHeight || 400;

  redactedImg.style.width = dispW + "px";
  redactedImg.style.height = dispH + "px";

  if (sliderCanvas) {
    sliderCanvas.width = dispW;
    sliderCanvas.height = dispH;
  }
  if (sideOrigCanvas && sideOrigImg.clientWidth) {
    sideOrigCanvas.width = sideOrigImg.clientWidth;
    sideOrigCanvas.height = sideOrigImg.clientHeight;
  }
  if (sideRedactedCanvas && sideRedactedImg.clientWidth) {
    sideRedactedCanvas.width = sideRedactedImg.clientWidth;
    sideRedactedCanvas.height = sideRedactedImg.clientHeight;
  }
}

function drawHighlights() {
  const s = stepsData[currentStepIdx];
  if (!s || !s.regions) return;

  const targetList = currentMode === "slider"
    ? [{ canvas: sliderCanvas, img: origImg }]
    : [{ canvas: sideOrigCanvas, img: sideOrigImg }, { canvas: sideRedactedCanvas, img: sideRedactedImg }];

  targetList.forEach(({ canvas, img }) => {
    if (!canvas || !img || !img.clientWidth) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const natW = img.naturalWidth || canvas.width;
    const natH = img.naturalHeight || canvas.height;
    const scaleX = canvas.width / natW;
    const scaleY = canvas.height / natH;

    // Draw all regions faintly
    s.regions.forEach((r) => {
      const rx = r.x * scaleX;
      const ry = r.y * scaleY;
      const rw = r.width * scaleX;
      const rh = r.height * scaleY;

      ctx.strokeStyle = "rgba(88, 166, 255, 0.4)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rx, ry, rw, rh);
    });

    // Highlight hovered region
    if (hoveredRegion) {
      const hx = hoveredRegion.x * scaleX;
      const hy = hoveredRegion.y * scaleY;
      const hw = hoveredRegion.width * scaleX;
      const hh = hoveredRegion.height * scaleY;

      ctx.fillStyle = "rgba(248, 81, 73, 0.25)";
      ctx.fillRect(hx, hy, hw, hh);

      ctx.strokeStyle = "#f85149";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(hx, hy, hw, hh);
    }
  });
}

// Draggable split slider logic
let isDragging = false;

function setSliderPosition(clientX) {
  const rect = sliderContainer.getBoundingClientRect();
  let pct = ((clientX - rect.left) / rect.width) * 100;
  pct = Math.max(0, Math.min(100, pct));
  redactedLayer.style.width = pct + "%";
  sliderHandle.style.left = pct + "%";
}

sliderHandle.addEventListener("mousedown", (e) => {
  isDragging = true;
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  setSliderPosition(e.clientX);
});

window.addEventListener("mouseup", () => {
  isDragging = false;
});

sliderHandle.addEventListener("touchstart", () => { isDragging = true; }, { passive: true });
window.addEventListener("touchmove", (e) => {
  if (isDragging && e.touches[0]) setSliderPosition(e.touches[0].clientX);
}, { passive: true });
window.addEventListener("touchend", () => { isDragging = false; });

// Mode switching
btnSlider.addEventListener("click", () => {
  currentMode = "slider";
  btnSlider.classList.add("active");
  btnSideBySide.classList.remove("active");
  displayStep(currentStepIdx);
});

btnSideBySide.addEventListener("click", () => {
  currentMode = "sideBySide";
  btnSideBySide.classList.add("active");
  btnSlider.classList.remove("active");
  displayStep(currentStepIdx);
});

// Step navigation
prevStep.addEventListener("click", () => {
  if (currentStepIdx > 0) displayStep(currentStepIdx - 1);
});
nextStep.addEventListener("click", () => {
  if (currentStepIdx < stepsData.length - 1) displayStep(currentStepIdx + 1);
});
stepSelect.addEventListener("change", (e) => {
  displayStep(parseInt(e.target.value, 10));
});
refreshBtn.addEventListener("click", fetchData);

clearHistoryBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_COMPARISON_HISTORY" });
  stepsData = [];
  showEmpty("Comparison history cleared from memory.");
});

window.addEventListener("resize", () => {
  if (stepsData.length > 0) {
    syncSliderDimensions();
    drawHighlights();
  }
});

// Auto-poll every 2 seconds while viewer tab is open
pollTimer = setInterval(fetchData, 2000);

// Initial fetch
fetchData();
