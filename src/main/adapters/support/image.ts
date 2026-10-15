/**
 * Avatars, hashed, so that "is this the same person" can be answered by a picture.
 *
 * Pivot search asks whether two accounts on two sites belong to one person. Most of the
 * signals available for that are weak — a shared username is a coincidence waiting to
 * happen, a shared display name even more so. The profile picture is different: an avatar
 * is a file the subject uploaded twice, and finding the same file behind two handles is
 * the strongest cheap evidence this app can produce without a human looking at anything.
 *
 * It is only strong if the comparison survives what the sites do to the file. Every
 * platform re-encodes and re-sizes what it is given, so byte equality answers almost
 * nothing and a plain sha256 of the download says "different" for two copies of the same
 * photograph. Hence perceptual hashing: reduce the picture to its coarse structure, emit
 * 64 bits, and compare by Hamming distance. Two hashes rather than one, because they fail
 * differently — dHash reads horizontal gradients and survives re-compression well but is
 * fooled by a mirror flip, pHash reads low-frequency content and survives cropping and
 * gamma shifts but is duller on flat images. A caller that wants a claim should want both
 * to agree.
 *
 * Three deliberate positions are encoded here.
 *
 * **The URL gate comes before the socket.** These URLs arrive inside third-party JSON —
 * they are attacker-influenced by construction. `checkImageUrl` refuses anything that is
 * not a plain public https image before any request is made, so the app cannot be aimed
 * at the loopback interface or a link-local metadata endpoint by a crafted profile.
 *
 * **PNG is decoded here, in TypeScript; everything else is Electron's problem.** A PNG
 * decoder is inflate plus five filters, small enough to own and deterministic across
 * environments, which matters because a hash that differs between the test suite in plain
 * Node and the packaged app is worse than no hash. A baseline JPEG decoder is not in that
 * category, and JPEG is what real avatars are — GitHub and Medium both serve
 * `image/jpeg`. So JPEG goes through Chromium's decoder via `nativeImage`, reached
 * lazily, and simply is not available outside Electron.
 *
 * **A picture that cannot be decoded produces no hash.** Not a digest of the raw bytes,
 * not a length-based stand-in. A byte-level fallback would return "different" for two
 * re-encodings of one photograph while looking exactly like a real comparison, which is
 * the failure mode the confidence model exists to prevent. `null` with a reason is the
 * honest answer and the pivot feature is written to expect it.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { inflateSync } from 'node:zlib'

import { httpGetBinary } from './net'

/** A 64-bit perceptual hash pair, each 16 lowercase hex characters. */
export interface ImageHash {
  dhash: string
  phash: string
}

export interface DecodedImage {
  width: number
  height: number
  /** one byte of luma per pixel, row-major */
  gray: Uint8Array
}

export interface FetchedImage {
  url: string
  /**
   * True only when a hash came out the other end. Not the HTTP status — a caller of this
   * module has exactly one question, and `status` is still here for the case file.
   */
  ok: boolean
  status: number
  mediaType: string
  bytes: number
  /** sha256 of the exact bytes received, lowercase hex. null when nothing was fetched. */
  sha256: string | null
  hash: ImageHash | null
  /** Present whenever `hash` is null. Machine-readable, e.g. 'blocked:private-host', 'http:404', 'transport:ENOTFOUND', 'undecodable:jpeg', 'empty', 'too-large'. */
  reason: string | null
  durationMs: number
}

/**
 * Refuse to decode anything with an implausible edge. An avatar is never 8193 pixels
 * wide, and the cap keeps a hostile header from asking for a gigabyte of scanline buffer
 * before the data that would have failed to inflate is even read.
 */
const MAX_DIMENSION = 8192

/* ------------------------------------------------------------------ *
 * The URL gate
 * ------------------------------------------------------------------ */

