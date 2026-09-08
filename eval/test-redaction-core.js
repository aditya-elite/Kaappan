// eval/test-redaction-core.js — Unit Tests for Pure Redaction & Geometry Core

const assert = require("assert");
const path = require("path");

const {
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
} = require(path.join(__dirname, "../extension/redaction_core.js"));

console.log("=== Running Redaction Core Unit Tests ===");

// 1. Reconciled Constants
console.log("\n[Test 1] Reconciled Constants Verification");
assert.strictEqual(REDACTION_PADDING_PX, 8, "Padding constant must be 8px");
assert.strictEqual(IOU_UNION_THRESHOLD, 0.25, "IoU union threshold must be 0.25 (live production constant)");
assert.strictEqual(CONTAINMENT_THRESHOLD, 0.6, "Containment threshold must be 0.6 (live production constant)");
console.log("✓ Reconciled constants verified: IoU=0.25, Containment=0.6, Padding=8px");

// 2. IoU & Overlap Math
console.log("\n[Test 2] IoU & Overlap Math");
const boxA = { x: 10, y: 10, width: 50, height: 50 };
const boxIdentical = { x: 10, y: 10, width: 50, height: 50 };
const boxDisjoint = { x: 100, y: 100, width: 50, height: 50 };
const boxPartial = { x: 35, y: 10, width: 50, height: 50 };
const boxNested = { x: 20, y: 20, width: 20, height: 20 };

assert.strictEqual(calculateIoU(boxA, boxIdentical), 1.0, "Identical boxes must have IoU = 1.0");
assert.strictEqual(calculateIoU(boxA, boxDisjoint), 0.0, "Disjoint boxes must have IoU = 0.0");
assert(calculateIoU(boxA, boxPartial) > 0 && calculateIoU(boxA, boxPartial) < 1.0, "Partial overlap IoU between 0 and 1");
assert.strictEqual(calculateIoU(boxA, boxNested), 400 / 2500, "Nested box IoU exact fraction check");
console.log("✓ IoU calculations passed!");

// 3. Fusion Union-Merge Logic
console.log("\n[Test 3] Fusion Union-Merge Logic");
const domRegs = [
  { x: 10, y: 10, width: 50, height: 50, kind: "email" },
  { x: 20, y: 20, width: 50, height: 50, kind: "password" },
  { x: 500, y: 500, width: 20, height: 20, kind: "phone" },
];

const fused = fuseRegions(domRegs, []);
assert.strictEqual(fused.length, 2, "Overlapping DOM regions must merge into 1 box; disjoint stays separate (total 2)");
assert.strictEqual(fused[0].x, 10);
assert.strictEqual(fused[0].y, 10);
assert.strictEqual(fused[0].width, 60);
assert.strictEqual(fused[0].height, 60);
console.log("✓ Fusion union-merge passed!");

// 4. Threshold Boundary Conditions (IoU & Containment Boundaries)
console.log("\n[Test 4] Fusion at Exactly the Threshold Boundary");
// Box A: (0, 0, 100, 100), Area = 10000.
// Box B: (w, 0, 100, 100), Overlap = (100 - w) * 100.
// At w = 60: Overlap = 4000, Union = 16000 -> IoU = 4000/16000 = 0.25 exactly.
// Containment = 4000/10000 = 0.40 (below 0.6).
// Strict boundary rule (iou > 0.25): IoU == 0.25 must NOT merge.
const bBase = { x: 0, y: 0, width: 100, height: 100 };
const bAtExactIoU = { x: 60, y: 0, width: 100, height: 100 };
assert.strictEqual(calculateIoU(bBase, bAtExactIoU), 0.25, "IoU must be exactly 0.25 at boundary");
const fusedAtExactIoU = fuseRegions([bBase, bAtExactIoU], []);
assert.strictEqual(fusedAtExactIoU.length, 2, "Boxes at exactly IoU = 0.25 threshold boundary do not merge under strict > 0.25");

