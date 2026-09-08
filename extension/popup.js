/**
 * popup.js — Control Center for Privacy-Preserving Browser Agent
 */

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const backendStatusEl = document.getElementById("backendStatus");
let userStopped = false;

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function log(msg, ok = true) {
  if (!logEl) return;
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  if (userStopped) return;
  if (statusEl && !statusEl.textContent.includes("waiting")) {
    statusEl.textContent = ok ? "running" : "error";
    statusEl.className = "badge " + (ok ? "running" : "err");
  }
}

// --- Backend Health Prober ---
async function checkBackendStatus() {
  if (!backendStatusEl) return;
  try {
    const res = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      backendStatusEl.textContent = "Server: Connected";
      backendStatusEl.className = "badge ready";
    } else {
      backendStatusEl.textContent = "Server: Offline";
      backendStatusEl.className = "badge offline";
    }
  } catch (e) {
    backendStatusEl.textContent = "Server: Offline";
    backendStatusEl.className = "badge offline";
  }
}
checkBackendStatus();
setInterval(checkBackendStatus, 8000);

// --- Offline Demo Banner & Toggle ---
const offlineBanner = document.getElementById("offlineBanner");
const btnToggleOffline = document.getElementById("btnToggleOffline");
let isOfflineModeActive = false;

function updateOfflineUI(active) {
  isOfflineModeActive = Boolean(active);
  if (offlineBanner) offlineBanner.style.display = isOfflineModeActive ? "block" : "none";
  if (btnToggleOffline) {
    btnToggleOffline.textContent = isOfflineModeActive ? "⚡ Offline Demo: ON" : "⚡ Offline Demo: OFF";
    btnToggleOffline.style.background = isOfflineModeActive ? "#4338ca" : "";
    btnToggleOffline.style.color = isOfflineModeActive ? "#ffffff" : "";
  }
}

btnToggleOffline?.addEventListener("click", () => {
  const newState = !isOfflineModeActive;
  updateOfflineUI(newState);
  chrome.runtime.sendMessage({ type: "SET_OFFLINE_MODE", enabled: newState });
  log(`Offline Demo Mode set to: ${newState ? "ENABLED (Zero API calls)" : "DISABLED"}`);
});

// --- Agent Modes Selector ---
const modeGuarded = document.getElementById("modeGuarded");
const modeSupervised = document.getElementById("modeSupervised");
const modePreview = document.getElementById("modePreview");
const modeDesc = document.getElementById("modeDescription");
let currentAgentMode = "guarded";

function setModeUI(mode) {
  currentAgentMode = mode || "guarded";
  [modeGuarded, modeSupervised, modePreview].forEach((b) => b?.classList.remove("active"));
  if (currentAgentMode === "supervised") {
    modeSupervised?.classList.add("active");
    if (modeDesc) modeDesc.textContent = "Supervised (User approval for sensitive actions)";
  } else if (currentAgentMode === "preview") {
    modePreview?.classList.add("active");
    if (modeDesc) modeDesc.textContent = "Preview (Plan only, zero browser actions executed)";
  } else {
    modeGuarded?.classList.add("active");
    if (modeDesc) modeDesc.textContent = "Guarded (Auto-execute safe actions)";
  }
}

modeGuarded?.addEventListener("click", () => {
  setModeUI("guarded");
  chrome.runtime.sendMessage({ type: "SET_AGENT_MODE", mode: "guarded" });
});
modeSupervised?.addEventListener("click", () => {
  setModeUI("supervised");
  chrome.runtime.sendMessage({ type: "SET_AGENT_MODE", mode: "supervised" });
});
modePreview?.addEventListener("click", () => {
  setModeUI("preview");
  chrome.runtime.sendMessage({ type: "SET_AGENT_MODE", mode: "preview" });
});

// --- Explainable Block Alert ---
const blockCard = document.getElementById("blockCard");
const blockAction = document.getElementById("blockAction");
const blockReason = document.getElementById("blockReason");
const blockPolicy = document.getElementById("blockPolicy");

function showBlockCard(decision) {
  if (!blockCard || !decision) return;
  if (blockAction) blockAction.textContent = `Action: ${decision.action || "none"}`;
  if (blockReason) blockReason.textContent = `Reason: ${decision.message || "Blocked by safety policy"}`;
  if (blockPolicy) blockPolicy.textContent = decision.policy || "Policy Engine";
  blockCard.style.display = "block";
  if (statusEl) {
    statusEl.textContent = "blocked";
    statusEl.className = "badge blocked";
  }
}