/**
 * Hostname suffixes that never name a public web server. `.onion` is in the list not
 * because it is private but because reaching it needs Tor, so an attempt is a guaranteed
 * confusing failure rather than a fetch.
 */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localhost', '.home', '.lan', '.test', '.invalid', '.onion']

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Private, loopback, link-local, CGNAT, benchmarking, multicast and reserved space. */
function isReservedIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true
  if (a >= 224) return true // 224/4 multicast and 240/4 reserved, including 255.255.255.255
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return false
}

/**
 * null when the URL is safe to fetch; otherwise a short machine-readable reason.
 *
 * **This is a check on the URL, not on where the connection ends up.** It does not defend
 * against DNS rebinding, because the fetch resolves the name itself and a hostname that
 * looks public here can resolve to 127.0.0.1 a millisecond later. Closing that would mean
 * resolving first and pinning the address for the connection, which the built-in `fetch`
 * does not expose. What this does buy is the whole class of attacks that need no DNS at
 * all — a literal address, a loopback name, a `file:` URL — which is what actually turns
 * up in adversarial profile data.
 *
 * The WHATWG parser helps more than it looks: it normalises the numeric host forms, so
 * `https://2130706433/` and `https://0x7f.1/` both arrive here as `127.0.0.1` and are
 * rejected by the same branch as the obvious spelling.
 */
export function checkImageUrl(url: string): string | null {
  if (typeof url !== 'string' || url.trim() === '') return 'unparseable'
  if (url.length > 2048) return 'too-long'

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'unparseable'
  }

  if (parsed.protocol !== 'https:') return 'scheme'
  if (parsed.username !== '' || parsed.password !== '') return 'credentials'

  // A bracketed host is an IPv6 literal; there is no legitimate avatar behind one.
  if (parsed.hostname.startsWith('[')) return 'ip-literal'

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '') return 'unparseable'

  const v4 = IPV4.exec(host)
  if (v4 !== null) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (octets.some((o) => o > 255)) return 'unparseable'
    return isReservedIpv4(octets[0], octets[1]) ? 'private-host' : null
  }

  if (host === 'localhost') return 'private-host'
  if (!host.includes('.')) return 'private-host'
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private-host'

  return null
}

/* ------------------------------------------------------------------ *
 * Format sniffing
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * What the bytes actually are, ignoring what the server called them.
 *
 * Used for the `undecodable:<format>` reason, which is the only place the operator finds
 * out that a source has started serving WebP and the avatar signal quietly went away.
 */
export function sniffImageFormat(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 6) {
    const head = bytes.toString('ascii', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'

  // SVG has no magic number, so this is a text probe over the head of the file: an
  // optional BOM, then any number of declarations, doctypes and comments, then the tag.
  const head = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '')
  if (/^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'svg'

  return 'unknown'
}

/* ------------------------------------------------------------------ *
 * PNG, decoded here
 * ------------------------------------------------------------------ */

/** Samples per pixel, indexed by PNG colour type. The gaps (1 and 5) are not legal. */
const PNG_CHANNELS: Record<number, number | undefined> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * BT.601 luma, with any transparency composited over white first.
 *
 * White rather than black because that is what a profile page puts behind an avatar, and
 * because a transparent PNG logo composited over black inverts its own contrast and would
 * not match the JPEG the other site made of it.
 *
 * Luma is a linear combination, so compositing the luma is the same number as compositing
 * each channel and then taking the luma; this does it once instead of three times.
 */
function compositeLuma(r: number, g: number, b: number, alpha: number): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  return Math.round(alpha >= 255 ? y : (y * alpha + 255 * (255 - alpha)) / 255)
}

/**
 * Chunk CRCs are not verified. zlib rejects a corrupt IDAT stream on its own, the
 * scanline arithmetic below rejects anything of the wrong length, and every path out of
 * here is `null` — so a CRC check would buy a different reason for the same refusal.
 */
