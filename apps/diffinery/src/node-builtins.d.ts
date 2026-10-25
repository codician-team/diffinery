// The parts of node:zlib and node:crypto that @diffinery/git-core uses (zlib.ts, sha1.ts). The Worker
// has them at runtime through nodejs_compat, but type-checks without @types/node.
declare module "node:zlib" {
  interface ZlibOptions {
    chunkSize?: number;
    maxOutputLength?: number;
  }
  function inflateSync(data: Uint8Array, options?: ZlibOptions): Uint8Array;
}

declare module "node:crypto" {
  interface Hash {
    update(data: Uint8Array): Hash;
    digest(): Uint8Array;
  }
  function createHash(algorithm: "sha1"): Hash;
}
