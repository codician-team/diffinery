// Text modules (wrangler's default rule imports *.txt as a string).
declare module "*.txt" {
  const text: string;
  export default text;
}

// Compiled WebAssembly modules (wrangler's default CompiledWasm rule, and celld's for every .wasm import; the wasm
// plugin in vitest.config.ts under tests). A plain .wasm path: celld documents .wasm?module only for unbundled Workers.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// Data modules (wrangler's default Data rule imports *.bin as an ArrayBuffer; the bin plugin in vitest.config.ts under tests).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}

// These two packages ship wasm-bindgen typings beside the file (`*.wasm.d.ts`, the module's exports), which
// would win over the pattern above; an exact name wins over both.
declare module "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
