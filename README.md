# 🛡️ Kaappan

> **Kaappan — On-Device Privacy Guardian for Browser Agents**  
> *Developed for Smart India Hackathon (SIH — Problem Statement SIH26171)*

[![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![ONNX Runtime Web](https://img.shields.io/badge/ONNX_Runtime-WebAssembly_SIMD-005CED?logo=onnx&logoColor=white)](https://onnxruntime.ai/)
[![Local Only](https://img.shields.io/badge/Deployment-100%25_Local_%2F_Zero_Cloud_Hosting-informational)](#-100-local-execution--zero-deployment-required)
[![FastAPI](https://img.shields.io/badge/Backend-Local_FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Open Weights](https://img.shields.io/badge/LLM-Open--Weights_Qwen2.5--VL_%7C_Ollama_%7C_vLLM-blueviolet)](#running-fully-offline-with-ollamavllm)
[![Privacy](https://img.shields.io/badge/Privacy-100%25_Local_PII_Redaction-green)](#architecture--data-flow)

---

> [!IMPORTANT]
> ### 💻 100% Local Execution — Zero Deployment Required
> This project is designed to run **entirely on your local machine**. 
> - **No Cloud Deployment**: You do not need to host or deploy any web services, databases, or infrastructure.
> - **Local AI Inference**: Computer vision face detection runs on-device using WebAssembly SIMD inside Chrome.
> - **Local Decision Server**: The lightweight FastAPI decision bridge runs strictly on `localhost:8000`.
> - **Zero-Data-Retention**: PII is stripped and redacted locally before any external reasoning API call is made.

---

## 📌 Overview

Autonomous browser agents require full-page visual screenshots and DOM trees to understand web pages and take actions (clicking buttons, filling forms, navigating). However, transmitting raw screenshots and sensitive fields directly to cloud vision LLMs presents severe privacy and compliance risks (exposure of passwords, emails, phone numbers, ID cards, and biometric faces).

Named after the Tamil root காப்பான் (*kaappan*, "one who protects"), **Kaappan** establishes a **zero-leakage on-device perception pipeline**:
1. **Local Visual AI (ONNX Runtime Web)** detects biometric faces directly on the user's machine using WebAssembly SIMD.
2. **Local DOM Inspector** identifies password fields, emails, contact details, and authentication inputs.
3. **Client-Side Redaction Engine** burns blackouts into the screenshot and DOM metadata *before* anything leaves the browser.
4. **Local Placeholder Substitution** keeps personal user profiles strictly inside `chrome.storage.local`—the decision model only ever sees semantic tokens (`{{name}}`, `{{email}}`).

---

## ✨ Key Features

- 🧠 **On-Device Visual Perception**: Executes an ultra-lightweight ONNX face-detection model (~1MB) inside a Chrome Offscreen Document with multi-threaded WASM SIMD acceleration.
- 🔒 **Hybrid PII Redaction Engine**: Merges DOM-level heuristics (passwords, phone regex, email inputs) with computer vision to redact all sensitive regions on an `OffscreenCanvas`.
- 🎭 **Privacy-Preserving Profile Autofill**: Safely automates user tasks without sharing personal data. The cloud agent reasons with abstract tokens, while the local extension resolves and injects real values.
- ⚡ **Multi-Model Vision Backend**: Local FastAPI server with drop-in support for **Google Gemini** (free-tier friendly) and **Anthropic Claude 3.5 Sonnet**.
- 📊 **Evaluation & Benchmarking Suite**: Built-in evaluation scripts (`eval/eval.py`) to compute precision, recall, and F1 score against ground-truth PII datasets.
- ⏱️ **Real-Time Telemetry & Diagnostics**: Live popup dashboard reporting memory consumption (JS heap), model load time, inference latency, and step-by-step action history.

---

## 🏗️ Architecture & Data Flow

```
                                      CLIENT (Local Machine)                                 │         CLOUD
                                                                                             │
  ┌──────────────┐      ┌─────────────────────────┐      ┌─────────────────────────────┐     │   ┌────────────────┐
  │  Active Tab  │ ───> │  content.js (DOM Scan)  │ ───> │        background.js        │     │   │ Local Server   │
  │  (Web Page)  │      │ - Passwords, Emails     │      │  (Orchestrator Service)     │     │   │ (localhost:8000│
  └──────────────┘      │ - Phone RegEx & Inputs  │      └──────────────┬──────────────┘     │   │  main_gemini)  │
         │              └─────────────────────────┘                     │                    │   └───────┬────────┘
         │ Screenshot                                                   │ Native Image Crops │           │
         ▼                                                              ▼                    │           │
  ┌──────────────┐                                       ┌─────────────────────────────┐     │           │
  │ Visible Tab  │ ────────────────────────────────────> │  offscreen.js (ONNX Model)  │     │           │
  │   Capture    │                                       │ - Ultra-Light Face Detector │     │           │
  └──────────────┘                                       │ - WASM SIMD multi-threaded  │     │           │
                                                         └──────────────┬──────────────┘     │           │
                                                                        │ Face Bounding Boxes│           │
                                                                        ▼                    │           │
                                                         ┌─────────────────────────────┐     │           │
                                                         │     OffscreenCanvas         │     │           │
                                                         │  [Burn Redaction Blackouts] │     │           │
                                                         └──────────────┬──────────────┘     │           │
                                                                        │                    │           │
                                                                        │ Sanitized Image +  │           │
                                                                        │ Abstract Metadata  │           │
                                                                        └────────────────────┼──────────>│
                                                                                             │   (Vision LLM)
                                                                                             │           │
                                                         ┌─────────────────────────────┐     │           │ Next Action
                                                         │ Local Token Replacement     │ <───┼───────────┘ (JSON)
                                                         │ ({{name}} -> "Jane Doe")    │     │
                                                         └──────────────┬──────────────┘     │
                                                                        │ Executed Locally   │
                                                                        ▼                    │
                                                         ┌─────────────────────────────┐     │
                                                         │ Active Tab DOM Interaction  │     │
                                                         └─────────────────────────────┘     │
```

---

## 📁 Project Structure

```
extension/                           # Chrome Extension (Manifest V3)
  ├── manifest.json                  # MV3 config, COOP/COEP isolation, WASM CSP
  ├── background.js                  # Core state machine & orchestrator
  ├── content.js                     # DOM scanner & visual redaction overlay
  ├── offscreen.html / offscreen.js  # Sandboxed ONNX runtime host for canvas/WASM
  ├── popup.html / popup.js          # Diagnostic UI, profile manager, live logs
  ├── icons/                         # Extension toolbar icons
  ├── models/
  │   ├── face_detector.onnx         # 1MB Ultra-Light Fast Generic Face Detector
  │   └── priors.json                # Precomputed SSD anchor boxes
  └── lib/                           # ONNX Runtime WebAssembly binaries
      ├── ort.min.js
      └── ort-wasm-simd-threaded.*
server/                              # Local Agent Decision Engine (FastAPI)
  ├── main_gemini.py                 # Google Gemini backend (Free tier)
  ├── main.py                        # Anthropic Claude 3.5 backend
  ├── mock_main.py                   # Offline mock test server (No API key needed)
  └── requirements.txt               # Python backend dependencies
demo-page/                           # Local Interactive Evaluation Environment
  └── test.html                      # Test form with interactive photo uploader
eval/                                # Verification & Scoring Tools
  ├── eval.py                        # Precision / Recall / F1 calculation
  └── labels.example.json            # Example ground-truth annotation format
setup.sh                             # Runtime downloader for ONNX WebAssembly
```

---

## 🚀 Running Locally (Zero Deployment)

### Prerequisites
- **Google Chrome** (v109+ for Offscreen API & WebAssembly SIMD support)
- **Python 3.10+**
- Active API Key for **Google Gemini** ([Get Free Key at Google AI Studio](https://aistudio.google.com/apikey)) or **Anthropic Claude** (or use `mock_main.py` for offline testing without any API keys)

---

### Step 1: Initialize ONNX WebAssembly Runtime
Run the setup script once to pull the official `onnxruntime-web` WASM runtime into `extension/lib/`:

```bash
# On Linux / macOS / Git Bash
./setup.sh
```

*(If you already have `ort.min.js` and the `.wasm` / `.mjs` files in `extension/lib/`, this step is already complete).*

---

### Step 2: Start the Local Decision Server

Navigate to the `server/` directory and install dependencies:

```bash
cd server
pip install -r requirements.txt
```

Start the local server on `localhost:8000`:

#### Option A: Fully Offline with Open-Weights (Ollama / vLLM) — PS26171 Compliant
Run completely locally without sending any data or requests to external APIs:

```bash
# 1. Pull the recommended open-weights vision model in Ollama
ollama pull qwen2.5-vl:7b

# 2. Configure environment variables in server/.env (or export in shell)
export OPENAI_COMPAT_BASE_URL="http://localhost:11434/v1"
export OPENAI_COMPAT_MODEL="qwen2.5-vl:7b"
# (Optional) export OPENAI_COMPAT_API_KEY=""

# 3. Launch local decision server
cd server
uvicorn main:app --reload --port 8000
```

Verify server status:
```bash
curl http://127.0.0.1:8000/health
# Output: {"status":"ok","provider":"openai_compat","model":"qwen2.5-vl:7b","openWeights":true,...}
```

##### Open-Weights Environment Variables:
| Variable | Description | Default |
| :--- | :--- | :--- |
| `OPENAI_COMPAT_BASE_URL` | Base URL for OpenAI-compatible vision endpoint (Ollama / vLLM) | `""` (Empty = check closed-weights fallback) |
| `OPENAI_COMPAT_MODEL` | Vision model identifier | `Qwen2.5-VL-7B-Instruct` |
| `OPENAI_COMPAT_API_KEY` | Bearer token / API key (optional for local Ollama) | `""` |

#### Option B: Google Gemini (Cloud Dev Fallback)
```bash
# Set your API key
export GEMINI_API_KEY="your_gemini_api_key_here"  # Linux / macOS / Git Bash
# or in PowerShell: $env:GEMINI_API_KEY="your_gemini_api_key_here"

# Launch local server
uvicorn main:app --reload --port 8000
```

#### Option C: Anthropic Claude (Cloud Dev Fallback)
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
uvicorn main:app --reload --port 8000
```

#### Option D: Offline Mock Server (No Model Required)
```bash
uvicorn mock_main:app --reload --port 8000
```

---

### Step 3: Load Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `extension/` folder in this repository.

---

### Step 4: Run the Interactive Demo

1. Open `demo-page/test.html` directly in Chrome (drag and drop the file into a Chrome tab or use File > Open).
2. Click the **Kaappan** extension icon from your Chrome toolbar.
3. *(Optional)* Expand **"Saved profile"**, save your name/email/phone.
4. Upload any picture or use the built-in form fields.
5. In the prompt box, enter a goal such as:
   ```
   Fill in the form with my saved information and submit
   ```
6. Click **Start**:
   - Watch the live step logs detailing DOM scanning and face detection.
   - Observe the live visual redaction masks applied on the page.
   - Verify in server logs that only sanitized, blacked-out images are processed.

---

## 🔬 Benchmark & Evaluation

Evaluate the precision, recall, and F1 score of the local redaction engine:

```bash
python eval/eval.py eval/labels.example.json predictions.json
```

### Metrics Tracked:
- **Redaction Precision**: Ratio of correctly identified PII regions over total flagged areas.
- **Redaction Recall**: Percentage of actual PII items protected (goal: >99%).
- **Inference Latency**: Client-side face detection time (typically <45ms on WASM SIMD).
- **Client Heap Overhead**: Memory footprint monitored live in popup UI.

---

## 🔤 On-Device OCR: Implementation & Tradeoffs

Kaappan includes an on-device OCR engine ([ocrad.js](file:///c:/Users/nparu/OneDrive/Desktop/sih26171-browser-agent-all-black/sih26171-browser-agent/extension/lib/ocrad.js)) running directly inside the Chrome Extension background worker for fast local text detection on canvas-rendered PII and image crops:

- **MV3 Compatibility Patch**: Modified `ocrad.js` initialization header to replace dynamic `eval()` execution with safe environment detection (`Module = typeof Module !== 'undefined' ? Module : {}`), ensuring full compliance with Chrome MV3 `wasm-unsafe-eval` Content Security Policy (CSP).
- **Execution Performance**: Synchronous crop OCR executes in 3–12ms per element box, avoiding remote network overhead.
- **Alphabet & Language Support**: Limited to standard **ASCII/Latin** character sets (English characters, digits, common symbols). Does not support non-Latin scripts (Devanagari, Cyrillic, CJK, etc.).
- **Resolution Bounds**: Best accuracy achieved on crop bounding boxes under **600×200px**. Full-page image OCR or oversized crops produce low-confidence text output and are skipped to avoid excessive JS heap memory overhead.
- **Degraded Capabilities Handling**: If OCR script initialization fails or encounters invalid image data, the engine gracefully records `OCR_FAILED` or `VISION_MODEL_UNAVAILABLE` in the step's `degradedCapabilities` audit array and degrades to visual-only / DOM-based redaction without crashing execution.

---

## 🛡️ Privacy & Detection Guarantees

Kaappan operates under a probabilistic protection model balancing privacy protection with computational efficiency.

| Data Type | Detection & Redaction Pipeline | Measured Detection Rate / Target | Known Edge Cases & Un-redacted Scenarios | Degraded Fallback Behavior |
| :--- | :--- | :---: | :--- | :--- |
| **Passphrases & Input Fields** | DOM heuristic & type matching (`input[type=password]`, shadow DOM traversal) | **100.0%** | Custom canvas controls without HTML input elements | Bounding box spatial blackout derived from parent containers |
| **PII Text (Emails, Phone, IDs)** | Hybrid DOM Regex parsing + local canvas OCR crop scanning | **94.6%** (35/37) | Non-Latin scripts, highly stylized fonts, low-contrast text on complex backgrounds | Telemetry logs `OCR_FAILED`; DOM bounding box redaction applied as fallback |
| **Biometric Faces** | ONNX Ultra-Light Face Detector via WASM SIMD in Offscreen document | **100.0%** (3/3) | Extreme head rotation (>60°), heavy face occlusion (>50%), faces <20px | Telemetry logs `FACE_DETECTION_FAILED`; visual warning added to popup audit card |
| **User Profile Data** | Local profile storage (`chrome.storage.local`) & client token replacement | Design Target (unmeasured): 100% (Deterministic token replacement) | None (tokens replaced locally before network dispatch) | Fallback prompt prompts user for manual parameter entry if missing |
| **Screen State Classification** | Heuristic DOM page classifier (`classifyScreenState()`) based on input tags & keywords | N/A (DOM heuristic, unmeasured) | Non-standard form markup; single-page apps (SPA) with lazy-rendered inputs | Fallback to `CONTENT_BROWSING` policy mode |

> [!NOTE]
> `classifyScreenState()` is a deterministic **DOM-derived heuristic classifier** that evaluates visible `<input>` tags, `type` attributes, labels, and text keywords to classify pages into `LOGIN_SIGNUP`, `CHECKOUT_PAYMENT`, `GENERAL_FORM`, or `CONTENT_BROWSING`. It uses **no vision model at all** (neither cloud nor local) — it strictly reads DOM tags and text keywords.

---

## ⚠️ Known Limitations

- **Custom Non-Native Widgets**: The agent interacts with standard native HTML form elements (`<input>`, `<textarea>`, `<select>`, `<button>`). Custom non-native components (e.g. React-Select, MUI dropdowns, custom ARIA listboxes, or `contentEditable` elements) are not handled out-of-the-box and require standard HTML controls or direct selector clicking.
- **Cross-Origin Iframes & Closed Shadow DOM**: DOM inspection and PII scanning automatically traverse open shadow roots (`el.shadowRoot`) and same-origin `<iframe>` documents. Cross-origin iframes and closed shadow roots are isolated by browser security models and cannot be inspected directly by content scripts.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/aditya-elite/Kaappan/issues).

---

## 📜 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

