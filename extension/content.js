// content.js — runs in the page. Fast, reliable PII signal comes from DOM attributes
// (password fields, autocomplete hints, input types) rather than pixels alone.
//
// CHANGES vs previous version:
//   * scanPage() now reports devicePixelRatio so background.js can convert CSS-pixel
//     rects into the physical-pixel space that captureVisibleTab() actually returns.
//     Without this, every redaction box covered only the top-left 1/dpr of its target
//     on any scaled/retina display.
//   * Element descriptors no longer carry the raw `value` of inputs. A filled email or
//     phone field was previously transmitted verbatim inside the elements[] array, which
//     defeats the whole point of redacting it out of the screenshot. The agent only needs
//     to know *whether* a field is filled, not what's in it.

const SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[autocomplete*="email" i]',
  'input[autocomplete*="tel" i]',
  'input[autocomplete*="name" i]',
  'input[autocomplete*="address" i]',
  'input[autocomplete*="cc-" i]',      // credit card fields
  'input[autocomplete*="bday" i]',
  'input[name*="email" i]',
  'input[name*="phone" i]',
  'input[name*="mobile" i]',
  'input[name*="contact" i]',
  'input[name*="tel" i]',
  'input[name*="name" i]',
  'input[name*="first_name" i]',
  'input[name*="last_name" i]',
  'input[name*="fname" i]',
  'input[name*="lname" i]',
  'input[name*="ssn" i]',
  'input[name*="aadhaar" i]',
  'input[name*="passport" i]',
  'input[name*="pan" i]',
  'input[name*="license" i]',
  'input[name*="tax" i]',
  'input[name*="national" i]',
  'input[name*="card" i]',
  'input[name*="cvv" i]',
  'input[name*="cvc" i]',
  'input[name*="account" i]',
  'input[name*="routing" i]',
  'input[name*="address" i]',
  'input[name*="street" i]',
  'input[name*="city" i]',
  'input[name*="zip" i]',
  'input[name*="postal" i]',
  'input[name*="state" i]',
  'input[name*="dob" i]',
  'input[name*="birth" i]',
  'input[name*="bday" i]',
  'input[name*="salary" i]',
  'input[name*="ctc" i]',
  'input[name*="income" i]',
  'input[name*="compensation" i]',
  'textarea[name*="bio" i]',
  'textarea[name*="summary" i]',
  'textarea[name*="resume" i]',
  'textarea[name*="statement" i]',
  'textarea[name*="address" i]',
  'img[alt*="photo" i]',
  'img[alt*="face" i]',
  'img[alt*="avatar" i]',
  'img[alt*="profile" i]',
  'img[id*="photo" i]',
  'img[id*="avatar" i]',
  'img[class*="photo" i]',
  'img[class*="avatar" i]',
];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?<!\w)(?:(?:\+91|0)[-.\s]?)?[6-9]\d{4}\s?\d{5}\b|(?<!\w)(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|(?<!\w)[6-9]\d{9}\b/;
const AADHAAR_RE = /(?<!\d)[1-9]\d{3}\s?\d{4}\s?\d{4}(?!\s?\d)/;
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const CC_RE = /\b(?:\d{4}[ -]?){3}\d{4}\b/;

// Non-PII business identifiers to prevent false positive regex detections
const NON_PII_CONTEXT_RE = /\b(?:order\s*(?:#|no|id|num)?|trk|track|tracking|isbn|sku|invoice|inv|ref|model|serial|ticket)\b/i;
const TRACKING_OR_CODE_RE = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i;
const NON_PII_PREFIX_RE = /(?:order|ord|trk|track|tracking|isbn|sku|invoice|inv|ref|model|serial|ticket)\s*(?:#|no|id|num)?[:\s-]*$/i;
const NON_PII_SPAN_RE = /\b(?:order|ord|trk|track|tracking|isbn|sku|invoice|inv|ref|model|serial|ticket)\s*(?:#|no|id|num)?[:\s#]+(?:\d+(?:[ -]\d+)*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b/gi;

// Global variants for replace() in extractPageContent() — these need /g to redact ALL
// matches within a block, not just the first.
const EMAIL_RE_G = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE_G = /(?<!\w)(?:(?:\+91|0)[-.\s]?)?[6-9]\d{4}\s?\d{5}\b|(?<!\w)(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|(?<!\w)[6-9]\d{9}\b/g;
const AADHAAR_RE_G = /(?<!\d)[1-9]\d{3}\s?\d{4}\s?\d{4}(?!\s?\d)/g;
const PAN_RE_G = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
const CC_RE_G = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
  }
  if (msg.type === "SCAN_DOM" || msg.type === "LOCAL_PRIVACY_SCAN") {
    sendResponse(scanPage(msg.opts || {}));
  }
  if (msg.type === "GET_VIEWPORT") {
    sendResponse({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    });
  }
  if (msg.type === "FLASH_OVERLAY") {
    flashOverlay(msg.regions);
    sendResponse({ ok: true });
  }
  if (msg.type === "SCRAPE_CONTENT") {
    sendResponse(extractPageContent(msg.opts || {}));
  }
  if (msg.type === "SHOW_INPUT_PROMPT") {
    showInPageInputPrompt(msg.request);
    sendResponse({ ok: true });
  }
  if (msg.type === "DISMISS_INPUT_PROMPT") {
    dismissInPageInputPrompt();
    sendResponse({ ok: true });
  }
  return true; // keep the message channel open for async sendResponse
});

// Draws the same redaction boxes directly on the live page for ~1s so judges/users
// can *see* what's being blacked out before it's sent anywhere. The screenshot
// redaction (in background.js) is what actually protects the data; this is proof.
// Regions arrive here in CSS pixels — background.js converts back from device pixels.
let overlayEls = [];
function flashOverlay(regions) {
  overlayEls.forEach((el) => el.remove());
  overlayEls = [];

  for (const r of regions || []) {
    const box = document.createElement("div");
    box.style.cssText = `
      position: fixed; left: ${r.x}px; top: ${r.y}px;
      width: ${r.width}px; height: ${r.height}px;
      background: rgba(0,0,0,0.85); border: 2px solid #ff4d4d;
      z-index: 2147483647; pointer-events: none; border-radius: 3px;
    `;
    document.body.appendChild(box);
    overlayEls.push(box);
  }

  setTimeout(() => {
    overlayEls.forEach((el) => el.remove());
    overlayEls = [];
  }, 900);
}

// Deep DOM query helper to traverse open shadow roots and same-origin iframes
function queryAllDeep(selector, root = document) {
  const elements = [];
  try {
    elements.push(...Array.from(root.querySelectorAll(selector)));
  } catch (e) {
    // Ignore invalid selectors or context errors
  }

  try {
    const doc = root.ownerDocument || root;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.shadowRoot) {
        const shadowSel = selector.startsWith("body ") ? selector.slice(5) : selector;
        elements.push(...queryAllDeep(shadowSel, node.shadowRoot));
      }
      if (node.tagName === "IFRAME") {
        try {
          if (node.contentDocument) {
            elements.push(...queryAllDeep(selector, node.contentDocument));
          }
        } catch (e) {
          // Cross-origin iframe security boundary
        }
      }
    }
  } catch (e) {
    // Fail gracefully if tree walker encounters restrictions
  }
  return elements;
}

// Returns element bounding rect translated to top page coordinate space (handling iframes)
function getElementPageRect(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") {
    return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  let right = r.right;
  let bottom = r.bottom;

  let curWin = el.ownerDocument ? el.ownerDocument.defaultView : null;
  while (curWin && curWin !== window) {
    try {
      const frameEl = curWin.frameElement;
      if (frameEl) {
        const fr = frameEl.getBoundingClientRect();
        x += fr.left;
        y += fr.top;
        right += fr.left;
        bottom += fr.top;
        curWin = frameEl.ownerDocument ? frameEl.ownerDocument.defaultView : null;
      } else {
        break;
      }
    } catch (e) {
      break;
    }
  }

  return {
    x,
    y,
    left: x,
    top: y,
    width: r.width,
    height: r.height,
    right,
    bottom,
  };
}

function isInViewport(rect) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top < window.innerHeight &&
    rect.bottom >= 0 &&
    rect.left < window.innerWidth &&
    rect.right >= 0
  );
}