function decodePng(bytes: Buffer): DecodedImage | null {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null

  let width = 0
  let height = 0
  let bitDepth = 0
  let colourType = -1
  let interlace = 0
  let sawHeader = false
  let palette: Buffer | null = null
  let paletteAlpha: Buffer | null = null
  const idat: Buffer[] = []

  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (length > 0x7fffffff) return null
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) return null // truncated chunk
    const data = bytes.subarray(start, end)

    if (type === 'IHDR') {
      if (length !== 13 || sawHeader) return null
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colourType = data[9]
      if (data[10] !== 0 || data[11] !== 0) return null // unknown compression or filter method
      interlace = data[12]
      sawHeader = true
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      paletteAlpha = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }

  if (!sawHeader || idat.length === 0) return null
  // Adam7. Decoding it properly means seven passes and a reassembly step; decoding it
  // improperly means a hash of a picture that was never displayed. Refuse instead.
  if (interlace !== 0) return null
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null
  if (bitDepth !== 8 && bitDepth !== 16) return null

  const channels = PNG_CHANNELS[colourType]
  if (channels === undefined) return null
  // Palette entries are bytes, so a palette image at 16 bits does not exist, and sub-byte
  // depths are outside what this decoder claims to support.
  if (colourType === 3 && (bitDepth !== 8 || palette === null)) return null

  const sampleBytes = bitDepth / 8
  const bpp = channels * sampleBytes
  const stride = width * bpp

  let raw: Buffer
  try {
    // All IDAT chunks are one zlib stream that happens to be cut into pieces; inflating
    // them separately fails on any file whose compressor did not align to the split.
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  if (raw.length !== height * (stride + 1)) return null

  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x]
      const a = x >= bpp ? out[dst + x - bpp] : 0
      const b = y > 0 ? out[up + x] : 0
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0
      let value: number
      switch (filter) {
        case 0:
          value = cur
          break
        case 1:
          value = cur + a
          break
        case 2:
          value = cur + b
          break
        case 3:
          value = cur + ((a + b) >> 1)
          break
        case 4:
          value = cur + paeth(a, b, c)
          break
        default:
          return null
      }
      out[dst + x] = value & 0xff
    }
  }

  const gray = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    for (let x = 0; x < width; x++) {
      // At 16 bits the high byte comes first, and the high byte is the whole of what an
      // 8-bit-per-pixel hash can see, so the low byte is dropped rather than averaged.
      const p = row + x * bpp
      let r = 0
      let g = 0
      let b = 0
      let alpha = 255
      switch (colourType) {
        case 0:
          r = g = b = out[p]
          break
        case 2:
          r = out[p]
          g = out[p + sampleBytes]
          b = out[p + 2 * sampleBytes]
          break
        case 3: {
          const index = out[p]
          const at = index * 3
          const plte = palette as Buffer
          if (at + 2 >= plte.length) return null // index past the end of the palette
          r = plte[at]
          g = plte[at + 1]
          b = plte[at + 2]
          // tRNS for a palette image is one alpha byte per entry, and it is allowed to be
          // shorter than the palette; the entries it does not reach are opaque.
          if (paletteAlpha !== null && index < paletteAlpha.length) alpha = paletteAlpha[index]
          break
        }
        case 4:
          r = g = b = out[p]
          alpha = out[p + sampleBytes]
          break
        default:
          r = out[p]
          g = out[p + sampleBytes]
          b = out[p + 2 * sampleBytes]
          alpha = out[p + 3 * sampleBytes]
          break
      }
      gray[y * width + x] = compositeLuma(r, g, b, alpha)
    }
  }

  return { width, height, gray }
}

/* ------------------------------------------------------------------ *
 * Everything else, decoded by Chromium — only when Chromium is present
 * ------------------------------------------------------------------ */

interface ElectronBitmapImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  getBitmap(): Buffer
}

interface ElectronNativeImage {
  createFromBuffer(buffer: Buffer): ElectronBitmapImage
}

/** `undefined` means the lookup has not been attempted; `null` means it failed. */
let cachedNativeImage: ElectronNativeImage | null | undefined

