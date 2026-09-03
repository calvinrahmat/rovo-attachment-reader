'use strict';

// Custom, minimal worker_threads entry point for tesseract.js OCR — written
// because the stock node_modules/tesseract.js/src/worker-script/node/index.js
// can't be used directly in Forge:
//
//  1. `new Worker(workerPath)` needs a real absolute path on disk. Forge's
//     webpack bundler doesn't preserve real filesystem `__dirname`/
//     `import.meta.url` values for ANY module (confirmed for both
//     tesseract.js's own internal path computation and ours), so there's no
//     reliable way to compute "where is my node_modules" at runtime inside
//     the bundle.
//  2. The Emscripten WASM glue (tesseract.js-core/tesseract-core-*.js) has
//     the exact same problem for locating its .wasm binary — it reads
//     `__dirname + "/tesseract-core-lstm.wasm"`.
//  3. tesseract.js's SIMD-variant auto-detection (getCore.js) picks between
//     4 different core+wasm pairs at runtime, which would mean embedding
//     and materializing all 4 to be safe.
//
// The fix used here: esbuild-bundle THIS file (see gen_ocr_worker_bundle.mjs)
// together with tesseract.js's worker-script logic and exactly one fixed
// core variant (lstm-only, no SIMD) into a single self-contained .cjs file,
// with only true Node builtins left external. src/ocr-assets.js embeds that
// bundle's text, the matching tesseract-core-lstm.wasm, and the English
// trained data, all as base64 constants — guaranteed part of the static
// import graph our own bundler (Forge's) follows correctly, unlike a
// runtime file reference. index.js decodes and writes all three to /tmp at
// invocation time (a hardcoded, always-real, always-writable path in
// Lambda-style sandboxes — no path computation needed) before spawning the
// worker from there. Once this bundle is running as a genuine standalone
// file at a real path, its own `__dirname` is correct again — the
// worker-script's `dispatchHandlers`/adapter wiring below is otherwise
// identical to the stock node worker-script/node/index.js.

const { parentPort } = require('worker_threads');
const zlib = require('zlib');
const fs = require('fs');
const worker = require('tesseract.js/src/worker-script/index.js');

// Fixed core variant: lstm-only, no SIMD. This app only ever calls
// createWorker with oem=LSTM_ONLY, so this is the correct variant anyway —
// skipping SIMD auto-detection also means we only need to materialize one
// matching .wasm file instead of up to four.
const Core = require('tesseract.js-core/tesseract-core-lstm');

worker.setAdapter({
  getCore: async () => Core,
  gunzip: (data) => zlib.gunzipSync(Buffer.from(data)),
  fetch: undefined, // never used: langPath is always a local /tmp path, never a URL
  // readCache doubles as the general "read this file" primitive worker-
  // script/index.js uses to load the actual trained-data bytes from
  // langPath (not just an optional cache-hit check) — it must really read
  // the file. writeCache/deleteCache/checkCache are true cache-only
  // operations, harmless no-ops here since cacheMethod: 'none' means we
  // never intend to persist anything back.
  readCache: (p) => fs.promises.readFile(p),
  writeCache: () => Promise.resolve(),
  deleteCache: () => Promise.resolve(),
  checkCache: () => Promise.resolve(false),
});

parentPort.on('message', (packet) => {
  worker.dispatchHandlers(packet, (obj) => parentPort.postMessage(obj));
});
