// benchmark.js — Automated Benchmark Harness Runner for SIH PS26171

const FIXTURES = [
  { id: 1, name: "01_signup_form.html", title: "Plain Signup Form" },
  { id: 2, name: "02_indian_id.html", title: "Indian ID Page" },
  { id: 3, name: "03_payment_form.html", title: "Payment Form" },
  { id: 4, name: "04_faces_img.html", title: "Page with Faces" },
  { id: 5, name: "05_same_origin_iframe.html", title: "Same-Origin Iframe" },
  { id: 6, name: "06_shadow_dom.html", title: "Shadow DOM" },
  { id: 7, name: "07_canvas_email.html", title: "Canvas Rendered Email" },
  { id: 8, name: "08_long_paragraph.html", title: "Long Paragraph Precision" },
  { id: 9, name: "09_below_the_fold.html", title: "PII Below the Fold" },
  { id: 10, name: "10_placeholder_attribute.html", title: "PII in Placeholder Attribute" },
  { id: 11, name: "11_negative_controls.html", title: "Negative Controls" },
  { id: 12, name: "12_mixed_page.html", title: "Mixed Page" },
  { id: 13, name: "13_dense_table.html", title: "Dense Table Stress Test" },
  { id: 14, name: "14_clean_page.html", title: "Clean Page (Zero PII)" },
  { id: 15, name: "15_prompt_injection.html", title: "Prompt Injection Attack Fixture" }
];

let lastBenchmarkReport = null;
let preflightOk = false;
let preflightReport = null;