/**
 * Reach Electron's decoder without putting Electron into the module graph.
 *
 * `src/main/service.ts` imports nothing from Electron on purpose — that is what lets the
 * test suite drive the entire application in plain Node. This module is reachable from an
 * adapter and therefore from the service, so a static `import { nativeImage } from
 * 'electron'` here would break the suite for every test, not just the imaging ones. A
 * `createRequire` lookup keeps the dependency out of the graph and out of the bundle.
 *
 * The verification below is not paranoia about a missing package. Outside Electron,
 * `require('electron')` **succeeds** and returns a *string* — the npm package's index.js
 * exports the path to the downloaded binary so that build tooling can spawn it. A truthy
 * check therefore passes, and the very next line dies on `.createFromBuffer` of a string.
 * So: the `process.versions.electron` guard first, then confirm the result is an object
 * carrying a callable `nativeImage.createFromBuffer`, and cache whichever way it went.
 * Every failure is `null`; nothing here throws.
 *
 * The require base is `process.execPath` because inside the main process it does not
 * matter — Electron serves its own module out of a patched loader rather than out of
 * node_modules — and outside the main process the guard has already returned.
 */
function nativeImageApi(): ElectronNativeImage | null {
  if (cachedNativeImage !== undefined) return cachedNativeImage
  cachedNativeImage = null

  const version = process.versions.electron
  if (typeof version !== 'string' || version === '') return cachedNativeImage

  try {
    const required: unknown = createRequire(process.execPath)('electron')
    if (typeof required !== 'object' || required === null) return cachedNativeImage
    const candidate: unknown = (required as { nativeImage?: unknown }).nativeImage
    if (typeof candidate !== 'object' || candidate === null) return cachedNativeImage
    if (typeof (candidate as { createFromBuffer?: unknown }).createFromBuffer !== 'function') {
      return cachedNativeImage
    }
    cachedNativeImage = candidate as ElectronNativeImage
  } catch {
    cachedNativeImage = null
  }
  return cachedNativeImage
}

function decodeViaElectron(bytes: Buffer): DecodedImage | null {
  const api = nativeImageApi()
  if (api === null) return null

  try {
    const image = api.createFromBuffer(bytes)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const width = Math.trunc(size.width)
    const height = Math.trunc(size.height)
    if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null

    const bitmap = image.getBitmap()
    // Skia is entitled to pad its rows, so the row length is derived rather than assumed.
    const stride = Math.floor(bitmap.length / height)
    if (stride < width * 4) return null

    const gray = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      const row = y * stride
      for (let x = 0; x < width; x++) {
        const p = row + x * 4
        const alpha = bitmap[p + 3]
        // BGRA, and premultiplied: the stored channel is already colour * alpha / 255.
        // Compositing that over white is therefore `stored + (255 - alpha)`, which needs
        // no division and so cannot divide by a zero alpha.
        const b = bitmap[p] + 255 - alpha
        const g = bitmap[p + 1] + 255 - alpha
        const r = bitmap[p + 2] + 255 - alpha
        gray[y * width + x] = Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b))
      }
    }
    return { width, height, gray }
  } catch {
    return null
  }
}

/**
 * Decode to native-resolution grayscale, by whichever route the bytes allow.
 *
 * Both routes produce the same shape so that everything downstream is one code path. PNG
 * deliberately does **not** fall back to Electron when the built-in decoder refuses: the
 * point of owning that decoder is that a given PNG hashes identically in the test suite
 * and in the packaged app, and a fallback would quietly reintroduce the difference for
 * exactly the files where the two disagree.
 */
export function decodeImage(bytes: Buffer): DecodedImage | null {
  if (bytes.length === 0) return null
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(bytes)
  return decodeViaElectron(bytes)
}

/* ------------------------------------------------------------------ *
 * Resize, DCT, and the two hashes
 * ------------------------------------------------------------------ */

