// eval/test-policy-engine.js — Automated Unit Tests for Policy Engine

const assert = require("assert");
const path = require("path");

const {
  REASON_CODES,
  SCREEN_STATES,
  normalizeHostname,
  isDomainAllowed,
  isSensitiveAction,
  evaluateAction,
  classifyScreenState,
  getEscalatedPolicy,
} = require(path.join(__dirname, "../extension/policy_engine.js"));

console.log("=== Running Policy Engine Unit Tests ===");

// 1. Test Domain Normalization & Allowlist (Website Lock)
console.log("\n[Test 1] Website Lock & Domain Verification");
assert.strictEqual(normalizeHostname("https://example.com/form"), "example.com");
assert.strictEqual(normalizeHostname("http://sub.demo.org:8000/test"), "sub.demo.org");
assert.strictEqual(normalizeHostname("file:///C:/test.html"), "localhost");

const allowed = ["example.com", "forms.example.com", "localhost"];
assert.strictEqual(isDomainAllowed("https://example.com/app", allowed), true, "example.com should be allowed");
assert.strictEqual(isDomainAllowed("https://forms.example.com/login", allowed), true, "forms.example.com should be allowed");
assert.strictEqual(isDomainAllowed("https://sub.example.com/page", allowed), true, "subdomain of example.com should be allowed");
assert.strictEqual(isDomainAllowed("http://localhost:8000/demo", allowed), true, "localhost should be allowed");

// CRITICAL SECURITY TEST: Prevent lookalike attacks
assert.strictEqual(isDomainAllowed("https://evil-example.com/steal", allowed), false, "evil-example.com MUST BE BLOCKED");
assert.strictEqual(isDomainAllowed("https://notexample.com/steal", allowed), false, "notexample.com MUST BE BLOCKED");
assert.strictEqual(isDomainAllowed("https://attacker.org/hack", allowed), false, "attacker.org MUST BE BLOCKED");
console.log("✓ Website lock tests passed!");