function hideBlockCard() {
  if (blockCard) blockCard.style.display = "none";
}

// --- Supervised Mode Action Approval ---
const approvalCard = document.getElementById("approvalCard");
const approvalActionText = document.getElementById("approvalActionText");
const approvalReasonText = document.getElementById("approvalReasonText");
const approvalPolicy = document.getElementById("approvalPolicy");
const btnApproveAction = document.getElementById("btnApproveAction");
const btnRejectAction = document.getElementById("btnRejectAction");

function renderApprovalCard(req) {
  if (!req || !approvalCard) return;
  if (approvalActionText) {
    approvalActionText.textContent = `${req.action?.action || "action"} ${req.action?.selector || req.action?.fileId || ""}`;
  }
  if (approvalReasonText) approvalReasonText.textContent = req.reason || "This action requires confirmation.";
  if (approvalPolicy) approvalPolicy.textContent = req.policy || "Action Safety";
  approvalCard.style.display = "block";
  if (statusEl) {
    statusEl.textContent = "approval req";
    statusEl.className = "badge paused";
  }
}

function hideApprovalCard() {
  if (approvalCard) approvalCard.style.display = "none";
}

btnApproveAction?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "APPROVE_PENDING_ACTION" });
  hideApprovalCard();
  if (statusEl) {
    statusEl.textContent = "running";
    statusEl.className = "badge running";
  }
  log("Action approved by user.", true);
});

btnRejectAction?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "REJECT_PENDING_ACTION" });
  hideApprovalCard();
  if (statusEl) {
    statusEl.textContent = "stopped";
    statusEl.className = "badge err";
  }
  log("Action rejected by user.", false);
});

// --- Step Progress ---
const stepCounterText = document.getElementById("stepCounterText");
const progressBarFill = document.getElementById("progressBarFill");

function updateStepProgress(step, maxSteps) {
  if (stepCounterText) stepCounterText.textContent = `Step ${step} / ${maxSteps}`;
  if (progressBarFill) {
    const pct = Math.min(100, Math.round((step / Math.max(1, maxSteps)) * 100));
    progressBarFill.style.width = `${pct}%`;
  }
}

// --- Local Privacy Scan ---
const btnScanPage = document.getElementById("btnScanPage");
const privacyScanCard = document.getElementById("privacyScanCard");
const privacyScanMetrics = document.getElementById("privacyScanMetrics");

btnScanPage?.addEventListener("click", async () => {
  btnScanPage.disabled = true;
  btnScanPage.textContent = "Scanning on-device...";
  log("Starting Local Privacy Scan (DOM + Vision)...", true);
  try {
    const res = await chrome.runtime.sendMessage({ type: "RUN_LOCAL_PRIVACY_SCAN" });
    if (res && res.ok) {
      if (privacyScanCard) privacyScanCard.style.display = "block";
      if (privacyScanMetrics) {
        privacyScanMetrics.innerHTML = `
          <strong>✓ Scan Findings (100% On-Device):</strong><br/>
          • <b>${res.facesCount}</b> face(s) detected via local ONNX<br/>
          • <b>${res.emailCount}</b> email field(s)<br/>
          • <b>${res.phoneCount}</b> phone number(s)<br/>
          • <b>${res.passwordCount}</b> password field(s)<br/>
          • <b>${res.sensitiveTextCount}</b> sensitive text/input region(s)<br/>
          • <b>${res.protectedTermsCount}</b> user protected term match(es)<br/>
          • <b>${res.totalRegionsDetected}</b> total region(s) masked &amp; flashed on page.<br/>
          <span style="color:#5eead4; font-size:10px; font-weight:600;">AI REQUEST: NONE (Zero external data sent)</span>
        `;
      }
      log(`Local scan complete: ${res.totalRegionsDetected} sensitive region(s) detected and masked. AI Request: NONE.`);
    } else {
      log(`Local scan error: ${res?.error || "failed"}`, false);
    }
  } catch (e) {
    log(`Local scan failed: ${e.message}`, false);
  } finally {
    btnScanPage.disabled = false;
    btnScanPage.textContent = "🔍 Local Privacy Scan";
  }
});

// --- Allowed Domains (Website Lock) ---
const allowedDomainInput = document.getElementById("allowedDomainInput");
const btnAddDomain = document.getElementById("btnAddDomain");
const allowedDomainsList = document.getElementById("allowedDomainsList");
let currentAllowedDomains = [];

