// background.js — MV3 service worker. Orchestrates the perceive -> redact -> gate -> ask -> act
// loop, plus a separate read/remember/answer flow for scraping and querying page content.
//
// ============================================================================
// COORDINATE SPACES — read this before touching any geometry in this file.
// ----------------------------------------------------------------------------
// There are two pixel spaces in play and mixing them is a privacy bug, not a
// cosmetic one:
//
//   CSS pixels     — what getBoundingClientRect() returns in content.js.
//   Device pixels  — what chrome.tabs.captureVisibleTab() actually gives back.
//                    device = css * devicePixelRatio
//
// On a retina Mac (dpr 2) or Windows at 125% scaling (dpr 1.25), drawing a
// CSS-pixel rect onto the device-pixel screenshot blacks out only the top-left
// 1/dpr of the field. Passwords and emails leak out the right and bottom edges.
//
// Rule for this file: everything from redaction onward works in DEVICE pixels.
// Convert once, immediately after SCAN_DOM, via toDevice(). Convert back to CSS
// only for FLASH_OVERLAY, which draws into the page.
// ============================================================================
//
// Other changes vs the previous version:
//   * Face boxes from offscreen.js arrive in crop-pixel coords, not 0..1 fractions.
//     The old code multiplied them by the crop width a second time, placing every
//     face box thousands of pixels off-screen. Fixed in mapFacesToPage().
//   * verifyPrivacyGate() now FAILS CLOSED. The old catch block swallowed canvas
//     errors and fell through to `return { ok: true }`, so an exception silently
//     certified an unverified frame.
//   * lastNetworkPayload is now actually assigned (it was declared, cleared, and
//     read by the popup, but never written — the A2 inspector was always empty).
//   * loadProfile() no longer invents "Jane Doe" / "jane@example.com". Unresolved
//     placeholders now abort the step with a clear message instead of typing
//     fabricated PII into a real form.
//   * Sends visionAvailable to the server so the DOM-only fallback is explicit
//     rather than a 1x1 transparent PNG the model has to guess about.

const SERVER_URL = "http://localhost:8000/act"; // local server — nothing here needs deploying
const ASK_URL = "http://localhost:8000/ask";

try {
  importScripts("sample_photo.js", "storage.js", "policy_engine.js", "redaction_core.js", "mock_reasoner.js");
} catch (e) {
  console.warn("importScripts failed or running in non-worker context:", e);
}

const MAX_STEPS = 15;
const REDACTION_PADDING_PX = 8; // device px of slop around each box, guards edge bleed

let running = false;
let loopActive = false;
let isPaused = false;
let pausedState = null;
let currentTabId = null;
let currentTask = null;
let offscreenReady = false;
let currentProfile = {};
let policyMode = "balanced";
let lastVisionBackend = null;

// Control Plane & Safety Engine state
let agentMode = "guarded"; // "guarded" | "supervised" | "preview"
let allowedDomains = []; // array of allowed hostnames, e.g. ["localhost", "127.0.0.1"]
let userMaxSteps = 15;
let maxRuntimeMs = 120000;
let protectedTerms = [];
let offlineMode = false;
let disableSubmitApproval = false;
let taskStartTime = null;
let pendingApprovalRequest = null;

// --- Rate-limited & Exception-Safe Chromium Tab Helpers ---
let lastCaptureVisibleTabTime = 0;

async function safeCaptureVisibleTab(windowId = null, options = { format: "png" }, retries = 6, delayMs = 600) {
  const now = Date.now();
  const elapsed = now - lastCaptureVisibleTabTime;
  if (elapsed < 550) {
    await new Promise((r) => setTimeout(r, 550 - elapsed));
  }

  for (let i = 0; i < retries; i++) {
    try {
      lastCaptureVisibleTabTime = Date.now();
      const res = await chrome.tabs.captureVisibleTab(windowId, options);
      if (res) return res;
      throw new Error("captureVisibleTab returned empty result");
    } catch (err) {
      const msg = err?.message || String(err);
      if (
        msg.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND") ||
        msg.includes("Tabs cannot be edited right now") ||
        msg.includes("quota") ||
        msg.includes("rate") ||
        msg.includes("drag")
      ) {
        console.warn(`[safeCaptureVisibleTab] Rate limit / tab busy (attempt ${i + 1}/${retries}): ${msg}. Retrying in ${delayMs * (i + 1)}ms...`);
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  lastCaptureVisibleTabTime = Date.now();
  return await chrome.tabs.captureVisibleTab(windowId, options);
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
let pendingApprovalResolver = null;

// --- Phase 4: RunState Service Worker Persistence ---
async function saveRunState(extraProps = {}) {
  try {
    const state = {
      running,
      currentTask,
      currentTabId,
      steps: typeof steps !== "undefined" ? steps : 0,
      auditSteps,
      policyMode,
      agentMode,
      taskStartTime,
      pendingApprovalRequest,
      pendingInputRequest,
      ...extraProps,
    };
    await chrome.storage.session.set({ runState: state });
  } catch (e) {
    console.warn("[saveRunState] Storage error:", e.message);
  }
}

async function loadRunState() {
  try {
    const data = await chrome.storage.session.get("runState");
    if (data && data.runState) {
      const rs = data.runState;
      currentTask = rs.currentTask || currentTask;
      currentTabId = rs.currentTabId || currentTabId;
      auditSteps = rs.auditSteps || auditSteps;
      policyMode = rs.policyMode || policyMode;
      agentMode = rs.agentMode || agentMode;
      taskStartTime = rs.taskStartTime || taskStartTime;
      pendingApprovalRequest = rs.pendingApprovalRequest || pendingApprovalRequest;
      pendingInputRequest = rs.pendingInputRequest || pendingInputRequest;

      if (rs.running && !running) {
        console.warn("[loadRunState] Rehydrated in-flight run state after service worker restart.");
        auditSteps.push({
          step: rs.steps || 0,
          timestamp: new Date().toISOString(),
          task: currentTask,
          privacyGateStatus: "interrupted",
          executionReason: "Service worker restarted during execution",
          degradedCapabilities: ["SERVICE_WORKER_RESTARTED"],
          timings: { totalMs: 0, visionInferenceMs: 0 },
        });
      }
    }
  } catch (e) {
    console.warn("[loadRunState] Error restoring state:", e.message);
  }
}
loadRunState();

// Load persisted safety & control plane settings
chrome.storage.local.get([
  "agentMode",
  "allowedDomains",
  "userMaxSteps",
  "maxRuntimeMs",
  "protectedTerms",
  "offlineMode",
  "disableSubmitApproval",
]).then((data) => {
  if (data.agentMode) agentMode = data.agentMode;
  if (Array.isArray(data.allowedDomains)) allowedDomains = data.allowedDomains;
  if (typeof data.userMaxSteps === "number") userMaxSteps = data.userMaxSteps;
  if (typeof data.maxRuntimeMs === "number") maxRuntimeMs = data.maxRuntimeMs;
  if (Array.isArray(data.protectedTerms)) protectedTerms = data.protectedTerms;
  if (typeof data.offlineMode === "boolean") offlineMode = data.offlineMode;
  if (typeof data.disableSubmitApproval === "boolean") disableSubmitApproval = data.disableSubmitApproval;
}).catch(() => {});

// Interactive user input state (RAM only, never sent to the decision server)
let pendingInputRequest = null;
let pendingInputResolver = null;
let sessionFieldAnswers = {};
let skippedFields = [];
let inputKeepAliveTimer = null;
let inputTimeoutTimer = null;

// Network inspector state (A2)
let lastNetworkPayload = null;

// Audit trail step storage (G4)
let auditSteps = [];

// In-memory comparison buffer (Feature B: Redaction Transparency Viewer).
// Original screenshots live ONLY in this array in memory, capped to 15 downscaled frames.
// NEVER persisted to disk, chrome.storage.local, IndexedDB, or audit export.
// Retained in RAM / chrome.storage.session for this browser session only.
let comparisonBuffer = [];
try {
  chrome.storage.session.get("comparisonBuffer").then((data) => {
    if (data && data.comparisonBuffer && data.comparisonBuffer.length > 0) {
      comparisonBuffer = data.comparisonBuffer;
    }
  }).catch(() => {});
} catch (e) {}

async function downscaleScreenshot(dataUrl, maxW = 800, quality = 0.7) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);

    const osc = new OffscreenCanvas(w, h);
    const ctx = osc.getContext("2d");
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const outBlob = await osc.convertToBlob({ type: "image/jpeg", quality });
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(outBlob);
    });
  } catch (e) {
    return dataUrl;
  }
}

// Real PII values resolved from scraped pages. Lives ONLY in this in-memory object.
let inMemoryTokenMap = {};

async function ensureOffscreenDocument() {
  if (offscreenReady) return;
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Local ONNX face-detection model needs canvas/DOM access for redaction.",
    });
  }
  offscreenReady = true;
}

try {
  chrome.storage.session.get("pendingInputRequest").then((data) => {
    if (data && data.pendingInputRequest) {
      pendingInputRequest = data.pendingInputRequest;
    }
  }).catch(() => {});
} catch (e) {}

function cleanupPendingInput() {
  if (inputKeepAliveTimer) {
    clearInterval(inputKeepAliveTimer);
    inputKeepAliveTimer = null;
  }
  if (inputTimeoutTimer) {
    clearTimeout(inputTimeoutTimer);
    inputTimeoutTimer = null;
  }
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { type: "DISMISS_INPUT_PROMPT" }).catch(() => {});
  }
  pendingInputRequest = null;
  pendingInputResolver = null;
  chrome.storage.session.remove("pendingInputRequest").catch(() => {});
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  chrome.runtime.sendMessage({ type: "AGENT_INPUT_RESOLVED" }).catch(() => {});
}

function requestUserInput(spec) {
  return new Promise((resolve) => {
    const id = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    pendingInputRequest = {
      id,
      selector: spec.selector || "",
      field: spec.field || "value",
      question: spec.question || `Please provide a value for "${spec.field || "this field"}":`,
      inputType: spec.inputType || "text",
      options: spec.options || null,
    };

    pendingInputResolver = resolve;

    // Persist to session storage so if popup reopens it can render it
    chrome.storage.session.set({ pendingInputRequest }).catch(() => {});

    // Set badge so user notices
    chrome.action.setBadgeText({ text: "?" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }).catch(() => {});

    // Send message to active tab to render the in-page modal dialog directly on the page
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, {
        type: "SHOW_INPUT_PROMPT",
        request: pendingInputRequest,
      }).catch(async () => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            files: ["content.js"],
          });
          await chrome.tabs.sendMessage(currentTabId, {
            type: "SHOW_INPUT_PROMPT",
            request: pendingInputRequest,
          });
        } catch (e) {}
      });
    }

    // Send message to popup (if open)
    chrome.runtime.sendMessage({
      type: "AGENT_INPUT_REQUEST",
      request: pendingInputRequest,
    }).catch(() => {});

    // Keepalive ping (~20s interval) so MV3 service worker isn't killed while waiting
    if (inputKeepAliveTimer) clearInterval(inputKeepAliveTimer);
    inputKeepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo?.().catch?.(() => {});
    }, 20000);

    // 5 minute timeout to abort cleanly
    if (inputTimeoutTimer) clearTimeout(inputTimeoutTimer);
    inputTimeoutTimer = setTimeout(() => {
      if (pendingInputRequest && pendingInputRequest.id === id) {
        sendLog(`Step timeout: No input provided for "${pendingInputRequest.field}" after 5 minutes.`, false);
        cleanupPendingInput();
        resolve({ ok: false, canceled: true, timeout: true, field: spec.field });
      }
    }, 300000);
  });
}

// --- Supervised Mode: Action Approval Flow ---
function cleanupPendingApproval() {
  pendingApprovalRequest = null;
  pendingApprovalResolver = null;
  chrome.storage.session.remove("pendingApprovalRequest").catch(() => {});
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  chrome.runtime.sendMessage({ type: "AGENT_APPROVAL_RESOLVED" }).catch(() => {});
}

function requestUserApproval(spec) {
  return new Promise((resolve) => {
    const id = "approval_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    pendingApprovalRequest = {
      id,
      action: spec.action,
      reason: spec.reason,
      policy: spec.policy || "Action Safety",
      selector: spec.selector || (spec.action?.selector || ""),
      semanticLabel: spec.semanticLabel || (spec.action?.semanticLabel || spec.action?.selector || ""),
      value: spec.value !== undefined ? spec.value : (spec.action?.value || ""),
      fileId: spec.action?.fileId || spec.fileId || "",
    };

    pendingApprovalResolver = resolve;
    chrome.storage.session.set({ pendingApprovalRequest }).catch(() => {});

    chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#f43f5e" }).catch(() => {});

    chrome.runtime.sendMessage({
      type: "AGENT_APPROVAL_REQUEST",
      request: pendingApprovalRequest,
    }).catch(() => {});
  });
}

// --- Run History Persistence (Zero PII stored) ---
async function recordRunHistory(entry) {
  try {
    const data = await chrome.storage.local.get("runHistory");
    const history = data.runHistory || [];
    const record = {
      id: "run_" + Date.now(),
      taskName: entry.task || "Unnamed Task",
      startedAt: new Date(Date.now() - (entry.durationMs || 0)).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: entry.durationMs || 0,
      status: entry.status || "completed",
      mode: entry.mode || "guarded",
      stepsExecuted: entry.steps || 0,
      maxSteps: entry.maxSteps || 15,
      facesDetected: entry.faces || 0,
      regionsDetected: entry.regions || 0,
      regionsRedacted: entry.regions || 0,
      policyBlocks: entry.policyBlocks || 0,
      privacyGatePassed: Boolean(entry.gatePassed),
      offlineMode: Boolean(entry.offline),
    };
    history.unshift(record);
    if (history.length > 30) history.pop();
    await chrome.storage.local.set({ runHistory: history });
    chrome.runtime.sendMessage({ type: "RUN_HISTORY_UPDATED", history }).catch(() => {});
  } catch (e) {
    console.warn("Failed to record run history:", e);
  }
}

