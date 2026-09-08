/**
 * mock_reasoner.js — On-Device Offline Reasoning Engine for SIH26171
 *
 * Provides realistic autonomous action proposals for offline demo mode without
 * calling any external cloud LLM or backend API.
 * Follows the exact element inspection contract as mock_main.py.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MockReasoner = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Plans the next logical action based on available DOM elements and previous action history.
   *
   * @param {Object} ctx
   * @param {Array} ctx.elements List of structural elements from scanPage()
   * @param {Array} ctx.recentActions History of executed actions in the current task
   * @param {Array} ctx.availableFiles Metadata list of user-attached files
   * @param {string} ctx.task User prompt / task description
   * @returns {Object} Structured action { action, selector, value?, fileId? }
   */
  function planOfflineAction(ctx = {}) {
    const elements = ctx.elements || [];
    const recentActions = ctx.recentActions || [];
    const availableFiles = ctx.availableFiles || [];
    const already = new Set(recentActions.map((a) => a.selector).filter(Boolean));

    // 1. Process unhandled interactive form elements
    for (const el of elements) {
      if (!el.selector) continue;
      if (el.isFilled) continue;
      if (already.has(el.selector)) continue;

      const tag = (el.tag || "").toLowerCase();
      const type = (el.type || "").toLowerCase();
      const text = ((el.text || "") + " " + (el.semanticLabel || "")).toLowerCase();
      const selLow = el.selector.toLowerCase();

      // A. File Upload Controls
      const isFileInput = tag === "input" && type === "file";
      const isUploadBtn =
        (tag === "button" || el.role === "button" || selLow.includes("upload") || selLow.includes("photo")) &&
        (text.includes("upload") || text.includes("attach") || text.includes("photo") || text.includes("browse") || selLow.includes("btn"));

      if (isFileInput || isUploadBtn) {
        if (availableFiles.length > 0) {
          let chosen = availableFiles[0];
          for (const f of availableFiles) {
            const fLabel = (f.label || "").toLowerCase();
            const fName = (f.name || "").toLowerCase();
            if ((text.includes("photo") || text.includes("avatar") || text.includes("image")) &&
                (fLabel.includes("photo") || fLabel.includes("image") || /\.(jpg|jpeg|png|webp)$/i.test(fName))) {
              chosen = f;
              break;
            }
            if ((text.includes("resume") || text.includes("cv") || text.includes("document")) &&
                (fLabel.includes("resume") || fLabel.includes("cv") || /\.(pdf|docx|txt)$/i.test(fName))) {
              chosen = f;
              break;
            }
          }
          return {
            action: "upload",
            selector: el.selector,
            fileId: chosen.id,
            semanticLabel: el.semanticLabel,
          };
        }
      }

      // Skip non-input elements for typing
      if (!["input", "textarea", "select"].includes(tag)) continue;

      // B. Named profile role fields (name, email, phone)
      const role = el.role;
      if (role === "name" || role === "email" || role === "phone") {
        return {
          action: "type",
          selector: el.selector,
          value: `{{${role}}}`,
          semanticLabel: el.semanticLabel,
        };
      }

      // C. Dropdowns (<select>)
      if (tag === "select" && el.options && el.options.length > 0) {
        const validOpt = el.options.find((o) => o.value && String(o.value).trim()) || el.options[0];
        return {
          action: "select",
          selector: el.selector,
          value: validOpt.value,
          semanticLabel: el.semanticLabel,
        };
      }

      // D. Checkboxes and radio buttons
      if (type === "checkbox" || el.role === "checkbox") {
        return {
          action: "check",
          selector: el.selector,
          value: true,
          semanticLabel: el.semanticLabel,
        };
      }

      // E. General text inputs and textareas
      const placeholder = (el.placeholder || "").toLowerCase();
      let fallbackValue = "Completed via Offline Agent";
      if (text.includes("experience") || placeholder.includes("year")) fallbackValue = "3";
      else if (text.includes("salary") || placeholder.includes("ctc")) fallbackValue = "85000";
      else if (text.includes("city") || text.includes("location")) fallbackValue = "Bangalore";
      else if (text.includes("company")) fallbackValue = "Acme Tech Solutions";

      return {
        action: "type",
        selector: el.selector,
        value: fallbackValue,
        semanticLabel: el.semanticLabel,
      };
    }

    // 2. All inputs handled -> Look for unclicked Submit / Apply button
    for (const el of elements) {
      if (!el.selector) continue;
      if (already.has(el.selector)) continue;

      const tag = (el.tag || "").toLowerCase();
      const type = (el.type || "").toLowerCase();
      const text = ((el.text || "") + " " + (el.semanticLabel || "")).toLowerCase();

      const isButton = tag === "button" || el.role === "button" || type === "submit";
      if (isButton && ["submit", "apply", "send", "confirm", "next", "register"].some((w) => text.includes(w))) {
        return {
          action: "click",
          selector: el.selector,
          semanticLabel: el.semanticLabel || el.text,
        };
      }
    }

    // 3. Nothing remaining -> Task finished
    return { action: "done" };
  }

  return { planOfflineAction };
});