function renderAllowedDomains(domains) {
  currentAllowedDomains = Array.isArray(domains) ? domains : [];
  if (!allowedDomainsList) return;
  if (currentAllowedDomains.length === 0) {
    allowedDomainsList.innerHTML = '<span style="font-size:10px; color:#64748b;">No restrictions (all websites allowed)</span>';
    return;
  }
  allowedDomainsList.innerHTML = currentAllowedDomains
    .map(
      (d, idx) => `
      <span class="tag">
        ${escapeHtml(d)}
        <span class="tag-del" data-idx="${idx}">&times;</span>
      </span>
    `
    )
    .join("");

  allowedDomainsList.querySelectorAll(".tag-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      currentAllowedDomains.splice(idx, 1);
      chrome.runtime.sendMessage({ type: "SET_ALLOWED_DOMAINS", domains: currentAllowedDomains });
      renderAllowedDomains(currentAllowedDomains);
    });
  });
}

function addDomainFromInput() {
  const val = allowedDomainInput ? allowedDomainInput.value.trim().toLowerCase() : "";
  if (!val) return;
  const clean = val.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  if (clean && !currentAllowedDomains.includes(clean)) {
    currentAllowedDomains.push(clean);
    chrome.runtime.sendMessage({ type: "SET_ALLOWED_DOMAINS", domains: currentAllowedDomains });
    renderAllowedDomains(currentAllowedDomains);
  }
  if (allowedDomainInput) allowedDomainInput.value = "";
}

btnAddDomain?.addEventListener("click", addDomainFromInput);
allowedDomainInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addDomainFromInput();
});

// --- Protected Terms Manager ---
const protectedTermInput = document.getElementById("protectedTermInput");
const btnAddTerm = document.getElementById("btnAddTerm");
const protectedTermsList = document.getElementById("protectedTermsList");
let currentProtectedTerms = [];

function renderProtectedTerms(terms) {
  currentProtectedTerms = Array.isArray(terms) ? terms : [];
  if (!protectedTermsList) return;
  if (currentProtectedTerms.length === 0) {
    protectedTermsList.innerHTML = '<span style="font-size:10px; color:#64748b;">No protected terms configured</span>';
    return;
  }
  protectedTermsList.innerHTML = currentProtectedTerms
    .map(
      (t, idx) => `
      <span class="tag" style="border-color: #0f766e; color: #5eead4;">
        🔒 ${escapeHtml(t)}
        <span class="tag-del" data-term-idx="${idx}">&times;</span>
      </span>
    `
    )
    .join("");

  protectedTermsList.querySelectorAll(".tag-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.termIdx, 10);
      currentProtectedTerms.splice(idx, 1);
      chrome.runtime.sendMessage({ type: "SET_PROTECTED_TERMS", terms: currentProtectedTerms });
      renderProtectedTerms(currentProtectedTerms);
    });
  });
}

function addTermFromInput() {
  const val = protectedTermInput ? protectedTermInput.value.trim() : "";
  if (!val || val.length < 2) return;
  if (!currentProtectedTerms.includes(val)) {
    currentProtectedTerms.push(val);
    chrome.runtime.sendMessage({ type: "SET_PROTECTED_TERMS", terms: currentProtectedTerms });
    renderProtectedTerms(currentProtectedTerms);
  }
  if (protectedTermInput) protectedTermInput.value = "";
}

btnAddTerm?.addEventListener("click", addTermFromInput);
protectedTermInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addTermFromInput();
});

// --- Step and Runtime Limit Inputs ---
const maxStepsInput = document.getElementById("maxStepsInput");
const maxRuntimeInput = document.getElementById("maxRuntimeInput");

maxStepsInput?.addEventListener("change", (e) => {
  const val = Math.max(1, parseInt(e.target.value, 10) || 15);
  chrome.runtime.sendMessage({ type: "SET_STEP_LIMIT", maxSteps: val });
});

maxRuntimeInput?.addEventListener("change", (e) => {
  const val = Math.max(10, parseInt(e.target.value, 10) || 120);
  chrome.storage.local.set({ maxRuntimeMs: val * 1000 });
});

// --- Run History & JSON Export ---
const runHistoryContainer = document.getElementById("runHistoryContainer");
const btnExportRunHistory = document.getElementById("btnExportRunHistory");
const btnClearRunHistory = document.getElementById("btnClearRunHistory");