// 2. Test evaluateAction: Website Lock Enforcement
console.log("\n[Test 2] Policy Engine Domain Block Evaluation");
const blockedDomainRes = evaluateAction({
  action: { action: "click", selector: "#submit" },
  currentUrl: "https://evil-site.com/login",
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(blockedDomainRes.allowed, false);
assert.strictEqual(blockedDomainRes.decision, "BLOCK");
assert.strictEqual(blockedDomainRes.reasonCode, REASON_CODES.DOMAIN_NOT_ALLOWED);
assert.strictEqual(blockedDomainRes.policy, "Website Lock");
assert(blockedDomainRes.message.includes("evil-site.com"));
console.log("✓ Domain rejection produces explainable BLOCK decision!");

// 3. Test Step Limits
console.log("\n[Test 3] Step Limit Enforcement");
const step14Res = evaluateAction({
  action: { action: "type", selector: "#name", value: "John" },
  currentUrl: "https://trusted.com/app",
  stepCount: 14,
  maxSteps: 15,
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(step14Res.allowed, true);
assert.strictEqual(step14Res.decision, "ALLOW");

const step16Res = evaluateAction({
  action: { action: "type", selector: "#name", value: "John" },
  currentUrl: "https://trusted.com/app",
  stepCount: 16,
  maxSteps: 15,
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(step16Res.allowed, false);
assert.strictEqual(step16Res.decision, "BLOCK");
assert.strictEqual(step16Res.reasonCode, REASON_CODES.STEP_LIMIT_REACHED);
assert.strictEqual(step16Res.policy, "Step Limit");
console.log("✓ Step limits (14/15 allow, 16/15 block) verified!");

// 4. Test Runtime Limits
console.log("\n[Test 4] Runtime Limit Enforcement");
const now = Date.now();
const runtimeRes = evaluateAction({
  action: { action: "type", selector: "#name", value: "John" },
  currentUrl: "https://trusted.com/app",
  stepCount: 1,
  maxSteps: 15,
  startTime: now - 150000, // 150s ago
  maxRuntimeMs: 120000,    // 120s max
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(runtimeRes.allowed, false);
assert.strictEqual(runtimeRes.decision, "BLOCK");
assert.strictEqual(runtimeRes.reasonCode, REASON_CODES.RUNTIME_LIMIT_REACHED);
console.log("✓ Runtime limits verified!");

// 5. Test Privacy Gate Failure
console.log("\n[Test 5] Privacy Gate Integration");
const gateFailRes = evaluateAction({
  action: { action: "type", selector: "#name", value: "John" },
  currentUrl: "https://trusted.com/app",
  privacyGateResult: { ok: false, reason: "Unmasked pixel leak at (12, 34)", allowFallback: false },
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(gateFailRes.allowed, false);
assert.strictEqual(gateFailRes.decision, "BLOCK");
assert.strictEqual(gateFailRes.reasonCode, REASON_CODES.PRIVACY_GATE_FAILED);
assert.strictEqual(gateFailRes.policy, "Privacy Gate");
console.log("✓ Privacy gate failure blocks execution!");

// 6. Test Agent Modes (Guarded, Supervised, Preview)
console.log("\n[Test 6] Agent Modes Evaluation");
// Guarded mode — non-sensitive action -> ALLOW
const guardedRes = evaluateAction({
  action: { action: "type", selector: "#email", value: "test@example.com" },
  currentUrl: "https://trusted.com/app",
  mode: "guarded",
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(guardedRes.allowed, true);
assert.strictEqual(guardedRes.decision, "ALLOW");

// Guarded mode — sensitive action (Submit application click) -> ASK (Default Guarded Mode Approval)
const guardedSubmitRes = evaluateAction({
  action: { action: "click", selector: "#submit-btn", semanticLabel: "Submit Application" },
  currentUrl: "https://trusted.com/app",
  mode: "guarded",
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(guardedSubmitRes.allowed, false);
assert.strictEqual(guardedSubmitRes.decision, "ASK");
assert.strictEqual(guardedSubmitRes.reasonCode, REASON_CODES.SENSITIVE_ACTION_REQUIRES_APPROVAL);

// Guarded mode — sensitive action with disableSubmitApproval: true -> ALLOW
const guardedBypassRes = evaluateAction({
  action: { action: "click", selector: "#submit-btn", semanticLabel: "Submit Application" },
  currentUrl: "https://trusted.com/app",
  mode: "guarded",
  configuration: { allowedDomains: ["trusted.com"], disableSubmitApproval: true },
});
assert.strictEqual(guardedBypassRes.allowed, true);
assert.strictEqual(guardedBypassRes.decision, "ALLOW");

// Supervised mode with low risk action -> ALLOW
const supervisedSafeRes = evaluateAction({
  action: { action: "type", selector: "#email", value: "test@example.com" },
  currentUrl: "https://trusted.com/app",
  mode: "supervised",
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(supervisedSafeRes.allowed, true);
assert.strictEqual(supervisedSafeRes.decision, "ALLOW");

// Supervised mode with sensitive action (Submit application click) -> ASK
const supervisedSubmitRes = evaluateAction({
  action: { action: "click", selector: "#submit-btn", semanticLabel: "Submit Application" },
  currentUrl: "https://trusted.com/app",
  mode: "supervised",
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(supervisedSubmitRes.allowed, false);
assert.strictEqual(supervisedSubmitRes.decision, "ASK");
assert.strictEqual(supervisedSubmitRes.reasonCode, REASON_CODES.SENSITIVE_ACTION_REQUIRES_APPROVAL);
assert.strictEqual(supervisedSubmitRes.policy, "Action Safety");

// Supervised mode with upload action -> ASK
const supervisedUploadRes = evaluateAction({
  action: { action: "upload", selector: "#resume", fileId: "file_123" },
  currentUrl: "https://trusted.com/app",
  mode: "supervised",
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(supervisedUploadRes.allowed, false);
assert.strictEqual(supervisedUploadRes.decision, "ASK");

// Preview mode -> PREVIEW
const previewRes = evaluateAction({
  action: { action: "type", selector: "#email", value: "test@example.com" },
  currentUrl: "https://trusted.com/app",
  mode: "preview",
  configuration: { allowedDomains: ["trusted.com"] },
});
assert.strictEqual(previewRes.allowed, false);
assert.strictEqual(previewRes.decision, "PREVIEW");
assert.strictEqual(previewRes.reasonCode, REASON_CODES.PREVIEW_MODE);
assert.strictEqual(previewRes.policy, "Agent Mode");
console.log("✓ Guarded, Supervised, and Preview modes all verified!");

// 7. Test Structural Validity
console.log("\n[Test 7] Structural Validity");
const invalidRes = evaluateAction({
  action: null,
  currentUrl: "https://trusted.com/app",
});
assert.strictEqual(invalidRes.allowed, false);
assert.strictEqual(invalidRes.decision, "BLOCK");
assert.strictEqual(invalidRes.reasonCode, REASON_CODES.INVALID_ACTION);
// 8. Test Offline Reasoner
console.log("\n[Test 8] On-Device Offline Reasoner");
const { planOfflineAction } = require(path.join(__dirname, "../extension/mock_reasoner.js"));

const sampleElements = [
  { selector: "#name", tag: "input", type: "text", role: "name", isFilled: false },
  { selector: "#email", tag: "input", type: "email", role: "email", isFilled: false },
  { selector: "#submit-btn", tag: "button", type: "submit", text: "Submit Application", isFilled: false },
];

const act1 = planOfflineAction({ elements: sampleElements, recentActions: [] });
assert.strictEqual(act1.action, "type");
assert.strictEqual(act1.selector, "#name");
assert.strictEqual(act1.value, "{{name}}");

const act2 = planOfflineAction({ elements: sampleElements, recentActions: [{ action: "type", selector: "#name" }] });
assert.strictEqual(act2.action, "type");
assert.strictEqual(act2.selector, "#email");

const act3 = planOfflineAction({
  elements: sampleElements,
  recentActions: [
    { action: "type", selector: "#name" },
    { action: "type", selector: "#email" },
  ],
});
assert.strictEqual(act3.action, "click");
assert.strictEqual(act3.selector, "#submit-btn");

const act4 = planOfflineAction({
  elements: sampleElements,
  recentActions: [
    { action: "type", selector: "#name" },
    { action: "type", selector: "#email" },
    { action: "click", selector: "#submit-btn" },
  ],
});
assert.strictEqual(act4.action, "done");
console.log("✓ On-Device Offline Reasoner passed!");

// 9. Test Explainable Policy Block Structure
console.log("\n[Test 9] Explainable Block Payload Verification");
const blockResult = evaluateAction({
  action: { action: "click", selector: "#restricted" },
  currentUrl: "https://disallowed.com",
  configuration: { allowedDomains: ["approved.com"] },
});
assert.strictEqual(blockResult.allowed, false);
assert.strictEqual(typeof blockResult.decision, "string");
assert.strictEqual(typeof blockResult.reasonCode, "string");
assert.strictEqual(typeof blockResult.policy, "string");
assert.strictEqual(typeof blockResult.message, "string");
assert.strictEqual(typeof blockResult.action, "string");
assert.strictEqual(typeof blockResult.timestamp, "string");
console.log("✓ Explainable block structure fully compliant with spec!");
 
// 10. Test Screen-State Classifier & Dynamic Policy Escalation (P2.1)
console.log("\n[Test 10] Screen-State Classifier & Dynamic Safety Escalation");
const loginElements = [
  { tag: "input", type: "email", text: "Email address", placeholder: "you@domain.com" },
  { tag: "input", type: "password", text: "Password", placeholder: "Enter password" },
  { tag: "button", text: "Sign In", selector: "#login-btn" },
];
assert.strictEqual(classifyScreenState(loginElements), SCREEN_STATES.LOGIN_SIGNUP, "Password screen must classify as LOGIN_SIGNUP");

const checkoutElements = [
  { tag: "input", type: "text", text: "Card Number", placeholder: "1234 5678 9012 3456" },
  { tag: "input", type: "text", text: "CVV", placeholder: "123" },
  { tag: "button", text: "Pay Now", selector: "#pay-btn" },
];
assert.strictEqual(classifyScreenState(checkoutElements), SCREEN_STATES.CHECKOUT_PAYMENT, "Payment screen must classify as CHECKOUT_PAYMENT");

const generalElements = [
  { tag: "input", type: "text", text: "Search query", placeholder: "Search..." },
  { tag: "input", type: "text", text: "Filter location", placeholder: "City" },
];
assert.strictEqual(classifyScreenState(generalElements), SCREEN_STATES.GENERAL_FORM, "Multiple standard inputs must classify as GENERAL_FORM");

const contentElements = [
  { tag: "a", text: "Read more about privacy", selector: "#read-more" },
];
assert.strictEqual(classifyScreenState(contentElements), SCREEN_STATES.CONTENT_BROWSING, "Read-only elements must classify as CONTENT_BROWSING");

// Test Dynamic Policy Escalation
const escLogin = getEscalatedPolicy(SCREEN_STATES.LOGIN_SIGNUP, "supervised", "permissive");
assert.strictEqual(escLogin.escalated, true, "Login screen should trigger escalation");
assert.strictEqual(escLogin.effectiveMode, "guarded", "Supervised mode must escalate to guarded on login screen");
assert.strictEqual(escLogin.effectivePolicy, "balanced", "Permissive policy must escalate to balanced on login screen");

const escCheckout = getEscalatedPolicy(SCREEN_STATES.CHECKOUT_PAYMENT, "guarded", "balanced");
assert.strictEqual(escCheckout.escalated, true, "Checkout screen should trigger escalation");
assert.strictEqual(escCheckout.effectivePolicy, "strict", "Balanced policy must escalate to strict on checkout");

const escGeneral = getEscalatedPolicy(SCREEN_STATES.GENERAL_FORM, "supervised", "permissive");
assert.strictEqual(escGeneral.escalated, false, "General form should not trigger auto-escalation");
assert.strictEqual(escGeneral.effectiveMode, "supervised");
assert.strictEqual(escGeneral.effectivePolicy, "permissive");

console.log("✓ Screen-state classifier and dynamic safety escalation passed!");

console.log("\n✅ ALL POLICY ENGINE & REASONER UNIT TESTS PASSED SUCCESSFULLY!");
