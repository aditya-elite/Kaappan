# NOTICE — Third-Party Open Source Components

Kaappan includes and links against third-party open-source software libraries under their respective licenses:

1. **GNU Ocrad (Emscripten JS Port — ocrad.js)**
   - **Path**: `extension/lib/ocrad.js`
   - **License**: GNU Affero General Public License v3.0 (AGPL-3.0)
   - **Copyright**: (C) 2003-2024 Antonio Diaz Diaz / Emscripten Contributors
   - **Notice**: `ocrad.js` is a vendored JavaScript compilation of the GNU Ocrad OCR engine. It operates as an isolated component inside the Chrome Extension Offscreen Document. Modifications made to `ocrad.js` are documented in the file header comment and made available under AGPL-3.0.

2. **ONNX Runtime Web (onnxruntime-web)**
   - **Path**: `extension/lib/ort.min.js`, `extension/lib/ort-wasm-simd-threaded.*`
   - **License**: MIT License
   - **Copyright**: (C) Microsoft Corporation

3. **Ultra-Light Fast Generic Face Detector (ONNX)**
   - **Path**: `extension/models/face_detector.onnx`
   - **License**: MIT License / Open Weights
   - **Copyright**: (C) Linzaer

4. **FastAPI & Uvicorn Backend**
   - **Path**: `server/`
   - **License**: MIT License