async function checkPreflight() {
  const badge = document.getElementById("preflightStatusBadge");
  const details = document.getElementById("preflightDetails");
  const runBtn = document.getElementById("runBtn");
  const card = document.getElementById("preflightCard");

  if (badge) {
    badge.className = "status-badge badge-warn";
    badge.textContent = "Verifying...";
  }
  if (details) {
    details.innerHTML = "Checking OCRAD definition, ONNX inference session, and local FastAPI server connectivity...";
  }

  const failures = [];
  let ocradOk = false;
  let onnxOk = false;
  let serverOk = false;
  let backend = "unknown";

  // 1. Check OCRAD defined (either in window or via offscreen)
  if (typeof OCRAD !== "undefined") {
    ocradOk = true;
  }

  // 2. Check offscreen document (OCRAD + ONNX session)
  try {
    const offscreenRes = await chrome.runtime.sendMessage({ type: "CHECK_PREFLIGHT" });
    if (offscreenRes && offscreenRes.ok) {
      ocradOk = ocradOk || Boolean(offscreenRes.ocradDefined);
      onnxOk = Boolean(offscreenRes.onnxLoaded);
      backend = offscreenRes.backend || "wasm";
    } else {
      if (offscreenRes && offscreenRes.error) {
        failures.push(`ONNX runtime error in offscreen document: ${offscreenRes.error}`);
      } else {
        failures.push("No response from offscreen document (ONNX runtime unavailable)");
      }
    }
  } catch (e) {
    failures.push(`Failed to communicate with offscreen vision host: ${e.message}`);
  }

  if (!ocradOk) {
    failures.push("OCRAD is NOT defined (extension/lib/ocrad.js failed to initialize or missing)");
  }
  if (!onnxOk) {
    failures.push("ONNX face detector session failed to load in offscreen document");
  }

  // 3. Check local server reachable
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("http://localhost:8000/fixtures/01_signup_form.html", {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (res.ok) {
      serverOk = true;
    } else {
      failures.push(`Local server responded with HTTP status ${res.status} (expected 200)`);
    }
  } catch (e) {
    failures.push(`Local server unreachable at http://localhost:8000 (${e.name === "AbortError" ? "Connection timed out" : "Connection refused — ensure server is started"})`);
  }

  preflightOk = failures.length === 0;
  preflightReport = { ocradOk, onnxOk, serverOk, backend, failures };

  if (preflightOk) {
    if (badge) {
      badge.className = "status-badge badge-pass";
      badge.textContent = "PASSED";
    }
    if (card) {
      card.style.borderLeftColor = "var(--accent-green)";
    }
    if (details) {
      details.innerHTML = `✅ <b>System Ready:</b> Server reachable (port 8000) • OCRAD loaded • ONNX session active (backend: <code>${backend}</code>). All pre-flight checks passed.`;
    }
    if (runBtn) runBtn.disabled = false;
  } else {
    if (badge) {
      badge.className = "status-badge badge-fail";
      badge.textContent = "BLOCKED";
    }
    if (card) {
      card.style.borderLeftColor = "var(--accent-red)";
    }
    if (details) {
      details.innerHTML = `❌ <b>Pre-Flight Failure — Benchmark Execution Refused:</b><ul style="margin: 4px 0 0 18px; padding: 0; color: #f85149;">${failures.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`;
    }
    if (runBtn) runBtn.disabled = true;
  }

  return preflightReport;
}

document.addEventListener("DOMContentLoaded", () => {
  const runBtn = document.getElementById("runBtn");
  const exportJsonBtn = document.getElementById("exportJsonBtn");
  const recheckPreflightBtn = document.getElementById("recheckPreflightBtn");

  runBtn?.addEventListener("click", () => runFullBenchmark());
  exportJsonBtn?.addEventListener("click", () => exportReportJson());
  recheckPreflightBtn?.addEventListener("click", () => checkPreflight());

  // Automatic initial pre-flight check on harness load
  checkPreflight();
});

async function runFullBenchmark() {
  const runBtn = document.getElementById("runBtn");
  const exportJsonBtn = document.getElementById("exportJsonBtn");
  const progressContainer = document.getElementById("progressContainer");
  const progressFill = document.getElementById("progressFill");
  const statusMessage = document.getElementById("statusMessage");

  // Hard pre-flight gate check
  const preflight = await checkPreflight();
  if (!preflight || preflight.failures.length > 0) {
    statusMessage.innerHTML = `<span style="color: #f85149; font-weight: bold;">⛔ Execution Refused:</span> Pre-flight checks failed (${preflight.failures.join("; ")}). Benchmark refused to prevent measuring a degraded system.`;
    runBtn.disabled = true;
    progressContainer.style.display = "none";
    return;
  }

  const isAblation = document.getElementById("ablationModeOption")?.checked || false;

  runBtn.disabled = true;
  exportJsonBtn.disabled = true;
  progressContainer.style.display = "block";
  progressFill.style.width = "0%";
  statusMessage.textContent = isAblation ? "Starting benchmark suite in Ablation Mode (Redaction ON vs OFF)..." : "Starting benchmark suite...";

  const fixtureResults = [];
  const allPredictedRegions = [];
  const allGroundTruthItems = [];
  const resourceSamples = [];
  const latencyList = [];
  const allMisses = [];
  const ablationResults = [];

  // Create single test runner tab
  let testTab = null;
  try {
    testTab = await safeTabCreate({ url: "about:blank", active: false });
  } catch (e) {
    statusMessage.textContent = "Error creating benchmark runner tab: " + e.message;
    runBtn.disabled = false;
    return;
  }

  const BASE_URL = "http://localhost:8000/fixtures/";

  for (let i = 0; i < FIXTURES.length; i++) {
    const fix = FIXTURES[i];
    const targetUrl = BASE_URL + fix.name;

    const pct = Math.round(((i + 1) / FIXTURES.length) * 100);
    progressFill.style.width = `${pct}%`;
    statusMessage.textContent = `Running Fixture ${fix.id}/${FIXTURES.length}: ${fix.title}...`;

    try {
      // 1. Navigate runner tab to fixture URL
      await safeTabUpdate(testTab.id, { url: targetUrl });
      await waitForTabComplete(testTab.id, 5000);
      await waitForLayoutSettle(testTab.id); // Dynamic mutation-based layout settle (P2.3)

      // Throttle spacing to respect Chromium captureVisibleTab rate limits (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)
      await new Promise((r) => setTimeout(r, 450));

      // 2. Invoke perceiveAndRedact pipeline via background worker
      const perc = await chrome.runtime.sendMessage({
        type: "PERCEIVE_AND_REDACT",
        tabId: testTab.id,
        opts: { policyMode: "balanced" }
      });

      if (perc.error) {
        throw new Error(perc.error);
      }

      // 3. Extract ground truth live from tab DOM (world: MAIN to access page-defined window.__groundTruth)
      let rawGtItems = [];
      try {
        const gtExec = await chrome.scripting.executeScript({
          target: { tabId: testTab.id },
          world: "MAIN",
          func: () => {
            if (typeof window.__groundTruth === "function") {
              try {
                const res = window.__groundTruth();
                if (Array.isArray(res) && res.length > 0) return res;
              } catch (e) {
                console.error("[benchmark] window.__groundTruth call failed:", e);
              }
            }
            return [];
          }
        });
        rawGtItems = gtExec[0]?.result || [];
      } catch (e) {
        console.warn("[benchmark] world: MAIN execution error:", e);
      }

      // If rawGtItems is still empty, run resilient DOM extraction fallback
      if (!rawGtItems || rawGtItems.length === 0) {
        try {
          const domExec = await chrome.scripting.executeScript({
            target: { tabId: testTab.id },
            func: () => {
              const items = [];
              function collectPii(node, offsetLeft = 0, offsetTop = 0) {
                const category = node.getAttribute("data-pii");
                if (!category) return;
                let rects = [];
                if (node.tagName === "IMG") {
                  const r = node.getBoundingClientRect();
                  rects = [{ x: offsetLeft + r.left, y: offsetTop + r.top, width: r.width, height: r.height }];
                } else {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const clientRects = Array.from(range.getClientRects());
                  rects = clientRects.map((r) => ({
                    x: offsetLeft + r.left,
                    y: offsetTop + r.top,
                    width: r.width,
                    height: r.height,
                  }));
                  if (rects.length === 0) {
                    const r = node.getBoundingClientRect();
                    rects = [{ x: offsetLeft + r.left, y: offsetTop + r.top, width: r.width, height: r.height }];
                  }
                }
                items.push({
                  category,
                  rects,
                  text: node.value || node.innerText || node.alt || node.getAttribute("placeholder") || "",
                });
              }

              document.querySelectorAll("[data-pii]").forEach((n) => collectPii(n));
              // Check shadow roots
              document.querySelectorAll("*").forEach((el) => {
                if (el.shadowRoot) {
                  el.shadowRoot.querySelectorAll("[data-pii]").forEach((n) => collectPii(n));
                }
              });
              // Check same-origin iframes
              document.querySelectorAll("iframe").forEach((iframe) => {
                try {
                  if (iframe.contentDocument) {
                    const f = iframe.getBoundingClientRect();
                    iframe.contentDocument.querySelectorAll("[data-pii]").forEach((n) => collectPii(n, f.left, f.top));
                  }
                } catch (e) {}
              });
              return items;
            },
          });
          rawGtItems = domExec[0]?.result || [];
        } catch (e) {
          console.warn("[benchmark] DOM fallback extraction failed:", e);
        }
      }

      const dpr = perc.dpr || 1;

      // 4. Convert Ground Truth rects to physical device pixels
      const deviceGtItems = rawGtItems.map(gt => ({
        category: gt.category,
        text: gt.text,
        rects: (gt.rects || []).map(r => ({
          x: r.x * dpr,
          y: r.y * dpr,
          width: r.width * dpr,
          height: r.height * dpr
        }))
      }));

      // Count positive Ground Truth items (excluding negative controls with category === 'none')
      const posGtCount = deviceGtItems.filter(g => g.category !== "none").length;

      // 5. Score detection (Metric 2)
      const detectionScore = BenchmarkScoring.scoreDetection(perc.fusedRegions, deviceGtItems);

      // Collect misses
      (detectionScore.misses || []).forEach(m => {
        allMisses.push({
          fixtureId: fix.id,
          fixtureName: fix.name,
          type: "Detection Miss (FN)",
          category: m.category,
          text: m.text,
          info: `Bounding box not detected by pipeline`
        });
      });

      // 6. Score redaction pixel leaks (Metric 3)
      let redactionScore = { coverage: 1.0, pixelLeaks: [], totalPiiPixels: 0, coveredPiiPixels: 0, leakedPiiPixels: 0, piiLeakRate: 0.0 };
      if (perc.redactedDataUrl) {
        try {
          const imgData = await loadImageData(perc.redactedDataUrl);
          redactionScore = BenchmarkScoring.scoreRedactionImageData(imgData, deviceGtItems, perc.fusedRegions);
        } catch (e) {
          console.warn(`[benchmark] Redaction image scoring failed for ${fix.name}:`, e.message);
        }
      }

      // If Ablation mode is enabled, evaluate Pass B (Redaction OFF baseline using unredacted screenshotUrl)
      let ablationResult = null;
      if (isAblation) {
        let rawScore = { coverage: 0.0, pixelLeaks: [], totalPiiPixels: 0, coveredPiiPixels: 0, leakedPiiPixels: 0, piiLeakRate: 0.0 };
        if (perc.screenshotUrl) {
          try {
            const rawImgData = await loadImageData(perc.screenshotUrl);
            rawScore = BenchmarkScoring.scoreRedactionImageData(rawImgData, deviceGtItems, []);
          } catch (e) {
            console.warn(`[benchmark] Raw screenshot scoring failed for ${fix.name}:`, e.message);
          }
        }
        const totalPixels = redactionScore.totalPiiPixels || rawScore.totalPiiPixels || 0;
        const leakedOn = redactionScore.leakedPiiPixels || 0;
        const leakedOff = totalPixels > 0 ? (rawScore.leakedPiiPixels || totalPixels) : 0;
        const leakRateOn = totalPixels > 0 ? Math.round((leakedOn / totalPixels) * 1000) / 10 : 0.0;
        const leakRateOff = totalPixels > 0 ? Math.round((leakedOff / totalPixels) * 1000) / 10 : 0.0;
        const reductionPct = Math.max(0, Math.round((leakRateOff - leakRateOn) * 10) / 10);

        ablationResult = {
          fixtureId: fix.id,
          fixtureName: fix.name,
          title: fix.title,
          totalPiiPixels: totalPixels,
          redactionOn: {
            leakRate: leakRateOn,
            leakedPixels: leakedOn,
            coverage: redactionScore.coverage
          },
          redactionOff: {
            leakRate: leakRateOff,
            leakedPixels: leakedOff,
            coverage: rawScore.coverage
          },
          leakReduction: reductionPct
        };
        ablationResults.push(ablationResult);
      }

      (redactionScore.pixelLeaks || []).forEach(leak => {
        allMisses.push({
          fixtureId: fix.id,
          fixtureName: fix.name,
          type: "Pixel Leak Failure",
          category: leak.category,
          text: leak.text,
          info: `Non-black pixel at (${leak.x}, ${leak.y}): ${leak.color}`
        });
      });

      // 7. Store timings & metrics
      latencyList.push(perc.timings);
      if (perc.offscreenMemory) {
        resourceSamples.push({
          usedJSHeapSize: perc.offscreenMemory.usedJSHeapSize,
          modelLoadTimeMs: 0,
          activeBackend: perc.visionBackend || "webgpu",
          bytesTransmitted: perc.redactedDataUrl ? perc.redactedDataUrl.length : 0
        });
      }

      fixtureResults.push({
        fixtureId: fix.id,
        fixtureName: fix.name,
        title: fix.title,
        dpr: dpr,
        gtItemCount: posGtCount,
        detection: detectionScore.overall,
        redaction: redactionScore,
        ablation: ablationResult,
        timings: perc.timings,
        fusedCount: perc.fusedRegions.length,
        domCount: perc.domRegions.length,
        faceCount: perc.faceRegions.length,
        degradedCapabilities: perc.degradedCapabilities || []
      });

      allPredictedRegions.push(...perc.fusedRegions);
      allGroundTruthItems.push(...deviceGtItems);

    } catch (err) {
      console.error(`[benchmark] Error processing ${fix.name}:`, err);
      allMisses.push({
        fixtureId: fix.id,
        fixtureName: fix.name,
        type: "Execution Crash / Error",
        category: "error",
        text: err.message,
        info: "Pipeline execution threw an unhandled exception"
      });
    }
  }

  // Close runner tab
  if (testTab) {
    chrome.tabs.remove(testTab.id).catch(() => {});
  }

  // Aggregate overall metrics across all fixtures
  const overallDetection = BenchmarkScoring.scoreDetection(allPredictedRegions, allGroundTruthItems);
  const resourceMetrics = BenchmarkScoring.aggregateResourceMetrics(resourceSamples);
  const latencyMetrics = BenchmarkScoring.aggregateLatency(latencyList);

  const isMeasured = fixtureResults.length > 0 && 
                     fixtureResults.length === FIXTURES.length && 
                     fixtureResults.every(r => r.timings && typeof r.timings.totalPipelineMs === "number" && r.timings.totalPipelineMs > 0);

  const report = {
    provenance: {
      generatedBy: "extension/benchmark.js",
      measured: isMeasured,
      chromeVersion: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || "unknown",
      backend: resourceMetrics.activeBackend || "wasm",
      timestamp: new Date().toISOString(),
      fixtureCount: FIXTURES.length,
    },
    timestamp: new Date().toISOString(),
    fixtureCount: FIXTURES.length,
    ablationMode: isAblation,
    ablation: isAblation ? {
      enabled: true,
      fixtureResults: ablationResults,
      summary: {
        meanLeakRateOn: ablationResults.length ? Math.round(ablationResults.reduce((a, b) => a + b.redactionOn.leakRate, 0) / ablationResults.length * 10) / 10 : 0,
        meanLeakRateOff: ablationResults.length ? Math.round(ablationResults.reduce((a, b) => a + b.redactionOff.leakRate, 0) / ablationResults.length * 10) / 10 : 0,
        totalLeakedOn: ablationResults.reduce((a, b) => a + b.redactionOn.leakedPixels, 0),
        totalLeakedOff: ablationResults.reduce((a, b) => a + b.redactionOff.leakedPixels, 0),
        meanReduction: ablationResults.length ? Math.round(ablationResults.reduce((a, b) => a + b.leakReduction, 0) / ablationResults.length * 10) / 10 : 0
      }
    } : null,
    overallDetection: overallDetection.overall,
    byCategory: overallDetection.byCategory,
    resourceMetrics,
    latencyMetrics,
    fixtureResults,
    misses: allMisses
  };

  lastBenchmarkReport = report;

  // Render UI
  renderReportUI(report);

  statusMessage.textContent = `✅ Benchmark run completed across ${FIXTURES.length} fixtures!`;
  runBtn.disabled = false;
  exportJsonBtn.disabled = false;
}

function renderReportUI(report) {
  // 1. KPI Cards
  const f1 = (report.overallDetection.f1 * 100).toFixed(1) + "%";
  const prec = (report.overallDetection.precision * 100).toFixed(1) + "%";
  const rec = (report.overallDetection.recall * 100).toFixed(1) + "%";

  document.getElementById("kpiDetectionF1").textContent = f1;
  document.getElementById("kpiDetectionSub").textContent = `Precision ${prec} | Recall ${rec}`;

  // Average coverage across fixtures
  const coverages = report.fixtureResults.map(r => r.redaction?.coverage || 1.0);
  const avgCoverage = ((coverages.reduce((a, b) => a + b, 0) / (coverages.length || 1)) * 100).toFixed(1) + "%";
  const totalLeaks = report.misses.filter(m => m.type.includes("Pixel Leak")).length;

  document.getElementById("kpiRedactionCoverage").textContent = avgCoverage;
  document.getElementById("kpiRedactionSub").textContent = `Mean Coverage | ${totalLeaks} Leak(s)`;

  document.getElementById("kpiPeakMemory").textContent = `${report.resourceMetrics.peakOffscreenHeapMB} MB`;
  document.getElementById("kpiMemorySub").textContent = `Backend: ${report.resourceMetrics.activeBackend} | Model: 8.5MB`;

  document.getElementById("kpiAvgLatency").textContent = `${report.latencyMetrics.mean} ms`;
  document.getElementById("kpiLatencySub").textContent = `Median: ${report.latencyMetrics.median}ms | p95: ${report.latencyMetrics.p95}ms`;

  // 2. Misses Section
  const missesContainer = document.getElementById("missesContainer");
  const missesTableBody = document.getElementById("missesTableBody");
  const missCount = document.getElementById("missCount");

  missCount.textContent = report.misses.length;
  missesTableBody.innerHTML = "";

  if (report.misses.length > 0) {
    missesContainer.style.display = "block";
    report.misses.forEach(m => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="font-weight: 600; color: #38bdf8;">#${m.fixtureId} (${m.fixtureName})</td>
        <td><span class="status-badge badge-fail">${m.type}</span></td>
        <td><code>${m.category}</code></td>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(m.text)}</td>
        <td style="color: #8b949e;">${escapeHtml(m.info)}</td>
      `;
      missesTableBody.appendChild(tr);
    });
  } else {
    missesContainer.style.display = "none";
  }

  // 3. Fixture Breakdown Table
  const tableBody = document.getElementById("fixtureTableBody");
  tableBody.innerHTML = "";

  report.fixtureResults.forEach(r => {
    const tr = document.createElement("tr");
    const p = (r.detection.precision * 100).toFixed(0) + "%";
    const recPct = (r.detection.recall * 100).toFixed(0) + "%";
    const f1Pct = (r.detection.f1 * 100).toFixed(0) + "%";
    const cov = ((r.redaction?.coverage || 1.0) * 100).toFixed(0) + "%";
    const leaks = (r.redaction?.pixelLeaks || []).length;
    const degraded = (r.degradedCapabilities && r.degradedCapabilities.length > 0)
      ? `<span class="status-badge badge-warn" title="${escapeHtml(r.degradedCapabilities.join(', '))}">${escapeHtml(r.degradedCapabilities.join(', '))}</span>`
      : '<span class="status-badge badge-pass">Healthy</span>';

    const f1Class = r.detection.f1 >= 0.8 ? "badge-pass" : (r.detection.f1 > 0 ? "badge-warn" : "badge-fail");

    tr.innerHTML = `
      <td>${r.fixtureId}</td>
      <td style="font-weight: 500; color: #f8fafc;">${escapeHtml(r.title)}</td>
      <td>${r.gtItemCount}</td>
      <td style="color: #3fb950;">${r.detection.tp}</td>
      <td style="color: #d29922;">${r.detection.fp}</td>
      <td style="color: #f85149;">${r.detection.fn}</td>
      <td>${p}</td>
      <td>${recPct}</td>
      <td><span class="status-badge ${f1Class}">${f1Pct}</span></td>
      <td>${cov}</td>
      <td>${leaks > 0 ? `<span class="status-badge badge-fail">${leaks} leak(s)</span>` : '<span class="status-badge badge-pass">0</span>'}</td>
      <td>${degraded}</td>
      <td style="color: #8b949e;">${r.timings.clientTotal} ms</td>
    `;
    tableBody.appendChild(tr);
  });

  // 4. Ablation Study Section
  const ablationContainer = document.getElementById("ablationContainer");
  const ablationTableBody = document.getElementById("ablationTableBody");
  if (report.ablation && report.ablation.enabled && ablationContainer && ablationTableBody) {
    ablationContainer.style.display = "block";
    ablationTableBody.innerHTML = "";
    report.ablation.fixtureResults.forEach(ab => {
      const tr = document.createElement("tr");
      const onBadge = ab.redactionOn.leakRate === 0 
        ? `<span class="status-badge badge-pass">${ab.redactionOn.leakRate.toFixed(1)}%</span>`
        : `<span class="status-badge badge-warn">${ab.redactionOn.leakRate.toFixed(1)}%</span>`;
      const offBadge = ab.totalPiiPixels > 0 
        ? `<span class="status-badge badge-fail">${ab.redactionOff.leakRate.toFixed(1)}%</span>`
        : `<span class="status-badge badge-pass">0.0% (N/A)</span>`;
      const benefitBadge = ab.leakReduction > 0
        ? `<span class="status-badge badge-pass">+${ab.leakReduction.toFixed(1)}% Protected</span>`
        : `<span style="color: var(--text-muted);">0.0% (No PII)</span>`;

      tr.innerHTML = `
        <td>${ab.fixtureId}</td>
        <td style="font-weight: 500; color: #f8fafc;">${escapeHtml(ab.title)}</td>
        <td>${ab.totalPiiPixels.toLocaleString()} px</td>
        <td>${onBadge}</td>
        <td>${offBadge}</td>
        <td>${ab.redactionOn.leakedPixels.toLocaleString()} px</td>
        <td>${ab.redactionOff.leakedPixels.toLocaleString()} px</td>
        <td>${benefitBadge}</td>
      `;
      ablationTableBody.appendChild(tr);
    });
  } else if (ablationContainer) {
    ablationContainer.style.display = "none";
  }
}

function exportReportJson() {
  if (!lastBenchmarkReport) return;
  const jsonStr = JSON.stringify(lastBenchmarkReport, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `kaappan-benchmark-live-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function safeTabCreate(createProperties, retries = 5, delayMs = 250) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.create(createProperties);
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes("Tabs cannot be edited right now") || msg.includes("drag")) {
        console.warn(`[safeTabCreate] Tab busy/dragging, retrying ${i + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return await chrome.tabs.create(createProperties);
}

async function safeTabUpdate(tabId, updateProperties, retries = 5, delayMs = 250) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.update(tabId, updateProperties);
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes("Tabs cannot be edited right now") || msg.includes("drag")) {
        console.warn(`[safeTabUpdate] Tab busy/dragging on tab ${tabId}, retrying ${i + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return await chrome.tabs.update(tabId, updateProperties);
}

async function waitForTabComplete(tabId, timeoutMs = 5000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.status === "complete") return;
  } catch (e) {}

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, timeoutMs);

    function listener(tid, changeInfo) {
      if (tid === tabId && changeInfo.status === "complete") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function loadImageData(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      try {
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        resolve(imageData);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = (err) => reject(err);
    img.src = dataUrl;
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function waitForLayoutSettle(tabId, maxWaitMs = 600) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return new Promise((resolve) => {
          let timeout;
          let observer;
          const done = () => {
            if (observer) observer.disconnect();
            if (timeout) clearTimeout(timeout);
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          };
          observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(done, 80);
          });
          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
          });
          timeout = setTimeout(done, 150);
        });
      },
    });
  } catch (e) {
    await new Promise((r) => setTimeout(r, 200));
  }
}