function renderRunHistory(history) {
  if (!runHistoryContainer) return;
  if (!history || history.length === 0) {
    runHistoryContainer.innerHTML = '<div class="hint">No execution runs recorded yet.</div>';
    return;
  }
  runHistoryContainer.innerHTML = history
    .map((r) => {
      const statusClass =
        r.status === "completed"
          ? "ready"
          : r.status === "blocked"
          ? "blocked"
          : r.status === "preview"
          ? "running"
          : "err";
      const durSec = Math.round((r.durationMs || 0) / 1000);
      return `
      <div style="background: #020617; border: 1px solid #1e293b; border-radius: 4px; padding: 5px 8px; margin-bottom: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="color:#e2e8f0;">${escapeHtml(r.taskName || "Unnamed")}</strong>
          <span class="badge ${statusClass}">${r.status}</span>
        </div>
        <div style="font-size: 9.5px; color: #94a3b8; margin-top: 2px;">
          ${r.stepsExecuted}/${r.maxSteps} steps • ${r.facesDetected} faces • ${r.regionsRedacted} redacted • ${r.policyBlocks || 0} blocks • ${durSec}s
          ${r.offlineMode ? ' • <span style="color:#a5b4fc">offline</span>' : ''}
        </div>
      </div>
    `;
    })
    .join("");
}

btnExportRunHistory?.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "GET_RUN_HISTORY" });
  const history = (res && res.history) || [];
  downloadJson(
    {
      exportTime: new Date().toISOString(),
      agent: "Privacy-Preserving Browser Agent (SIH26171)",
      totalRuns: history.length,
      runs: history,
    },
    "agent_run_history.json"
  );
});

btnClearRunHistory?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_RUN_HISTORY" });
  renderRunHistory([]);
});

// --- Start / Stop / Resume Agent Task ---
document.getElementById("start")?.addEventListener("click", async () => {
  const task = document.getElementById("task").value.trim();
  if (!task) {
    log("Enter a task first.", false);
    return;
  }
  userStopped = false;
  hideBlockCard();
  hideApprovalCard();
  updateStepProgress(0, parseInt(maxStepsInput?.value || "15", 10));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({
    type: "START_AGENT",
    task,
    tabId: tab.id,
    mode: currentAgentMode,
    offlineMode: isOfflineModeActive,
  });
  if (statusEl) {
    statusEl.textContent = "running";
    statusEl.className = "badge running";
  }
  log(`Started task on tab ${tab.id}: "${task}" [Mode: ${currentAgentMode}]`);
});

document.getElementById("stop")?.addEventListener("click", () => {
  userStopped = true;
  hideInputPrompt();
  hideApprovalCard();
  chrome.runtime.sendMessage({ type: "STOP_AGENT" });
  if (statusEl) {
    statusEl.textContent = "stopped";
    statusEl.className = "badge idle";
  }
  log("Stopped.");
});

const resumeBtn = document.getElementById("resume");
resumeBtn?.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "RESUME_AGENT_TASK" });
  if (res && res.ok) {
    resumeBtn.style.display = "none";
    if (statusEl) {
      statusEl.textContent = "running";
      statusEl.className = "badge running";
    }
  } else {
    log(`Resume failed: ${res?.reason || "unknown error"}`, false);
  }
});

document.getElementById("openViewer")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

document.getElementById("runBenchmark")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("benchmark.html") });
});

// --- Interactive User Input Prompt Panel ---
const inputPromptPanel = document.getElementById("inputPromptPanel");
const inputPromptQuestion = document.getElementById("inputPromptQuestion");
const inputPromptFieldContainer = document.getElementById("inputPromptFieldContainer");
const inputPromptRemember = document.getElementById("inputPromptRemember");
const inputPromptSubmit = document.getElementById("inputPromptSubmit");
const inputPromptSkip = document.getElementById("inputPromptSkip");
let currentPendingInputId = null;

