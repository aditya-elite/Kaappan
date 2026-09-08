/**
 * policy_engine.js — Centralized Policy & Safety Engine for SIH26171 Browser Agent
 *
 * Deterministic priority order:
 *  1. Structural validity of action (Action Validator)
 *  2. Website Lock (Domain Allowlist)
 *  3. Step limits
 *  4. Runtime limits
 *  5. Privacy gate verification
 *  6. Action sensitivity assessment
 *  7. Agent Mode check (Guarded / Supervised / Preview)
 *  8. Decision dispatch: ALLOW / ASK / BLOCK / PREVIEW
 *
 * Exposes clean, standardized decision objects with stable machine-readable reason codes.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PolicyEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const REASON_CODES = {
    DOMAIN_NOT_ALLOWED: "DOMAIN_NOT_ALLOWED",
    STEP_LIMIT_REACHED: "STEP_LIMIT_REACHED",
    RUNTIME_LIMIT_REACHED: "RUNTIME_LIMIT_REACHED",
    PRIVACY_GATE_FAILED: "PRIVACY_GATE_FAILED",
    SENSITIVE_ACTION_REQUIRES_APPROVAL: "SENSITIVE_ACTION_REQUIRES_APPROVAL",
    UNGROUNDED_DATA: "UNGROUNDED_DATA",
    PREVIEW_MODE: "PREVIEW_MODE",
    USER_REJECTED: "USER_REJECTED",
    INVALID_ACTION: "INVALID_ACTION",
  };

  const SENSITIVE_KEYWORDS = [
    "submit",
    "send",
    "apply",
    "confirm",
    "order",
    "purchase",
    "checkout",
    "pay",
    "payment",
    "delete",
    "remove",
    "destroy",
    "terminate",
    "cancel subscription",
  ];

  /**
   * Normalizes a URL or hostname to a clean, lowercase domain string.
   * Gracefully handles file://, localhost, ports, protocols, and IP addresses.
   */
  function normalizeHostname(urlOrHostname) {
    if (!urlOrHostname || typeof urlOrHostname !== "string") return "";
    let s = urlOrHostname.trim();
    if (!s) return "";

    // Handle local file protocol
    if (s.startsWith("file://") || s.startsWith("file:/")) {
      return "localhost";
    }

    // Try parsing as full URL
    try {
      if (!s.includes("://")) {
        s = "https://" + s;
      }
      const parsed = new URL(s);
      let host = parsed.hostname.toLowerCase();
      // Remove IPv6 brackets if present
      host = host.replace(/^\[|\]$/g, "");
      return host;
    } catch (e) {
      // Fallback: strip port and leading slashes
      const cleaned = urlOrHostname
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        .split(":")[0]
        .toLowerCase()
        .trim();
      return cleaned;
    }
  }

  /**
   * Checks whether a hostname/URL is allowed by the allowedDomains list.
   * Enforces strict hostname boundary matching (prevents lookalike domains such as
   * evil-example.com matching example.com).
   */
  function isDomainAllowed(urlOrHostname, allowedDomains) {
    if (!allowedDomains || !Array.isArray(allowedDomains) || allowedDomains.length === 0) {
      return true; // Unrestricted if not configured or empty
    }

    const host = normalizeHostname(urlOrHostname);
    if (!host) return false;

    // Wildcard allows everything
    if (allowedDomains.some((d) => String(d).trim() === "*")) {
      return true;
    }

    return allowedDomains.some((allowed) => {
      const normAllowed = normalizeHostname(String(allowed).trim());
      if (!normAllowed) return false;

      // Exact match
      if (host === normAllowed) return true;

      // Subdomain match: host must end with .normAllowed
      if (host.endsWith("." + normAllowed)) {
        return true;
      }

      return false;
    });
  }

  /**
   * Determines whether an action is classified as sensitive (high risk).
   */
  function isSensitiveAction(action, targetElement = null) {
    if (!action || typeof action !== "object") return false;

    // File uploads are always sensitive
    if (action.action === "upload") return true;

    // Form submission keywords in click actions
    if (action.action === "click") {
      const sel = (action.selector || "").toLowerCase();
      const label = (action.semanticLabel || "").toLowerCase();
      const elText = ((targetElement?.text || "") + " " + (targetElement?.semanticLabel || "")).toLowerCase();
      const elType = (targetElement?.type || "").toLowerCase();

      if (elType === "submit") return true;

      const combined = `${sel} ${label} ${elText}`;
      for (const kw of SENSITIVE_KEYWORDS) {
        // Match whole word or prominent token
        const regex = new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`, "i");
        if (regex.test(combined)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Evaluates an action proposal against the centralized safety policy.
   *
   * @param {Object} ctx
   * @param {Object} ctx.action Proposed action { action, selector, value, ... }
   * @param {string} ctx.currentUrl Current page URL
   * @param {string} ctx.task Task description
   * @param {string} ctx.mode Agent mode: "guarded" | "supervised" | "preview"
   * @param {number} ctx.stepCount Current step number (1-based)
   * @param {number} ctx.maxSteps Maximum allowed steps
   * @param {number} [ctx.startTime] Task start timestamp (ms)
   * @param {number} [ctx.maxRuntimeMs] Maximum task duration (ms)
   * @param {Object} [ctx.privacyGateResult] Result from verifyPrivacyGate
   * @param {Object} [ctx.configuration] Additional policy settings { allowedDomains, ... }
   * @param {Array} [ctx.elements] Page elements for target inspection
   *
   * @returns {Object} Policy decision
   */
  function evaluateAction(ctx = {}) {
    const {
      action,
      currentUrl = "",
      task = "",
      mode = "guarded",
      stepCount = 1,
      maxSteps = 15,
      startTime = null,
      maxRuntimeMs = null,
      privacyGateResult = null,
      configuration = {},
      elements = [],
    } = ctx;

    const timestamp = new Date().toISOString();
    const actionDesc = action
      ? `${action.action || "unknown"} ${action.selector || action.fileId || ""}`.trim()
      : "none";

    // 1. Structural validity check
    if (!action || typeof action !== "object" || !action.action) {
      return {
        allowed: false,
        decision: "BLOCK",
        reasonCode: REASON_CODES.INVALID_ACTION,
        policy: "Action Validator",
        message: "The proposed action was malformed or missing an action verb.",
        action: actionDesc,
        timestamp,
      };
    }

    // Done and scroll are safe internal completions, but domain and limits still apply
    const isTerminal = action.action === "done";

    // 2. Website Lock (Domain Allowlist)
    const allowedDomains = configuration.allowedDomains || [];
    if (allowedDomains.length > 0 && currentUrl) {
      if (!isDomainAllowed(currentUrl, allowedDomains)) {
        const host = normalizeHostname(currentUrl);
        return {
          allowed: false,
          decision: "BLOCK",
          reasonCode: REASON_CODES.DOMAIN_NOT_ALLOWED,
          policy: "Website Lock",
          message: `The current website '${host || currentUrl}' is not in the allowed-domain list.`,
          action: actionDesc,
          timestamp,
        };
      }
    }

    // 3. Step Limits
    if (typeof maxSteps === "number" && maxSteps > 0) {
      if (stepCount > maxSteps) {
        return {
          allowed: false,
          decision: "BLOCK",
          reasonCode: REASON_CODES.STEP_LIMIT_REACHED,
          policy: "Step Limit",
          message: `Maximum step limit reached (${stepCount - 1} / ${maxSteps}). Automation stopped.`,
          action: actionDesc,
          timestamp,
        };
      }
    }

    // 4. Runtime Limits
    if (startTime && typeof maxRuntimeMs === "number" && maxRuntimeMs > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed > maxRuntimeMs) {
        return {
          allowed: false,
          decision: "BLOCK",
          reasonCode: REASON_CODES.RUNTIME_LIMIT_REACHED,
          policy: "Runtime Limit",
          message: `Maximum task runtime limit reached (${Math.round(elapsed / 1000)}s / ${Math.round(maxRuntimeMs / 1000)}s).`,
          action: actionDesc,
          timestamp,
        };
      }
    }

    // 5. Privacy Gate Verification
    if (privacyGateResult && privacyGateResult.ok === false && !privacyGateResult.allowFallback) {
      return {
        allowed: false,
        decision: "BLOCK",
        reasonCode: REASON_CODES.PRIVACY_GATE_FAILED,
        policy: "Privacy Gate",
        message: `Privacy gate rejected transmission: ${privacyGateResult.reason || "Pixel verification failed"}`,
        action: actionDesc,
        timestamp,
      };
    }

    // If action is "done", no DOM execution is needed
    if (isTerminal) {
      return {
        allowed: true,
        decision: "ALLOW",
        reasonCode: null,
        policy: null,
        message: "Task marked complete by agent.",
        action: actionDesc,
        timestamp,
      };
    }

    // Target element inspection
    const targetElement = action.selector
      ? elements.find((e) => e.selector === action.selector)
      : null;

    // 6. Agent Mode Evaluation
    const normalizedMode = String(mode || "guarded").toLowerCase();

    // Mode: PREVIEW
    if (normalizedMode === "preview") {
      return {
        allowed: false,
        decision: "PREVIEW",
        reasonCode: REASON_CODES.PREVIEW_MODE,
        policy: "Agent Mode",
        message: `Preview mode: Planned action [${actionDesc}] displayed for inspection. No browser actions are executed.`,
        action: actionDesc,
        timestamp,
      };
    }

    // Mode: SUPERVISED
    if (normalizedMode === "supervised") {
      const sensitive = isSensitiveAction(action, targetElement);
      if (sensitive) {
        return {
          allowed: false,
          decision: "ASK",
          reasonCode: REASON_CODES.SENSITIVE_ACTION_REQUIRES_APPROVAL,
          policy: "Action Safety",
          message: `Sensitive action [${actionDesc}] requires explicit user approval before execution.`,
          action: actionDesc,
          timestamp,
        };
      }
    }

    // Mode: GUARDED (Default) — Sensitive actions (submit, pay, delete, order, upload) require approval
    // unless explicitly disabled via configuration.disableSubmitApproval
    if (normalizedMode === "guarded") {
      const disableApproval = Boolean(configuration && configuration.disableSubmitApproval);
      if (!disableApproval) {
        const sensitive = isSensitiveAction(action, targetElement);
        if (sensitive) {
          return {
            allowed: false,
            decision: "ASK",
            reasonCode: REASON_CODES.SENSITIVE_ACTION_REQUIRES_APPROVAL,
            policy: "Action Safety",
            message: `Sensitive action [${actionDesc}] requires explicit user approval before execution.`,
            action: actionDesc,
            timestamp,
          };
        }
      }
    }

    // All checks passed, safely allowed
    return {
      allowed: true,
      decision: "ALLOW",
      reasonCode: null,
      policy: null,
      message: "Action validated and approved by policy engine.",
      action: actionDesc,
      timestamp,
    };
  }

  const SCREEN_STATES = {
    LOGIN_SIGNUP: "LOGIN_SIGNUP",
    CHECKOUT_PAYMENT: "CHECKOUT_PAYMENT",
    GENERAL_FORM: "GENERAL_FORM",
    CONTENT_BROWSING: "CONTENT_BROWSING",
  };

  /**
   * Classifies the current screen based on interactive elements, input types, and DOM text.
   * elements: Array of element descriptors from scanPage
   * pageText: Optional string of visible page text
   */
  function classifyScreenState(elements = [], pageText = "") {
    let hasPassword = false;
    let hasCardOrCvv = false;
    let hasAuthTerms = false;
    let hasPaymentTerms = false;
    let formInputCount = 0;

    const lowerPage = (pageText || "").toLowerCase();

    for (const el of elements) {
      const type = (el.type || "").toLowerCase();
      const role = (el.role || "").toLowerCase();
      const text = (el.text || "").toLowerCase();
      const label = (el.label || el.semanticLabel || "").toLowerCase();
      const placeholder = (el.placeholder || "").toLowerCase();
      const combined = `${text} ${label} ${placeholder} ${el.selector || ""}`.toLowerCase();

      if (type === "password" || role === "password") {
        hasPassword = true;
      }

      if (
        type === "password" ||
        /\b(login|signin|sign-in|log-in|signup|sign-up|register|auth|credentials|mfa|otp)\b/.test(combined)
      ) {
        hasAuthTerms = true;
      }

      if (
        /\b(card[-_\s]?number|cvv|cvc|expir|credit[-_\s]?card|debit[-_\s]?card|upi|billing|checkout|payment|cart)\b/.test(combined)
      ) {
        hasCardOrCvv = true;
        hasPaymentTerms = true;
      }

      if (["input", "select", "textarea"].includes((el.tag || "").toLowerCase()) || el.type) {
        formInputCount++;
      }
    }

    if (hasPassword || hasAuthTerms) {
      return SCREEN_STATES.LOGIN_SIGNUP;
    }
    if (hasCardOrCvv || hasPaymentTerms || /\b(billing address|checkout|payment details|order summary)\b/.test(lowerPage)) {
      return SCREEN_STATES.CHECKOUT_PAYMENT;
    }
    if (formInputCount >= 2) {
      return SCREEN_STATES.GENERAL_FORM;
    }
    return SCREEN_STATES.CONTENT_BROWSING;
  }

  /**
   * Calculates the escalated agent mode and privacy policy based on screen state.
   */
  function getEscalatedPolicy(screenState, currentAgentMode = "guarded", currentPrivacyPolicy = "balanced") {
    let effectiveMode = currentAgentMode;
    let effectivePolicy = currentPrivacyPolicy;
    let escalated = false;

    if (screenState === SCREEN_STATES.LOGIN_SIGNUP || screenState === SCREEN_STATES.CHECKOUT_PAYMENT) {
      // Escalate supervised -> guarded
      if (effectiveMode === "supervised") {
        effectiveMode = "guarded";
        escalated = true;
      }
      // Escalate permissive -> balanced (or balanced -> strict on checkout)
      if (effectivePolicy === "permissive") {
        effectivePolicy = "balanced";
        escalated = true;
      } else if (screenState === SCREEN_STATES.CHECKOUT_PAYMENT && effectivePolicy === "balanced") {
        effectivePolicy = "strict";
        escalated = true;
      }
    }

    return {
      screenState,
      effectiveMode,
      effectivePolicy,
      escalated,
    };
  }

  return {
    REASON_CODES,
    SENSITIVE_KEYWORDS,
    SCREEN_STATES,
    normalizeHostname,
    isDomainAllowed,
    isSensitiveAction,
    evaluateAction,
    classifyScreenState,
    getEscalatedPolicy,
  };
});