/**
 * Area-average ("box") resize, separable, with fractional edge weights.
 *
 * Both hashes go through this one function. Nearest-neighbour would make the hashes
 * depend on which source pixels happen to land on the sample grid, which is precisely the
 * dependency that must not exist between one site's 400x400 avatar and another's 128x128
 * copy of it. Bilinear would be defensible but is a worse low-pass filter when the scale
 * factor is large, and every input here is being reduced hard.
 */
function boxResize(img: DecodedImage, dw: number, dh: number): Float64Array {
  const { width: sw, height: sh, gray } = img

  const horizontal = new Float64Array(dw * sh)
  const xScale = sw / dw
  for (let x = 0; x < dw; x++) {
    const x0 = x * xScale
    const x1 = (x + 1) * xScale
    const first = Math.floor(x0)
    const last = Math.min(sw, Math.ceil(x1))
    for (let y = 0; y < sh; y++) {
      let acc = 0
      let weight = 0
      for (let i = first; i < last; i++) {
        const w = Math.min(x1, i + 1) - Math.max(x0, i)
        if (w <= 0) continue
        acc += gray[y * sw + i] * w
        weight += w
      }
      horizontal[y * dw + x] = weight > 0 ? acc / weight : 0
    }
  }

  const out = new Float64Array(dw * dh)
  const yScale = sh / dh
  for (let y = 0; y < dh; y++) {
    const y0 = y * yScale
    const y1 = (y + 1) * yScale
    const first = Math.floor(y0)
    const last = Math.min(sh, Math.ceil(y1))
    for (let x = 0; x < dw; x++) {
      let acc = 0
      let weight = 0
      for (let j = first; j < last; j++) {
        const w = Math.min(y1, j + 1) - Math.max(y0, j)
        if (w <= 0) continue
        acc += horizontal[j * dw + x] * w
        weight += w
      }
      out[y * dw + x] = weight > 0 ? acc / weight : 0
    }
  }

  return out
}

/**
 * 64 bits to 16 hex characters, most significant bit first.
 *
 * `bits[0]` is bit 63 — the first comparison the hash made — so the printed string reads
 * in the same order the image was scanned, and a prefix of the hex is a prefix of the
 * top-left of the picture.
 */
function bitsToHex(bits: number[]): string {
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]
    hex += nibble.toString(16)
  }
  return hex
}

const PHASH_SIZE = 32
const PHASH_BLOCK = 8

/** cos(pi * (2x + 1) * u / 2N) for the eight coefficients that survive the crop. */
const DCT_COS = (() => {
  const table = new Float64Array(PHASH_BLOCK * PHASH_SIZE)
  for (let u = 0; u < PHASH_BLOCK; u++) {
    for (let x = 0; x < PHASH_SIZE; x++) {
      table[u * PHASH_SIZE + x] = Math.cos((Math.PI * (2 * x + 1) * u) / (2 * PHASH_SIZE))
    }
  }
  return table
})()

const DCT_SCALE = (() => {
  const table = new Float64Array(PHASH_BLOCK)
  for (let u = 0; u < PHASH_BLOCK; u++) {
    table[u] = u === 0 ? Math.sqrt(1 / PHASH_SIZE) : Math.sqrt(2 / PHASH_SIZE)
  }
  return table
})()

/**
 * The top-left 8x8 of the orthonormal 2-D DCT-II of a 32x32 plane.
 *
 * Separable, and only the frequencies that survive the crop are ever computed: 64 of the
 * 1,024 coefficients are kept, so both passes run over eight frequencies instead of
 * thirty-two and the other 960 are never formed at all.
 */
