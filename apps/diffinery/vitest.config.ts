import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { timeouts } from "../../vitest.shared";

// The path is base64-encoded so the id does not look like a node_modules file, which vitest would hand to Node unprocessed.
const PREFIX = "virtual:wasm-module/";

export default defineConfig({
  test: timeouts,
  resolve: {
    alias: {
      "cloudflare:workflows": fileURLToPath(new URL("./test/unit/stubs/cloudflare-workflows.ts", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./test/unit/stubs/cloudflare-workers.ts", import.meta.url)),
      "cloudflare:sockets": fileURLToPath(new URL("./test/unit/stubs/cloudflare-sockets.ts", import.meta.url)),
    },
  },
  plugins: [
    {
      // `import text from "x.txt"` gives the file's text and `import data from "x.bin"` an ArrayBuffer,
      // like wrangler's Text and Data rules in the Worker (vite would otherwise give an asset URL).
      name: "diffinery:text-and-data-modules",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".txt")) return `import { readFileSync } from "node:fs";\nexport default readFileSync(${JSON.stringify(id)}, "utf8");`;
        if (id.endsWith(".bin")) return `import { readFileSync } from "node:fs";\nconst b = readFileSync(${JSON.stringify(id)});\nexport default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);`;
        return null;
      },
    },
    {
      // `import mod from "x.wasm"` gives a compiled WebAssembly.Module, like wrangler's CompiledWasm rule in the Worker.
      name: "diffinery:wasm-module",
      enforce: "pre",
      async resolveId(source, importer) {
        if (!source.endsWith(".wasm")) return null;
        const file = await this.resolve(source, importer, { skipSelf: true });
        return file ? PREFIX + Buffer.from(file.id).toString("base64url") : null;
      },
      load(id) {
        if (!id.startsWith(PREFIX)) return null;
        return `import { readFileSync } from "node:fs";\nexport default new WebAssembly.Module(readFileSync(${JSON.stringify(Buffer.from(id.slice(PREFIX.length), "base64url").toString())}));`;
      },
    },
  ],
});
