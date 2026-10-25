// Text modules (wrangler's default rule imports *.txt as a string).
declare module "*.txt" {
  const text: string;
  export default text;
}

// Compiled WebAssembly modules (wrangler's default CompiledWasm rule; the wasm plugin in vitest.config.ts under tests).
declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}

// Data modules (wrangler's default Data rule imports *.bin as an ArrayBuffer; the bin plugin in vitest.config.ts under tests).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