function dctBlock(plane: Float64Array): Float64Array {
  const rows = new Float64Array(PHASH_SIZE * PHASH_BLOCK)
  for (let y = 0; y < PHASH_SIZE; y++) {
    for (let u = 0; u < PHASH_BLOCK; u++) {
      let acc = 0
      for (let x = 0; x < PHASH_SIZE; x++) acc += plane[y * PHASH_SIZE + x] * DCT_COS[u * PHASH_SIZE + x]
      rows[y * PHASH_BLOCK + u] = acc * DCT_SCALE[u]
    }
  }

  const block = new Float64Array(PHASH_BLOCK * PHASH_BLOCK)
  for (let v = 0; v < PHASH_BLOCK; v++) {
    for (let u = 0; u < PHASH_BLOCK; u++) {
      let acc = 0
      for (let y = 0; y < PHASH_SIZE; y++) acc += rows[y * PHASH_BLOCK + u] * DCT_COS[v * PHASH_SIZE + y]
      block[v * PHASH_BLOCK + u] = acc * DCT_SCALE[v]
    }
  }
  return block
}

function dhashOf(img: DecodedImage): string {
  // Nine columns for eight comparisons: the extra column is what makes this a gradient
  // hash rather than a brightness hash, and brightness is the thing re-encoding changes.
  const px = boxResize(img, 9, 8)
  const bits: number[] = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits.push(px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0)
  }
  return bitsToHex(bits)
}

function phashOf(img: DecodedImage): string {
  const block = dctBlock(boxResize(img, PHASH_SIZE, PHASH_SIZE))

  // The DC term at [0][0] is the average brightness of the whole picture. It is one to
  // two orders of magnitude larger than every AC coefficient, so including it in the
  // median would drag the threshold above almost all of them and produce a hash that is
  // mostly zeroes for every image alike. It is excluded from the median — and it still
  // occupies its bit in the output, where it is compared against that median like the
  // others and, being the largest value present, is essentially always a 1.
  const ac = Array.from(block.subarray(1)).sort((a, b) => a - b)
  const median = ac[Math.floor(ac.length / 2)]

  const bits: number[] = []
  for (let i = 0; i < block.length; i++) bits.push(block[i] > median ? 1 : 0)
  return bitsToHex(bits)
}

/**
 * Both hashes of an encoded image, or null if it could not be decoded.
 *
 * A picture smaller than 2x2 is refused rather than upscaled: a 1x1 tracking pixel and a
 * 1x1 transparent placeholder would otherwise both hash to a perfectly valid-looking
 * value, and every such placeholder on the internet would "match" every other one.
 */
export function hashImage(bytes: Buffer): ImageHash | null {
  const img = decodeImage(bytes)
  if (img === null) return null
  if (img.width < 2 || img.height < 2) return null
  if (img.gray.length !== img.width * img.height) return null
  return { dhash: dhashOf(img), phash: phashOf(img) }
}

const HEX_ONLY = /^[0-9a-f]+$/

/**
 * Hamming distance between two hex hashes, or -1 if the pair is not comparable.
 *
 * -1 rather than a throw or a 0: these strings come out of stored case files that may
 * predate a format change, and "cannot compare" must not read as "identical". Input is
 * accepted in either case although this module only ever emits lowercase.
 */
export function hammingHex(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') return -1
  if (a.length === 0 || a.length !== b.length) return -1
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (!HEX_ONLY.test(left) || !HEX_ONLY.test(right)) return -1

  let distance = 0
  for (let i = 0; i < left.length; i++) {
    let x = parseInt(left[i], 16) ^ parseInt(right[i], 16)
    while (x !== 0) {
      distance += x & 1
      x >>= 1
    }
  }
  return distance
}

/* ------------------------------------------------------------------ *
 * Fetch
 * ------------------------------------------------------------------ */

/** A transport error, reduced to something worth grouping by in a case file. */
function transportReason(error: string): string {
  if (error.startsWith('Timed out')) return 'transport:timeout'
  if (error.startsWith('Cancelled')) return 'transport:cancelled'
  const code = /^([A-Z][A-Z0-9_]{2,}):/.exec(error)
  return `transport:${code === null ? error.replace(/\s+/g, ' ').trim() : code[1]}`
}

/** What the server said it sent, or failing that, what it actually sent. */
function mediaTypeOf(contentType: string | undefined, bytes: Buffer): string {
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (declared !== '') return declared
  const sniffed = sniffImageFormat(bytes)
  if (sniffed === 'unknown') return 'application/octet-stream'
  return sniffed === 'svg' ? 'image/svg+xml' : `image/${sniffed}`
}