// Clip a rect to the visible viewport. Rects that hang off-screen would otherwise
// produce redaction boxes with negative origins, which silently no-op on canvas.
function clipToViewport(rect) {
  const x1 = Math.max(0, rect.x);
  const y1 = Math.max(0, rect.y);
  const x2 = Math.min(window.innerWidth, rect.x + rect.width);
  const y2 = Math.min(window.innerHeight, rect.y + rect.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// Prompt Injection Defense (P1.3): Detects hidden, transparent, zero-size, or camouflaged elements
function isHiddenOrAdversarial(el) {
  if (!el || typeof window === "undefined") return false;
  try {
    let curr = el;
    let depth = 0;
    while (curr && curr.nodeType === Node.ELEMENT_NODE && depth < 10) {
      if (window.getComputedStyle) {
        const style = window.getComputedStyle(curr);
        if (style) {
          if (style.display === "none") return true;
          if (style.visibility === "hidden" || style.visibility === "collapse") return true;
          const opacity = parseFloat(style.opacity || "1");
          if (!isNaN(opacity) && opacity <= 0.05) return true;
          const fontSize = parseFloat(style.fontSize || "16");
          if (!isNaN(fontSize) && fontSize <= 1) return true;

          // Check color camouflage (e.g. white on white, or identical text/bg colors)
          const color = (style.color || "").replace(/\s+/g, "").toLowerCase();
          const bgColor = (style.backgroundColor || "").replace(/\s+/g, "").toLowerCase();
          if (
            color &&
            bgColor &&
            color === bgColor &&
            color !== "rgba(0,0,0,0)" &&
            color !== "transparent"
          ) {
            return true;
          }
        }
      }
      curr = curr.parentElement;
      depth++;
    }

    // Check off-screen or zero-dimension coordinates
    if (typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return true;
      if (r.right < -50 || r.bottom < -50 || r.left > (window.innerWidth || 1920) + 1000 || r.top > (window.innerHeight || 1080) + 10000) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function scanPage(opts = {}) {
  const regions = [];
  const elements = [];
  const seenRegions = new Set();

  const counts = {
    passwords: 0,
    emails: 0,
    phones: 0,
    sensitiveTexts: 0,
    protectedTerms: 0,
    formsScanned: 0,
    imagesScanned: 0,
  };

  const protectedTerms = (opts && Array.isArray(opts.protectedTerms))
    ? opts.protectedTerms.map((t) => String(t).trim()).filter((t) => t.length >= 2)
    : [];

  function addRegion(clipped, kind) {
    if (!clipped) return;
    const key = `${Math.round(clipped.x)},${Math.round(clipped.y)},${Math.round(clipped.width)},${Math.round(clipped.height)}`;
    if (!seenRegions.has(key)) {
      seenRegions.add(key);
      regions.push({ ...clipped, kind });
    }
  }

  // 1. Sensitive elements -> bounding boxes to redact in the screenshot
  queryAllDeep(SENSITIVE_SELECTORS.join(",")).forEach((el) => {
    const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    const isPassword = el.type === "password" || (el.name || "").toLowerCase().includes("pass");
    const hasValue = isInput ? (el.value || "").trim().length > 0 : (el.innerText || "").trim().length > 0;

    // Only redact non-password inputs if they currently contain a value (prevents redacting empty inputs)
    if (isInput && !isPassword && !hasValue) {
      return;
    }

    const rect = getElementPageRect(el);
    if (!isInViewport(rect)) return;
    const clipped = clipToViewport(rect);
    if (clipped) {
      addRegion(clipped, "dom-sensitive");
      const t = (el.type || "").toLowerCase();
      const n = (el.name || "").toLowerCase();
      if (isPassword) counts.passwords++;
      else if (t === "email" || n.includes("email")) counts.emails++;
      else if (t === "tel" || n.includes("phone") || n.includes("mobile") || n.includes("tel")) counts.phones++;
      else counts.sensitiveTexts++;
    }
  });

  // 2. Automatically mask all confidential data being filled into form inputs & textareas
  queryAllDeep("input, textarea, [contenteditable='true']").forEach((el) => {
    const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    const isSpecial = el.type === "submit" || el.type === "button" || el.type === "reset" ||
                      el.type === "checkbox" || el.type === "radio" || el.type === "file" || el.type === "hidden";
    if (isInput && isSpecial) return;

    counts.formsScanned++;
    const val = isInput ? (el.value || "").trim() : (el.innerText || "").trim();
    if (val.length > 0) {
      const rect = getElementPageRect(el);
      if (!isInViewport(rect)) return;
      const clipped = clipToViewport(rect);
      if (clipped) {
        addRegion(clipped, "dom-filled");
        counts.sensitiveTexts++;
      }
    }
  });

  // 3. Infer profile role or label sensitivity on any input/textarea
  queryAllDeep("input, textarea").forEach((el) => {
    const isPassword = el.type === "password" || (el.name || "").toLowerCase().includes("pass");
    const hasValue = (el.value || "").trim().length > 0;
    if (!isPassword && !hasValue) return;

    const labelText = getElementLabel(el);
    const role = inferProfileRole(el, labelText);
    if (role) {
      const rect = getElementPageRect(el);
      if (!isInViewport(rect)) return;
      const clipped = clipToViewport(rect);
      if (clipped) addRegion(clipped, "dom-sensitive");
    }
  });

  // 4. Regex sweep over visible leaf text nodes, input values & placeholders for emails/phones/IDs/cards
  queryAllDeep("body *").forEach((el) => {
    const isLeaf = el.children.length === 0;
    const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    if (!isLeaf && !isInput) return;
    if (isHiddenOrAdversarial(el)) return;

    // Skip script/style elements
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return;

    const textContent = isLeaf ? (el.innerText || "") : "";
    const valContent = isInput ? (el.value || "") : "";
    const placeholderContent = isInput ? (el.placeholder || el.getAttribute("placeholder") || "") : "";

    const candidateTexts = [textContent, valContent, placeholderContent].filter((t) => t && t.length >= 5);
    for (const content of candidateTexts) {
      const trimmed = content.trim();

      // Check if text is non-PII order/tracking/reference identifier
      if (NON_PII_CONTEXT_RE.test(trimmed) || TRACKING_OR_CODE_RE.test(trimmed)) {
        continue;
      }

      if (
        EMAIL_RE.test(trimmed) || PHONE_RE.test(trimmed) ||
        AADHAAR_RE.test(trimmed) || PAN_RE.test(trimmed) || CC_RE.test(trimmed)
      ) {
        const rect = getElementPageRect(el);
        if (!isInViewport(rect)) return;
        const clipped = clipToViewport(rect);
        if (clipped) {
          addRegion(clipped, "regex-text");
          if (EMAIL_RE.test(trimmed)) counts.emails++;
          else if (PHONE_RE.test(trimmed)) counts.phones++;
          else counts.sensitiveTexts++;
          break;
        }
      }
    }
  });

  // 4.5 Explicitly tagged PII elements (e.g. canvas or custom containers tagged with data-pii)
  queryAllDeep("[data-pii]:not([data-pii='none'])").forEach((el) => {
    const rect = getElementPageRect(el);
    if (!isInViewport(rect)) return;
    const clipped = clipToViewport(rect);
    if (clipped) {
      addRegion(clipped, "dom-tagged-pii");
      const cat = (el.getAttribute("data-pii") || "").toLowerCase();
      if (cat === "password") counts.passwords++;
      else if (cat === "email") counts.emails++;
      else if (cat === "phone") counts.phones++;
      else counts.sensitiveTexts++;
    }
  });

  // 5. User-Configured Protected Terms sweep
  if (protectedTerms.length > 0) {
    queryAllDeep("body *").forEach((el) => {
      const isLeaf = el.children.length === 0;
      const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
      if (!isLeaf && !isInput) return;

      const textContent = isLeaf ? (el.innerText || "") : "";
      const valContent = isInput ? (el.value || "") : "";
      const placeholderContent = isInput ? (el.placeholder || el.getAttribute("placeholder") || "") : "";
      const ariaContent = el.getAttribute("aria-label") || "";

      const candidateTexts = [textContent, valContent, placeholderContent, ariaContent].filter((t) => t && t.length >= 2);
      for (const content of candidateTexts) {
        for (const term of protectedTerms) {
          const regex = new RegExp(`(^|[^a-zA-Z0-9])(${escapeRegExp(term)})([^a-zA-Z0-9]|$)`, "i");
          if (regex.test(content)) {
            const rect = getElementPageRect(el);
            if (!isInViewport(rect)) continue;
            const clipped = clipToViewport(rect);
            if (clipped) {
              addRegion(clipped, "protected-term");
              counts.protectedTerms++;
              break;
            }
          }
        }
      }
    });
  }

  // Non-sensitive structural elements the agent is allowed to act on.
  // NOTE: we deliberately do NOT include el.value here — see file header.
  queryAllDeep(
    "button, a, input:not([type=password]), select, textarea, [role=button], " +
    "[role=combobox], [role=checkbox], [role=radio], [role=option], [contenteditable='true']"
  ).forEach((el) => {
    if (elements.length >= 200) return; // cap payload size
    if (isHiddenOrAdversarial(el)) return; // P1.3 client-side prompt injection scrubber
    const rect = el.getBoundingClientRect();
    const isFileInput = el.tagName === "INPUT" && el.type === "file";
    if (!isFileInput && !isInViewport(rect)) return;

    const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    const curVal = isInput ? (el.value || "") : "";
    const labelText = getElementLabel(el);
    const placeholder = el.placeholder || "";

    // Visible text for buttons/links or associated question label for inputs
    let textVal = "";
    if (isInput) {
      textVal = labelText || placeholder;
    } else {
      const inner = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (labelText && inner && !inner.toLowerCase().includes(labelText.toLowerCase()) && !labelText.toLowerCase().includes(inner.toLowerCase())) {
        textVal = `${labelText}: ${inner}`;
      } else {
        textVal = inner || labelText || placeholder;
      }
    }
    textVal = textVal.slice(0, 120).trim();

    let isFilled = isInput
      ? Boolean(curVal.trim() && (el.tagName !== "SELECT" || el.selectedIndex > 0))
      : Boolean(el.isContentEditable && el.innerText.trim());

    if (!isFilled && (isFileInput || el.getAttribute("role") === "button" || el.tagName === "BUTTON")) {
      const card = el.closest('[role="listitem"], .Qr7Oae, .geSdp, [data-item-id], .form-group, .form-field');
      if (card) {
        const hasAttachment = card.querySelector('[aria-label*="Remove" i], [aria-label*="Clear" i], button[aria-label*="Remove" i], [role="button"][aria-label*="Remove" i]');
        if (hasAttachment && (textVal.toLowerCase().includes("upload") || textVal.toLowerCase().includes("add file") || isFileInput)) {
          isFilled = true;
        }
      }
    }

    // For <select>, the chosen label is not PII and helps the model avoid re-selecting.
    const selectedLabel =
      el.tagName === "SELECT" && el.selectedIndex > 0
        ? (el.options[el.selectedIndex].text || "").slice(0, 60)
        : undefined;

    const roleVal = inferProfileRole(el, labelText);

    elements.push({
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      type: el.type ? el.type.toLowerCase() : undefined,
      text: textVal,
      placeholder: placeholder.slice(0, 60),
      isFilled: isFilled,
      valueLength: curVal.length,          // length only — never the contents
      selectedLabel: selectedLabel,
      semanticLabel: `${el.tagName.toLowerCase()}:${roleVal || textVal}`,
      role: roleVal,
      accept: isFileInput ? (el.accept || undefined) : undefined,
      multiple: isFileInput ? Boolean(el.multiple) : undefined,
      options: el.tagName === "SELECT"
        ? Array.from(el.options).map((o) => ({ value: o.value, label: o.text })).slice(0, 30)
        : undefined,
    });
  });

  // All rendered <img> elements, as candidates for face detection.
  const imageRegions = [];
  queryAllDeep("img, canvas, video").forEach((el) => {
    const rect = getElementPageRect(el);
    if (rect.width > 20 && rect.height > 20 && isInViewport(rect)) {
      const clipped = clipToViewport(rect);
      if (clipped) imageRegions.push(clipped);
    }
  });

  // OCR candidates (P1.1): all <canvas> elements and large <img> elements (>150x50 px)
  const ocrCandidates = [];
  queryAllDeep("canvas").forEach((el) => {
    const rect = getElementPageRect(el);
    if (rect.width >= 20 && rect.height >= 10 && isInViewport(rect)) {
      const clipped = clipToViewport(rect);
      if (clipped) ocrCandidates.push({ ...clipped, kind: "canvas" });
    }
  });
  queryAllDeep("img").forEach((el) => {
    const rect = getElementPageRect(el);
    if (rect.width > 150 && rect.height > 50 && isInViewport(rect)) {
      const clipped = clipToViewport(rect);
      if (clipped) ocrCandidates.push({ ...clipped, kind: "image" });
    }
  });

  let isTopFrame = window === window.top;
  let frameOffset = isTopFrame ? { x: 0, y: 0 } : null;
  if (!isTopFrame) {
    try {
      if (window.frameElement) {
        const frameRect = window.frameElement.getBoundingClientRect();
        frameOffset = { x: frameRect.left, y: frameRect.top };
      }
    } catch (e) {
      // Cross-origin boundary — cannot read frameElement
      frameOffset = null;
    }
  }

  return {
    regions,
    elements,
    imageRegions,
    ocrCandidates,
    categories: {
      passwords: counts.passwords,
      emails: counts.emails,
      phones: counts.phones,
      sensitiveTexts: counts.sensitiveTexts,
      protectedTerms: counts.protectedTerms,
      formsScanned: counts.formsScanned,
      imagesScanned: imageRegions.length,
      ocrCandidatesCount: ocrCandidates.length,
      totalDomRegions: regions.length,
    },
    isTopFrame,
    frameOffset,
    // Critical: captureVisibleTab() returns physical pixels, these rects are CSS pixels.
    dpr: window.devicePixelRatio || 1,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

// Extracts human-readable question or field label across standard forms, Google Forms, React/Vue/Angular
function getElementLabel(el) {
  // 1. aria-labelledby (e.g. Google Forms, accessible custom UI)
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const texts = labelledBy.split(/\s+/).map((id) => {
      const target = document.getElementById(id);
      return target ? (target.innerText || target.textContent || "").trim() : "";
    }).filter(Boolean);
    if (texts.length > 0) return texts.join(" ");
  }

  // 2. aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // 3. Explicit label element for="id"
  if (el.id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) {
        const text = (label.innerText || label.textContent || "").trim();
        if (text) return text;
      }
    } catch (e) {}
  }

  // 4. Ancestor <label> wrapper
  const parentLabel = el.closest("label");
  if (parentLabel) {
    const text = (parentLabel.innerText || parentLabel.textContent || "").trim();
    if (text) return text;
  }

  // 5. Question container (e.g. Google Forms question card, form-group)
  const container = el.closest(
    '[role="listitem"], .Qr7Oae, .geSdp, [data-item-id], .freebirdFormviewerViewNumberedItemContainer, .form-group, .form-field, fieldset, tr, .field, [data-field]'
  );
  if (container) {
    const heading = container.querySelector(
      '[role="heading"], legend, label, .title, .header, th, dt, .label, [id*="title"], [class*="title"], .M7eMe, [aria-level]'
    );
    if (heading) {
      const text = (heading.innerText || heading.textContent || "").trim();
      if (text) return text;
    }
  }

  // 6. Preceding sibling label/text
  let prev = el.previousElementSibling;
  while (prev) {
    if (["LABEL", "SPAN", "DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6"].includes(prev.tagName)) {
      const text = (prev.innerText || prev.textContent || "").trim();
      if (text && text.length < 80) return text;
    }
    prev = prev.previousElementSibling;
  }

  return (el.placeholder || el.getAttribute("title") || el.name || "").trim();
}

// Guesses whether an input is meant for the user's own name/email/phone
function inferProfileRole(el, labelText = "") {
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return null;
  if (el.type === "password") return null;

  const combined = [
    el.name,
    el.id,
    el.autocomplete,
    el.placeholder,
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    labelText,
  ].filter(Boolean).join(" ").toLowerCase();

  if (el.type === "email" || /email/i.test(combined)) return "email";
  if (
    el.type === "tel" ||
    /phone|mobile|cell|telephone|contact|mobile_number|phone_number|phonenumber|mobilenumber|contactno|phoneno/i.test(combined)
  ) {
    return "phone";
  }
  if (/full_?name|first_?name|last_?name|\bname\b/i.test(combined)) return "name";
  return null;
}

// Generates guaranteed unique CSS selector by inspecting attributes and climbing DOM until unique.
// Supports piercing Shadow DOM roots with '>>>' syntax.
function cssPath(el) {
  if (!el) return "";
  try {
    const rootNode = el.getRootNode ? el.getRootNode() : null;
    if (rootNode && rootNode !== document && rootNode.host) {
      const hostSel = cssPath(rootNode.host);
      const innerSel = cssPathWithinRoot(el, rootNode);
      return `${hostSel} >>> ${innerSel}`;
    }
  } catch (e) {}
  return cssPathWithinRoot(el, document);
}

function cssPathWithinRoot(el, root = document) {
  // 1. Unique ID
  if (el.id) {
    try {
      const sel = `#${CSS.escape(el.id)}`;
      if (root.querySelectorAll(sel).length === 1) return sel;
    } catch (e) {}
  }

  // 2. Unique name attribute
  if (el.name) {
    try {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      if (root.querySelectorAll(sel).length === 1) return sel;
    } catch (e) {}
  }

  // 3. Unique aria-labelledby attribute
  const ariaLabelledBy = el.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    try {
      const sel = `${el.tagName.toLowerCase()}[aria-labelledby="${CSS.escape(ariaLabelledBy)}"]`;
      if (root.querySelectorAll(sel).length === 1) return sel;
    } catch (e) {}
  }

  // 4. Walk up DOM tree until selector matches uniquely within root
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== root && parts.length < 15) {
    let selector = node.tagName.toLowerCase();
    if (node.id) {
      try {
        const idSel = `#${CSS.escape(node.id)}`;
        if (root.querySelectorAll(idSel).length === 1) {
          parts.unshift(idSel);
          return parts.join(" > ");
        }
      } catch (e) {}
    }
    const role = node.getAttribute("role");
    if (role) {
      selector += `[role="${role}"]`;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => {
        if (c.tagName !== node.tagName) return false;
        if (role) return c.getAttribute("role") === role;
        return true;
      });
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(selector);
    const candidate = parts.join(" > ");
    try {
      if (root.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    } catch (e) {}
    node = parent;
  }
  return parts.join(" > ");
}

function redactTextBlock(text, tokenize) {
  if (!text || typeof text !== "string") return text;

  // 0. Temporarily mask out non-PII spans (orders, tracking numbers, ISBNs) so PII tokenizers never touch them
  const maskedSpans = [];
  let maskedText = text.replace(NON_PII_SPAN_RE, (match) => {
    const placeholder = `__KAAPPAN_NON_PII_${maskedSpans.length}__`;
    maskedSpans.push({ placeholder, original: match });
    return placeholder;
  });

  // Strict precedence order: EMAIL -> CARD -> AADHAAR -> PAN -> PHONE (longest first)
  let result = maskedText
    .replace(EMAIL_RE_G, tokenize("email"))
    .replace(CC_RE_G, tokenize("card_number"))
    .replace(AADHAAR_RE_G, tokenize("id_number"))
    .replace(PAN_RE_G, tokenize("pan"))
    .replace(PHONE_RE_G, tokenize("phone"));

  // Restore non-PII spans untokenised
  for (const item of maskedSpans) {
    result = result.replace(item.placeholder, item.original);
  }

  return result;
}

function redactTextBlocks(blocks, opts = {}, tokenizeFn = null) {
  const localTokenMap = {};
  let counter = 0;
  const tokenize = tokenizeFn || function (kind) {
    return (match) => {
      const token = `{{scraped_${kind}_${counter++}}}`;
      localTokenMap[token] = match;
      return token;
    };
  };

  let redactedBlocks = blocks.map((text) => redactTextBlock(text, tokenize));

  const protectedTerms = (opts && Array.isArray(opts.protectedTerms))
    ? opts.protectedTerms.map((t) => String(t).trim()).filter((t) => t.length >= 2)
    : [];

  if (protectedTerms.length > 0) {
    for (const term of protectedTerms) {
      const regex = new RegExp(`(^|[^a-zA-Z0-9])(${escapeRegExp(term)})([^a-zA-Z0-9]|$)`, "gi");
      redactedBlocks = redactedBlocks.map((b) =>
        b.replace(regex, (m, p1, p2, p3) => `${p1}${tokenize("protected_term")(p2)}${p3}`)
      );
    }
  }

  return { redactedBlocks, localTokenMap };
}

function extractPageContent(opts = {}) {
  const blocks = [];
  const selectors =
    "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, label, legend, figcaption, article, section, div, span";
  queryAllDeep(selectors).forEach((el) => {
    if (el.children.length > 3) return; // skip large container wrappers
    if (isHiddenOrAdversarial(el)) return; // P1.3 client-side prompt injection scrubber
    const text = el.innerText?.trim();
    if (text && text.length >= 10 && text.length < 2000) {
      if (!blocks.includes(text)) {
        blocks.push(text);
      }
    }
  });

  const { redactedBlocks, localTokenMap } = redactTextBlocks(blocks, opts);

  return {
    url: typeof location !== "undefined" ? location.href : "",
    title: (typeof document !== "undefined" && document.title) ? document.title : (typeof location !== "undefined" ? location.href : ""),
    blocks: redactedBlocks.slice(0, 300), // cap payload size
    localTokenMap,
    scrapedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// In-Page Interactive Prompt Modal (Zero-Guessing Enforcement)
// ---------------------------------------------------------------------------

function dismissInPageInputPrompt() {
  const existing = document.getElementById("sih-agent-prompt-modal");
  if (existing) existing.remove();
}

function showInPageInputPrompt(req) {
  dismissInPageInputPrompt();
  if (!req) return;

  // Highlight and scroll the target field into view if possible
  if (req.selector) {
    try {
      const target = document.querySelector(req.selector);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        const origOutline = target.style.outline;
        target.style.outline = "3px solid #3b82f6";
        target.style.outlineOffset = "2px";
        setTimeout(() => {
          try { target.style.outline = origOutline; } catch (e) {}
        }, 3000);
      }
    } catch (e) {}
  }

  const modal = document.createElement("div");
  modal.id = "sih-agent-prompt-modal";
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(15, 23, 42, 0.65);
    backdrop-filter: blur(4px);
    z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #f8fafc;
    box-sizing: border-box;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #0f172a;
    border: 1px solid rgba(255, 255, 255, 0.15);
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.6);
    border-radius: 12px;
    width: 440px;
    max-width: 90vw;
    padding: 22px 24px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 14px;
  `;

  const header = document.createElement("div");
  header.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
  header.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 16px; color: #38bdf8;">
      <span>🤖</span> <span>Agent Needs Your Input</span>
    </div>
    <div style="font-size: 12px; color: #94a3b8;">
      This field is not present in your saved profile or uploaded documents.
    </div>
  `;

  const questionLabel = document.createElement("label");
  questionLabel.style.cssText = "font-size: 14px; font-weight: 500; color: #e2e8f0; line-height: 1.4;";
  questionLabel.textContent = req.question || `Please provide a value for "${req.field}":`;

  let inputEl;
  if (req.inputType === "select" && req.options && req.options.length > 0) {
    inputEl = document.createElement("select");
    inputEl.style.cssText = `
      width: 100%; box-sizing: border-box; padding: 9px 12px;
      background: #1e293b; color: #f8fafc; border: 1px solid #475569;
      border-radius: 6px; font-size: 14px; outline: none; cursor: pointer;
    `;
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "-- Select an option --";
    inputEl.appendChild(defaultOpt);
    for (const opt of req.options) {
      const o = document.createElement("option");
      o.value = opt.value ?? opt.label;
      o.textContent = opt.label ?? opt.value;
      inputEl.appendChild(o);
    }
  } else {
    inputEl = document.createElement("input");
    inputEl.type = req.inputType || "text";
    inputEl.placeholder = `Enter ${req.field || "value"}...`;
    inputEl.style.cssText = `
      width: 100%; box-sizing: border-box; padding: 9px 12px;
      background: #1e293b; color: #f8fafc; border: 1px solid #475569;
      border-radius: 6px; font-size: 14px; outline: none;
    `;
  }

  const rememberContainer = document.createElement("label");
  rememberContainer.style.cssText = `
    display: flex; align-items: center; gap: 8px; font-size: 12px;
    color: #94a3b8; cursor: pointer; user-select: none;
  `;
  const rememberCheckbox = document.createElement("input");
  rememberCheckbox.type = "checkbox";
  rememberCheckbox.checked = true;
  rememberCheckbox.style.cursor = "pointer";
  rememberContainer.appendChild(rememberCheckbox);
  const rememberText = document.createElement("span");
  rememberText.textContent = "Remember this value for future runs";
  rememberContainer.appendChild(rememberText);

  const buttonRow = document.createElement("div");
  buttonRow.style.cssText = "display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px;";

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip Field (Esc)";
  skipBtn.style.cssText = `
    padding: 8px 14px; font-size: 13px; font-weight: 500;
    background: #334155; color: #cbd5e1; border: 1px solid #475569;
    border-radius: 6px; cursor: pointer;
  `;
  skipBtn.onmouseenter = () => (skipBtn.style.background = "#475569");
  skipBtn.onmouseleave = () => (skipBtn.style.background = "#334155");

  const submitBtn = document.createElement("button");
  submitBtn.textContent = "Submit & Fill (Enter)";
  submitBtn.style.cssText = `
    padding: 8px 16px; font-size: 13px; font-weight: 500;
    background: #2563eb; color: #ffffff; border: none;
    border-radius: 6px; cursor: pointer;
  `;
  submitBtn.onmouseenter = () => (submitBtn.style.background = "#1d4ed8");
  submitBtn.onmouseleave = () => (submitBtn.style.background = "#2563eb");

  buttonRow.appendChild(skipBtn);
  buttonRow.appendChild(submitBtn);

  card.appendChild(header);
  card.appendChild(questionLabel);
  card.appendChild(inputEl);
  card.appendChild(rememberContainer);
  card.appendChild(buttonRow);
  modal.appendChild(card);
  document.body.appendChild(modal);

  setTimeout(() => inputEl.focus(), 50);

  function doSubmit() {
    const val = inputEl.value.trim();
    if (!val && req.inputType === "select") {
      inputEl.style.borderColor = "#ef4444";
      return;
    }
    const remember = rememberCheckbox.checked;
    dismissInPageInputPrompt();
    chrome.runtime.sendMessage({
      type: "SUBMIT_USER_INPUT",
      id: req.id,
      value: val,
      remember: remember,
    }).catch(() => {});
  }

  function doSkip() {
    dismissInPageInputPrompt();
    chrome.runtime.sendMessage({
      type: "CANCEL_USER_INPUT",
      id: req.id,
    }).catch(() => {});
  }

  submitBtn.onclick = doSubmit;
  skipBtn.onclick = doSkip;

  inputEl.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSubmit();
    }
  };

  modal.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      doSkip();
    }
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    redactTextBlock,
    redactTextBlocks,
    extractPageContent,
    EMAIL_RE,
    PHONE_RE,
    AADHAAR_RE,
    PAN_RE,
    CC_RE,
    EMAIL_RE_G,
    PHONE_RE_G,
    AADHAAR_RE_G,
    PAN_RE_G,
    CC_RE_G,
    NON_PII_CONTEXT_RE,
    NON_PII_PREFIX_RE,
  };
}

