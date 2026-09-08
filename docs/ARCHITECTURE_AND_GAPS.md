# SIH PS26171 — Current Build: Architecture & Gap Analysis

**PS26171 — On-device Visual Perception for Light-weight Browser Agents (ISRO)**
Analysis 2026-09-04. Based on: manifest.json, background.js (2445 L), content.js,
offscreen.js, popup.html/js, storage.js, viewer.html/js, sample_photo.js, main.py.

**Status: a triage pass was applied 2026-09-04 ahead of a 2-day review.** Fixed items are
marked ✅ below; see `CHANGES.md` in the patched bundle for the full changelog.

---

## 1. What exists today

Chrome MV3 extension + local FastAPI relay (`main.py`) that forwards to a server-side VLM.

### Agent loop (`background.js :: runLoop`, MAX_STEPS 15)
1. `captureVisibleTab()` → screenshot in **device pixels**
2. `SCAN_DOM` over all frames → sensitive rects, image rects, structural element list
   (selectors + labels, **values never transmitted** — only `isFilled` / `valueLength`)
3. `toDevice(rect, dpr)` — single CSS→device conversion point
4. Crop each image region → offscreen document → **local ONNX face detector**
   (Ultra-Light-Fast-Generic-Face-Detector-1MB, RFB-320), WebGPU with WASM fallback
5. `fuseRegions()` — IoU > 0.25 union merge of DOM / regex / vision boxes; tracks max and min confidence
6. `redactImage()` — black rectangles, 3px outward pad, floor/ceil outward
7. `verifyPrivacyGate()` — confidence floor per policy dial (strict .85 / balanced .60 /
   permissive .30), then re-decodes the redacted JPEG and samples 5 points per region to
   confirm they are black. Fails closed.
8. `payloadContainsRawPii()` scans the outgoing payload for real secret values, then POST
   redacted image + element list + tokenised document context → `localhost:8000/act`
9. `validateAction()` — allowlist: known action type, selector present verbatim in this
   step's element list, action/tag compatibility, fileId exists
10. Resolve `{{doc_*}}` / `{{scraped_*}}` handles back to real values **locally**
11. Execute via `chrome.scripting.executeScript` in the frame owning the element

### Second flow — read / ask
Scrape page text → regex-tokenise PII locally into `{{scraped_email_3}}` → send tokens to
`/ask` → resolve back to real values client-side. Token map lives only in memory.

### Supporting subsystems
- **Zero-guessing**: `enforce_data_grounding()` server-side rewrites ungrounded
  type/select/radio-click into `ask_user`; client re-verifies grounding before executing.
  Unanswered fields → `skippedFields`, never re-asked.
- **Files**: IndexedDB Blobs. Only `{id,label,name,mime,size}` manifest crosses the wire;
  `upload` actions carry a `fileId` resolved to bytes locally. Delete cascades to derived
  profile fields via `_derivedFrom`.
- **Evidence surfaces**: judge dashboard (derived from real audit trail), network payload
  inspector, audit + benchmark JSON export, split-slider redaction transparency viewer.
- **Security**: CORS locked to extension origin, per-install shared secret header.

---

## 2. Scoring rubric vs. current state

| Metric | Weight | State |
|---|---|---|
| 1. Accuracy of visual context from screen | 25% | Screen understanding is ~100% DOM. **No vision model reads the screen.** Largest open gap. |
| 2. PII detection recall & precision | 20% | DOM selectors + 4 regexes + faces (now working ✅). No OCR, no NER — pixels and names still invisible. |
| 3. Precision of redaction | 20% | ✅ Text-range redaction landed. IoU-0.25 union merge can still balloon boxes. |
| 4. Client-side resource utilization | 20% | ~6 full-image decodes per step; per-point `getImageData`; popup-heap metric is meaningless. |
| 5. End-to-end latency | 15% | Same causes + server round trip + fixed sleeps (250ms, 5×600ms, 8×600ms). |

---

## 3. Compliance red flags

1. ✅ **Closed-weights server model.** PS: *"free to use any offline deployable
   (open-source/open-weights) model on server side. During SIH they can use cloud hosted
   version of these."* **Fixed**: primary path is now any OpenAI-compatible endpoint —
   hosted Qwen2.5-VL during SIH, local vLLM/Ollama offline, same code path. Closed
   providers remain as dev fallbacks and are flagged by `/health` + a startup warning.
2. ⬜ **No local ViT or equivalent doing decisioning.** PS asks for a local vision model
   that *"reads the user's screen and takes decision based on that."* The face detector
   now works but only runs on image crops — it does not read the screen.
3. ⬜ **Firefox unsupported.** `chrome.offscreen` is Chrome-only. PS names chrome *and* Firefox.

---

## 4. Correctness bugs