/**
 * Fetch one avatar and hash it. Never throws; every failure is a populated `reason`.
 *
 * The gate runs before the request, so a blocked URL costs no packet and leaves a record
 * saying which rule refused it. `sha256` is over the bytes actually received — which,
 * when `truncated` fired, is the retained prefix and not the whole file, so it is a
 * digest of the evidence held rather than a claim about the original.
 */
/** Redirect hops an avatar fetch will follow, re-gating each one. */
const MAX_IMAGE_REDIRECTS = 5

export async function fetchImage(
  url: string,
  opts: { timeoutMs: number; signal?: AbortSignal; maxBytes?: number; userAgent?: string }
): Promise<FetchedImage> {
  const started = Date.now()

  const blocked = checkImageUrl(url)
  if (blocked !== null) {
    return {
      url,
      ok: false,
      status: 0,
      mediaType: '',
      bytes: 0,
      sha256: null,
      hash: null,
      reason: `blocked:${blocked}`,
      durationMs: Date.now() - started
    }
  }

  /*
   * Redirects are followed by hand, and that is the whole reason this loop exists.
   *
   * `checkImageUrl` only ever sees the URL it is given. With `redirect: 'follow'` the
   * runtime chases a 302 on its own, so a perfectly public `https://` avatar URL is free
   * to hand the fetch straight to a link-local metadata endpoint and the gate never hears
   * about it. Following manually means the gate runs on every hop, which is the only
   * arrangement in which it means anything.
   *
   * Five hops is generous for an avatar CDN and short enough that a redirect loop is a
   * reported condition rather than a hang.
   */
  let res = await httpGetBinary({
    url,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    maxBytes: opts.maxBytes,
    userAgent: opts.userAgent,
    accept: 'image/*',
    redirect: 'manual'
  })
  let hop = 0
  let current = url
  while (res.error === null && res.status >= 300 && res.status < 400) {
    if (++hop > MAX_IMAGE_REDIRECTS) {
      return {
        url: current,
        ok: false,
        status: res.status,
        mediaType: '',
        bytes: 0,
        sha256: null,
        hash: null,
        reason: 'blocked:too-many-redirects',
        durationMs: Date.now() - started
      }
    }
    const location = res.headers['location']
    if (location === undefined || location === '') break
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      break
    }
    const refused = checkImageUrl(next)
    if (refused !== null) {
      return {
        url: next,
        ok: false,
        status: res.status,
        mediaType: '',
        bytes: 0,
        sha256: null,
        hash: null,
        reason: `blocked:redirect-to-${refused}`,
        durationMs: Date.now() - started
      }
    }
    current = next
    res = await httpGetBinary({
      url: next,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      maxBytes: opts.maxBytes,
      userAgent: opts.userAgent,
      accept: 'image/*',
      redirect: 'manual'
    })
  }

  const body = res.body
  const mediaType = mediaTypeOf(res.headers['content-type'], body)
  const sha256 = body.byteLength > 0 ? createHash('sha256').update(body).digest('hex') : null
  const settle = (hash: ImageHash | null, reason: string | null): FetchedImage => ({
    url: res.url,
    ok: hash !== null,
    status: res.status,
    mediaType,
    bytes: res.bytes,
    sha256,
    hash,
    reason,
    durationMs: Date.now() - started
  })

  if (res.error !== null) return settle(null, transportReason(res.error))
  if (!res.ok) return settle(null, `http:${res.status}`)
  if (body.byteLength === 0) return settle(null, 'empty')
  // A cut-off image is not a smaller image; whatever a decoder made of the prefix would
  // hash a picture nobody has ever seen.
  if (res.truncated) return settle(null, 'too-large')

  const hash = hashImage(body)
  return hash === null ? settle(null, `undecodable:${sniffImageFormat(body)}`) : settle(hash, null)
}