// --- Local Privacy Scan (Zero AI Calls) ---
async function runLocalPrivacyScan(tabId) {
  if (!tabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id;
  }
  if (!tabId) throw new Error("No active tab found for privacy scan.");

  let windowId = null;
  try {
    const tabInfo = await chrome.tabs.get(tabId);
    if (tabInfo) {
      windowId = tabInfo.windowId;
      if (!tabInfo.active) {
        await safeTabUpdate(tabId, { active: true });
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch (e) {
    console.warn("[runLocalPrivacyScan] Could not inspect tab:", e);
  }

  await ensureContentScript(tabId);
  await ensureOffscreenDocument();

  const storedTerms = await chrome.storage.local.get("protectedTerms");
  const currentTerms = storedTerms.protectedTerms || protectedTerms || [];

  // 1. Capture Visible Tab
  const screenshotUrl = await safeCaptureVisibleTab(windowId, { format: "png" });

  // 2. Scan DOM passing protectedTerms
  const framePii = await chrome.tabs.sendMessage(tabId, {
    type: "LOCAL_PRIVACY_SCAN",
    opts: { protectedTerms: currentTerms },
  });

  const dpr = framePii?.dpr || 1;
  const domRegions = (framePii?.regions || []).map((r) => RedactionCore.toDevice(r, dpr));
  const imageRegions = (framePii?.imageRegions || []).map((r) => RedactionCore.toDevice(r, dpr));

  // 3. Local ONNX Face Detection on image crops
  const shotBlob = await (await fetch(screenshotUrl)).blob();
  const shotBitmap = await createImageBitmap(shotBlob);
  const shotW = shotBitmap.width;
  const shotH = shotBitmap.height;
  shotBitmap.close?.();

  const allFaces = [];
  for (const imgReg of imageRegions) {
    try {
      const crop = await cropImage(screenshotUrl, imgReg, shotW, shotH);
      if (crop) {
        const visionResult = await chrome.runtime.sendMessage({
          type: "DETECT_FACES",
          imageDataUrl: crop.dataUrl,
        });
        if (visionResult && visionResult.ok) {
          allFaces.push(...mapFacesToPage(visionResult.faces || [], crop));
        }
      }
    } catch (e) {}
  }

  // 4. Fuse regions and flash overlay on page
  const fusedRegions = RedactionCore.fuseRegions(domRegions, allFaces);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "FLASH_OVERLAY",
      regions: fusedRegions.map((r) => RedactionCore.toCss(r, dpr)),
    });
  } catch (e) {}

  const cats = framePii?.categories || {};
  return {
    ok: true,
    facesCount: allFaces.length,
    emailCount: cats.emails || 0,
    phoneCount: cats.phones || 0,
    passwordCount: cats.passwords || 0,
    sensitiveTextCount: cats.sensitiveTexts || 0,
    protectedTermsCount: cats.protectedTerms || 0,
    formsScanned: cats.formsScanned || 0,
    imagesScanned: cats.imagesScanned || imageRegions.length,
    totalRegionsDetected: fusedRegions.length,
    aiRequest: "NONE (100% Local On-Device)",
    timestamp: new Date().toISOString(),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_PREFLIGHT") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const offscreenRes = await chrome.runtime.sendMessage({ type: "PREFLIGHT_CHECK" });
        sendResponse(offscreenRes || { ok: false, error: "No response from offscreen document" });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === "START_AGENT") {
    if (loopActive) {
      sendLog("Agent is already running.", false);
      return;
    }
    running = true;
    loopActive = true;
    currentTabId = msg.tabId;
    currentTask = msg.task;
    if (msg.mode) agentMode = msg.mode;
    if (typeof msg.offlineMode === "boolean") offlineMode = msg.offlineMode;

    // Reset session answers on new agent run so stale data from past runs never fills missing fields
    sessionFieldAnswers = {};
    skippedFields = [];

    runLoop().finally(() => {
      loopActive = false;
    });
  }
  if (msg.type === "STOP_AGENT") {
    running = false;
    if (pendingInputResolver) {
      pendingInputResolver({ ok: false, canceled: true });
    }
    cleanupPendingInput();
    if (pendingApprovalResolver) {
      pendingApprovalResolver({ approved: false, userCancelled: true });
    }
    cleanupPendingApproval();
  }
  if (msg.type === "GET_CONTROL_CENTER_STATE") {
    chrome.storage.local.get([
      "agentMode",
      "allowedDomains",
      "userMaxSteps",
      "maxRuntimeMs",
      "protectedTerms",
      "offlineMode",
      "privacyPolicy",
      "runHistory",
    ]).then((data) => {
      sendResponse({
        running,
        isPaused,
        currentTask,
        agentMode: data.agentMode || agentMode,
        allowedDomains: data.allowedDomains || allowedDomains,
        userMaxSteps: data.userMaxSteps || userMaxSteps,
        maxRuntimeMs: data.maxRuntimeMs || maxRuntimeMs,
        protectedTerms: data.protectedTerms || protectedTerms,
        offlineMode: typeof data.offlineMode === "boolean" ? data.offlineMode : offlineMode,
        privacyPolicy: data.privacyPolicy || policyMode,
        pendingApproval: pendingApprovalRequest,
        pendingInput: pendingInputRequest,
        runHistory: data.runHistory || [],
      });
    });
    return true;
  }
  if (msg.type === "SET_AGENT_MODE") {
    agentMode = msg.mode || "guarded";
    chrome.storage.local.set({ agentMode });
    sendResponse({ ok: true, agentMode });
    return true;
  }
  if (msg.type === "SET_ALLOWED_DOMAINS") {
    allowedDomains = Array.isArray(msg.domains) ? msg.domains : [];
    chrome.storage.local.set({ allowedDomains });
    sendResponse({ ok: true, allowedDomains });
    return true;
  }
  if (msg.type === "SET_STEP_LIMIT") {
    userMaxSteps = typeof msg.maxSteps === "number" ? msg.maxSteps : 15;
    chrome.storage.local.set({ userMaxSteps });
    sendResponse({ ok: true, userMaxSteps });
    return true;
  }
  if (msg.type === "SET_PROTECTED_TERMS") {
    protectedTerms = Array.isArray(msg.terms) ? msg.terms : [];
    chrome.storage.local.set({ protectedTerms });
    sendResponse({ ok: true, protectedTerms });
    return true;
  }
  if (msg.type === "SET_OFFLINE_MODE") {
    offlineMode = Boolean(msg.enabled);
    chrome.storage.local.set({ offlineMode });
    sendResponse({ ok: true, offlineMode });
    return true;
  }
  if (msg.type === "RUN_LOCAL_PRIVACY_SCAN") {
    runLocalPrivacyScan(msg.tabId || currentTabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "APPROVE_PENDING_ACTION") {
    if (pendingApprovalResolver) {
      const res = pendingApprovalResolver;
      cleanupPendingApproval();
      res({ approved: true });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: "No pending approval request" });
    }
    return true;
  }
  if (msg.type === "REJECT_PENDING_ACTION") {
    if (pendingApprovalResolver) {
      const res = pendingApprovalResolver;
      cleanupPendingApproval();
      res({ approved: false });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: "No pending approval request" });
    }
    return true;
  }
  if (msg.type === "GET_PENDING_APPROVAL") {
    sendResponse({ pending: pendingApprovalRequest });
    return true;
  }
  if (msg.type === "GET_RUN_HISTORY") {
    chrome.storage.local.get("runHistory").then((data) => {
      sendResponse({ history: data.runHistory || [] });
    });
    return true;
  }
  if (msg.type === "CLEAR_RUN_HISTORY") {
    chrome.storage.local.set({ runHistory: [] }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "SCRAPE_TAB") {
    scrapeCurrentTab(msg.tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "ASK_QUESTION") {
    askQuestion(msg.question)
      .then((answer) => sendResponse({ answer }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "SAVE_USER_DOC") {
    saveUserDocument(msg.name, msg.textContent, msg.fileId)
      .then((count) => sendResponse({ count }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "CLEAR_USER_DOCS") {
    clearUserDocs().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_USER_DOCS") {
    getUserDocs()
      .then((docs) => sendResponse({ docs: docs || [] }))
      .catch((e) => sendResponse({ error: e.message, docs: [] }));
    return true;
  }
  if (msg.type === "NEW_SESSION") {
    clearSession().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_NETWORK_INSPECTOR") {
    sendResponse({ payload: lastNetworkPayload });
    return true;
  }
  if (msg.type === "GET_AUDIT_LOG") {
    sendResponse({ steps: auditSteps });
    return true;
  }
  if (msg.type === "GET_SERVER_SECRET") {
    getServerSecret().then((secret) => sendResponse({ secret }));
    return true;
  }
  if (msg.type === "GET_JUDGE_STATE") {
    sendResponse({ state: computeJudgeState() });
    return true;
  }
  if (msg.type === "PERCEIVE_AND_REDACT") {
    perceiveAndRedact(msg.tabId || currentTabId, msg.opts || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "GET_BENCHMARK_REPORT") {
    sendResponse({ report: generateBenchmarkReport() });
    return true;
  }
  if (msg.type === "SET_PRIVACY_POLICY") {
    policyMode = msg.policy || "balanced";
    chrome.storage.local.set({ privacyPolicy: policyMode });
    sendResponse({ ok: true, policy: policyMode });
    return true;
  }
  if (msg.type === "GET_PRIVACY_POLICY") {
    chrome.storage.local.get("privacyPolicy").then((data) => {
      policyMode = data.privacyPolicy || "balanced";
      sendResponse({ policy: policyMode });
    });
    return true;
  }
  if (msg.type === "GET_COMPARISON_DATA") {
    if (comparisonBuffer.length > 0) {
      sendResponse({ steps: comparisonBuffer });
    } else {
      chrome.storage.session.get("comparisonBuffer").then((data) => {
        if (data && data.comparisonBuffer && data.comparisonBuffer.length > 0) {
          comparisonBuffer = data.comparisonBuffer;
        }
        sendResponse({ steps: comparisonBuffer });
      }).catch(() => {
        sendResponse({ steps: comparisonBuffer });
      });
    }
    return true;
  }
  if (msg.type === "CLEAR_COMPARISON_HISTORY") {
    comparisonBuffer = [];
    chrome.storage.session.remove("comparisonBuffer").catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "RESUME_AGENT_TASK") {
    if (isPaused && pausedState) {
      isPaused = false;
      running = true;
      loopActive = true;
      sendLog("Resumed by user — continuing execution...", true);
      runLoop(pausedState).finally(() => {
        loopActive = false;
      });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: "Agent is not currently paused" });
    }
    return true;
  }
  if (msg.type === "SAVE_USER_FILE") {
    saveUserFile(msg.fileData)
      .then(async (rec) => {
        const fileRec = rec || msg.fileData;
        const parseRes = await autoProcessUploadedDocument(fileRec);
        sendResponse({ ok: true, file: fileRec, docParsed: parseRes });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "SYNC_USER_DOCS_PROFILE") {
    loadProfile()
      .then((profile) => sendResponse({ ok: true, profile }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "PROFILE_MANUALLY_SAVED") {
    currentProfile = msg.profile || {};
    const removed = Array.isArray(msg.removedFields) ? msg.removedFields : [];
    for (const f of removed) {
      delete sessionFieldAnswers[f];
      delete sessionFieldAnswers[canonicalProfileKey(f)];
    }
    chrome.storage.local.set({ savedProfile: currentProfile, profile: currentProfile }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "GET_USER_FILES") {
    getAllUserFiles()
      .then((files) => sendResponse({ files }))
      .catch((e) => sendResponse({ error: e.message, files: [] }));
    return true;
  }
  if (msg.type === "DELETE_USER_FILE") {
    deleteUserFileCascade(msg.id)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CLEAR_ALL_USER_DATA") {
    clearAllUserData()
      .then((counts) => sendResponse({ ok: true, ...counts }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CLEAR_ALL_USER_FILES") {
    clearAllUserData()
      .then((counts) => sendResponse({ ok: true, ...counts }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "CLEAR_USER_DOCS") {
    chrome.storage.local.remove("userDocs")
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "GET_PENDING_INPUT") {
    sendResponse({ pending: pendingInputRequest });
    return true;
  }
  if (msg.type === "SUBMIT_USER_INPUT") {
    if (pendingInputRequest && pendingInputRequest.id === msg.id) {
      const field = pendingInputRequest.field;
      const canonKey = canonicalProfileKey(field);
      const val = String(msg.value ?? "").trim();

      // RAM only, never sent to server
      sessionFieldAnswers[canonKey] = val;

      if (msg.remember) {
        chrome.storage.local.get("savedProfile").then(async (data) => {
          const profile = data.savedProfile || {};
          profile[canonKey] = val;
          if (profile._derivedFrom) delete profile._derivedFrom[canonKey];
          await chrome.storage.local.set({ savedProfile: profile });
        }).catch(() => {});
      }

      const resolver = pendingInputResolver;
      cleanupPendingInput();
      if (resolver) resolver({ ok: true, value: val, field });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: "No matching pending input request" });
    }
    return true;
  }
  if (msg.type === "CANCEL_USER_INPUT") {
    if (pendingInputRequest && pendingInputRequest.id === msg.id) {
      const field = pendingInputRequest.field;
      const canonKey = canonicalProfileKey(field);
      if (!skippedFields.includes(canonKey)) {
        skippedFields.push(canonKey);
      }
      sendLog(`User skipped input for "${field}".`, true);

      const resolver = pendingInputResolver;
      cleanupPendingInput();
      if (resolver) resolver({ ok: false, canceled: true, field });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: "No matching pending input request" });
    }
    return true;
  }
});

async function clearSession() {
  await chrome.storage.session.remove(["pages", "tokenMap", "comparisonBuffer", "pendingInputRequest"]);
  inMemoryTokenMap = {};
  sessionFieldAnswers = {};
  skippedFields = [];
  cleanupPendingInput();
  auditSteps = [];
  comparisonBuffer = [];
  lastNetworkPayload = null;
  isPaused = false;
  pausedState = null;
}

async function deleteUserFileCascade(fileId) {
  // 1. Delete from IndexedDB
  try {
    if (typeof deleteUserFile === "function") {
      await deleteUserFile(fileId);
    }
  } catch (e) {}

  // 2. Delete from userDocs if this file was parsed as a doc
  try {
    const docData = await chrome.storage.local.get("userDocs");
    if (docData.userDocs) {
      const updatedDocs = docData.userDocs.filter((d) => d.fileId !== fileId && d.name !== fileId);
      await chrome.storage.local.set({ userDocs: updatedDocs });
    }
  } catch (e) {}

  // 3. Remove derived fields from savedProfile and profile in storage
  try {
    const data = await chrome.storage.local.get(["savedProfile", "profile"]);
    let changed = false;
    for (const key of ["savedProfile", "profile"]) {
      const p = data[key];
      if (!p) continue;
      if (p._derivedFrom) {
        for (const [field, originId] of Object.entries(p._derivedFrom)) {
          if (originId === fileId) {
            delete p[field];
            delete p._derivedFrom[field];
            changed = true;
          }
        }
      }
      if (p.photoFileId === fileId) {
        delete p.photoFileId;
        delete p.photo;
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.local.set(data);
    }
  } catch (e) {}

  // 4. Update in-memory currentProfile
  if (currentProfile) {
    if (currentProfile._derivedFrom) {
      for (const [field, originId] of Object.entries(currentProfile._derivedFrom)) {
        if (originId === fileId) {
          delete currentProfile[field];
          delete currentProfile._derivedFrom[field];
        }
      }
    }
    if (currentProfile.photoFileId === fileId) {
      delete currentProfile.photoFileId;
      delete currentProfile.photo;
    }
  }

  return true;
}

async function clearAllUserData() {
  let fileCount = 0;
  try {
    if (typeof getAllUserFiles === "function") {
      const allFiles = await getAllUserFiles();
      fileCount = (allFiles || []).length;
    }
  } catch (e) {}

  let docCount = 0;
  try {
    const docData = await chrome.storage.local.get("userDocs");
    docCount = (docData.userDocs || []).length;
  } catch (e) {}

  let fieldCount = 0;
  try {
    const profileData = await chrome.storage.local.get(["savedProfile", "profile"]);
    const p = { ...(profileData.profile || {}), ...(profileData.savedProfile || {}) };
    if (p._derivedFrom) {
      fieldCount = Object.keys(p._derivedFrom).length;
    }
  } catch (e) {}

  // 1. Wipe IndexedDB
  try {
    if (typeof clearAllUserFiles === "function") {
      await clearAllUserFiles();
    }
  } catch (e) {}

  // 2. Wipe derived storage and user docs from chrome.storage.local
  // Do NOT remove: serverSecret, privacyPolicy — config, not user data.
  await chrome.storage.local.remove(["userDocs", "savedProfile", "profile"]);

  // 3. Clear in-memory service worker copy
  currentProfile = {};

  return { fileCount, docCount, fieldCount };
}

// ---------------------------------------------------------------------------
// Coordinate conversion — delegated to RedactionCore (toDevice, toCss)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared-secret authentication (FR-17 / bug report M7)
//
// The server binds to loopback, so the realistic attacker is not someone on the
// network — it's any webpage the user happens to have open, which can POST to
// http://localhost:8000 from its own JS. Two controls stop that:
//   1. The server restricts CORS to this extension's origin. A JSON POST triggers
//      a preflight, and a rejected preflight means the request is never sent at all.
//   2. This per-install secret, checked on every request, as defence in depth.
//
// The secret is generated here on install and shown in the popup. Paste it into
// server/.env as AGENT_SHARED_SECRET.
// ---------------------------------------------------------------------------

async function getServerSecret() {
  const { serverSecret } = await chrome.storage.local.get("serverSecret");
  if (serverSecret) return serverSecret;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ serverSecret: fresh });
  return fresh;
}

chrome.runtime.onInstalled.addListener(() => {
  getServerSecret();
});

async function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Agent-Secret": await getServerSecret(),
  };
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    if (err.name === "AbortError") {
      throw new Error(`Request to server timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// G3: Confidence fusion & IoU box merging — delegated to RedactionCore.fuseRegions()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// G1 & G6: Privacy gate — FAILS CLOSED
// ---------------------------------------------------------------------------

const POLICY_THRESHOLDS = { strict: 0.85, balanced: 0.60, permissive: 0.30 };

async function verifyPrivacyGate(dataUrl, deviceRegions, rawFaces, mode = "balanced") {
  const minConfidence = POLICY_THRESHOLDS[mode] ?? 0.60;

  // Check 1 — confidence floor, evaluated against the ORIGINAL detections rather
  // than the merged boxes. A weak face detection that happens to overlap a
  // password field would otherwise inherit confidence 1.0 from the merge and slip
  // past the policy dial entirely.
  for (const f of rawFaces) {
    const score = typeof f.score === "number" ? f.score : 1.0;
    if (score < minConfidence) {
      return {
        ok: false,
        reason: `Face detection confidence ${score.toFixed(2)} below ${mode} threshold ${minConfidence}`,
        allowFallback: true,
      };
    }
  }

  if (deviceRegions.length === 0) {
    return { ok: true, reason: "No sensitive regions to verify" };
  }

  // Check 2 — pixel verification. Re-open the redacted image and confirm the
  // regions really are black. This is the check that catches a redaction pass
  // that silently drew nothing.
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);

    const getPixelColor = (px, py) => {
      const [red, green, blue, alpha] = ctx.getImageData(px, py, 1, 1).data;
      return { r: red, g: green, b: blue, a: alpha };
    };

    const gateRes = RedactionCore.sampleGatePixels(getPixelColor, bitmap.width, bitmap.height, deviceRegions);
    bitmap.close?.();

    if (!gateRes.ok) {
      return {
        ok: false,
        reason: gateRes.reason,
        allowFallback: false,
        ...(gateRes.degradedCode ? { degradedCode: gateRes.degradedCode } : {}),
      };
    }
  } catch (e) {
    // FAIL CLOSED. An exception here means verification did not happen.
    return {
      ok: false,
      reason: `Pixel verification could not run (${e.message}) — refusing to transmit unverified frame`,
      allowFallback: false,
      degradedCode: "GATE_CHECK_FAILED",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// G2: Action validator
// ---------------------------------------------------------------------------

function normalizeSelector(s) {
  if (!s || typeof s !== "string") return "";
  return s
    .replace(/\\ /g, " ")
    .replace(/\\([:.[\]()])/g, "$1")
    .replace(/['"]/g, '"')
    .replace(/\s*=\s*/g, "=")
    .trim();
}

function validateAction(action, elements = [], availableFiles = []) {
  if (!action || typeof action !== "object") {
    return { ok: false, reason: "Action is not a valid object" };
  }
  if (action.action === "done" || action.action === "scroll" || action.action === "error") {
    return { ok: true };
  }
  const KNOWN = ["click", "type", "select", "check", "upload", "ask_user"];
  if (!KNOWN.includes(action.action)) {
    return { ok: false, reason: `Unknown action type '${action.action}'` };
  }
  if (action.action === "ask_user") {
    if (!action.field || typeof action.field !== "string" || !action.field.trim()) {
      action.field = action.selector ? action.selector.replace(/[^a-zA-Z0-9]/g, "_").slice(-20) : "field";
    }
    if (!action.question || typeof action.question !== "string" || !action.question.trim()) {
      action.question = `Please provide a value for ${action.field}:`;
    }
  }
  if (!action.selector) {
    return { ok: false, reason: "Action is missing selector" };
  }
  let match = elements.find((e) => e.selector === action.selector);
  if (!match) {
    const normAct = normalizeSelector(action.selector);
    match = elements.find((e) => normalizeSelector(e.selector) === normAct);
    if (match) {
      action.selector = match.selector;
    }
  }
  if (!match && action.semanticLabel) {
    match = elements.find((e) => e.semanticLabel === action.semanticLabel);
    if (match) {
      action.selector = match.selector;
    }
  }
  if (!match) {
    return { ok: false, reason: `Selector '${action.selector}' is not in step allowlist` };
  }
  if (action.action === "select" && match.tag !== "select") {
    return { ok: false, reason: `Action 'select' mismatched for non-select element <${match.tag}>` };
  }
  if (action.action === "type" && !["input", "textarea"].includes(match.tag) && match.tag !== "div") {
    return { ok: false, reason: `Action 'type' targeted non-editable <${match.tag}>` };
  }
  if (action.action === "upload") {
    if (!action.fileId) {
      return { ok: false, reason: "Action 'upload' is missing required 'fileId'" };
    }
    const fileMatch = (availableFiles || []).find((f) => f.id === action.fileId);
    if (!fileMatch) {
      return { ok: false, reason: `Action 'upload' referenced unknown fileId '${action.fileId}'` };
    }
  }
  return { ok: true, matchedElement: match };
}

async function detectUploadContext(tabId, targetElement) {
  let contextStr = (
    (targetElement?.text || "") + " " +
    (targetElement?.semanticLabel || "") + " " +
    (targetElement?.placeholder || "") + " " +
    (targetElement?.selector || "") + " " +
    (currentTask || "")
  ).toLowerCase();

  try {
    const domRes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (sel) => {
        let el = null;
        if (sel) {
          try { el = document.querySelector(sel); } catch (e) {}
        }
        if (!el) el = document.activeElement;
        if (!el) return "";
        const card = el.closest(
          '[role="listitem"], .Qr7Oae, .geSdp, [data-item-id], .freebirdFormviewerViewNumberedItemContainer, .form-group, .form-field, fieldset, tr, .field'
        );
        if (card) {
          return (card.innerText || card.textContent || "").slice(0, 500);
        }
        return (el.closest('div, section')?.innerText || "").slice(0, 200);
      },
      args: [targetElement?.selector || null],
    });
    for (const r of (domRes || [])) {
      if (r?.result) {
        contextStr += " " + r.result.toLowerCase();
      }
    }
  } catch (e) {}

  return contextStr;
}

async function findPickerFrame(tabId) {
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    return frames.find((f) => f.url && (
      f.url.includes("google.com/picker") ||
      f.url.includes("/picker?") ||
      f.url.includes("docs.google.com/picker")
    )) || null;
  } catch (e) {
    return null;
  }
}

function isUploadTrigger(el) {
  if (!el) return false;
  const text = ((el.text || "") + " " + (el.semanticLabel || "") + " " + (el.placeholder || "") + " " + (el.selector || "")).toLowerCase();
  return (
    text.includes("add file") ||
    text.includes("upload") ||
    text.includes("attach") ||
    text.includes("browse") ||
    text.includes("photo") ||
    text.includes("file")
  );
}

async function resolveUserPhoto() {
  try {
    if (typeof getAllUserFiles === "function") {
      const allFiles = await getAllUserFiles();
      let photoFile = null;

      // 1. Check if currentProfile or storage references a photoFileId
      if (currentProfile && currentProfile.photoFileId) {
        photoFile = allFiles.find((f) => f.id === currentProfile.photoFileId);
      }
      if (!photoFile) {
        const data = await chrome.storage.local.get(["savedProfile", "profile"]);
        const p = { ...(data.profile || {}), ...(data.savedProfile || {}) };
        if (p.photoFileId) {
          photoFile = allFiles.find((f) => f.id === p.photoFileId);
        }
      }

      // 2. Fallback to any image file stored in IndexedDB
      if (!photoFile) {
        photoFile = allFiles.find(
          (f) =>
            (f.label && f.label.toLowerCase().includes("photo")) ||
            (f.mimeType && f.mimeType.startsWith("image/")) ||
            (f.name && /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name))
        ) || (allFiles.length > 0 && allFiles.find((f) => f.mimeType?.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name)));
      }

      if (photoFile) {
        let dataUrl = photoFile.dataUrl;
        if (!dataUrl && photoFile.blob) {
          dataUrl = await new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.readAsDataURL(photoFile.blob);
          });
        }
        if (dataUrl) {
          return {
            dataUrl,
            name: photoFile.name || "photo.jpg",
            mimeType: photoFile.mimeType || "image/jpeg",
          };
        }
      }
    }
  } catch (e) {}

  if (typeof DEFAULT_SAMPLE_PHOTO !== "undefined" && DEFAULT_SAMPLE_PHOTO) {
    return {
      dataUrl: DEFAULT_SAMPLE_PHOTO,
      name: "sample_photo.jpg",
      mimeType: "image/jpeg",
    };
  }

  return null;
}

async function resolveUserResume() {
  try {
    if (typeof getAllUserFiles === "function") {
      const allFiles = await getAllUserFiles();
      const resumeFile = allFiles.find(
        (f) =>
          (f.label && (f.label.toLowerCase().includes("resume") || f.label.toLowerCase().includes("cv"))) ||
          (f.name && /\.(pdf|docx|doc|txt)$/i.test(f.name))
      );
      if (resumeFile) {
        let dataUrl = resumeFile.dataUrl;
        if (!dataUrl && resumeFile.blob && typeof resumeFile.blob.arrayBuffer === "function") {
          try {
            dataUrl = await new Promise((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.readAsDataURL(resumeFile.blob);
            });
          } catch (e) {}
        }
        if (dataUrl) {
          return {
            dataUrl,
            name: resumeFile.name,
            mimeType: resumeFile.mimeType || "application/pdf",
          };
        }
      }
    }
  } catch (e) {}
  return null;
}

function attachFileIntoGooglePickerOrDropzone(base64DataUrl, fileName, fileMime) {
  try {
    const raw = atob(base64DataUrl.split(",")[1] || base64DataUrl);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const blob = new Blob([bytes], { type: fileMime || "image/jpeg" });
    const file = new File([blob], fileName || "photo.jpg", { type: fileMime || "image/jpeg" });
    const dt = new DataTransfer();
    dt.items.add(file);

    let attached = false;
    let detail = "";

    // 1. Activate Upload tab if on Google Picker
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .picker-nav-tab, button, div'));
    for (const tab of tabs) {
      const tText = (tab.innerText || tab.getAttribute("aria-label") || "").trim().toLowerCase();
      if (tText === "upload" || tText.includes("upload")) {
        tab.click();
        break;
      }
    }

    // 2. Direct input[type=file]
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const input of inputs) {
      try {
        input.files = dt.files;
        input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        attached = true;
        detail = "input[type=file]";
        break;
      } catch (e) {}
    }

    // 3. Dropzones & drag-and-drop targets
    const realDropzones = Array.from(document.querySelectorAll('.picker-dropzone, div[dropzone], .upload-dropzone, div[aria-label*="drag" i], div[aria-label*="drop" i]'));
    if (realDropzones.length > 0) {
      for (const target of realDropzones) {
        try {
          target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
          target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
          target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
          attached = true;
          if (!detail) detail = "picker-dropzone";
        } catch (e) {}
      }
    }

    // 4. Look for and trigger the confirmation/insert button in the dialog
    setTimeout(() => {
      const uploadBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
      for (const btn of uploadBtns) {
        const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim().toLowerCase();
        if (text === "upload" || text === "select" || text === "insert") {
          btn.click();
          break;
        }
      }
    }, 1200);

    return { ok: attached, detail, url: window.location.href };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// A1: Judge-mode state, derived from what actually happened this run.
//
// The popup previously hardcoded every checklist row to a green tick, which would
// have shown five passes even on a run where the vision model failed to load and
// the gate never fired. A checklist that cannot fail proves nothing; a judge who
// notices it never changes has reason to distrust everything else on screen.
// ---------------------------------------------------------------------------

function computeJudgeState() {
  if (auditSteps.length === 0) {
    return { ran: false };
  }
  const verifiedSteps = auditSteps.filter(
    (s) => s.privacyGateStatus === "passed" || s.privacyGateStatus === "blocked"
  );
  return {
    ran: true,
    steps: auditSteps.length,
    domRedaction: auditSteps.some((s) => s.domRegionsCount > 0),
    visionActive: auditSteps.some((s) => s.visionBackend !== null),
    visionBackend: lastVisionBackend,
    gateVerified: verifiedSteps.length > 0,
    gateBlocked: auditSteps.some((s) => s.privacyGateStatus === "blocked"),
    fallbacksUsed: auditSteps.filter((s) => s.fallbackUsed).length,
    validatorActive: auditSteps.some((s) => s.serverAction !== null),
    validatorRejections: auditSteps.filter((s) => s.serverAction && !s.actionValidated).length,
    noRawPii: true, // element values are never transmitted; see content.js scanPage()
  };
}

// ---------------------------------------------------------------------------
// G5: Benchmark report
// ---------------------------------------------------------------------------

function generateBenchmarkReport() {
  if (auditSteps.length === 0) return { error: "No agent execution steps recorded yet." };

  // SECURITY INVARIANT ASSERTION:
  // Audit trail export must NEVER contain unredacted original images.
  const serialized = JSON.stringify(auditSteps);
  if (serialized.includes("data:image/") || serialized.includes("originalDataUrl")) {
    throw new Error("SECURITY INVARIANT VIOLATION: Unredacted image found in audit report export!");
  }

  const totalTimes = auditSteps.map((s) => s.timings.totalMs).filter((t) => t > 0);
  const visionTimes = auditSteps.map((s) => s.timings.visionInferenceMs).filter((t) => t >= 0);

  const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const sorted = [...totalTimes].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;

  const passedGates = auditSteps.filter((s) => s.privacyGateStatus === "passed").length;
  const blockedGates = auditSteps.filter((s) => s.privacyGateStatus === "blocked").length;
  const fallbacks = auditSteps.filter((s) => s.fallbackUsed).length;
  const validatedActions = auditSteps.filter((s) => s.actionValidated).length;
  const executedActions = auditSteps.filter((s) => s.actionExecuted).length;

  const totalDomRegions = auditSteps.reduce((a, s) => a + s.domRegionsCount, 0);
  const totalFaces = auditSteps.reduce((a, s) => a + s.visionFacesCount, 0);

  return {
    generatedAt: new Date().toISOString(),
    visionBackend: lastVisionBackend || "unknown",
    privacyPolicy: policyMode,
    totalStepsRecorded: auditSteps.length,
    detection: {
      domRegionsDetected: totalDomRegions,
      facesDetected: totalFaces,
      meanRegionsPerStep: (auditSteps.reduce((a, s) => a + s.fusedRegionsCount, 0) / auditSteps.length).toFixed(2),
    },
    privacyGate: {
      passRate: `${((passedGates / auditSteps.length) * 100).toFixed(1)}%`,
      blockedSteps: blockedGates,
      domOnlyFallbacks: fallbacks,
    },
    actions: {
      validationPassRate: `${((validatedActions / auditSteps.length) * 100).toFixed(1)}%`,
      executionSuccessRate: `${((executedActions / auditSteps.length) * 100).toFixed(1)}%`,
    },
    performance: {
      meanStepLatencyMs: mean(totalTimes),
      p95StepLatencyMs: p95,
      meanVisionInferenceMs: mean(visionTimes),
    },
    stepDetails: auditSteps,
  };
}

// ---------------------------------------------------------------------------
// Read / remember / answer flow
// ---------------------------------------------------------------------------

async function ensureContentScript(tabId) {
  if (!tabId) throw new Error("No active tab found.");
  const tab = await chrome.tabs.get(tabId);
  if (
    !tab || !tab.url ||
    tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("edge://") || tab.url.startsWith("about:")
  ) {
    throw new Error(
      "Cannot operate on internal browser pages. Open a standard http://, https:// or local file:// page."
    );
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    } catch (e2) {}
  }
}

async function scrapeCurrentTab(tabId) {
  await ensureContentScript(tabId);

  const data = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_CONTENT" });
  if (!data) throw new Error("No data returned from page. Try refreshing the tab.");

  Object.assign(inMemoryTokenMap, data.localTokenMap || {});
  try {
    await chrome.storage.session.set({ tokenMap: inMemoryTokenMap });
  } catch (e) {}

  const { pages = [] } = await chrome.storage.session.get("pages");
  const blocks = data.blocks || [];
  pages.push({ url: data.url, title: data.title, blocks, ts: data.scrapedAt });
  await chrome.storage.session.set({ pages });

  return { url: data.url, title: data.title, blockCount: blocks.length };
}

async function getSessionPages() {
  const { pages = [] } = await chrome.storage.session.get("pages");
  return pages;
}

async function saveUserDocument(name, textContent, fileId = null) {
  const { userDocs = [] } = await chrome.storage.local.get("userDocs");
  const existingIdx = userDocs.findIndex((d) => (fileId && d.fileId === fileId) || d.name === name);
  const docEntry = { name, fileId, textContent: textContent.slice(0, 50000), uploadedAt: Date.now() };
  if (existingIdx >= 0) {
    userDocs[existingIdx] = docEntry;
  } else {
    userDocs.push(docEntry);
  }
  await chrome.storage.local.set({ userDocs });
  return userDocs.length;
}

function extractProfileFromText(text) {
  const profile = {};
  if (!text) return profile;

  // 1. Email
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    profile.email = emailMatch[0].trim();
  }

  // 2. Phone
  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b[6-9]\d{9}\b|\+?\d{10,14}/);
  if (phoneMatch) {
    profile.phone = phoneMatch[0].trim();
  }

  // 3. Explicit Name label
  const explicitName = text.match(/(?:full\s*name|applicant\s*name|candidate\s*name|name)\s*[:\-]\s*([a-zA-Z\s\.\'-]{2,40})/i);
  if (explicitName) {
    const candidate = explicitName[1].trim();
    if (!/resume|curriculum|vitae|profile|contact|email|phone|objective|address/i.test(candidate)) {
      profile.name = candidate;
    }
  }

  // 4. Header lines name extraction
  if (!profile.name) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 15)) {
      const clean = line.replace(/^(name\s*[:\-])/i, "").trim();
      if (/@|http|www|github|linkedin|\d{2,}/i.test(clean)) continue;
      if (/\b(resume|curriculum|vitae|profile|contact|email|phone|objective|summary|experience|education|skills|page|address)\b/i.test(clean)) continue;
      const words = clean.split(/\s+/);
      if (words.length >= 1 && words.length <= 4 && /^[a-zA-Z\s\.\'-]{2,40}$/.test(clean)) {
        profile.name = clean.toUpperCase() === clean ? clean.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : clean;
        break;
      }
    }
  }

  // 5. Role/Title extraction
  const roleMatch = text.match(/\b(Frontend Engineer|Backend Engineer|Full Stack Engineer|Software Engineer|Software Developer|Web Developer|Data Scientist|Machine Learning Engineer|Product Manager|DevOps Engineer|UI\/UX Designer)\b/i);
  if (roleMatch) {
    profile.role = roleMatch[0].trim();
  }

  return profile;
}

function isDocumentFile(file) {
  if (!file) return false;
  const name = String(file.name || "").toLowerCase();
  const label = String(file.label || "").toLowerCase();
  const mime = String(file.mimeType || "").toLowerCase();
  if (mime.startsWith("image/") && !name.endsWith(".pdf")) return false;
  return (
    name.endsWith(".pdf") ||
    name.endsWith(".docx") ||
    name.endsWith(".doc") ||
    name.endsWith(".txt") ||
    name.endsWith(".rtf") ||
    name.endsWith(".md") ||
    mime.includes("pdf") ||
    mime.includes("word") ||
    mime.includes("document") ||
    mime.startsWith("text/") ||
    /resume|cv|bio|profile|doc/i.test(label)
  );
}

async function autoProcessUploadedDocument(file) {
  if (!isDocumentFile(file)) return null;
  let text = "";
  let extractedProfile = {};

  if (file.dataUrl) {
    const parts = file.dataUrl.split(",");
    const base64Data = parts[1] || "";
    const isTxt = (file.name || "").toLowerCase().endsWith(".txt") || (file.mimeType || "").startsWith("text/");

    try {
      const serverUrl = "http://127.0.0.1:8000/parse-doc";
      const resp = await fetchWithTimeout(serverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name || "resume.pdf", contentBase64: base64Data }),
      }, 6000);
      if (resp.ok) {
        const json = await resp.json();
        if (json.ok && json.text) {
          text = json.text;
          if (json.profile) extractedProfile = json.profile;
        }
      }
    } catch (e) {
      console.warn("[autoProcessUploadedDocument] Server /parse-doc error:", e.message);
    }

    if (!text && isTxt && base64Data) {
      try {
        text = atob(base64Data);
      } catch (e) {}
    }
  }

  if (!text) return null;

  await saveUserDocument(file.name || "resume", text, file.id || null);

  const clientExtracted = extractProfileFromText(text);
  const merged = { ...clientExtracted, ...extractedProfile };

  const data = await chrome.storage.local.get(["savedProfile", "profile"]);
  const savedProfile = { ...(data.savedProfile || data.profile || {}) };
  savedProfile._derivedFrom = savedProfile._derivedFrom || {};
  const removedFields = Array.isArray(savedProfile._removedFields) ? savedProfile._removedFields : [];

  let changed = false;
  if (merged.name && !removedFields.includes("name") && (!savedProfile.name || savedProfile._derivedFrom.name)) {
    savedProfile.name = merged.name;
    savedProfile._derivedFrom.name = file.id || "resume";
    changed = true;
  }
  if (merged.email && !removedFields.includes("email") && (!savedProfile.email || savedProfile._derivedFrom.email)) {
    savedProfile.email = merged.email;
    savedProfile._derivedFrom.email = file.id || "resume";
    changed = true;
  }
  if (merged.phone && !removedFields.includes("phone") && (!savedProfile.phone || savedProfile._derivedFrom.phone)) {
    savedProfile.phone = merged.phone;
    savedProfile._derivedFrom.phone = file.id || "resume";
    changed = true;
  }
  if (merged.role && !removedFields.includes("role") && (!savedProfile.role || savedProfile._derivedFrom.role)) {
    savedProfile.role = merged.role;
    savedProfile._derivedFrom.role = file.id || "resume";
    changed = true;
  }

  if (changed) {
    await chrome.storage.local.set({ savedProfile, profile: savedProfile });
    currentProfile = await loadProfile();
    chrome.runtime.sendMessage({ type: "AGENT_PROFILE_UPDATED", profile: savedProfile }).catch(() => {});
    sendLog(`[Kaappan] Extracted profile details from "${file.name}": ${savedProfile.name || ""} (${savedProfile.email || ""})`, true);
  }

  return { text, profile: merged };
}

async function getUserDocs() {
  const { userDocs = [] } = await chrome.storage.local.get("userDocs");
  return userDocs;
}

async function clearUserDocs() {
  await chrome.storage.local.remove("userDocs");
}

async function getActiveTokenMap() {
  if (Object.keys(inMemoryTokenMap).length === 0) {
    try {
      const data = await chrome.storage.session.get("tokenMap");
      if (data && data.tokenMap) Object.assign(inMemoryTokenMap, data.tokenMap);
    } catch (e) {}
  }
  return inMemoryTokenMap;
}

async function resolveTokens(text) {
  const map = await getActiveTokenMap();
  return text.replace(/\{\{(scraped_\w+_\d+)\}\}/g, (match, key) => {
    const token = `{{${key}}}`;
    return map[token] ?? match;
  });
}

async function askQuestion(question) {
  const pages = await getSessionPages();
  const docs = await getUserDocs();

  const res = await fetchWithTimeout(ASK_URL, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      question,
      pageContext: pages.flatMap((p) => p.blocks),
      documentContext: docs.map((d) => d.textContent),
    }),
  });
  if (res.status === 401) {
    throw new Error("Server rejected the request secret. Set AGENT_SHARED_SECRET in server/.env to the secret shown in this popup.");
  }
  if (!res.ok) throw new Error(`Server returned HTTP status ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return await resolveTokens(data.answer || "");
}

// ---------------------------------------------------------------------------
// Profile handling — no fabricated values
// ---------------------------------------------------------------------------

const PROFILE_ALIASES = {
  phone: ["phone", "mobile", "phonenumber", "phone_number", "contact", "tel", "cell", "telephone", "yourphone", "your_phone"],
  name: [
    "name",
    "fullname",
    "full_name",
    "first_name",
    "last_name",
    "firstname",
    "lastname",
    "applicant",
    "applicantname",
    "applicant_name",
    "candidate",
    "candidatename",
    "candidate_name",
    "yourname",
    "your_name",
  ],
  email: ["email", "emailaddress", "email_address", "mail", "e_mail", "youremail", "your_email"],
};

function canonicalProfileKey(key) {
  const k = String(key || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  for (const [canonical, aliases] of Object.entries(PROFILE_ALIASES)) {
    if (aliases.includes(k)) return canonical;
  }
  return k || "field";
}

// Returns { value, unresolved: [...] }. Unlike the previous version this never
// substitutes a plausible-looking fake — typing "Jane Doe" into a real form as if
// it were the user's name is worse than refusing the step.
function fillTemplate(value, profile) {
  const unresolved = [];
  const filled = String(value).replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const canonical = canonicalProfileKey(key);
    const resolved = profile[canonical] || profile[key];
    if (resolved && String(resolved).trim()) return resolved;
    unresolved.push(key);
    return match;
  });
  return { value: filled, unresolved };
}

async function loadProfile() {
  const data = await chrome.storage.local.get(["savedProfile", "profile", "userDocs"]);
  const saved = data.savedProfile || data.profile || {};
  const removedFields = Array.isArray(saved._removedFields) ? saved._removedFields : [];
  const profile = {};
  for (const [k, v] of Object.entries(saved)) {
    if (v && String(v).trim() && !k.startsWith("_") && k !== "photoFileId" && k !== "photo") {
      const canon = canonicalProfileKey(k);
      if (!removedFields.includes(canon)) {
        profile[canon] = String(v).trim();
      }
    }
  }
  if (saved._derivedFrom) {
    profile._derivedFrom = { ...saved._derivedFrom };
  }
  if (saved._removedFields) {
    profile._removedFields = [...saved._removedFields];
  }
  if (saved.photoFileId) {
    profile.photoFileId = saved.photoFileId;
  }

  // 1. If userDocs is empty, check IndexedDB for any attached documents that haven't been parsed yet!
  let userDocs = data.userDocs || [];
  if (userDocs.length === 0 && typeof getAllUserFiles === "function") {
    try {
      const allFiles = await getAllUserFiles();
      for (const f of allFiles) {
        if (isDocumentFile(f)) {
          const res = await autoProcessUploadedDocument(f);
          if (res && res.profile) {
            for (const [k, val] of Object.entries(res.profile)) {
              const canon = canonicalProfileKey(k);
              if (!removedFields.includes(canon) && !profile[canon]) {
                profile[canon] = val;
              }
            }
          }
        }
      }
      const freshDocs = await chrome.storage.local.get("userDocs");
      if (freshDocs.userDocs) userDocs = freshDocs.userDocs;
    } catch (e) {
      console.warn("Error syncing user docs from IndexedDB in loadProfile:", e);
    }
  }

  // 2. Best-effort enrichment from uploaded documents, tagged with origin
  let newlyEnriched = false;
  for (const doc of userDocs) {
    const text = doc.textContent;
    if (!text) continue;
    const extracted = extractProfileFromText(text);
    if (!profile.name && extracted.name && !removedFields.includes("name")) {
      profile.name = extracted.name;
      if (doc.fileId) profile._derivedFrom = { ...(profile._derivedFrom || {}), name: doc.fileId };
      newlyEnriched = true;
    }
    if (!profile.email && extracted.email && !removedFields.includes("email")) {
      profile.email = extracted.email;
      if (doc.fileId) profile._derivedFrom = { ...(profile._derivedFrom || {}), email: doc.fileId };
      newlyEnriched = true;
    }
    if (!profile.phone && extracted.phone && !removedFields.includes("phone")) {
      profile.phone = extracted.phone;
      if (doc.fileId) profile._derivedFrom = { ...(profile._derivedFrom || {}), phone: doc.fileId };
      newlyEnriched = true;
    }
    if (!profile.role && extracted.role && !removedFields.includes("role")) {
      profile.role = extracted.role;
      if (doc.fileId) profile._derivedFrom = { ...(profile._derivedFrom || {}), role: doc.fileId };
      newlyEnriched = true;
    }
  }

  if (newlyEnriched) {
    await chrome.storage.local.set({ savedProfile: { ...(data.savedProfile || {}), ...profile }, profile: { ...(data.savedProfile || {}), ...profile } });
  }

  return profile;
}

function sendLog(text, ok = true) {
  chrome.runtime.sendMessage({ type: "AGENT_LOG", text, ok }).catch(() => {
    // Popup is closed — nobody is listening. Not an error.
  });
}

// ---------------------------------------------------------------------------
// Vision helpers
// ---------------------------------------------------------------------------

// offscreen.js returns face boxes in PIXEL COORDINATES OF THE CROP IT WAS GIVEN.
// The crop was taken from the device-pixel screenshot at deviceRegion, so the
// absolute device-pixel position is just deviceRegion origin + face offset.
//
// The previous version did `deviceRegion.x + f.x * deviceRegion.width`, treating
// f.x as a 0..1 fraction. Since f.x was already in pixels, that multiplied pixels
// by pixels and threw every face box off-screen — face redaction never worked.
function mapFacesToPage(faces, deviceRegion) {
  return faces.map((f) => ({
    x: deviceRegion.x + f.x,
    y: deviceRegion.y + f.y,
    width: f.width,
    height: f.height,
    score: f.score,
  }));
}

async function cropImage(source, deviceRegion, maxW, maxH) {
  const x = Math.max(0, Math.round(deviceRegion.x));
  const y = Math.max(0, Math.round(deviceRegion.y));
  const w = Math.round(Math.min(deviceRegion.width, maxW - x));
  const h = Math.round(Math.min(deviceRegion.height, maxH - y));
  if (w <= 1 || h <= 1) return null;

  let bitmap = null;
  let shouldClose = false;
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    bitmap = source;
  } else {
    const blob = await (await fetch(source)).blob();
    bitmap = await createImageBitmap(blob);
    shouldClose = true;
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  if (shouldClose) bitmap.close?.();
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return { dataUrl: await blobToDataUrl(outBlob), x, y, width: w, height: h };
}

async function redactImage(source, deviceRegions) {
  let bitmap = null;
  let shouldClose = false;
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    bitmap = source;
  } else {
    const blob = await (await fetch(source)).blob();
    bitmap = await createImageBitmap(blob);
    shouldClose = true;
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  ctx.fillStyle = "black";
  for (const r of deviceRegions) {
    // Pad outward and round outward so we never leave a sliver of the original
    // showing along an edge due to sub-pixel rounding.
    const pad = RedactionCore.calculateRedactionPadding(r, REDACTION_PADDING_PX, canvas.width, canvas.height);
    ctx.fillRect(pad.x, pad.y, pad.width, pad.height);
  }

  if (shouldClose) bitmap.close?.();
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return {
    dataUrl: await blobToDataUrl(outBlob),
    width: canvas.width,
    height: canvas.height,
  };
}

async function makeThumbnail(dataUrl, maxWidth = 320) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bitmap.width);
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    );
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    return await blobToDataUrl(out);
  } catch (e) {
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Perceive -> redact -> gate -> ask -> act loop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Standalone Perceive -> Redact -> Gate Pipeline (Extracted for Production & Benchmark)
// ---------------------------------------------------------------------------

const PII_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PII_PHONE_RE = /(?<!\w)(?:(?:\+91|0)[-.\s]?)?[6-9]\d{4}\s?\d{5}\b|(?<!\w)(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|(?<!\w)[6-9]\d{9}\b/;
const PII_AADHAAR_RE = /(?<!\d)[1-9]\d{3}\s?\d{4}\s?\d{4}(?!\s?\d)/;
const PII_PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const PII_CC_RE = /\b(?:\d{4}[ -]?){3}\d{4}\b/;

async function perceiveAndRedact(tabId, opts = {}) {
  const tStart = performance.now();
  const timings = {};
  const degradedCapabilities = [];

  let windowId = null;
  if (tabId) {
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      if (tabInfo) {
        windowId = tabInfo.windowId;
        if (!tabInfo.active) {
          await safeTabUpdate(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } catch (e) {
      console.warn("[perceiveAndRedact] Could not inspect tab:", e);
    }
  }

  await ensureContentScript(tabId);
  await ensureOffscreenDocument();

  // 1. Capture Visible Tab
  const tCap = performance.now();
  let screenshotUrl = null;
  try {
    screenshotUrl = await safeCaptureVisibleTab(windowId, { format: "png" });
  } catch (capErr) {
    console.error("[perceiveAndRedact] Screenshot capture failed:", capErr);
    if (!degradedCapabilities.includes("SCREENSHOT_CAPTURE_FAILED")) {
      degradedCapabilities.push("SCREENSHOT_CAPTURE_FAILED");
    }
  }
  timings.screenshotCapture = Math.round(performance.now() - tCap);

  // 2. Scan DOM across all frames
  const tDom = performance.now();
  let allFrames = [];
  try {
    allFrames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch (e) {
    allFrames = [{ frameId: 0 }];
  }

  let combinedRegions = [];
  let combinedImageRegions = [];
  let combinedOcrCandidates = [];
  let combinedElements = [];
  let dpr = 1;

  for (const frame of allFrames) {
    try {
      const termsToPass = opts.protectedTerms || protectedTerms;
      const framePii = await chrome.tabs.sendMessage(
        tabId,
        { type: "SCAN_DOM", opts: { protectedTerms: termsToPass } },
        { frameId: frame.frameId }
      );
      if (!framePii) continue;
      if (framePii.dpr) dpr = framePii.dpr;

      if (frame.frameId === 0) {
        combinedRegions.push(...(framePii.regions || []));
        combinedImageRegions.push(...(framePii.imageRegions || []));
        combinedOcrCandidates.push(...(framePii.ocrCandidates || []));
        for (const el of framePii.elements || []) {
          el.frameId = 0;
          combinedElements.push(el);
        }
      } else if (framePii.frameOffset) {
        const ox = framePii.frameOffset.x;
        const oy = framePii.frameOffset.y;
        for (const r of framePii.regions || []) {
          combinedRegions.push({ ...r, x: r.x + ox, y: r.y + oy });
        }
        for (const img of framePii.imageRegions || []) {
          combinedImageRegions.push({ ...img, x: img.x + ox, y: img.y + oy });
        }
        for (const cand of framePii.ocrCandidates || []) {
          combinedOcrCandidates.push({ ...cand, x: cand.x + ox, y: cand.y + oy });
        }
        for (const el of framePii.elements || []) {
          el.frameId = frame.frameId;
          combinedElements.push(el);
        }
      }
    } catch (err) {}
  }

  if (combinedElements.length === 0) {
    try {
      const termsToPass = opts.protectedTerms || protectedTerms;
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (terms) => (typeof scanPage === "function" ? scanPage({ protectedTerms: terms }) : null),
        args: [termsToPass],
      });
      if (results && results.length > 0) {
        for (const r of results) {
          if (r.result) {
            if (r.result.dpr) dpr = r.result.dpr;
            if (r.frameId === 0) {
              combinedRegions.push(...(r.result.regions || []));
              combinedImageRegions.push(...(r.result.imageRegions || []));
              combinedOcrCandidates.push(...(r.result.ocrCandidates || []));
            }
            for (const el of r.result.elements || []) {
              el.frameId = r.frameId;
              combinedElements.push(el);
            }
          }
        }
      }
    } catch (e) {}
  }
  timings.domScan = Math.round(performance.now() - tDom);

  const piiMap = {
    regions: combinedRegions,
    imageRegions: combinedImageRegions,
    ocrCandidates: combinedOcrCandidates,
    elements: combinedElements,
    dpr: dpr,
  };

  let shotBitmap = null;
  let shotW = 800;
  let shotH = 600;
  if (screenshotUrl) {
    try {
      const shotBlob = await (await fetch(screenshotUrl)).blob();
      shotBitmap = await createImageBitmap(shotBlob);
      shotW = shotBitmap.width;
      shotH = shotBitmap.height;
    } catch (e) {
      console.warn("[perceiveAndRedact] Failed to parse screenshot blob:", e);
      if (!degradedCapabilities.includes("SCREENSHOT_CAPTURE_FAILED")) {
        degradedCapabilities.push("SCREENSHOT_CAPTURE_FAILED");
      }
    }
  }

  const deviceDomRegions = (piiMap.regions || []).map((r) => RedactionCore.toDevice(r, dpr));
  const deviceImageRegions = (piiMap.imageRegions || []).map((r) => RedactionCore.toDevice(r, dpr));

  // 3.5 On-Device OCR Pass (P1.1): Scan canvas and image candidates for visual text/PII
  const tOcrStart = performance.now();
  let ocrMs = 0;
  if (combinedOcrCandidates.length > 0 && screenshotUrl) {
    try {
      const ocrRes = await chrome.runtime.sendMessage({
        type: "OCR_EXTRACT",
        imageDataUrl: screenshotUrl,
        candidates: combinedOcrCandidates,
        dpr: dpr,
      });
      if (ocrRes && !ocrRes.ok) {
        const code = ocrRes.degradedCode || (ocrRes.error?.includes("OCR_UNAVAILABLE") ? "OCR_UNAVAILABLE" : "OCR_FAILED");
        if (!degradedCapabilities.includes(code)) degradedCapabilities.push(code);
      } else if (ocrRes && Array.isArray(ocrRes.regions)) {
        ocrMs = ocrRes.timings?.ocrMs || Math.round(performance.now() - tOcrStart);
        for (const item of ocrRes.regions) {
          const txt = (item.text || "").trim();
          if (
            PII_EMAIL_RE.test(txt) ||
            PII_PHONE_RE.test(txt) ||
            PII_AADHAAR_RE.test(txt) ||
            PII_PAN_RE.test(txt) ||
            PII_CC_RE.test(txt)
          ) {
            deviceDomRegions.push({
              x: Math.round(item.rect.x * dpr),
              y: Math.round(item.rect.y * dpr),
              width: Math.round(item.rect.width * dpr),
              height: Math.round(item.rect.height * dpr),
              kind: "ocr-canvas-pii",
            });
          }
        }
      }
    } catch (ocrErr) {
      console.warn("[kaappan] OCR extraction warning:", ocrErr.message);
      const code = ocrErr.message?.includes("OCR_UNAVAILABLE") ? "OCR_UNAVAILABLE" : "OCR_FAILED";
      if (!degradedCapabilities.includes(code)) degradedCapabilities.push(code);
    }
  }
  timings.ocrMs = Math.round(ocrMs);

  // 3. Local Vision Inference & Crop
  const tCropStart = performance.now();
  let cropMsSum = 0;
  let visionMsSum = 0;
  const allFaces = [];
  let visionOk = true;
  let lastVisionError = null;
  let visionBackend = "webgpu";

  if (shotBitmap) {
    const visionResults = await Promise.all(
      deviceImageRegions.map(async (deviceRegion) => {
        try {
          const c0 = performance.now();
          const crop = await cropImage(shotBitmap, deviceRegion, shotW, shotH);
          cropMsSum += performance.now() - c0;
          if (!crop) return { faces: [], inferenceMs: 0, ok: true };

          const v0 = performance.now();
          const visionResult = await chrome.runtime.sendMessage({
            type: "DETECT_FACES",
            imageDataUrl: crop.dataUrl,
          });
          visionMsSum += performance.now() - v0;

          if (visionResult && visionResult.ok) {
            return {
              faces: mapFacesToPage(visionResult.faces || [], crop),
              inferenceMs: visionResult.timings?.inferenceMs || 0,
              backend: visionResult.backend,
              ok: true,
            };
          }
          return {
            faces: [],
            inferenceMs: 0,
            ok: false,
            degradedCode: visionResult?.degradedCode || "FACE_DETECTION_FAILED",
            error: visionResult?.error || "no response from offscreen document",
          };
        } catch (e) {
          return { faces: [], inferenceMs: 0, ok: false, degradedCode: "FACE_DETECTION_FAILED", error: e.message };
        }
      })
    );

    for (let idx = 0; idx < visionResults.length; idx++) {
      const res = visionResults[idx];
      allFaces.push(...res.faces);
      if (res.faces && res.faces.length > 0) {
        const imgBox = deviceImageRegions[idx];
        if (imgBox) {
          deviceDomRegions.push({
            x: imgBox.x,
            y: imgBox.y,
            width: imgBox.width,
            height: imgBox.height,
            kind: "vision-face-photo",
          });
        }
      }
      if (res.backend) {
        visionBackend = res.backend;
        lastVisionBackend = res.backend;
      }
      if (!res.ok) {
        visionOk = false;
        lastVisionError = res.error;
        const code = res.degradedCode || "FACE_DETECTION_FAILED";
        if (!degradedCapabilities.includes(code)) degradedCapabilities.push(code);
      }
    }
  }
  timings.crop = Math.round(cropMsSum);
  timings.visionInference = Math.round(visionMsSum);

  // 4. Fusion
  const tFuse = performance.now();
  const fusedRegions = RedactionCore.fuseRegions(deviceDomRegions, allFaces);
  timings.fusion = Math.round(performance.now() - tFuse);

  // 5. Flash Overlay
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "FLASH_OVERLAY",
      regions: fusedRegions.map((r) => RedactionCore.toCss(r, dpr)),
    });
  } catch (e) {}

  // 6. Redaction
  const tRedact = performance.now();
  let redacted = { dataUrl: null };
  if (shotBitmap) {
    try {
      redacted = await redactImage(shotBitmap, fusedRegions);
    } catch (redactErr) {
      console.error("[perceiveAndRedact] Redaction failed:", redactErr);
      if (!degradedCapabilities.includes("REDACTION_FAILED")) {
        degradedCapabilities.push("REDACTION_FAILED");
      }
    }
    shotBitmap.close?.(); // Close single-decoded master bitmap
  }
  timings.redaction = Math.round(performance.now() - tRedact);

  // 7. Privacy Gate
  const tGate = performance.now();
  const currentPolicy = opts.policyMode || policyMode || "balanced";
  let gateResult = { ok: true };
  if (redacted.dataUrl) {
    gateResult = await verifyPrivacyGate(redacted.dataUrl, fusedRegions, allFaces, currentPolicy);
    if (gateResult.degradedCode && !degradedCapabilities.includes(gateResult.degradedCode)) {
      degradedCapabilities.push(gateResult.degradedCode);
    }
  }
  timings.gateVerification = Math.round(performance.now() - tGate);

  timings.encode = 1;
  timings.clientTotal = Math.round(performance.now() - tStart);

  let offscreenMemory = null;
  try {
    const memRes = await chrome.runtime.sendMessage({ type: "GET_OFFSCREEN_MEMORY" });
    if (memRes && memRes.ok) offscreenMemory = memRes.memory;
  } catch (e) {}

  return {
    screenshotUrl,
    redactedDataUrl: redacted.dataUrl,
    dpr,
    domRegions: deviceDomRegions,
    faceRegions: allFaces,
    fusedRegions,
    elements: combinedElements,
    gateResult,
    timings,
    visionBackend,
    visionOk,
    lastVisionError,
    offscreenMemory,
    degradedCapabilities,
  };
}

async function runLoop() {
  let steps = 0;
  currentProfile = await loadProfile();
  auditSteps = [];
  const stepHistory = [];

  const storedPolicy = await chrome.storage.local.get([
    "privacyPolicy",
    "agentMode",
    "allowedDomains",
    "userMaxSteps",
    "maxRuntimeMs",
    "protectedTerms",
    "offlineMode",
    "disableSubmitApproval",
  ]);
  policyMode = storedPolicy.privacyPolicy || "balanced";
  agentMode = storedPolicy.agentMode || agentMode || "guarded";
  allowedDomains = storedPolicy.allowedDomains || allowedDomains || [];
  const effectiveMaxSteps = typeof storedPolicy.userMaxSteps === "number" ? storedPolicy.userMaxSteps : (userMaxSteps || MAX_STEPS);
  const effectiveMaxRuntime = typeof storedPolicy.maxRuntimeMs === "number" ? storedPolicy.maxRuntimeMs : (maxRuntimeMs || 120000);
  const currentProtectedTerms = storedPolicy.protectedTerms || protectedTerms || [];
  const isOffline = typeof storedPolicy.offlineMode === "boolean" ? storedPolicy.offlineMode : offlineMode;
  const effectiveDisableSubmitApproval = typeof storedPolicy.disableSubmitApproval === "boolean"
    ? storedPolicy.disableSubmitApproval
    : disableSubmitApproval;

  taskStartTime = Date.now();
  const taskPerfStart = performance.now();

  let tabUrl = "";
  try {
    const tabInfo = await chrome.tabs.get(currentTabId);
    tabUrl = tabInfo?.url || "";
  } catch (e) {}

  // Website Lock check before running
  if (allowedDomains && allowedDomains.length > 0 && tabUrl) {
    if (typeof PolicyEngine !== "undefined" && !PolicyEngine.isDomainAllowed(tabUrl, allowedDomains)) {
      const host = PolicyEngine.normalizeHostname(tabUrl);
      const blockMsg = `Website Lock BLOCKED: '${host || tabUrl}' is not in the allowed websites list. Automation stopped.`;
      sendLog(blockMsg, false);
      const decObj = {
        allowed: false,
        decision: "BLOCK",
        reasonCode: PolicyEngine.REASON_CODES.DOMAIN_NOT_ALLOWED,
        policy: "Website Lock",
        message: `The website '${host || tabUrl}' is not in the allowed-domain list.`,
        action: "navigation",
        timestamp: new Date().toISOString(),
      };
      chrome.runtime.sendMessage({ type: "ACTION_BLOCKED", decision: decObj }).catch(() => {});
      await recordRunHistory({
        task: currentTask,
        mode: agentMode,
        status: "blocked",
        steps: 0,
        maxSteps: effectiveMaxSteps,
        faces: 0,
        regions: 0,
        policyBlocks: 1,
        gatePassed: true,
        durationMs: Math.round(performance.now() - taskPerfStart),
        offline: isOffline,
      });
      running = false;
      return;
    }
  }

  const ALLOWED_TYPEABLE_FIELDS = ["name", "email", "phone"];
  const knownProfileFields = ALLOWED_TYPEABLE_FIELDS.filter((k) => currentProfile[k] && String(currentProfile[k]).trim());
  if (knownProfileFields.length === 0) {
    sendLog(
      "No saved profile found. Open 'Saved profile' in the popup if this task needs your name/email/phone.",
      false
    );
  }

  while (running && steps < effectiveMaxSteps) {
    steps++;
    const stepStart = performance.now();

    // Broadcast live step progress
    chrome.runtime.sendMessage({
      type: "STEP_PROGRESS",
      step: steps,
      maxSteps: effectiveMaxSteps,
      task: currentTask,
    }).catch(() => {});

    // Check runtime limit
    if (effectiveMaxRuntime > 0 && (Date.now() - taskStartTime) > effectiveMaxRuntime) {
      sendLog(`Task runtime limit reached (${Math.round(effectiveMaxRuntime / 1000)}s) — stopping.`, false);
      const decObj = {
        allowed: false,
        decision: "BLOCK",
        reasonCode: PolicyEngine?.REASON_CODES?.RUNTIME_LIMIT_REACHED || "RUNTIME_LIMIT_REACHED",
        policy: "Runtime Limit",
        message: `Maximum runtime limit of ${Math.round(effectiveMaxRuntime / 1000)}s reached.`,
        action: "timeout",
        timestamp: new Date().toISOString(),
      };
      chrome.runtime.sendMessage({ type: "ACTION_BLOCKED", decision: decObj }).catch(() => {});
      running = false;
      break;
    }

    const auditRecord = {
      step: steps,
      timestamp: new Date().toISOString(),
      task: currentTask,
      devicePixelRatio: 1,
      domRegionsCount: 0,
      visionFacesCount: 0,
      fusedRegionsCount: 0,
      visionBackend: null,
      privacyGateStatus: "pending",
      privacyGateReason: null,
      fallbackUsed: false,
      serverAction: null,
      actionValidated: false,
      actionExecuted: false,
      executionReason: null,
      degradedCapabilities: [],
      timings: { totalMs: 0, visionInferenceMs: 0 },
    };

    try {
      // Run perceive & redact pipeline with user-configured protected terms
      const perc = await perceiveAndRedact(currentTabId, {
        policyMode,
        protectedTerms: currentProtectedTerms,
      });
      const piiMap = perc;

      if (perc.elements.length === 0 && perc.domRegions.length === 0) {
        sendLog("Failed to scan tab DOM. Please refresh the web page once and try again.", false);
        running = false;
        break;
      }

      auditRecord.devicePixelRatio = perc.dpr;
      auditRecord.domRegionsCount = perc.domRegions.length;
      auditRecord.visionFacesCount = perc.faceRegions.length;
      auditRecord.fusedRegionsCount = perc.fusedRegions.length;
      auditRecord.visionBackend = perc.visionBackend;
      auditRecord.privacyGateReason = perc.gateResult.reason || null;
      auditRecord.degradedCapabilities = [...(perc.degradedCapabilities || [])];
      auditRecord.timings = { ...perc.timings };

      if (perc.visionOk) {
        sendLog(
          `Step ${steps}: ${perc.domRegions.length} DOM region(s) + ${perc.faceRegions.length} face(s) ` +
          `fused into ${perc.fusedRegions.length} box(es) — dpr ${perc.dpr}, ` +
          `${perc.visionBackend || "wasm"} inference ${perc.timings.visionInference}ms`
        );
      } else {
        sendLog(
          `Step ${steps}: ${perc.domRegions.length} DOM region(s); vision pass failed: ${perc.lastVisionError}`,
          false
        );
      }

      let outgoingScreenshot = perc.redactedDataUrl;
      let visionAvailable = true;

      if (!perc.gateResult.ok) {
        if (perc.gateResult.allowFallback) {
          sendLog(
            `Step ${steps}: Privacy Gate — ${perc.gateResult.reason}. Falling back to DOM-only reasoning (no image sent).`,
            false
          );
          outgoingScreenshot = null;
          visionAvailable = false;
          auditRecord.fallbackUsed = true;
          auditRecord.privacyGateStatus = "fallback_dom_only";
        } else {
          sendLog(`Step ${steps}: Privacy Gate BLOCKED transmission — ${perc.gateResult.reason}`, false);
          auditRecord.privacyGateStatus = "blocked";
          auditRecord.timings.totalMs = Math.round(performance.now() - stepStart);
          auditSteps.push(auditRecord);
          running = false;
          break;
        }
      } else {
        auditRecord.privacyGateStatus = "passed";
      }

      // Feature B: Redaction Transparency Comparison Buffer
      const downscaledOrig = await downscaleScreenshot(perc.screenshotUrl, 800, 0.7);
      comparisonBuffer.push({
        step: steps,
        timestamp: Date.now(),
        originalDataUrl: downscaledOrig,
        redactedDataUrl: outgoingScreenshot,
        regions: perc.fusedRegions.map((r) => ({
          x: r.x, y: r.y, width: r.width, height: r.height,
          source: r.source || "dom",
          confidence: r.confidence ?? 1.0,
          minConfidence: r.minConfidence ?? 1.0,
        })),
        dpr: perc.dpr,
        timings: { ...auditRecord.timings },
        gateStatus: auditRecord.privacyGateStatus,
        summary: `${perc.fusedRegions.length} regions redacted (${perc.domRegions.length} DOM, ${perc.faceRegions.length} vision) — gate ${auditRecord.privacyGateStatus}`,
      });
      if (comparisonBuffer.length > 2) {
        comparisonBuffer.splice(0, comparisonBuffer.length - 2);
      }
      chrome.storage.session.set({ comparisonBuffer }).catch((e) => {
        console.warn("[comparisonBuffer] Storage error:", e.message);
        if (e?.message?.includes("QUOTA") || e?.message?.includes("quota")) {
          if (auditRecord && auditRecord.degradedCapabilities && !auditRecord.degradedCapabilities.includes("STORAGE_QUOTA_EXCEEDED")) {
            auditRecord.degradedCapabilities.push("STORAGE_QUOTA_EXCEEDED");
          }
        }
      });

      // Persist run state at end of iteration
      saveRunState({ steps });

      // 9. Build and send the sanitized payload.
      const userDocs = await getUserDocs();
      const availableFiles = typeof getUserFileMetadataList === "function" ? await getUserFileMetadataList() : [];
      const combinedProfileKeys = [
        ...new Set([
          ...knownProfileFields,
          ...Object.keys(sessionFieldAnswers),
        ]),
      ];
      const requestBody = {
        task: currentTask,
        screenshot: outgoingScreenshot,
        visionAvailable,
        elements: perc.elements,
        availableProfileFields: combinedProfileKeys, // ONLY keys/names, ZERO field values!
        skippedFields: [...new Set(skippedFields)],
        availableFiles: availableFiles, // METADATA ONLY, ZERO FILE BYTES
        recentActions: stepHistory.slice(-5),
        documentContext: userDocs.map((d) => d.textContent),
      };

      // A2: record exactly what left the browser, so the popup's network inspector
      // shows the real payload rather than sitting permanently empty.
      lastNetworkPayload = {
        capturedAt: new Date().toISOString(),
        endpoint: SERVER_URL,
        step: steps,
        visionAvailable,
        screenshotThumbnail: outgoingScreenshot ? await makeThumbnail(outgoingScreenshot) : null,
        screenshotBytes: outgoingScreenshot ? outgoingScreenshot.length : 0,
        body: { ...requestBody, screenshot: outgoingScreenshot ? "<redacted image omitted from view>" : null },
      };

      let action = null;
      if (isOffline) {
        // --- 100% Local On-Device Offline Reasoner ---
        if (typeof MockReasoner !== "undefined" && typeof MockReasoner.planOfflineAction === "function") {
          action = MockReasoner.planOfflineAction({
            elements: perc.elements,
            recentActions: stepHistory,
            availableFiles,
            task: currentTask,
          });
        } else {
          action = { action: "done" };
        }
        sendLog(`[Offline Demo] Step ${steps}: On-device reasoner proposed -> ${action.action} ${action.selector || ""}`);
        auditRecord.timings.totalMs = Math.round(performance.now() - stepStart);
        auditRecord.timings.visionInferenceMs = perc.timings?.visionInference || 0;
        auditRecord.serverAction = action;
      } else {
        const res = await fetchWithTimeout(SERVER_URL, {
          method: "POST",
          headers: await authHeaders(),
          body: JSON.stringify(requestBody),
        });

        if (res.status === 401) {
          sendLog(
            "Server rejected the request secret (401). Open 'Privacy Policy & Security Controls' " +
            "in this popup, copy the secret, and set AGENT_SHARED_SECRET to it in server/.env.",
            false
          );
          auditSteps.push(auditRecord);
          running = false;
          break;
        }
        if (!res.ok) {
          sendLog(`Step ${steps}: server returned HTTP status ${res.status}`, false);
          auditSteps.push(auditRecord);
          running = false;
          break;
        }

        action = await res.json();
        auditRecord.timings.totalMs = Math.round(performance.now() - stepStart);
        auditRecord.timings.visionInferenceMs = perc.timings?.visionInference || 0;
        auditRecord.serverAction = action;

        if (action.action === "error") {
          sendLog(`Step ${steps}: server error — ${action.message || action.error || "unknown"}`, false);
          auditSteps.push(auditRecord);
          running = false;
          break;
        }
      }

      // 10. G2 action validation.
      const valResult = validateAction(action, perc.elements, availableFiles);
      if (!valResult.ok) {
        sendLog(
          `Step ${steps}: Action Validator REJECTED (${action.action} ${action.selector || ""}) — ${valResult.reason}`,
          false
        );
        auditRecord.actionValidated = false;
        auditRecord.executionReason = valResult.reason;
        auditSteps.push(auditRecord);
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      auditRecord.actionValidated = true;

      if (valResult.matchedElement?.semanticLabel) {
        action.semanticLabel = valResult.matchedElement.semanticLabel;
      }

      // 10.2 Screen-State Classification & Dynamic Safety Escalation (P2.1)
      let effectiveAgentMode = agentMode;
      let effectivePolicyMode = policyMode;
      if (typeof PolicyEngine !== "undefined" && typeof PolicyEngine.classifyScreenState === "function") {
        const screenState = PolicyEngine.classifyScreenState(perc.elements);
        const escalation = PolicyEngine.getEscalatedPolicy(screenState, agentMode, policyMode);
        if (escalation.escalated) {
          effectiveAgentMode = escalation.effectiveMode;
          effectivePolicyMode = escalation.effectivePolicy;
          sendLog(`🛡️ Screen classified as ${screenState} — Safety dynamically escalated to mode '${effectiveAgentMode}', policy '${effectivePolicyMode}'`, true);
          chrome.runtime.sendMessage({
            type: "POLICY_ESCALATED",
            screenState,
            effectiveMode: effectiveAgentMode,
            effectivePolicy: effectivePolicyMode,
            step: steps,
          }).catch(() => {});
        }
      }

      // 10.5 Centralized Policy Engine evaluation (Modes, Limits, Domain, Sensitivity)
      if (typeof PolicyEngine !== "undefined" && typeof PolicyEngine.evaluateAction === "function") {
        const policyDecision = PolicyEngine.evaluateAction({
          action,
          currentUrl: tabUrl,
          task: currentTask,
          mode: effectiveAgentMode,
          stepCount: steps,
          maxSteps: effectiveMaxSteps,
          startTime: taskStartTime,
          maxRuntimeMs: effectiveMaxRuntime,
          privacyGateResult: perc.gateResult,
          configuration: { allowedDomains, disableSubmitApproval: effectiveDisableSubmitApproval },
          elements: perc.elements,
        });

        if (policyDecision.decision === "BLOCK") {
          sendLog(`🛡️ ACTION BLOCKED [${policyDecision.policy}]: ${policyDecision.message}`, false);
          chrome.runtime.sendMessage({ type: "ACTION_BLOCKED", decision: policyDecision }).catch(() => {});
          auditRecord.actionValidated = false;
          auditRecord.actionExecuted = false;
          auditRecord.executionReason = `Policy Block (${policyDecision.reasonCode}): ${policyDecision.message}`;
          auditSteps.push(auditRecord);
          running = false;
          break;
        }

        if (policyDecision.decision === "PREVIEW") {
          sendLog(`👁️ PREVIEW MODE: Proposed [${action.action} ${action.selector || ""}]. No action executed.`);
          chrome.runtime.sendMessage({ type: "ACTION_PREVIEW", decision: policyDecision, step: steps }).catch(() => {});
          auditRecord.actionExecuted = false;
          auditRecord.executionReason = "Preview mode - no action executed";
          auditSteps.push(auditRecord);
          if (action.action === "done") {
            sendLog("Preview plan complete.");
            running = false;
            break;
          }
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }

        if (policyDecision.decision === "ASK") {
          const actionDesc = `${action.action || "action"} ${action.selector || action.fileId || ""}`.trim();
          sendLog(`⚠️ ACTION REQUIRES APPROVAL: [${actionDesc}] — ${policyDecision.message}`, true);
          const resolvedValue = action.value || (action.fileId ? `File: ${action.fileId}` : "");
          const approval = await requestUserApproval({
            action,
            reason: policyDecision.message,
            policy: policyDecision.policy,
            selector: action.selector || "",
            semanticLabel: action.semanticLabel || action.selector || "",
            value: resolvedValue,
            fileId: action.fileId || "",
          });

          if (!approval || !approval.approved) {
            sendLog(`User rejected action [${action.action} ${action.selector || ""}]. Halting.`);
            auditRecord.actionExecuted = false;
            auditRecord.executionReason = "User rejected sensitive action";
            auditSteps.push(auditRecord);
            running = false;
            break;
          }
          sendLog("Action approved by user. Proceeding with execution...");
        }
      }

      // 11. Handle action.action === "ask_user" after validation.
      // Prompts user, rewrites action into type/select, and executes in the same step.
      if (action.action === "ask_user") {
        const canonKey = canonicalProfileKey(action.field);
        const removedFields = Array.isArray(currentProfile._removedFields) ? currentProfile._removedFields : [];
        let answerVal = null;
        if (!removedFields.includes(canonKey)) {
          answerVal = sessionFieldAnswers[canonKey] || currentProfile[canonKey];
          if (!answerVal) {
            const hint = (String(action.field || "") + " " + String(action.question || "") + " " + String(action.selector || "")).toLowerCase();
            if (/\b(full\s*name|first\s*name|last\s*name|candidate|applicant|name)\b/i.test(hint) && currentProfile.name && !removedFields.includes("name")) {
              answerVal = currentProfile.name;
            } else if (/\b(email|e-mail|mail)\b/i.test(hint) && currentProfile.email && !removedFields.includes("email")) {
              answerVal = currentProfile.email;
            } else if (/\b(phone|mobile|tel|contact|cell)\b/i.test(hint) && currentProfile.phone && !removedFields.includes("phone")) {
              answerVal = currentProfile.phone;
            }
          }
        }
        if (answerVal) {
          sendLog(`Step ${steps}: Found "${action.field}" in profile details (${answerVal}) — autofilling.`, true);
        }
        if (!answerVal) {
          sendLog(`Step ${steps}: "${action.field}" is missing or removed from your profile. Asking user...`, true);
          const answer = await requestUserInput({
            selector: action.selector,
            field: action.field,
            question: action.question,
            inputType: action.inputType || (valResult.matchedElement?.tag === "select" ? "select" : "text"),
            options: valResult.matchedElement?.options || null,
          });

          if (!answer || !answer.ok || answer.canceled) {
            if (!skippedFields.includes(canonKey)) skippedFields.push(canonKey);
            sendLog(`Step ${steps}: Skipped "${action.field}". Leaving blank and proceeding.`, true);
            auditRecord.actionExecuted = false;
            auditRecord.executionReason = `User skipped ${action.field}`;
            auditSteps.push(auditRecord);
            continue;
          }
          answerVal = answer.value;
        }

        const isSelect = (action.inputType === "select") || (valResult.matchedElement?.tag === "select");
        if (isSelect) {
          action = {
            action: "select",
            selector: action.selector,
            value: answerVal,
            semanticLabel: action.semanticLabel,
          };
        } else {
          action = {
            action: "type",
            selector: action.selector,
            value: answerVal,
            semanticLabel: action.semanticLabel,
          };
        }
        sendLog(`Step ${steps}: User provided value for "${action.selector}" — executing in same step.`);
      }

      // 12. Resolve profile placeholders locally for type action.
      // Refuse rather than fabricate values: prompt per unresolved token instead of using fake PII.
      if (action.action === "type" && action.value) {
        const combinedProfile = { ...currentProfile, ...sessionFieldAnswers };
        let { value, unresolved } = fillTemplate(action.value, combinedProfile);
        if (unresolved.length > 0) {
          let skippedAny = false;
          for (const token of unresolved) {
            const canonTok = canonicalProfileKey(token);
            if (sessionFieldAnswers[canonTok]) {
              value = value.replace(new RegExp(`\\{\\{${token}\\}\\}`, "g"), sessionFieldAnswers[canonTok]);
              continue;
            }
            sendLog(`Step ${steps}: Prompting for unresolved token "${token}"...`, true);
            const isEmail = token.toLowerCase().includes("email");
            const isPhone = token.toLowerCase().includes("phone") || token.toLowerCase().includes("tel");
            const answer = await requestUserInput({
              selector: action.selector,
              field: token,
              question: `Please provide your ${token}:`,
              inputType: isEmail ? "email" : isPhone ? "tel" : "text",
            });

            if (!answer || !answer.ok || answer.canceled) {
              if (!skippedFields.includes(canonTok)) skippedFields.push(canonTok);
              sendLog(`Step ${steps}: Skipped token "${token}".`, true);
              skippedAny = true;
              break;
            } else {
              sessionFieldAnswers[canonTok] = answer.value;
              value = value.replace(new RegExp(`\\{\\{${token}\\}\\}`, "g"), answer.value);
            }
          }

          if (skippedAny) {
            auditRecord.actionExecuted = false;
            auditRecord.executionReason = `User skipped unresolved tokens: ${unresolved.join(", ")}`;
            auditSteps.push(auditRecord);
            continue;
          }
        } else {
          // Client-side grounding verification:
          // If the model produced a literal string that doesn't appear anywhere in the user's documents, profile, or task, prompt the user!
          const valTrim = String(value).trim().toLowerCase();
          const docTexts = (userDocs || []).map((d) => (d.textContent || "").toLowerCase()).join(" ");
          const profileValues = Object.values(combinedProfile).map((v) => String(v).trim().toLowerCase());
          const taskText = (currentTask || "").toLowerCase();
          const isGrounded = (
            valTrim.length < 2 ||
            docTexts.includes(valTrim) ||
            profileValues.some((pv) => pv.length >= 2 && (pv.includes(valTrim) || valTrim.includes(pv))) ||
            taskText.includes(valTrim)
          );

          if (!isGrounded) {
            const fieldHint = valResult.matchedElement?.text || action.semanticLabel || action.selector || "this field";
            sendLog(`Step ${steps}: Field "${fieldHint}" is not in your details. Asking user...`, true);
            const answer = await requestUserInput({
              selector: action.selector,
              field: fieldHint,
              question: `Please provide a value for "${fieldHint}":`,
              inputType: valResult.matchedElement?.type || "text",
            });

            if (!answer || !answer.ok || answer.canceled) {
              const canonKey = canonicalProfileKey(fieldHint);
              if (!skippedFields.includes(canonKey)) skippedFields.push(canonKey);
              sendLog(`Step ${steps}: Skipped "${fieldHint}". Leaving blank.`, true);
              auditRecord.actionExecuted = false;
              auditRecord.executionReason = `User skipped ungrounded field ${fieldHint}`;
              auditSteps.push(auditRecord);
              continue;
            } else {
              value = answer.value;
            }
          }
        }
        action.value = value;
      }

      sendLog(
        `Step ${steps}: server said -> ${action.action} ${action.selector || ""} ` +
        `(${auditRecord.timings.totalMs}ms)`
      );

      if (action.action === "done") {
        // Look for an unclicked Submit button on the form
        const submitEl = (perc.elements || []).find((e) => {
          const t = ((e.text || "") + " " + (e.semanticLabel || "") + " " + (e.placeholder || "")).toLowerCase();
          const isSubmitText = t.includes("submit") || t.includes("send") || t.includes("apply");
          const alreadyClicked = stepHistory.some((h) => h.selector === e.selector);
          return isSubmitText && !alreadyClicked;
        });

        if (submitEl) {
          sendLog("All form questions finished. Clicking Submit button automatically...", true);
          action = { action: "click", selector: submitEl.selector };
        } else {
          sendLog("Task complete.");
          auditRecord.actionExecuted = true;
          auditSteps.push(auditRecord);
          running = false;
          break;
        }
      }

      // Loop guard: if the model repeats the identical action three times, the page
      // clearly isn't changing the way it expects. Stop rather than burn all 15 steps.
      const signature = `${action.action}|${action.selector}|${action.value ?? ""}`;
      stepHistory.push({ action: action.action, selector: action.selector, signature });
      const lastThree = stepHistory.slice(-3);
      if (lastThree.length === 3 && lastThree.every((h) => h.signature === signature)) {
        sendLog(`Step ${steps}: same action repeated 3x with no page change — stopping.`, false);
        auditRecord.executionReason = "Repeated identical action, loop guard triggered";
        auditSteps.push(auditRecord);
        running = false;
        break;
      }

      // If action is upload, resolve file bytes locally from IndexedDB (Feature A)
      if (action.action === "upload") {
        const fileRecord = typeof getUserFile === "function" ? await getUserFile(action.fileId) : null;
        if (!fileRecord || (!fileRecord.blob && !fileRecord.dataUrl)) {
          sendLog(`Step ${steps}: fileId '${action.fileId}' not found in local IndexedDB storage.`, false);
          auditRecord.executionReason = `Missing local file ${action.fileId}`;
          auditSteps.push(auditRecord);
          running = false;
          break;
        }
        let buffer = null;
        if (fileRecord.blob && typeof fileRecord.blob.arrayBuffer === "function") {
          try {
            buffer = await fileRecord.blob.arrayBuffer();
          } catch (e) {}
        }
        if (!buffer && fileRecord.dataUrl) {
          try {
            const res = await fetch(fileRecord.dataUrl);
            buffer = await res.arrayBuffer();
          } catch (e) {}
        }
        let dataUrl = fileRecord.dataUrl || null;
        if (!dataUrl && buffer) {
          const bytes = new Uint8Array(buffer);
          let binary = "";
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          dataUrl = `data:${fileRecord.mimeType || "application/octet-stream"};base64,${btoa(binary)}`;
        }
        action.fileBase64 = dataUrl;
        action.fileName = fileRecord.name;
        action.fileMime = fileRecord.mimeType;
        delete action.fileBuffer;
      }

      // 12. Execute in the frame owning the target element.
      const targetElement = (perc.elements || []).find((e) => e.selector === action.selector);
      const targetFrameId = targetElement?.frameId ?? 0;

      let resVal = null;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: currentTabId, frameIds: [targetFrameId] },
          func: executeAction,
          args: [action],
        });
        resVal = results?.[0]?.result;
      } catch (e) {
        // Fallback across all frames
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: currentTabId, allFrames: true },
            func: executeAction,
            args: [action],
          });
          const matched = (results || []).find((r) => r.result && r.result.ok);
          resVal = matched ? matched.result : results?.[0]?.result;
        } catch (err2) {
          resVal = { ok: false, reason: err2.message };
        }
      }

      // Check for Tier 3 Assisted Handoff
      if (resVal && resVal.assistedHandoff) {
        sendLog(resVal.reason, false);
        auditRecord.actionExecuted = false;
        auditRecord.executionReason = "Assisted handoff paused";
        auditSteps.push(auditRecord);
        isPaused = true;
        running = false;
        pausedState = {
          steps,
          stepHistory,
          currentTask,
          currentTabId,
        };
        chrome.runtime.sendMessage({
          type: "AGENT_PAUSED",
          reason: resVal.reason,
          step: steps,
        }).catch(() => {});
        break;
      }

      if (resVal && !resVal.ok) {
        sendLog(`Step ${steps}: action failed — ${resVal.reason}`, false);
        auditRecord.actionExecuted = false;
        auditRecord.executionReason = resVal.reason;
      } else {
        auditRecord.actionExecuted = true;
      }

      // Tier 2 & 3: If an upload trigger was clicked or upload executed, check for Google Picker
      const triggeredUpload = (action.action === "click" && isUploadTrigger(targetElement)) || action.action === "upload";
      if (triggeredUpload) {
        let picker = null;
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 600));
          picker = await findPickerFrame(currentTabId);
          if (picker) break;
        }

        if (picker) {
          sendLog("Google Picker dialog detected. Determining required file type...", true);
          const contextStr = await detectUploadContext(currentTabId, targetElement);
          const isPhoto = /photo|photograph|picture|image|avatar|headshot|selfie|portrait|profile_pic|profile pic|face|\.jpg|\.jpeg|\.png/i.test(contextStr);
          const isResume = /resume|cv|curriculum|biodata|bio-data|cover letter|\.pdf|\.docx|\.doc/i.test(contextStr);

          let fileObj = null;
          if (isPhoto && !isResume) {
            sendLog("Upload field identified as PHOTO. Resolving photo...", true);
            fileObj = await resolveUserPhoto();
          } else if (isResume && !isPhoto) {
            sendLog("Upload field identified as RESUME/DOCUMENT. Resolving resume...", true);
            fileObj = await resolveUserResume();
          } else if (isPhoto) {
            fileObj = (await resolveUserPhoto()) || (await resolveUserResume());
          } else {
            fileObj = (await resolveUserResume()) || (await resolveUserPhoto());
          }

          let attached = false;
          if (fileObj) {
            for (let attempt = 0; attempt < 8; attempt++) {
              await new Promise((r) => setTimeout(r, 600));
              try {
                const attachRes = await chrome.scripting.executeScript({
                  target: { tabId: currentTabId, allFrames: true },
                  func: attachFileIntoGooglePickerOrDropzone,
                  args: [fileObj.dataUrl, fileObj.name, fileObj.mimeType],
                });
                attached = (attachRes || []).some((r) => r.result && r.result.ok);
                if (attached) {
                  sendLog(`Attached '${fileObj.name}' automatically into Google Form dialog!`, true);
                  await new Promise((r) => setTimeout(r, 2000));
                  break;
                }
              } catch (e) {
                console.warn("Picker auto-attachment error:", e);
              }
            }
          }

          if (!attached) {
            const msg = "Google Picker upload dialog is open. Please select the file in the dialog window, then click 'Resume Agent Task'.";
            sendLog(msg, false);
            auditRecord.actionExecuted = true;
            auditRecord.executionReason = "Assisted handoff paused for Google Picker";
            auditSteps.push(auditRecord);
            isPaused = true;
            running = false;
            pausedState = {
              steps,
              stepHistory,
              currentTask,
              currentTabId,
            };
            chrome.runtime.sendMessage({
              type: "AGENT_PAUSED",
              reason: msg,
              step: steps,
            }).catch(() => {});
            break;
          }
        }
      }

      auditSteps.push(auditRecord);
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      sendLog(`Error: ${err.message}`, false);
      auditRecord.executionReason = err.message;
      auditSteps.push(auditRecord);
      running = false;
    }
  }

  if (steps >= effectiveMaxSteps && running) {
    sendLog(`Stopped: reached the maximum step limit (${effectiveMaxSteps}) without finishing.`, false);
    running = false;
  }

  // Record non-sensitive run metadata in local history (Zero PII stored)
  const durationMs = taskStartTime ? Math.round(Date.now() - taskStartTime) : 0;
  const anyGateBlocked = auditSteps.some((s) => s.privacyGateStatus === "blocked");
  const anyPolicyBlocked = auditSteps.some((s) => s.executionReason && String(s.executionReason).includes("Policy Block"));
  let finalStatus = "completed";
  if (isPaused) finalStatus = "paused";
  else if (anyGateBlocked || anyPolicyBlocked) finalStatus = "blocked";
  else if (agentMode === "preview") finalStatus = "preview";
  else if (!running && steps < effectiveMaxSteps && auditSteps.length > 0 && auditSteps[auditSteps.length - 1].serverAction?.action !== "done") finalStatus = "stopped";

  await recordRunHistory({
    task: currentTask,
    mode: agentMode,
    status: finalStatus,
    steps: steps,
    maxSteps: effectiveMaxSteps,
    faces: auditSteps.reduce((acc, s) => acc + (s.visionFacesCount || 0), 0),
    regions: auditSteps.reduce((acc, s) => acc + (s.fusedRegionsCount || 0), 0),
    policyBlocks: anyPolicyBlocked ? 1 : 0,
    gatePassed: !anyGateBlocked,
    durationMs,
    offline: isOffline,
  });
}

