import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import decodeWebpWasm, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp from "@jsquash/webp/encode.js";
import JPEG_ENC_WASM from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?module";
import WEBP_DEC_WASM from "@jsquash/webp/codec/dec/webp_dec.wasm?module";
import { AVATAR_SIZES, MAX_AVATAR_BYTES, cropAndShrink, imageSize, jpegOrientation, makeAvatarImages, orientSquare, shrinkFactor, sniffImage, squareCrop, type Pixels } from "../../src/lib/image.js";
import { HttpError } from "../../src/lib/util.js";

// ---------------------------------------------------------------- fixtures, generated here

type Paint = (x: number, y: number) => [number, number, number, number?];

function pixels(width: number, height: number, paint: Paint): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  return { data, width, height };
}

/** A minimal RGBA PNG: IHDR, one IDAT (filter 0 rows), IEND. */
function png(img: Pixels): Uint8Array {
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, img.width);
  new DataView(ihdr.buffer).setUint32(4, img.height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = new Uint8Array((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) raw.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * (img.width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

let jpegReady: Promise<unknown> | undefined;
async function jpeg(img: Pixels, quality = 85): Promise<Uint8Array> {
  jpegReady ??= (initJpegEncode as unknown as (m: WebAssembly.Module) => Promise<unknown>)(JPEG_ENC_WASM);
  await jpegReady;
  return new Uint8Array(await encodeJpeg(img as Parameters<typeof encodeJpeg>[0], { quality }));
}

async function decodeWebp(bytes: ArrayBuffer): Promise<Pixels> {
  await (initWebpDecode as unknown as (m: WebAssembly.Module) => Promise<unknown>)(WEBP_DEC_WASM);
  return (await decodeWebpWasm(bytes)) as Pixels;
}

async function webp(img: Pixels, lossless = false): Promise<Uint8Array> {
  await makeAvatarImages(png(pixels(1, 1, () => [0, 0, 0]))); // initialises the shared encoder
  return new Uint8Array(await encodeWebp(img as Parameters<typeof encodeWebp>[0], { quality: 80, lossless: lossless ? 1 : 0 }));
}

/** Insert an EXIF APP1 segment carrying only an orientation tag right after SOI. */
function withOrientation(jpg: Uint8Array, orientation: number, le = true): Uint8Array {
  const tiff = new Uint8Array(26);
  const v = new DataView(tiff.buffer);
  tiff.set(new TextEncoder().encode(le ? "II" : "MM"), 0);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le); // IFD0 offset
  v.setUint16(8, 1, le); // one entry
  v.setUint16(10, 0x0112, le); // Orientation
  v.setUint16(12, 3, le); // SHORT
  v.setUint32(14, 1, le); // count
  v.setUint16(18, orientation, le);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)]);
}

/** A photo-like test card: smooth gradients plus fine noise, which is what makes real photos expensive to encode. */
const photo: Paint = (x, y) => {
  const n = ((x * 7919 + y * 104729) ^ (x * y)) % 23;
  return [(x * 0.21 + Math.sin(y / 37) * 40 + 90 + n) & 255, (y * 0.17 + Math.cos(x / 53) * 50 + 100 + n) & 255, (150 + Math.sin((x + y) / 71) * 60 + n) & 255];
};

const px = (img: Pixels, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

async function status(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, message: e.detail };
    throw e;
  }
  throw new Error("expected a rejection");
}

// ---------------------------------------------------------------- tests

