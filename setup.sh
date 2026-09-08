#!/usr/bin/env bash
# Pulls the official onnxruntime-web package and copies just the files the
# extension needs into extension/lib/. Run this once before loading the extension.
#
# Why a script instead of shipping the files directly: the wasm runtime is 14MB+
# and is safest coming straight from the official npm package rather than a copy
# that can't be verified running in a real browser ahead of time.

set -e
cd "$(dirname "$0")/extension"

ORT_VERSION="1.21.0"
echo "Installing onnxruntime-web@${ORT_VERSION}..."
npm install "onnxruntime-web@${ORT_VERSION}" --no-save --prefix .tmp-ort

mkdir -p lib
cp .tmp-ort/node_modules/onnxruntime-web/dist/ort.min.js lib/
# ort.min.js dynamically imports the JSEP-enabled wasm/mjs pair at runtime even when
# executionProviders is set to ["wasm"] - both variants are needed or you'll hit
# "Failed to fetch dynamically imported module ... jsep.mjs" the first time inference runs.
cp .tmp-ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm lib/
cp .tmp-ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs lib/
cp .tmp-ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm lib/
cp .tmp-ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs lib/

# Checksum verification (SHA-256)
echo "Verifying runtime integrity..."
EXPECTED_ORT_SHA256="79a344bf4f5dbfd4b214d5d7960896e1da1c4daa7e9ce9cd671b0b52ea4abaf9"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256=$(sha256sum lib/ort.min.js | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256=$(shasum -a 256 lib/ort.min.js | awk '{print $1}')
fi

if [ -n "$ACTUAL_SHA256" ]; then
  if [ "$ACTUAL_SHA256" = "$EXPECTED_ORT_SHA256" ]; then
    echo "✓ SHA-256 integrity verified for ort.min.js ($ACTUAL_SHA256)"
  else
    echo "⚠ Warning: SHA-256 mismatch for ort.min.js (got $ACTUAL_SHA256, expected $EXPECTED_ORT_SHA256)"
  fi
fi

rm -rf .tmp-ort
echo "Done. lib/ now has: $(ls lib)"
echo ""
echo "Next: load extension/ as an unpacked extension in chrome://extensions"
