"""
Computes redaction precision/recall against a hand-labeled test set — this gives you
real numbers for the two evaluation criteria worth 40% combined ("PII detection recall/
precision" and "redaction precision").

1. Take ~15-20 screenshots of pages with known PII (use the demo-page/test.html form
   plus a couple of real-looking pages).
2. For each, write ground-truth boxes by hand into labels.json (see the example below).
3. Run your redaction pipeline on the same screenshots and save its predicted boxes
   in the same format to predictions.json (log them from background.js during a test run,
   or call detectFaces()/scanPage() directly with these images loaded in a page).
4. Run: python3 eval.py labels.json predictions.json

labels.json / predictions.json format:
{
  "screenshot_1.png": [{"x": 40, "y": 120, "width": 180, "height": 60}, ...],
  "screenshot_2.png": [...]
}
"""

import json
import sys


def iou(a, b):
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["width"], a["y"] + a["height"]
    bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["width"], b["y"] + b["height"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area_a = a["width"] * a["height"]
    area_b = b["width"] * b["height"]
    return inter / (area_a + area_b - inter) if (area_a + area_b - inter) > 0 else 0


def evaluate(labels, predictions, iou_threshold=0.5):
    tp, fp, fn = 0, 0, 0

    for image, gt_boxes in labels.items():
        if not isinstance(gt_boxes, list):
            continue
        pred_boxes = predictions.get(image, [])
        if not isinstance(pred_boxes, list):
            continue
        matched_gt = set()
        matched_pred = set()

        for pi, pb in enumerate(pred_boxes):
            best_iou, best_gi = 0, None
            for gi, gb in enumerate(gt_boxes):
                if gi in matched_gt:
                    continue
                score = iou(pb, gb)
                if score > best_iou:
                    best_iou, best_gi = score, gi
            if best_iou >= iou_threshold:
                matched_gt.add(best_gi)
                matched_pred.add(pi)

        tp += len(matched_pred)
        fp += len(pred_boxes) - len(matched_pred)
        fn += len(gt_boxes) - len(matched_gt)

    precision = tp / (tp + fp) if (tp + fp) else 0
    recall = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 eval.py labels.json predictions.json")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        labels = json.load(f)
    with open(sys.argv[2]) as f:
        predictions = json.load(f)

    result = evaluate(labels, predictions)
    print(json.dumps(result, indent=2))