// At w = 59: Overlap = 4100, Union = 15900 -> IoU = 4100/15900 = 0.25786 > 0.25. Must merge!
const bAboveIoU = { x: 59, y: 0, width: 100, height: 100 };
assert(calculateIoU(bBase, bAboveIoU) > 0.25, "IoU must be > 0.25");
const fusedAboveIoU = fuseRegions([bBase, bAboveIoU], []);
assert.strictEqual(fusedAboveIoU.length, 1, "Boxes above IoU threshold (0.2578 > 0.25) must merge");

// Containment boundary:
// Box A: (0, 0, 100, 100), Area = 10000.
// Box C: (0, y, 50, 50), Area = 2500, minArea = 2500.
// At y = 70: Overlap = 50 * (100 - 70) = 1500. Containment = 1500 / 2500 = 0.60 exactly.
// IoU = 1500 / (10000 + 2500 - 1500) = 1500 / 11000 = 0.136 (< 0.25).
const bAtExactContainment = { x: 0, y: 70, width: 50, height: 50 };
const overlapC = calculateOverlapArea(bBase, bAtExactContainment);
assert.strictEqual(overlapC / 2500, 0.6, "Containment must be exactly 0.60 at boundary");
const fusedAtExactCont = fuseRegions([bBase, bAtExactContainment], []);
assert.strictEqual(fusedAtExactCont.length, 2, "Boxes at exactly containment = 0.60 threshold boundary do not merge under strict > 0.6");

// At y = 69: Overlap = 50 * 31 = 1550. Containment = 1550 / 2500 = 0.62 > 0.60. Must merge!
const bAboveContainment = { x: 0, y: 69, width: 50, height: 50 };
const fusedAboveCont = fuseRegions([bBase, bAboveContainment], []);
assert.strictEqual(fusedAboveCont.length, 1, "Boxes above containment threshold (0.62 > 0.6) must merge");
console.log("✓ Fusion threshold boundary tests passed!");

// 5. Nested Rectangles
console.log("\n[Test 5] Nested Rectangles");
const outerBox = { x: 10, y: 10, width: 100, height: 100, kind: "outer" };
const innerBox1 = { x: 20, y: 20, width: 30, height: 30, kind: "inner1" };
const innerBox2 = { x: 40, y: 40, width: 10, height: 10, kind: "inner2" };

const fusedNested = fuseRegions([outerBox, innerBox1, innerBox2], []);
assert.strictEqual(fusedNested.length, 1, "Fully nested rectangles must merge into outer enclosing box");
assert.strictEqual(fusedNested[0].x, 10);
assert.strictEqual(fusedNested[0].y, 10);
assert.strictEqual(fusedNested[0].width, 100);
assert.strictEqual(fusedNested[0].height, 100);
console.log("✓ Nested rectangles merge passed!");

// 6. Zero-Area Rectangles
console.log("\n[Test 6] Zero-Area Rectangles");
const zeroW = { x: 50, y: 50, width: 0, height: 50 };
const zeroH = { x: 50, y: 50, width: 50, height: 0 };
const zeroBoth = { x: 50, y: 50, width: 0, height: 0 };
const validBox = { x: 10, y: 10, width: 100, height: 100 };

assert.strictEqual(calculateIoU(validBox, zeroW), 0, "IoU with zero-width box is 0");
assert.strictEqual(calculateIoU(validBox, zeroH), 0, "IoU with zero-height box is 0");
assert.strictEqual(calculateIoU(zeroBoth, zeroBoth), 0, "IoU between two zero-area boxes is 0");
assert.strictEqual(calculateOverlapArea(validBox, zeroBoth), 0, "Overlap with zero-area box is 0");

const fusedZero = fuseRegions([validBox, zeroBoth], []);
assert.strictEqual(fusedZero.length, 2, "Zero-area box must not falsely merge into valid box");
assert(!Number.isNaN(fusedZero[0].width) && !Number.isNaN(fusedZero[1].width), "No NaN values in fusion results");
console.log("✓ Zero-area rectangle handling passed!");