function renderInputPrompt(req) {
  if (!req || !inputPromptPanel) return;
  currentPendingInputId = req.id;
  inputPromptQuestion.textContent = req.question || `Enter value for ${req.field}:`;
  inputPromptFieldContainer.innerHTML = "";

  const isSelect = req.inputType === "select" || (req.options && req.options.length > 0);
  if (isSelect && req.options && req.options.length > 0) {
    const selectEl = document.createElement("select");
    selectEl.id = "inputPromptValue";
    selectEl.style.marginBottom = "4px";

    const defOpt = document.createElement("option");
    defOpt.value = "";
    defOpt.textContent = "-- Select an option --";
    selectEl.appendChild(defOpt);

    for (const opt of req.options) {
      const optEl = document.createElement("option");
      optEl.value = opt.value || opt.label;
      optEl.textContent = opt.label || opt.value;
      selectEl.appendChild(optEl);
    }
    inputPromptFieldContainer.appendChild(selectEl);
    setTimeout(() => selectEl.focus(), 50);
  } else {
    const inputEl = document.createElement("input");
    inputEl.id = "inputPromptValue";
    inputEl.style.marginBottom = "4px";

    const t = (req.inputType || "text").toLowerCase();
    if (["email", "tel", "date", "password"].includes(t)) {
      inputEl.type = t;
    } else {
      inputEl.type = "text";
    }
    inputEl.placeholder = `Your ${req.field || "value"}`;
    inputPromptFieldContainer.appendChild(inputEl);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") inputPromptSubmit?.click();
    });
    setTimeout(() => inputEl.focus(), 50);
  }

  inputPromptPanel.style.display = "block";
  if (statusEl) {
    statusEl.textContent = "input needed";
    statusEl.className = "badge err";
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  log(`Action required: "${req.question || req.field}"`, true);
}

function hideInputPrompt() {
  if (inputPromptPanel) inputPromptPanel.style.display = "none";
  currentPendingInputId = null;
  if (inputPromptFieldContainer) inputPromptFieldContainer.innerHTML = "";
}

inputPromptSubmit?.addEventListener("click", async () => {
  if (!currentPendingInputId) return;
  const inputValEl = document.getElementById("inputPromptValue");
  const val = inputValEl ? inputValEl.value.trim() : "";
  if (!val) {
    log("Please enter or select a value before submitting (or click Skip).", false);
    return;
  }
  const remember = inputPromptRemember ? inputPromptRemember.checked : false;
  await chrome.runtime.sendMessage({
    type: "SUBMIT_USER_INPUT",
    id: currentPendingInputId,
    value: val,
    remember: remember,
  });
  hideInputPrompt();
  if (statusEl) {
    statusEl.textContent = "running";
    statusEl.className = "badge running";
  }
  if (remember) {
    loadProfile();
  }
});

inputPromptSkip?.addEventListener("click", async () => {
  if (!currentPendingInputId) return;
  await chrome.runtime.sendMessage({
    type: "CANCEL_USER_INPUT",
    id: currentPendingInputId,
  });
  hideInputPrompt();
  if (statusEl) {
    statusEl.textContent = "running";
    statusEl.className = "badge running";
  }
});

function showDegradedCard(codes = []) {
  const degCard = document.getElementById("degradedCard");
  const degList = document.getElementById("degradedList");
  if (!degCard || !degList) return;
  if (Array.isArray(codes) && codes.length > 0) {
    degCard.style.display = "block";
    degList.textContent = "Capability degradation detected: " + Array.from(new Set(codes)).join(", ");
  } else {
    degCard.style.display = "none";
  }
}

async function checkDegradedCapabilities() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_AUDIT_LOG" });
    if (res && Array.isArray(res.steps)) {
      const allDegraded = [];
      res.steps.forEach((s) => {
        if (Array.isArray(s.degradedCapabilities)) {
          allDegraded.push(...s.degradedCapabilities);
        }
      });
      showDegradedCard(allDegraded);
    }
  } catch (e) {}
}

// --- Initialize State on Popup Open ---
chrome.runtime.sendMessage({ type: "GET_CONTROL_CENTER_STATE" }, (res) => {
  if (res) {
    setModeUI(res.agentMode);
    updateOfflineUI(res.offlineMode);
    renderAllowedDomains(res.allowedDomains);
    renderProtectedTerms(res.protectedTerms);
    if (maxStepsInput && res.userMaxSteps) maxStepsInput.value = res.userMaxSteps;
    if (maxRuntimeInput && res.maxRuntimeMs) maxRuntimeInput.value = Math.round(res.maxRuntimeMs / 1000);
    renderRunHistory(res.runHistory);
    if (res.pendingApproval) renderApprovalCard(res.pendingApproval);
    if (res.pendingInput) renderInputPrompt(res.pendingInput);
    if (res.running) {
      if (statusEl) {
        statusEl.textContent = "running";
        statusEl.className = "badge running";
      }
    }
    checkDegradedCapabilities();
  }
});

