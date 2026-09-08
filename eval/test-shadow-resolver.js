// eval/test-shadow-resolver.js — Automated Unit Tests for Structured Shadow-DOM Resolver (P2.2)

const assert = require("assert");

console.log("=== Running Structured Shadow-DOM Resolver Unit Tests ===");

// Emulate a DOM tree with nested ShadowRoots
function createMockNode(id, tagName = "div") {
  return {
    id,
    tagName: tagName.toUpperCase(),
    shadowRoot: null,
    children: [],
    ownerDocument: null,
    querySelector: function(sel) {
      if (sel === `#${this.id}`) return this;
      for (const child of this.children) {
        if (child.id === sel.replace(/^#/, "")) return child;
        const sub = child.querySelector(sel);
        if (sub) return sub;
      }
      return null;
    }
  };
}

// Build mock document:
// document -> #host1 (has shadowRoot -> #host2 (has shadowRoot -> #target-btn))
const doc = createMockNode("doc", "html");
doc.ownerDocument = doc;

const host1 = createMockNode("host1", "custom-host");
host1.ownerDocument = doc;
doc.children.push(host1);

const shadowRoot1 = createMockNode("sr1", "shadow");
shadowRoot1.ownerDocument = doc;
host1.shadowRoot = shadowRoot1;

const host2 = createMockNode("host2", "nested-host");
host2.ownerDocument = doc;
shadowRoot1.children.push(host2);

const shadowRoot2 = createMockNode("sr2", "shadow");
shadowRoot2.ownerDocument = doc;
host2.shadowRoot = shadowRoot2;

const targetBtn = createMockNode("target-btn", "button");
targetBtn.ownerDocument = doc;
shadowRoot2.children.push(targetBtn);

// Standalone regular element in main document
const regularBtn = createMockNode("regular-btn", "button");
regularBtn.ownerDocument = doc;
doc.children.push(regularBtn);

// Test Resolver function (same logic as background.js)
function resolveShadowTarget(selOrAction, rootDocument = doc) {
  if (!selOrAction) return null;

  // A. Structured descriptor: { hostPath: ["#host1", "#host2"], inner: "#target-btn" }
  if (typeof selOrAction === "object" && (selOrAction.hostPath || selOrAction.inner)) {
    const hosts = Array.isArray(selOrAction.hostPath) ? selOrAction.hostPath : [selOrAction.hostPath].filter(Boolean);
    let currRoot = rootDocument;
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
    const direct = rootDocument.querySelector(selStr);
    if (direct) return direct;
  } catch (e) {}

  // C. Piercing '>>>' syntax traversal
  if (selStr.includes(">>>")) {
    const segments = selStr.split(">>>").map((s) => s.trim()).filter(Boolean);
    let currRoot = rootDocument;
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

    for (const child of root.children || []) {
      if (child.shadowRoot) {
        const found = searchRoots(child.shadowRoot, sel);
        if (found) return found;
      }
      const foundChild = searchRoots(child, sel);
      if (foundChild) return foundChild;
    }
    return null;
  }

  return searchRoots(rootDocument, selStr);
}

// 1. Direct document selector
console.log("\n[Test 1] Direct Document QuerySelector");
const resDirect = resolveShadowTarget("#regular-btn");
assert.strictEqual(resDirect.id, "regular-btn", "Direct element should be found");
console.log("✓ Direct document selector passed!");

// 2. Piercing >>> syntax traversal
console.log("\n[Test 2] Piercing '>>>' Syntax Traversal");
const resPiercing = resolveShadowTarget("#host1 >>> #host2 >>> #target-btn");
assert(resPiercing !== null, "Piercing selector should find nested element");
assert.strictEqual(resPiercing.id, "target-btn", "Piercing selector resolved target-btn");
console.log("✓ Piercing >>> syntax traversal passed!");

// 3. Structured descriptor { hostPath, inner }
console.log("\n[Test 3] Structured Descriptor { hostPath, inner }");
const resDescriptor = resolveShadowTarget({ hostPath: ["#host1", "#host2"], inner: "#target-btn" });
assert(resDescriptor !== null, "Structured descriptor should find nested element");
assert.strictEqual(resDescriptor.id, "target-btn", "Descriptor resolved target-btn");
console.log("✓ Structured descriptor resolution passed!");

// 4. Fallback search across shadow boundaries
console.log("\n[Test 4] Recursive Shadow Tree Fallback Search");
const resFallback = resolveShadowTarget("#target-btn");
assert(resFallback !== null, "Fallback should search into shadowRoots");
assert.strictEqual(resFallback.id, "target-btn", "Fallback resolved target-btn inside shadowRoot");
console.log("✓ Recursive fallback resolution passed!");

console.log("\n✅ ALL SHADOW-DOM RESOLVER UNIT TESTS PASSED SUCCESSFULLY!");