// 7. CSS <-> Device Pixel Scaling & Round-Trip Stability (dpr 1, 1.5, 2, 3)
console.log("\n[Test 7] CSS <-> Device Pixel Scaling & Round-Trip Stability");
const dprList = [1, 1.5, 2, 3];
const testCssBoxes = [
  { x: 100, y: 50, width: 200, height: 40, kind: "dom", extraProp: "keepMe" },
  { x: 17, y: 33, width: 105, height: 47, kind: "email" },
  { x: 3, y: 7, width: 15, height: 12, kind: "phone" },
];

dprList.forEach((dpr) => {
  testCssBoxes.forEach((orig) => {
    const dev = toDevice(orig, dpr);
    assert.strictEqual(dev.x, Math.round(orig.x * dpr), `toDevice x at dpr ${dpr}`);
    assert.strictEqual(dev.width, Math.round(orig.width * dpr), `toDevice width at dpr ${dpr}`);
    assert.strictEqual(dev.kind, orig.kind, `toDevice preserves kind at dpr ${dpr}`);
    if (orig.extraProp) {
      assert.strictEqual(dev.extraProp, orig.extraProp, "toDevice preserves metadata properties");
    }

    const cssBack = toCss(dev, dpr);
    assert(Math.abs(cssBack.x - orig.x) <= 1, `Round trip x accuracy within 1px at dpr ${dpr}`);
    assert(Math.abs(cssBack.width - orig.width) <= 1, `Round trip width accuracy within 1px at dpr ${dpr}`);
  });
});
console.log("✓ CSS <-> Device pixel round-trip stability passed across DPR 1, 1.5, 2, 3!");

// 8. Outward Padding & Image Edge Clamping
console.log("\n[Test 8] Outward Redaction Padding & Edge Clamping");
const normalBox = { x: 50, y: 50, width: 100, height: 40 };
const padded = calculateRedactionPadding(normalBox, REDACTION_PADDING_PX, 1000, 1000);
assert.strictEqual(padded.x, 42, "Padded x expands outward (50 - 8 = 42)");
assert.strictEqual(padded.y, 42, "Padded y expands outward (50 - 8 = 42)");
assert.strictEqual(padded.width, 116, "Padded width expands by padding*2 (100 + 16 = 116)");
assert.strictEqual(padded.height, 56, "Padded height expands by padding*2 (40 + 16 = 56)");

// Edge clamping at top-left
const nearOriginBox = { x: 2, y: 3, width: 50, height: 50 };
const paddedOrigin = calculateRedactionPadding(nearOriginBox, 8, 500, 500);
assert.strictEqual(paddedOrigin.x, 0, "Padded x clamped at image left edge 0");
assert.strictEqual(paddedOrigin.y, 0, "Padded y clamped at image top edge 0");

// Edge clamping at bottom-right (rects extending past bounds)
const nearEdgeBox = { x: 750, y: 550, width: 100, height: 100 };
const paddedEdge = calculateRedactionPadding(nearEdgeBox, 8, 800, 600);
assert.strictEqual(paddedEdge.x, 742, "Padded x = 750 - 8 = 742");
assert.strictEqual(paddedEdge.y, 542, "Padded y = 550 - 8 = 542");
assert.strictEqual(paddedEdge.width, 58, "Padded width clamped so 742 + 58 = 800 (does not exceed image width)");
assert.strictEqual(paddedEdge.height, 58, "Padded height clamped so 542 + 58 = 600 (does not exceed image height)");
assert(paddedEdge.x + paddedEdge.width <= 800, "Redaction box does not exceed canvas width");
assert(paddedEdge.y + paddedEdge.height <= 600, "Redaction box does not exceed canvas height");

// Negative coordinate box
const negativeBox = { x: -20, y: -20, width: 60, height: 60 };
const paddedNeg = calculateRedactionPadding(negativeBox, 8, 800, 600);
assert.strictEqual(paddedNeg.x, 0, "Negative x clamped to 0");
assert.strictEqual(paddedNeg.y, 0, "Negative y clamped to 0");
console.log("✓ Redaction padding and edge clamping passed!");