// --- Incoming Runtime Message Listener ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AGENT_LOG") log(msg.text, msg.ok !== false);
  if (msg.type === "STEP_PROGRESS") {
    updateStepProgress(msg.step, msg.maxSteps);
    checkDegradedCapabilities();
  }
  if (msg.type === "ACTION_BLOCKED") {
    showBlockCard(msg.decision);
  }
  if (msg.type === "ACTION_PREVIEW") {
    if (statusEl) {
      statusEl.textContent = "previewing";
      statusEl.className = "badge running";
    }
  }
  if (msg.type === "AGENT_APPROVAL_REQUEST") {
    renderApprovalCard(msg.request);
  }
  if (msg.type === "AGENT_APPROVAL_RESOLVED") {
    hideApprovalCard();
  }
  if (msg.type === "RUN_HISTORY_UPDATED") {
    renderRunHistory(msg.history);
  }
  if (msg.type === "AGENT_PAUSED") {
    if (statusEl) {
      statusEl.textContent = "paused";
      statusEl.className = "badge paused";
    }
    if (resumeBtn) resumeBtn.style.display = "block";
    log(`PAUSED: ${msg.reason}. Complete action on page, then click 'Resume'.`, false);
  }
  if (msg.type === "AGENT_INPUT_REQUEST") {
    renderInputPrompt(msg.request);
  }
  if (msg.type === "AGENT_INPUT_RESOLVED") {
    hideInputPrompt();
    if (statusEl) {
      statusEl.textContent = "running";
      statusEl.className = "badge running";
    }
  }
});

// --- Telemetry stats ---
const statsEl = document.getElementById("stats");
function updateStats() {
  if (performance.memory) {
    const usedMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
    if (statsEl) statsEl.textContent = `JS heap: ${usedMB} MB (Inference & perception monitored live)`;
  }
}
updateStats();
setInterval(updateStats, 2500);

// --- Privacy Policy Selector ---
const policySelect = document.getElementById("policySelect");
chrome.runtime.sendMessage({ type: "GET_PRIVACY_POLICY" }, (res) => {
  if (res && res.policy && policySelect) policySelect.value = res.policy;
});

policySelect?.addEventListener("change", (e) => {
  const policy = e.target.value;
  chrome.runtime.sendMessage({ type: "SET_PRIVACY_POLICY", policy });
});

// --- Network Payload Inspector ---
const refreshNetBtn = document.getElementById("refreshNet");
const netThumb = document.getElementById("netThumb");
const netJson = document.getElementById("netJson");

refreshNetBtn?.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "GET_NETWORK_INSPECTOR" });
  if (res && res.payload) {
    const payload = res.payload;
    if (payload.screenshotThumbnail && netThumb) {
      netThumb.src = payload.screenshotThumbnail;
      netThumb.style.display = "block";
    }
    const cleanPayload = { ...payload };
    delete cleanPayload.screenshotThumbnail;
    if (netJson) {
      netJson.textContent = JSON.stringify(cleanPayload, null, 2);
      netJson.style.display = "block";
    }
  } else {
    if (netJson) {
      netJson.textContent = "No network transmission recorded yet for this session.";
      netJson.style.display = "block";
    }
    if (netThumb) netThumb.style.display = "none";
  }
});

// --- Export Helper ---
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("exportAudit")?.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "GET_AUDIT_LOG" });
  const steps = res ? res.steps : [];
  downloadJson({ exportTime: new Date().toISOString(), steps }, "audit_log.json");
});

// --- Saved Profile (autofill) ---
const PROFILE_KEY = "savedProfile";
let currentSavedPhoto = null;

async function loadProfile() {
  try {
    await chrome.runtime.sendMessage({ type: "SYNC_USER_DOCS_PROFILE" });
  } catch (e) {}
  const data = await chrome.storage.local.get([PROFILE_KEY, "profile"]);
  const profile = data[PROFILE_KEY] || data.profile || {};
  const removedFields = Array.isArray(profile._removedFields) ? profile._removedFields : [];
  const nameEl = document.getElementById("profileName");
  const emailEl = document.getElementById("profileEmail");
  const phoneEl = document.getElementById("profilePhone");
  if (nameEl) nameEl.value = (!removedFields.includes("name") && profile.name) ? profile.name : "";
  if (emailEl) emailEl.value = (!removedFields.includes("email") && profile.email) ? profile.email : "";
  if (phoneEl) phoneEl.value = (!removedFields.includes("phone") && profile.phone) ? profile.phone : "";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AGENT_PROFILE_UPDATED" && msg.profile) {
    const removedFields = Array.isArray(msg.profile._removedFields) ? msg.profile._removedFields : [];
    const nameEl = document.getElementById("profileName");
    const emailEl = document.getElementById("profileEmail");
    const phoneEl = document.getElementById("profilePhone");
    if (nameEl && !removedFields.includes("name")) nameEl.value = msg.profile.name || "";
    if (emailEl && !removedFields.includes("email")) emailEl.value = msg.profile.email || "";
    if (phoneEl && !removedFields.includes("phone")) phoneEl.value = msg.profile.phone || "";
  }
});

