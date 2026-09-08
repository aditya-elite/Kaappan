// eval/test-scoring.js — Automated Unit Tests for benchmark-scoring.js

const assert = require('assert');
const path = require('path');

// Import the scoring engine
const {
  calculateIoU,
  calculateOverlapArea,
  scoreDetection,
  scoreRedactionImageData,
  calculatePiiLeakRate,
  aggregateResourceMetrics,
  aggregateLatency
} = require(path.join(__dirname, '../extension/benchmark-scoring.js'));

console.log("=== Running Benchmark Scoring Unit Tests ===");

// 1. Test IoU Calculation
console.log("\n[Test 1] IoU Calculation");
const rect1 = { x: 10, y: 10, width: 100, height: 100 };
const rect2 = { x: 10, y: 10, width: 100, height: 100 };
const rect3 = { x: 60, y: 10, width: 100, height: 100 };
const rect4 = { x: 200, y: 200, width: 50, height: 50 };

assert.strictEqual(calculateIoU(rect1, rect2), 1.0, "Identical rects should have IoU = 1.0");
assert.strictEqual(calculateIoU(rect1, rect4), 0.0, "Disjoint rects should have IoU = 0.0");
const partialIoU = calculateIoU(rect1, rect3);
assert(partialIoU > 0.3 && partialIoU < 0.4, `Partial overlap IoU should be ~0.333, got ${partialIoU}`);
console.log("✓ IoU calculation tests passed!");

// 2. Test Detection Scoring (Precision, Recall, F1)
console.log("\n[Test 2] Detection Scoring");
const gtItems = [
  { category: "email", rects: [{ x: 10, y: 10, width: 100, height: 30 }], text: "test@example.com" },
  { category: "phone", rects: [{ x: 10, y: 60, width: 120, height: 30 }], text: "9876543210" },
  { category: "none", rects: [{ x: 10, y: 120, width: 150, height: 30 }], text: "Order #12345" }
];

// Test Perfect Predictions
const predPerfect = [
  { x: 10, y: 10, width: 100, height: 30, kind: "regex" },
  { x: 10, y: 60, width: 120, height: 30, kind: "regex" }
];
const resPerfect = scoreDetection(predPerfect, gtItems);
assert.strictEqual(resPerfect.overall.tp, 2, "TP should be 2");
assert.strictEqual(resPerfect.overall.fp, 0, "FP should be 0");
assert.strictEqual(resPerfect.overall.fn, 0, "FN should be 0");
assert.strictEqual(resPerfect.overall.f1, 1.0, "F1 should be 1.0");

// Test False Positive on Negative Control
const predWithNegFP = [
  { x: 10, y: 10, width: 100, height: 30, kind: "regex" },
  { x: 10, y: 120, width: 150, height: 30, kind: "regex" } // Overlaps category="none"
];
const resNegFP = scoreDetection(predWithNegFP, gtItems);
assert.strictEqual(resNegFP.overall.tp, 1, "TP should be 1");
assert.strictEqual(resNegFP.overall.fp, 1, "FP should be 1");
assert.strictEqual(resNegFP.overall.fn, 1, "FN should be 1 (phone missed)");
assert.strictEqual(resNegFP.misses.length, 1, "Should have 1 miss");
assert.strictEqual(resNegFP.misses[0].category, "phone");
console.log("✓ Detection scoring tests passed!");

// 3. Test Redaction Pixel Leak Detection
console.log("\n[Test 3] Redaction Pixel Leak Detection");
// Create mock 10x10 ImageData (400 bytes)
const width = 10;
const height = 10;
const data = new Uint8ClampedArray(width * height * 4);

// Fill with white (255, 255, 255, 255)
for (let i = 0; i < data.length; i += 4) {
  data[i] = 255;
  data[i + 1] = 255;
  data[i + 2] = 255;
  data[i + 3] = 255;
}