describe("image format sniffing", () => {
  it("recognises JPEG, PNG and WebP by their magic bytes only", async () => {
    const img = pixels(3, 2, () => [10, 20, 30]);
    expect(sniffImage(await jpeg(img))).toBe("jpeg");
    expect(sniffImage(png(img))).toBe("png");
    expect(sniffImage(await webp(img))).toBe("webp");
    expect(sniffImage(new TextEncoder().encode("GIF89a\x01\x00\x01\x00"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("\0\0\0\x18ftypheic"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it("reads dimensions from headers without decoding", async () => {
    const img = pixels(37, 21, photo);
    expect(imageSize(await jpeg(img), "jpeg")).toEqual({ width: 37, height: 21 });
    expect(imageSize(withOrientation(await jpeg(img), 6), "jpeg")).toEqual({ width: 37, height: 21 });
    expect(imageSize(png(img), "png")).toEqual({ width: 37, height: 21 });
    expect(imageSize(await webp(img), "webp")).toEqual({ width: 37, height: 21 }); // VP8
    expect(imageSize(await webp(img, true), "webp")).toEqual({ width: 37, height: 21 }); // VP8L
    expect(imageSize(await webp(pixels(37, 21, (x) => [1, 2, 3, x * 6])), "webp")).toEqual({ width: 37, height: 21 }); // VP8X (alpha)
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2]), "jpeg")).toBeNull();
  });

  it("reads the EXIF orientation of a JPEG", async () => {
    const jpg = await jpeg(pixels(8, 8, photo));
    expect(jpegOrientation(jpg)).toBe(1);
    expect(jpegOrientation(withOrientation(jpg, 6))).toBe(6);
    expect(jpegOrientation(withOrientation(jpg, 8, false))).toBe(8);
    expect(jpegOrientation(withOrientation(jpg, 42))).toBe(1);
  });
});

describe("crop and scale math", () => {
  it("takes the centred square", () => {
    expect(squareCrop(3000, 2000)).toEqual({ x: 500, y: 0, side: 2000 });
    expect(squareCrop(2000, 3001)).toEqual({ x: 0, y: 500, side: 2000 });
    expect(squareCrop(64, 64)).toEqual({ x: 0, y: 0, side: 64 });
  });

  it("box-filters by an integer factor, keeping at least the minimum", () => {
    expect(shrinkFactor(4096, 512)).toBe(8);
    expect(shrinkFactor(2000, 512)).toBe(3); // 666 px
    expect(shrinkFactor(1023, 512)).toBe(1);
    expect(shrinkFactor(100, 512)).toBe(1);
    expect(cropAndShrink(pixels(3000, 2000, () => [1, 2, 3])).width).toBe(666);
    expect(cropAndShrink(pixels(300, 200, () => [1, 2, 3])).width).toBe(200);
  });

  it("averages colour weighted by alpha and crops off the sides", () => {
    // 4×2: red | green green | blue. The centre square is the two green columns.
    const img = pixels(4, 2, (x) => (x === 0 ? [255, 0, 0] : x === 3 ? [0, 0, 255] : [0, 200, 0]));
    const out = cropAndShrink(img, 1);
    expect(out.width).toBe(1);
    expect(px(out, 0, 0)).toEqual([0, 200, 0, 255]);
    // A transparent black pixel next to opaque white: still white, half transparent.
    const half = cropAndShrink(pixels(2, 1, (x) => (x ? [255, 255, 255, 255] : [0, 0, 0, 0])), 1);
    expect(px(half, 0, 0)).toEqual([0, 0, 0, 0]); // 2×1 crops to the centre 1×1 (x = 0)
    const quad = cropAndShrink(pixels(2, 2, (x) => (x ? [255, 255, 255, 255] : [0, 0, 0, 0])), 1);
    expect(px(quad, 0, 0)).toEqual([255, 255, 255, 128]);
  });

  it("applies EXIF orientations to a square", () => {
    const A = [1, 0, 0, 255],
      B = [2, 0, 0, 255],
      C = [3, 0, 0, 255],
      D = [4, 0, 0, 255];
    const img = pixels(2, 2, (x, y) => [[A, B], [C, D]][y]![x]! as [number, number, number, number]);
    const grid = (o: number) => {
      const r = orientSquare(img, o);
      return [px(r, 0, 0)[0], px(r, 1, 0)[0], px(r, 0, 1)[0], px(r, 1, 1)[0]];
    };
    expect(grid(1)).toEqual([1, 2, 3, 4]);
    expect(grid(2)).toEqual([2, 1, 4, 3]); // mirrored
    expect(grid(3)).toEqual([4, 3, 2, 1]); // 180°
    expect(grid(4)).toEqual([3, 4, 1, 2]); // flipped
    expect(grid(5)).toEqual([1, 3, 2, 4]); // transposed
    expect(grid(6)).toEqual([3, 1, 4, 2]); // 90° clockwise
    expect(grid(7)).toEqual([4, 2, 3, 1]); // transversed
    expect(grid(8)).toEqual([2, 4, 1, 3]); // 90° counter-clockwise
  });
});

describe("decode → crop → resize → encode", () => {
  it("turns a landscape photo into small square WebPs of the centre", async () => {
    // Red and blue bars outside the centre square; the avatar must be all photo, no bars.
    const jpg = await jpeg(pixels(1200, 800, (x, y) => (x < 200 ? [255, 0, 0] : x >= 1000 ? [0, 0, 255] : photo(x, y))));
    const out = await makeAvatarImages(jpg);
    expect([...out.keys()]).toEqual([...AVATAR_SIZES]);
    const sizes: Record<number, number> = {};
    for (const [size, bytes] of out) {
      sizes[size] = bytes.byteLength;
      expect(sniffImage(bytes)).toBe("webp");
      expect(imageSize(bytes, "webp")).toEqual({ width: size, height: size });
      const back = await decodeWebp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      for (const [x, y] of [
        [0, 0],
        [size - 1, size / 2],
      ]) {
        const [r, , b] = px(back as Pixels, x!, y!);
        expect(r! < 200 || b! < 200).toBe(true); // neither pure red nor pure blue survived the crop
      }
    }
    // A few KB each.
    console.log("avatar WebP bytes (1200×800 synthetic photo):", sizes);
    expect(sizes[256]!).toBeLessThan(20_000);
    expect(sizes[64]!).toBeLessThan(sizes[256]!);
  });

  it("keeps transparency from a PNG and accepts WebP input", async () => {
    const pic = pixels(300, 300, (x, y) => ((x - 150) ** 2 + (y - 150) ** 2 < 120 ** 2 ? [30, 120, 220] : [0, 0, 0, 0]));
    const fromPng = await makeAvatarImages(png(pic));
    const corner = px((await decodeWebp(fromPng.get(64)!.slice().buffer)) as Pixels, 0, 0);
    const centre = px((await decodeWebp(fromPng.get(64)!.slice().buffer)) as Pixels, 32, 32);
    expect(corner[3]).toBe(0);
    expect(centre[3]).toBe(255);
    const fromWebp = await makeAvatarImages(await webp(pixels(100, 50, photo)));
    expect(imageSize(fromWebp.get(256)!, "webp")).toEqual({ width: 256, height: 256 });
  });

  it("rotates a JPEG by its EXIF orientation", async () => {
    // Stored: red top half, blue bottom half. Orientation 6 (rotate 90° clockwise) shows red on the right.
    const jpg = withOrientation(await jpeg(pixels(300, 300, (_x, y) => (y < 150 ? [230, 20, 20] : [20, 20, 230])), 95), 6);
    const out = await makeAvatarImages(jpg);
    const img = (await decodeWebp(out.get(128)!.slice().buffer)) as Pixels;
    const [lr, , lb] = px(img, 10, 64);
    const [rr, , rb] = px(img, 117, 64);
    expect(lb!).toBeGreaterThan(lr!);
    expect(rr!).toBeGreaterThan(rb!);
  });

  it("rejects what it cannot or should not handle", async () => {
    expect(await status(makeAvatarImages(new TextEncoder().encode("GIF89a\x01\x00\x01\x00")))).toEqual({ status: 422, message: "Use a JPEG, PNG or WebP image." });
    expect((await status(makeAvatarImages(new Uint8Array(MAX_AVATAR_BYTES + 1)))).status).toBe(413);
    // A header claiming 5000×10: refused before anything is decoded.
    const wide = png(pixels(1, 1, () => [0, 0, 0]));
    new DataView(wide.buffer, wide.byteOffset).setUint32(16, 5000);
    expect(await status(makeAvatarImages(wide))).toMatchObject({ status: 422, message: expect.stringContaining("3072") });
    // A plausible JPEG header (64×64 baseline frame) followed by junk.
    const junk = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 64, 0, 64, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, ...Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff)]);
    expect(imageSize(junk, "jpeg")).toEqual({ width: 64, height: 64 });
    expect(await status(makeAvatarImages(junk))).toMatchObject({ status: 422, message: expect.stringContaining("could not be read") });
  });
});