document.getElementById("saveProfile")?.addEventListener("click", async () => {
  const data = await chrome.storage.local.get([PROFILE_KEY, "profile"]);
  const existing = { ...(data.profile || {}), ...(data[PROFILE_KEY] || {}) };
  const removedFields = Array.isArray(existing._removedFields) ? [...existing._removedFields] : [];

  const nameVal = document.getElementById("profileName")?.value.trim() || "";
  const emailVal = document.getElementById("profileEmail")?.value.trim() || "";
  const phoneVal = document.getElementById("profilePhone")?.value.trim() || "";

  const profile = {
    _derivedFrom: { ...(existing._derivedFrom || {}) },
    _removedFields: removedFields,
  };

  if (nameVal) {
    profile.name = nameVal;
    const idx = profile._removedFields.indexOf("name");
    if (idx >= 0) profile._removedFields.splice(idx, 1);
  } else {
    delete profile.name;
    delete profile._derivedFrom.name;
    if (!profile._removedFields.includes("name")) profile._removedFields.push("name");
  }

  if (emailVal) {
    profile.email = emailVal;
    const idx = profile._removedFields.indexOf("email");
    if (idx >= 0) profile._removedFields.splice(idx, 1);
  } else {
    delete profile.email;
    delete profile._derivedFrom.email;
    if (!profile._removedFields.includes("email")) profile._removedFields.push("email");
  }

  if (phoneVal) {
    profile.phone = phoneVal;
    const idx = profile._removedFields.indexOf("phone");
    if (idx >= 0) profile._removedFields.splice(idx, 1);
  } else {
    delete profile.phone;
    delete profile._derivedFrom.phone;
    if (!profile._removedFields.includes("phone")) profile._removedFields.push("phone");
  }

  await chrome.storage.local.set({ [PROFILE_KEY]: profile, profile: profile });
  await chrome.runtime.sendMessage({
    type: "PROFILE_MANUALLY_SAVED",
    profile,
    removedFields: profile._removedFields,
  }).catch(() => {});

  const profileStatusEl = document.getElementById("profileStatus");
  if (profileStatusEl) {
    const removedCount = profile._removedFields.length;
    profileStatusEl.textContent = removedCount > 0 ? `Saved locally (removed ${profile._removedFields.join(", ")}).` : "Saved locally.";
    setTimeout(() => { profileStatusEl.textContent = ""; }, 2500);
  }
});
loadProfile();

// --- Attached Files for Forms ---
const fileUploadInput = document.getElementById("fileUploadInput");
const fileLabelInput = document.getElementById("fileLabel");
const fileUploadStatus = document.getElementById("fileUploadStatus");
const userFilesList = document.getElementById("userFilesList");
const clearAllFilesBtn = document.getElementById("clearAllFilesBtn");

async function renderUserFiles() {
  if (!userFilesList) return;
  const res = await chrome.runtime.sendMessage({ type: "GET_USER_FILES" });
  const files = (res && res.files) || [];

  if (files.length === 0) {
    userFilesList.innerHTML = '<span class="hint">No files attached. Default sample photo will be used for photo uploads.</span>';
    return;
  }

  userFilesList.innerHTML = files
    .map(
      (f) => `
    <div style="display: flex; justify-content: space-between; align-items: center; background: #020617; border: 1px solid #334155; border-radius: 4px; padding: 4px 6px; margin-bottom: 3px;">
      <div>
        <strong style="color: #38bdf8;">${escapeHtml(f.label || f.name)}</strong>
        <span style="font-size: 9.5px; color: #94a3b8;">(${escapeHtml(f.name)})</span>
      </div>
      <button class="secondary btn-del-file" data-id="${escapeHtml(f.id)}" style="width: auto; margin: 0; padding: 2px 6px; font-size: 10px; color: #f87171;">✕</button>
    </div>
  `
    )
    .join("");

  userFilesList.querySelectorAll(".btn-del-file").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const fileId = e.target.dataset.id;
      await chrome.runtime.sendMessage({ type: "DELETE_USER_FILE", id: fileId });
      await renderUserFiles();
    });
  });
}

