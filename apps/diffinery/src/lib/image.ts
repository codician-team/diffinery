/**
 * Profile pictures: check an uploaded JPEG, PNG or WebP and turn it into small square WebPs.
 *
 * Everything runs in the Worker on jSquash's WASM codecs. Wrangler bundles each `*.wasm` import
 * as a compiled WebAssembly.Module (its default CompiledWasm rule), and each codec gets its module
 * through `init(module)`, so nothing is fetched at runtime.
 *
 * Memory: a decoded picture costs width × height × 4 bytes, twice over (the codec's WASM heap and
 * the JS copy), so dimensions are read from the file header and checked before decoding. Right after
 * decoding, the centre square is box-filtered in plain JS to at most ~2× the largest size we keep, and
 * only that small copy goes through the resampler and the encoder.
 */
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import { decode as decodePng, init as initPngDecode } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";
import resize, { initResize } from "@jsquash/resize";
import JPEG_DEC_WASM from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?module";
import PNG_DEC_WASM from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm?module";
import WEBP_DEC_WASM from "@jsquash/webp/codec/dec/webp_dec.wasm?module";
// @jsquash/webp's encoder picks its SIMD build when the runtime supports WASM SIMD, which V8 (workerd, Node) does.
import WEBP_ENC_WASM from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?module";
import RESIZE_WASM from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm?module";
import { HttpError } from "./util.js";

/** Square sizes we store, in pixels: 2× the 20, 40 (`.av.lg`) and 96 (`.av.xl`, rounded up) CSS pixel avatars. */
export const AVATAR_SIZES = [64, 128, 256] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Decoding holds the pixels twice (4 bytes each); 3072² keeps that well under a Worker's 128 MB. Browsers shrink to 512 px before uploading. */
export const MAX_AVATAR_SIDE = 3072;
/** WebP quality: small files that still look crisp at 2×. */
export const AVATAR_QUALITY = 80;

export const UNSUPPORTED_IMAGE = "Use a JPEG, PNG or WebP image.";

export type ImageFormat = "jpeg" | "png" | "webp";

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Workers and Node have no ImageData; the codecs construct it, so provide the plain shape they need.
const g = globalThis as { ImageData?: unknown };
g.ImageData ??= class ImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
};

// ---------------------------------------------------------------- headers