| # | Sev | Bug | Status |
|---|---|---|---|
| B1 | Critical | `offscreen.js` reads `bitmap.width/height` **after** `bitmap.close()`. Detached bitmap returns 0 → `scale = Infinity` → all boxes NaN → `nms()` filters every face out. | ✅ fixed — captured dimensions before `bitmap.close()` |
| B2 | Critical | `documentContext` shipped the full resume as raw text. | ✅ fixed — tokenised out, resolved back locally, payload scanned and blocked on leak |
| B12 | Critical | PII regex ordering precedence. | ✅ fixed — longest-first: EMAIL → CARD → AADHAAR → PAN → PHONE with non-PII span masking |
| B13 | Critical | `ocrad.js` MV3 CSP `eval()` failure silently skipping OCR execution. | ✅ fixed — patched `ocrad.js` vendor file, added startup assertion + loud `OCR_UNAVAILABLE` propagation |
| B14 | High | Service worker restart orphaning active run states after 30s idle. | ✅ fixed — single `runState` object persisted to `chrome.storage.session` & rehydrated on init |
| B15 | High | Untested redaction & geometry core functions in `background.js`. | ✅ fixed — extracted pure UMD `extension/redaction_core.js`, reconciled to live constants (IoU 0.25, containment 0.6), wired to production call sites, and verified in test suite |
| B9 | Low | `comparisonBuffer` writes to `chrome.storage.session` exceeding 10MB quota. | ✅ fixed — bounded to 2 recent pairs, downscaled before storing, quota exceptions caught and logged as `STORAGE_QUOTA_EXCEEDED` |
| B3 | High | Prompt injection in page labels/button text. | ✅ fixed — client-side scrubber (`isHiddenOrAdversarial`) and server boundary rules verified in `test-prompt-injection.js` |
| B4 | High | Gate false-positive killed the run. | ✅ fixed — withholds the image, continues DOM-only, still audited as "blocked" |
| B5 | Medium | `runLoop(pausedState)` called a zero-parameter function. | ✅ fixed |
| B6 | Medium | `queryAllDeep()` shadow roots CSS path discrepancy. | ✅ fixed — piercing `>>>` traversal and structured `{ hostPath, inner }` descriptors verified in `test-shadow-resolver.js` |
| B7 | Low | `/parse-doc` has no `require_secret`. | ⬜ open — `/parse-doc` lacks `require_secret` check in `server/main.py` |
| B8 | Low | Popup's opt-in face redaction called `DETECT_FACES` without offscreen document. | ✅ fixed — `background.js` manages `ensureOffscreenDocument()` before face detection dispatch |
| B10 | Low | Element `text` / `placeholder` labels are never PII-scrubbed. | ⬜ open — raw element placeholder and semanticLabel sent in structural elements |
| B11 | Low | Auto-clicks Submit with no confirmation before an irreversible action. | ⬜ open — guarded mode prompts in main flow, but secondary loop auto-clicks submit without approval |

---

## 5. Strategic reframe

The local vision model is a bolt-on. The PS wants it **load-bearing** — driving both screen
understanding (metric 1, 25%) and PII detection the DOM cannot see (metric 2, 20%). The DOM
pipeline is a genuine strength (high precision, near-zero cost) and should stay as the
precision half of a fusion story — but vision has to carry recall.

### Target local stack (ONNX Runtime Web / Transformers.js on WebGPU)
- **OCR** — PaddleOCR-lite ONNX (det + rec); feeds the PII regex sweep for *pixels*. Single
  biggest recall win on metric 2, and the thing that makes "on-device visual perception" true.
- **UI element detection** — YOLOv8n-class / OmniParser-style icon and control detection
  producing element boxes + roles from pixels. Directly targets metric 1.
- **PII NER** — distilled token-classification model over OCR'd + DOM text, catching names,
  addresses and DOB that regexes miss.
- **Screen-state ViT** — CLIP/MobileViT image encoder classifying page type (login / payment /
  form / document viewer). Cheap, satisfies "ViT" literally, and can auto-escalate the privacy
  policy dial on sensitive page types.
- **Face detection** — existing model, now functional.

### Assets to elevate
The token-substitution scheme is the PS's "semantic obfuscation" option, already implemented
and now covering documents as well as scraped pages. Present it as a first-class second
redaction mode alongside bounding-box blackout — it is a differentiator most teams won't have.

---

## 6. Remaining work, in priority order

1. **OCR pass** — metric 2 recall, and makes the vision claim real. ~1 day.
2. **Eval harness with ground truth** — 75% of the rubric is measured; there are no numbers yet.
   Needs a labelled page set and per-category recall/precision + latency + memory.
3. **Real resource instrumentation** — replace the popup JS-heap number; decode the screenshot
   once per step instead of ~6 times; batch `getImageData` per region instead of per point.
4. **UI element detection + screen-state ViT** — metric 1.
5. **Address/NER redaction**, prompt-injection hardening, Firefox path, remaining low-sev bugs.