fileUploadInput?.addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  const label = fileLabelInput?.value.trim() || "";
  const extractedSummaries = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileId = "file_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const dataUrl = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(file);
    });

    const fileRecord = {
      id: fileId,
      name: file.name,
      label: label || (file.type.startsWith("image/") ? "photo" : "document"),
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      blob: file,
      dataUrl: dataUrl,
    };

    if (typeof saveUserFile === "function") {
      try { await saveUserFile(fileRecord); } catch (err) {}
    }
    const res = await chrome.runtime.sendMessage({ type: "SAVE_USER_FILE", fileData: fileRecord }).catch(() => {});
    if (res && res.docParsed && res.docParsed.profile) {
      const p = res.docParsed.profile;
      if (p.name || p.email) {
        extractedSummaries.push(`${file.name}: ${p.name || ""}${p.email ? ` (${p.email})` : ""}`);
      }
    }
  }

  if (fileUploadStatus) {
    if (extractedSummaries.length > 0) {
      fileUploadStatus.innerHTML = `<span style="color: #38bdf8; font-weight: 500;">✓ Attached & extracted: ${escapeHtml(extractedSummaries.join(", "))}</span>`;
    } else {
      fileUploadStatus.textContent = `Attached ${files.length} file(s).`;
    }
  }
  if (fileLabelInput) fileLabelInput.value = "";
  fileUploadInput.value = "";
  await renderUserFiles();
  await loadProfile();
  const profileDetails = document.getElementById("profileDetails");
  if (profileDetails && extractedSummaries.length > 0) {
    profileDetails.open = true;
  }
});

clearAllFilesBtn?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_ALL_USER_DATA" });
  await renderUserFiles();
  if (fileUploadStatus) fileUploadStatus.textContent = "All files removed.";
});
renderUserFiles();

// --- Server Request Secret (Security) ---
const secretBox = document.getElementById("secretBox");
let currentSecret = "";
chrome.runtime.sendMessage({ type: "GET_SERVER_SECRET" }, (res) => {
  currentSecret = (res && res.secret) || "";
  if (secretBox) secretBox.textContent = currentSecret || "unavailable";
});

document.getElementById("copySecret")?.addEventListener("click", async () => {
  if (!currentSecret) return;
  await navigator.clipboard.writeText(currentSecret);
  const btn = document.getElementById("copySecret");
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = "Copy secret"; }, 1500);
});

// --- Judge Mode Checklist ---
function setCheck(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = "check-icon " + (state === true ? "pass" : state === false ? "fail" : "idle");
  el.textContent = state === true ? "\u2705" : state === false ? "\u274C" : "\u2014";
  if (label) el.parentElement.querySelector("span:last-child").textContent = label;
}

async function refreshJudge() {
  const res = await chrome.runtime.sendMessage({ type: "GET_JUDGE_STATE" });
  const s = res && res.state;
  const hint = document.getElementById("judgeHint");

  if (!s || !s.ran) {
    if (hint) hint.textContent = "No run recorded yet — start a task, then refresh.";
    ["chkDOM", "chkVision", "chkGate", "chkVal", "chkToken"].forEach((id) => setCheck(id, null));
    return;
  }

  if (hint) hint.textContent = `Derived from the last run (${s.steps} step${s.steps === 1 ? "" : "s"}).`;
  setCheck("chkDOM", s.domRedaction, "DOM PII regions detected & redacted");
  setCheck(
    "chkVision",
    s.visionActive,
    s.visionActive ? `Local ONNX vision ran on-device (${s.visionBackend})` : "Local ONNX vision model did not run"
  );
  setCheck(
    "chkGate",
    s.gateVerified,
    s.gateBlocked ? "Privacy gate BLOCKED a transmission" : "Privacy gate verified pixels before send"
  );
  setCheck(
    "chkVal",
    s.validatorActive,
    s.validatorRejections > 0 ? `Action validator rejected ${s.validatorRejections} action(s)` : "Action allowlist validator enforced"
  );
  setCheck("chkToken", s.noRawPii, "No raw field values transmitted");
}

document.getElementById("refreshJudge")?.addEventListener("click", refreshJudge);
refreshJudge();