// 9. Privacy Gate Verification (Pure Pixel Buffer Sampling)
console.log("\n[Test 9] Privacy Gate Verification Sampling");

// Case 9a: Every sampled pixel is pure black (Passed)
const blackPixels = (x, y) => ({ r: 0, g: 0, b: 0, a: 255 });
const samplePass = sampleGatePixels(blackPixels, 800, 600, [{ x: 20, y: 20, width: 100, height: 30 }]);
assert.strictEqual(samplePass.ok, true, "Gate passes when all sampled pixels are black");
assert.strictEqual(samplePass.sampled, 5, "5 sample points checked per region");

// Case 9b: Detecting a single non-black pixel (Fail closed)
// Sub-case: Unmasked pixel at corner (22, 22) with RGB 16 (just above dark threshold 15)
const leakCorner = (x, y) => (x === 22 && y === 22 ? { r: 16, g: 0, b: 0, a: 255 } : { r: 0, g: 0, b: 0, a: 255 });
const failCorner = sampleGatePixels(leakCorner, 800, 600, [{ x: 20, y: 20, width: 100, height: 30 }]);
assert.strictEqual(failCorner.ok, false, "Gate fails when a single corner pixel has R=16 (> 15)");
assert(failCorner.reason.includes("Unmasked pixel"), "Reason contains 'Unmasked pixel'");

// Sub-case: Unmasked pixel at center
const leakCenter = (x, y) => (x === 70 && y === 35 ? { r: 0, g: 255, b: 0, a: 255 } : { r: 0, g: 0, b: 0, a: 255 });
const failCenter = sampleGatePixels(leakCenter, 800, 600, [{ x: 20, y: 20, width: 100, height: 30 }]);
assert.strictEqual(failCenter.ok, false, "Gate fails when a single center pixel is unmasked");

// Sub-case: Threshold boundary RGB 15 (permissible dark threshold)
const thresholdDark = (x, y) => ({ r: 15, g: 15, b: 15, a: 255 });
const passThresholdDark = sampleGatePixels(thresholdDark, 800, 600, [{ x: 20, y: 20, width: 100, height: 30 }]);
assert.strictEqual(passThresholdDark.ok, true, "Pixels <= 15 on all channels pass the dark check");

// Case 9c: Fail closed on malformed buffers
assert.strictEqual(sampleGatePixels(null, 800, 600, [{ x: 10, y: 10, width: 50, height: 50 }]).ok, false, "Fails closed on null pixel function");
assert.strictEqual(sampleGatePixels(blackPixels, 0, 600, [{ x: 10, y: 10, width: 50, height: 50 }]).ok, false, "Fails closed on zero width");
assert.strictEqual(sampleGatePixels(blackPixels, 800, 0, [{ x: 10, y: 10, width: 50, height: 50 }]).ok, false, "Fails closed on zero height");
assert.strictEqual(sampleGatePixels(blackPixels, -800, 600, [{ x: 10, y: 10, width: 50, height: 50 }]).ok, false, "Fails closed on negative dimension");

// Sub-case: Exception inside reader function fails closed
const throwingBuffer = () => { throw new Error("GPU buffer detached"); };
const failThrow = sampleGatePixels(throwingBuffer, 800, 600, [{ x: 10, y: 10, width: 50, height: 50 }]);
assert.strictEqual(failThrow.ok, false, "Fails closed on throwing pixel accessor");
assert.strictEqual(failThrow.degradedCode, "GATE_CHECK_FAILED", "Surfaces GATE_CHECK_FAILED code");

// Sub-case: Geometry mismatch (regions completely outside image)
const offscreenRegion = [{ x: 2000, y: 2000, width: 100, height: 100 }];
const failMismatch = sampleGatePixels(blackPixels, 800, 600, offscreenRegion);
assert.strictEqual(failMismatch.ok, false, "Fails closed when sample count is zero (geometry mismatch)");
console.log("✓ Privacy gate verification tests passed!");

console.log("\n✅ ALL REDACTION CORE UNIT TESTS PASSED!");