// Redact top-left 5x5 region to black (0, 0, 0, 255)
for (let y = 0; y < 5; y++) {
  for (let x = 0; x < 5; x++) {
    const idx = (y * width + x) * 4;
    data[idx] = 0;
    data[idx + 1] = 0;
    data[idx + 2] = 0;
    data[idx + 3] = 255;
  }
}

const mockImageData = { width, height, data };
const gtBlackRegion = [
  { category: "email", rects: [{ x: 0, y: 0, width: 4, height: 4 }], text: "black@test.com" }
];
const gtLeakedRegion = [
  { category: "phone", rects: [{ x: 4, y: 4, width: 4, height: 4 }], text: "9999999999" } // spans into white area
];

const resBlack = scoreRedactionImageData(mockImageData, gtBlackRegion, []);
assert.strictEqual(resBlack.pixelLeaks.length, 0, "Black region should have 0 pixel leaks");
assert.strictEqual(resBlack.coverage, 1.0, "Coverage should be 1.0");
assert.strictEqual(resBlack.piiLeakRate, 0.0, "Black region leak rate should be 0.0%");

const resLeaked = scoreRedactionImageData(mockImageData, gtLeakedRegion, []);
assert(resLeaked.pixelLeaks.length > 0, "Leaked region should report pixel leak");
assert(resLeaked.coverage < 1.0, "Coverage should be < 1.0 due to leak");
assert(resLeaked.piiLeakRate > 0.0, "Leaked region should have piiLeakRate > 0");

// Direct unit test of calculatePiiLeakRate
assert.strictEqual(calculatePiiLeakRate(0, 100), 0.0, "0 leaks should be 0.0%");
assert.strictEqual(calculatePiiLeakRate(100, 100), 100.0, "100 leaks out of 100 should be 100.0%");
assert.strictEqual(calculatePiiLeakRate(25, 100), 25.0, "25 leaks out of 100 should be 25.0%");
assert.strictEqual(calculatePiiLeakRate(10, 0), 0.0, "0 total pixels should return 0.0%");
console.log("✓ Redaction pixel leak and PII leak rate tests passed!");

// 4. Test Latency Aggregation
console.log("\n[Test 4] Latency Aggregation");
const latencies = [
  { domScan: 10, visionInference: 100, clientTotal: 150 },
  { domScan: 20, visionInference: 120, clientTotal: 200 },
  { domScan: 15, visionInference: 110, clientTotal: 175 }
];
const latRes = aggregateLatency(latencies);
assert.strictEqual(latRes.mean, 175, "Mean total latency should be 175ms");
assert.strictEqual(latRes.median, 175, "Median total latency should be 175ms");
assert.strictEqual(latRes.byStage.domScan.mean, 15, "Mean domScan should be 15ms");
console.log("✓ Latency aggregation tests passed!");

// 5. Test Ablation Dual-Pass Comparison (Redaction ON vs OFF)
console.log("\n[Test 5] Ablation Dual-Pass Comparison");
const passARedacted = scoreRedactionImageData(mockImageData, gtBlackRegion, []);
// Unredacted raw image: all pixels white (255, 255, 255)
const rawImageData = { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4).fill(255) };
const passBUnredacted = scoreRedactionImageData(rawImageData, gtBlackRegion, []);

assert.strictEqual(passARedacted.piiLeakRate, 0.0, "Pass A (Redacted) leak rate must be 0.0%");
assert.strictEqual(passBUnredacted.piiLeakRate, 100.0, "Pass B (Unredacted) leak rate must be 100.0%");
const leakReduction = passBUnredacted.piiLeakRate - passARedacted.piiLeakRate;
assert.strictEqual(leakReduction, 100.0, "Privacy benefit must be 100.0% reduction in leaked pixels");
console.log("✓ Ablation dual-pass comparison tests passed!");

console.log("\n✅ ALL SCORING UNIT TESTS PASSED SUCCESSFULLY!");