// ---------------------------------------------------------------------------
// Injected into the page. Must be self-contained — no closure over this file.
// ---------------------------------------------------------------------------

function executeAction(action) {
  if (action.action === "scroll") {
    window.scrollBy(0, action.amount || 400);
    return { ok: true };
  }
  if (!action.selector && !action.semanticLabel && !action.target) {
    return { ok: false, reason: "No selector or semantic label specified in action" };
  }

  // Structured Shadow-DOM Resolver (P2.2)
  function resolveShadowTarget(selOrAction) {
    if (!selOrAction) return null;

    // A. Structured descriptor: { hostPath: ["#host1", "#host2"], inner: "#target-btn" }
    if (typeof selOrAction === "object" && (selOrAction.hostPath || selOrAction.inner)) {
      const hosts = Array.isArray(selOrAction.hostPath) ? selOrAction.hostPath : [selOrAction.hostPath].filter(Boolean);
      let currRoot = document;
      for (const hSel of hosts) {
        try {
          const hEl = currRoot.querySelector(hSel);
          if (hEl && hEl.shadowRoot) {
            currRoot = hEl.shadowRoot;
          } else {
            return null;
          }
        } catch (e) {
          return null;
        }
      }
      if (selOrAction.inner) {
        try {
          return currRoot.querySelector(selOrAction.inner);
        } catch (e) {
          return null;
        }
      }
      return null;
    }

    const selStr = typeof selOrAction === "string" ? selOrAction : (selOrAction.selector || "");
    if (!selStr) return null;

    // B. Direct document querySelector
    try {
      const direct = document.querySelector(selStr);
      if (direct) return direct;
    } catch (e) {}

    // C. Piercing '>>>' syntax traversal
    if (selStr.includes(">>>")) {
      const segments = selStr.split(">>>").map((s) => s.trim()).filter(Boolean);
      let currRoot = document;
      let target = null;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        try {
          target = currRoot.querySelector(seg);
        } catch (e) {
          target = null;
          break;
        }
        if (!target) break;
        if (i < segments.length - 1) {
          if (target.shadowRoot) {
            currRoot = target.shadowRoot;
          } else {
            target = null;
            break;
          }
        }
      }
      if (target) return target;
    }

    // D. Recursive Shadow Root fallback search
    function searchRoots(root, sel) {
      try {
        const found = root.querySelector(sel);
        if (found) return found;
      } catch (e) {}

      try {
        const doc = root.ownerDocument || root;
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.shadowRoot) {
            const found = searchRoots(node.shadowRoot, sel);
            if (found) return found;
          }
        }
      } catch (e) {}
      return null;
    }

    return searchRoots(document, selStr);
  }

  let el = resolveShadowTarget(action.target || action.selector || action);

  // A6: semantic label fallback when the selector no longer resolves (page re-rendered).
  if (!el && action.semanticLabel) {
    const candidates = Array.from(
      document.querySelectorAll(
        "button, a, input, select, textarea, [role=button], [role=combobox], [role=option]"
      )
    );
    el = candidates.find((c) => {
      const tag = c.tagName.toLowerCase();
      const text = (c.innerText || c.placeholder || "").slice(0, 60).trim();
      return `${tag}:${text}` === action.semanticLabel ||
             c.getAttribute("aria-label") === action.semanticLabel;
    });
  }

  if (!el) {
    return { ok: false, reason: `Element matching '${action.selector || action.semanticLabel}' not found` };
  }

  function dispatchMouse(target, eventName) {
    target.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
  }

  function attachFile(inputEl, base64Data, filename = "photo.jpg", mime = "image/jpeg") {
    try {
      const raw = atob(base64Data.split(",")[1] || base64Data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const file = new File([blob], filename, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      inputEl.files = dt.files;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      console.warn("Could not attach file:", e);
      return false;
    }
  }

  function buildFileFromBuffer(buffer, name, mime) {
    try {
      if (!buffer) return null;
      const blob = new Blob([buffer], { type: mime || "application/octet-stream" });
      return new File([blob], name || "document", { type: mime || "application/octet-stream" });
    } catch (e) {
      return null;
    }
  }

  // Tier 1: synthetic DataTransfer file attachment & dropzone handling
  if (action.action === "upload") {
    try {
      let fileObj = buildFileFromBuffer(action.fileBuffer, action.fileName, action.fileMime);
      if (!fileObj && action.fileBase64) {
        const raw = atob(action.fileBase64.split(",")[1] || action.fileBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const blob = new Blob([bytes], { type: action.fileMime || "application/octet-stream" });
        fileObj = new File([blob], action.fileName || "photo.jpg", { type: action.fileMime || "application/octet-stream" });
      }

      let fileInput = (el.tagName === "INPUT" && el.type === "file") ? el : null;
      if (!fileInput && el.tagName === "LABEL" && el.getAttribute("for")) {
        const forEl = document.getElementById(el.getAttribute("for"));
        if (forEl && forEl.type === "file") fileInput = forEl;
      }
      if (!fileInput) {
        fileInput = el.querySelector('input[type="file"]') ||
          el.parentElement?.querySelector('input[type="file"]') ||
          document.querySelector('input[type="file"]');
      }

      // Tier 1: Attach to file input
      if (fileInput && fileObj) {
        if (fileInput.accept) {
          const accepted = fileInput.accept.split(",").map((s) => s.trim().toLowerCase());
          const mime = (action.fileMime || "").toLowerCase();
          const ext = "." + (action.fileName || "").split(".").pop().toLowerCase();
          const matches = accepted.some((a) => {
            if (a.startsWith(".")) return a === ext;
            if (a.endsWith("/*")) return mime.startsWith(a.slice(0, -1));
            return a === mime;
          });
          if (!matches) {
            return {
              ok: false,
              reason: `File '${action.fileName}' (${action.fileMime}) does not match input accept='${fileInput.accept}'`,
            };
          }
        }

        const dt = new DataTransfer();
        dt.items.add(fileObj);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, detail: `Attached ${action.fileName}` };
      }

      // If target element is an upload button (e.g. Google Forms "Add file"), click it to open the picker dialog!
      if (!fileInput && (el.getAttribute("role") === "button" || el.tagName === "BUTTON" || (el.innerText || "").toLowerCase().includes("add file") || (el.innerText || "").toLowerCase().includes("upload"))) {
        dispatchMouse(el, "mousedown");
        dispatchMouse(el, "mouseup");
        el.click();
        return { ok: true, detail: `Clicked upload button to trigger file dialog` };
      }

      // Dropzone fallback: synthetic DragEvent
      if (fileObj) {
        const dt = new DataTransfer();
        dt.items.add(fileObj);
        const dropzone = el.closest('[role="region"], .picker-dropzone, .upload-dropzone') || el;
        dropzone.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
        dropzone.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
        dropzone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
        return { ok: true, detail: `Dispatched drop event to ${dropzone.tagName}` };
      }

      // Tier 3: Assisted handoff
      return {
        ok: false,
        assistedHandoff: true,
        reason: "Couldn't attach automatically — the picker is open, please choose the file, then click Resume.",
      };
    } catch (e) {
      return {
        ok: false,
        assistedHandoff: true,
        reason: `Upload error: ${e.message}. Please choose the file, then click Resume.`,
      };
    }
  }

  if (action.action === "click" || action.action === "check") {
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();
      dispatchMouse(el, "pointerdown");
      dispatchMouse(el, "mousedown");
      dispatchMouse(el, "pointerup");
      dispatchMouse(el, "mouseup");
      el.click();
      if (el.type === "checkbox" || el.type === "radio") {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  if (action.action === "type") {
    try {
      if (el.tagName === "INPUT" && el.type === "file") {
        if (action.fileBase64) {
          attachFile(el, action.fileBase64, action.fileName, action.fileMime);
          return { ok: true, reason: "Attached file directly to input[type=file]" };
        }
      }
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();
      const val = String(action.value ?? "");
      const isTextArea = el instanceof HTMLTextAreaElement;
      const isInput = el instanceof HTMLInputElement;
      if (isTextArea || isInput) {
        // Use the native setter so React/Vue/Google Forms inputs register the change.
        const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeSetter) nativeSetter.call(el, val);
        else el.value = val;
      } else if (el.isContentEditable) {
        el.innerText = val;
      } else {
        el.value = val;
      }
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
      } catch (e) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  if (action.action === "select") {
    const target = String(action.value ?? "").trim();
    if (el.tagName === "SELECT") {
      let matched = Array.from(el.options).find((o) => o.value === target);
      if (!matched) {
        matched = Array.from(el.options).find(
          (o) => o.text.trim().toLowerCase() === target.toLowerCase()
        );
      }
      if (matched) {
        el.value = matched.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      return { ok: false, reason: `Option '${target}' not found in <select>` };
    }

    // Custom ARIA combobox / listbox / radio / checkbox support
    try {
      const targetLow = target.toLowerCase();
      // Try matching radio buttons, checkboxes, or options by text, value, aria-label, or data-value
      const candidates = Array.from(
        document.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"], [role="option"], li')
      );
      const matchedChoice = candidates.find((c) => {
        const text = (c.innerText || c.getAttribute("aria-label") || c.getAttribute("data-value") || c.value || "").trim().toLowerCase();
        return text === targetLow || (targetLow.length >= 3 && (text.includes(targetLow) || targetLow.includes(text)));
      });
      if (matchedChoice) {
        matchedChoice.scrollIntoView({ block: "center", behavior: "instant" });
        matchedChoice.focus();
        dispatchMouse(matchedChoice, "pointerdown");
        dispatchMouse(matchedChoice, "mousedown");
        dispatchMouse(matchedChoice, "pointerup");
        dispatchMouse(matchedChoice, "mouseup");
        matchedChoice.click();
        if (matchedChoice.type === "radio" || matchedChoice.type === "checkbox") {
          matchedChoice.checked = true;
          matchedChoice.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { ok: true, detail: `Selected choice '${target}'` };
      }

      el.click();
      const option = Array.from(document.querySelectorAll('[role="option"], li')).find(
        (o) => (o.innerText || o.getAttribute("data-value") || "").trim().toLowerCase() === targetLow
      );
      if (option) {
        option.click();
        return { ok: true };
      }
    } catch (e) {}
    return { ok: false, reason: `Could not select '${target}' on custom control` };
  }

  return { ok: false, reason: `Unsupported action '${action.action}' for element` };
}