/** The format from the file's magic bytes (the content type is not trusted). */
export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  return null;
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** Pixel dimensions from the file header, without decoding; null when the header is malformed. */
export function imageSize(b: Uint8Array, format: ImageFormat): { width: number; height: number } | null {
  if (format === "png") {
    if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (format === "webp") {
    if (b.length < 30) return null;
    const chunk = ascii(b, 12, 4);
    // Lossy: frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height.
    if (chunk === "VP8 ") return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff } : null;
    // Lossless: signature 0x2f, then width-1 and height-1 in 14 bits each.
    if (chunk === "VP8L") {
      if (b[20] !== 0x2f) return null;
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    // Extended: canvas width-1 and height-1 as 24-bit numbers.
    if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
      i += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

/** The EXIF orientation (1–8) of a JPEG; 1 when there is none. */
export function jpegOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const m = b[i + 1]!;
    if (m === 0xda || m === 0xd9) break; // start of scan: no more metadata
    const len = u16be(b, i + 2);
    if (m === 0xe1 && len >= 8 && ascii(b, i + 4, 6) === "Exif\0\0") {
      const t = i + 10; // TIFF header
      const le = ascii(b, t, 2) === "II";
      const r16 = (at: number) => (le ? u16le(b, at) : u16be(b, at));
      const r32 = (at: number) => (le ? (u16le(b, at) | (u16le(b, at + 2) << 16)) >>> 0 : u32be(b, at));
      if (t + 8 > b.length) return 1;
      const ifd = t + r32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = r16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > b.length || e + 12 > i + 2 + len) break;
        if (r16(e) === 0x0112) {
          const o = r16(e + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

// ---------------------------------------------------------------- pixels

/** The centred square of a width × height picture. */
export function squareCrop(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** Integer box-filter factor that brings `side` down to no less than `min` pixels. */
export function shrinkFactor(side: number, min: number): number {
  return Math.max(1, Math.floor(side / min));
}

/**
 * Cut the centred square out of a picture and box-filter it by an integer factor, so the result is
 * between `min` and 2 × `min` pixels on a side (or the square itself when it is smaller than that).
 * Alpha-weighted, so transparent pixels do not darken the edges. Always returns a fresh buffer.
 */
export function cropAndShrink(img: Pixels, min = 512): Pixels {
  const crop = squareCrop(img.width, img.height);
  const k = shrinkFactor(crop.side, min);
  const side = Math.floor(crop.side / k);
  const x0 = crop.x + Math.floor((crop.side - side * k) / 2);
  const y0 = crop.y + Math.floor((crop.side - side * k) / 2);
  const src = img.data;
  const out = new Uint8ClampedArray(side * side * 4);
  const n = k * k;
  for (let oy = 0; oy < side; oy++) {
    for (let ox = 0; ox < side; ox++) {
      let r = 0,
        gr = 0,
        bl = 0,
        a = 0;
      for (let dy = 0; dy < k; dy++) {
        let p = ((y0 + oy * k + dy) * img.width + x0 + ox * k) * 4;
        for (let dx = 0; dx < k; dx++, p += 4) {
          const al = src[p + 3]!;
          r += src[p]! * al;
          gr += src[p + 1]! * al;
          bl += src[p + 2]! * al;
          a += al;
        }
      }
      const q = (oy * side + ox) * 4;
      if (a > 0) {
        out[q] = r / a;
        out[q + 1] = gr / a;
        out[q + 2] = bl / a;
      }
      out[q + 3] = a / n;
    }
  }
  return { data: out, width: side, height: side };
}

/** Apply an EXIF orientation to a square picture, so it shows the way the camera held it. */
export function orientSquare(img: Pixels, orientation: number): Pixels {
  if (orientation <= 1 || orientation > 8 || img.width !== img.height) return img;
  const s = img.width;
  const e = s - 1;
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, s * s);
  const out = new Uint8ClampedArray(s * s * 4);
  const dst = new Uint32Array(out.buffer);
  // For each displayed pixel (x, y), the stored pixel it comes from.
  const from: Record<number, (x: number, y: number) => number> = {
    2: (x, y) => y * s + (e - x), // mirrored
    3: (x, y) => (e - y) * s + (e - x), // rotated 180°
    4: (x, y) => (e - y) * s + x, // flipped
    5: (x, y) => x * s + y, // transposed
    6: (x, y) => (e - x) * s + y, // rotated 90° clockwise
    7: (x, y) => (e - x) * s + (e - y), // transversed
    8: (x, y) => x * s + (e - y), // rotated 90° counter-clockwise
  };
  const f = from[orientation]!;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) dst[y * s + x] = src[f(x, y)]!;
  return { data: out, width: s, height: s };
}

// ---------------------------------------------------------------- codecs

type InitWith = (module: WebAssembly.Module) => Promise<unknown>;
let shared: Promise<unknown> | undefined;

/** Encoder and resampler are small and shared; decoders get a fresh instance per picture (below). */
function sharedCodecs(): Promise<unknown> {
  shared ??= Promise.all([(initWebpEncode as unknown as InitWith)(WEBP_ENC_WASM), initResize(RESIZE_WASM), initPngDecode(PNG_DEC_WASM)]).catch((e) => {
    shared = undefined;
    throw e;
  });
  return shared;
}

async function decode(bytes: Uint8Array, format: ImageFormat): Promise<Pixels> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // A WASM heap never shrinks, so a new Emscripten instance per picture lets a big decode's heap be collected.
  if (format === "jpeg") {
    await (initJpegDecode as unknown as InitWith)(JPEG_DEC_WASM);
    return decodeJpeg(buf);
  }
  if (format === "webp") {
    await (initWebpDecode as unknown as InitWith)(WEBP_DEC_WASM);
    return decodeWebp(buf);
  }
  return decodePng(buf);
}

/** Resample a square picture with Lanczos3 (no-op at the same size). */
async function resample(img: Pixels, size: number): Promise<Pixels> {
  if (img.width === size && img.height === size) return img;
  return resize(img as Parameters<typeof resize>[0], { width: size, height: size, method: "lanczos3", fitMethod: "stretch", premultiply: true, linearRGB: true });
}

/**
 * Check, decode, centre-crop, scale and encode an uploaded picture.
 * Returns one WebP per entry of AVATAR_SIZES. Client mistakes throw HttpError 413/422.
 */
export async function makeAvatarImages(bytes: Uint8Array): Promise<Map<AvatarSize, Uint8Array>> {
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw new HttpError(413, "That picture is larger than 5 MB. Use a smaller file.");
  const format = sniffImage(bytes);
  if (!format) throw new HttpError(422, UNSUPPORTED_IMAGE);
  const dims = imageSize(bytes, format);
  if (!dims || !dims.width || !dims.height) throw new HttpError(422, `That picture could not be read. ${UNSUPPORTED_IMAGE}`);
  if (dims.width > MAX_AVATAR_SIDE || dims.height > MAX_AVATAR_SIDE) throw new HttpError(422, `That picture is ${dims.width}×${dims.height} pixels; the limit is ${MAX_AVATAR_SIDE}×${MAX_AVATAR_SIDE}.`);
  await sharedCodecs();
  let decoded: Pixels;
  try {
    decoded = await decode(bytes, format);
  } catch {
    throw new HttpError(422, `That picture could not be read. ${UNSUPPORTED_IMAGE}`);
  }
  if (decoded.width > MAX_AVATAR_SIDE || decoded.height > MAX_AVATAR_SIDE) throw new HttpError(422, `That picture is larger than ${MAX_AVATAR_SIDE}×${MAX_AVATAR_SIDE} pixels.`);
  let square = cropAndShrink(decoded, 2 * AVATAR_SIZES[AVATAR_SIZES.length - 1]!);
  if (format === "jpeg") square = orientSquare(square, jpegOrientation(bytes));
  const out = new Map<AvatarSize, Uint8Array>();
  for (const size of AVATAR_SIZES) {
    const px = await resample(square, size);
    out.set(size, new Uint8Array(await encodeWebp(px as Parameters<typeof encodeWebp>[0], { quality: AVATAR_QUALITY, method: 6 })));
  }
  return out;
}
