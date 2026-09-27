/* global Module, HEAPF32, runtimeInitialized, module, console */
// Replacement for upstream dtln-rs's dtln_post.js, overlaid by the Ficus
// denoiser build (apps/web/scripts/dtln/Dockerfile). Emscripten appends it to
// the generated glue, so it runs in the module's scope. Differences from
// upstream, all needed by apps/web/public/voice/dtln/processor.js:
//   - `ready` reports whether the WASM runtime has initialized, so a worklet
//     created after load does not wait for a postRun that already fired;
//   - `postRun` is an array the worklet pushes its ready callback onto;
//   - the heap is read through the module-scope `HEAPF32` view, which
//     `updateMemoryViews()` refreshes on memory growth — Emscripten 4.x no
//     longer publishes the views on `Module` (upstream's `Module.HEAPF32`).
// The ES-module default export is appended by build.sh AFTER emcc runs:
// Emscripten's JS optimizer parses the glue as a script, so `export` here
// fails the link. Upstream's CommonJS guard stays and is inert in a module.
const DTLN_SAMPLE_BLOCK_SIZE = 512
const DTLN_SIZEOF_FLOAT32 = 4

// Export interface that matches the node plugin.
let DtlnPlugin = {
  get ready() {
    return runtimeInitialized
  },
  postRun: [],
  dtln_create: () => {
    console.log(`Creating new DTLN ${Module}`)
    return Module._dtln_create_wasm()
  },
  dtln_destroy: (handle) => Module._dtln_destroy_wasm(handle),
  dtln_denoise: (handle, input, output) => {
    let audioBufferPtr = Module._dtln_get_audio_buffer(handle) / DTLN_SIZEOF_FLOAT32
    HEAPF32.set(input, audioBufferPtr)
    Module._dtln_denoise_wasm(handle)
    output.set(HEAPF32.subarray(audioBufferPtr, audioBufferPtr + DTLN_SAMPLE_BLOCK_SIZE))
    return false
  },
}

if (typeof module !== 'undefined') {
  module.exports = DtlnPlugin
}

Module.postRun = [
  () => {
    console.log(`Finished loading DTLN plugin!!!`)
    // Upstream's expression form, kept verbatim so the built glue is unchanged.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    DtlnPlugin.postRun && DtlnPlugin.postRun.forEach((fn) => fn())
  },
]
