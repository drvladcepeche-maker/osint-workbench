/**
 * Tests for the imaging layer behind avatar matching.
 *
 * These are property tests dressed as unit tests, because the property is the feature.
 * "Two accounts share an avatar" is only usable evidence if the same picture at two
 * different sizes produces two hashes that are close, and two different pictures produce
 * two hashes that are far apart, with a gap wide enough that a threshold can live in it.
 * So the resize test asserts numbers rather than "it did not throw", and the numbers it
 * asserts are stated in the test itself — if a change to the resize filter or the DCT
 * narrows that gap, the suite says so instead of quietly degrading the signal.
 *
 * Nothing here touches the network. The PNG fixtures are generated in this file by a
 * small encoder written against the same specification the decoder reads, which is the
 * point: it is an independent implementation, so a shared misunderstanding of the filter
 * arithmetic cannot cancel out. (`scripts/make-icons.mjs` contains the writer this
 * approach is copied from; it is deliberately not imported, because a test that shares
 * code with the thing that produced the expectation proves less than it appears to.)
 *
 * The JPEG case asserts `null`. That is not a gap in coverage — in plain Node there is no
 * decoder for it, and the module is required to say so rather than invent a hash.
 */

import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

import {
  checkImageUrl,
  decodeImage,
  fetchImage,
  hammingHex,
  hashImage,
  sniffImageFormat
} from '../src/main/adapters/support/image'

/* ------------------------------------------------------------------ *
 * A PNG writer, so the decoder has something real to read
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

interface PngSpec {
  width: number
  height: number
  colourType: number
  bitDepth?: number
  /** Unfiltered scanline bytes, `height * stride`. 16-bit samples are big-endian. */
  raw: Uint8Array
  /** Filter type to encode each row with. Defaults to None for every row. */
  filters?: number[]
  palette?: Uint8Array
  transparency?: Uint8Array
  interlace?: number
}

function encodePng(spec: PngSpec): Buffer {
  const bitDepth = spec.bitDepth ?? 8
  const channels = CHANNELS[spec.colourType]
  const bpp = (channels * bitDepth) / 8
  const stride = spec.width * bpp
  assert.equal(spec.raw.length, stride * spec.height, 'fixture raw length must match the header')

  const filtered = Buffer.alloc(spec.height * (stride + 1))
  for (let y = 0; y < spec.height; y++) {
    const filter = spec.filters?.[y] ?? 0
    filtered[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const cur = spec.raw[y * stride + x]
      const a = x >= bpp ? spec.raw[y * stride + x - bpp] : 0
      const b = y > 0 ? spec.raw[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? spec.raw[(y - 1) * stride + x - bpp] : 0
      let value: number
      switch (filter) {
        case 1:
          value = cur - a
          break
        case 2:
          value = cur - b
          break
        case 3:
          value = cur - ((a + b) >> 1)
          break
        case 4:
          value = cur - paeth(a, b, c)
          break
        default:
          value = cur
          break
      }
      filtered[y * (stride + 1) + 1 + x] = value & 0xff
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(spec.width, 0)
  ihdr.writeUInt32BE(spec.height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = spec.colourType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = spec.interlace ?? 0

  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  if (spec.palette !== undefined) parts.push(chunk('PLTE', Buffer.from(spec.palette)))
  if (spec.transparency !== undefined) parts.push(chunk('tRNS', Buffer.from(spec.transparency)))
  parts.push(chunk('IDAT', deflateSync(filtered, { level: 6 })))
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/* ------------------------------------------------------------------ *
 * Picture generators
 * ------------------------------------------------------------------ */

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

/**
 * A smooth, low-frequency picture with a bright off-centre blob — the shape of a real
 * avatar as far as a 32x32 DCT is concerned. Smooth on purpose: a high-frequency pattern
 * would alias differently at 64 and at 32, and the test would then be measuring aliasing
 * rather than the hash.
 */
function portrait(fx: number, fy: number): number {
  const wave = Math.sin(Math.PI * (1.3 * fx + 0.2)) * Math.cos(Math.PI * (1.1 * fy - 0.3))
  const blob = 1 - Math.min(1, Math.hypot(fx - 0.32, fy - 0.62) * 1.6)
  return clamp255(40 + 150 * wave + 70 * blob)
}

/** A visually unrelated picture: diagonal bands, no blob, opposite gradient direction. */
function bands(fx: number, fy: number): number {
  return clamp255(255 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (3 * fx - 2 * fy))))
}

/** Render a continuous function to an 8-bit greyscale PNG at the given size. */
function greyPng(size: number, f: (fx: number, fy: number) => number): Buffer {
  const raw = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw[y * size + x] = f((x + 0.5) / size, (y + 0.5) / size)
  }
  return encodePng({ width: size, height: size, colourType: 0, raw })
}

/** Deterministic pseudo-random bytes; a fixed seed so a failure is always reproducible. */
function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let s = seed >>> 0
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = (s >>> 16) & 0xff
  }
  return out
}

function decoded(bytes: Buffer): { width: number; height: number; gray: Uint8Array } {
  const img = decodeImage(bytes)
  assert.ok(img !== null, 'expected these bytes to decode')
  return img
}

function hashed(bytes: Buffer): { dhash: string; phash: string } {
  const h = hashImage(bytes)
  assert.ok(h !== null, 'expected these bytes to hash')
  return h
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

export function imageTests(test: (name: string, fn: () => void | Promise<void>) => void): void {
  test('a generated RGB gradient PNG decodes at native size with the right luma', () => {
    const w = 64
    const h = 48
    const raw = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 3
        raw[p] = x * 4 // a neutral ramp: r = g = b, so luma is exactly the ramp
        raw[p + 1] = x * 4
        raw[p + 2] = x * 4
      }
    }
    const img = decoded(encodePng({ width: w, height: h, colourType: 2, raw }))

    assert.equal(img.width, 64)
    assert.equal(img.height, 48)
    assert.equal(img.gray.length, 64 * 48)
    assert.equal(img.gray[0], 0)
    assert.equal(img.gray[63], 252)
    assert.equal(img.gray[32], 128)
    // Every row is the same ramp, so the image is constant down each column.
    for (let y = 0; y < h; y++) assert.equal(img.gray[y * w + 17], 68, `row ${y} must match row 0`)
  })

  test('all five PNG scanline filters round-trip', () => {
    // Ten rows of noise, each encoded with a different filter, so every reconstruction
    // path is exercised both against a None row above it and against a filtered one.
    const w = 7
    const h = 10
    const raw = noise(w * h * 3, 0x5eed)
    const filters = [0, 1, 2, 3, 4, 4, 3, 2, 1, 0]
    const img = decoded(encodePng({ width: w, height: h, colourType: 2, raw, filters }))

    for (let i = 0; i < w * h; i++) {
      const expected = clamp255(0.299 * raw[i * 3] + 0.587 * raw[i * 3 + 1] + 0.114 * raw[i * 3 + 2])
      assert.equal(img.gray[i], expected, `pixel ${i} (row ${Math.floor(i / w)}, filter ${filters[Math.floor(i / w)]})`)
    }

    // And the filter choice must be invisible to the hash: same picture, all filters None.
    const plain = encodePng({ width: w, height: h, colourType: 2, raw })
    const filteredBytes = encodePng({ width: w, height: h, colourType: 2, raw, filters })
    assert.notDeepEqual(plain, filteredBytes, 'the two encodings must actually differ on the wire')
    assert.deepEqual(hashed(plain), hashed(filteredBytes))
  })

  test('greyscale, palette and 16-bit PNGs decode to the same grey the spec implies', () => {
    // Colour type 0: the sample is the luma.
    const grey = decoded(encodePng({ width: 4, height: 2, colourType: 0, raw: new Uint8Array([0, 85, 170, 255, 10, 20, 30, 40]) }))
    assert.deepEqual(Array.from(grey.gray), [0, 85, 170, 255, 10, 20, 30, 40])

    // Colour type 3: indices into a palette, with tRNS making entry 0 fully transparent.
    // Transparent composites over white, so it must read 255 and not 0.
    const palette = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255])
    const paletted = decoded(
      encodePng({
        width: 4,
        height: 1,
        colourType: 3,
        raw: new Uint8Array([0, 1, 2, 3]),
        palette,
        transparency: new Uint8Array([0])
      })
    )
    assert.equal(paletted.gray[0], 255, 'a fully transparent palette entry must composite over white')
    assert.equal(paletted.gray[1], clamp255(0.299 * 255), 'pure red')
    assert.equal(paletted.gray[2], clamp255(0.587 * 255), 'pure green')
    assert.equal(paletted.gray[3], 255, 'white')

    // Bit depth 16, big-endian: the high byte is what an 8-bit hash can see.
    const deep = decoded(
      encodePng({
        width: 3,
        height: 1,
        colourType: 0,
        bitDepth: 16,
        raw: new Uint8Array([0x00, 0xff, 0x80, 0x00, 0xff, 0x01])
      })
    )
    assert.deepEqual(Array.from(deep.gray), [0, 128, 255])
  })

  test('an RGBA PNG composites its alpha over white, not black', () => {
    // Half-opaque red. Luma of pure red is 0.299 * 255 = 76.245; over white at alpha 128
    // that is (76.245 * 128 + 255 * 127) / 255 = 165.27, so 165. Over black it would be
    // 38 — which is the number that would silently break matching against the same avatar
    // served as an opaque JPEG.
    const rgba = decoded(
      encodePng({ width: 2, height: 1, colourType: 6, raw: new Uint8Array([255, 0, 0, 128, 255, 0, 0, 255]) })
    )
    assert.equal(rgba.gray[0], 165)
    assert.equal(rgba.gray[1], 76)
  })

  test('an interlaced PNG is refused rather than half-decoded', () => {
    const raw = noise(16 * 16, 0x1337)
    const progressive = encodePng({ width: 16, height: 16, colourType: 0, raw })
    const interlaced = encodePng({ width: 16, height: 16, colourType: 0, raw, interlace: 1 })

    assert.ok(decodeImage(progressive) !== null, 'the same image without Adam7 must still decode')
    assert.equal(decodeImage(interlaced), null)
    assert.equal(hashImage(interlaced), null, 'no hash may be produced from an image we cannot read')
  })

  test('malformed PNG bytes produce null, never a partial picture', () => {
    const good = encodePng({ width: 8, height: 8, colourType: 0, raw: noise(64, 7) })

    // A truncated file: the IDAT chunk is cut in half.
    assert.equal(decodeImage(good.subarray(0, good.length - 20)), null)
    // Correct signature, garbage afterwards.
    assert.equal(decodeImage(Buffer.concat([good.subarray(0, 8), Buffer.from(noise(64, 9))])), null)
    // A header that claims more rows than the IDAT can possibly contain.
    const lying = Buffer.from(good)
    lying.writeUInt32BE(9, 20) // IHDR height field
    assert.equal(decodeImage(lying), null)
    // Not an image at all.
    assert.equal(decodeImage(Buffer.from('not an image', 'utf8')), null)
    assert.equal(decodeImage(Buffer.alloc(0)), null)
  })

  test('a 1x1 image is refused rather than hashed', () => {
    const dot = encodePng({ width: 1, height: 1, colourType: 0, raw: new Uint8Array([200]) })
    assert.ok(decodeImage(dot) !== null, 'it decodes fine')
    assert.equal(hashImage(dot), null, 'but it must not produce a hash every other placeholder matches')
  })

  test('the same picture at two sizes hashes close, a different picture hashes far', () => {
    // The property the whole avatar signal rests on. Measured on these fixtures:
    //
    //   portrait 64x64 vs 32x32   dhash 0    phash 0    (bit-identical hashes)
    //   bands    64x64 vs 32x32   dhash 0    phash 8
    //   portrait vs bands, both 64x64        dhash 30   phash 34
    //
    // The bands picture is the harder half deliberately: its detail sits near what a
    // 32-pixel grid can represent, so halving the resolution genuinely changes it and the
    // phash moves eight bits. That is the realistic ceiling on a same-picture distance,
    // and it is still nowhere near thirty. The thresholds below sit in that gap with room
    // for a resize or DCT change to shift the numbers without invalidating the feature.
    const same64 = hashed(greyPng(64, portrait))
    const same32 = hashed(greyPng(32, portrait))
    const other64 = hashed(greyPng(64, bands))
    const other32 = hashed(greyPng(32, bands))

    const dNear = hammingHex(same64.dhash, same32.dhash)
    const pNear = hammingHex(same64.phash, same32.phash)
    assert.ok(dNear >= 0 && dNear <= 8, `dhash across a 2x resize should stay within 8 bits, was ${dNear}`)
    assert.ok(pNear >= 0 && pNear <= 8, `phash across a 2x resize should stay within 8 bits, was ${pNear}`)

    const dSecond = hammingHex(other64.dhash, other32.dhash)
    const pSecond = hammingHex(other64.phash, other32.phash)
    assert.ok(dSecond >= 0 && dSecond <= 12, `the property must hold for a second picture too, dhash was ${dSecond}`)
    assert.ok(pSecond >= 0 && pSecond <= 12, `the property must hold for a second picture too, phash was ${pSecond}`)

    const dFar = hammingHex(same64.dhash, other64.dhash)
    const pFar = hammingHex(same64.phash, other64.phash)
    assert.ok(dFar >= 20, `two different pictures must be far apart by dhash, were ${dFar}`)
    assert.ok(pFar >= 20, `two different pictures must be far apart by phash, were ${pFar}`)

    // The gap is the usable part: any threshold between the two survives both.
    assert.ok(dFar - dNear >= 12, `dhash gap too narrow to hold a threshold: ${dNear} vs ${dFar}`)
    assert.ok(pFar - pNear >= 12, `phash gap too narrow to hold a threshold: ${pNear} vs ${pFar}`)
  })

  test('a hash is 16 lowercase hex characters and is stable across re-encoding', () => {
    const raw = new Uint8Array(32 * 32)
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw[y * 32 + x] = portrait((x + 0.5) / 32, (y + 0.5) / 32)

    const a = hashed(encodePng({ width: 32, height: 32, colourType: 0, raw }))
    const b = hashed(
      encodePng({ width: 32, height: 32, colourType: 0, raw, filters: Array.from({ length: 32 }, (_, i) => i % 5) })
    )

    for (const value of [a.dhash, a.phash]) assert.match(value, /^[0-9a-f]{16}$/)
    assert.equal(a.dhash, b.dhash, 'the same pixels must hash identically however they were compressed')
    assert.equal(a.phash, b.phash)
    assert.notEqual(a.dhash, a.phash, 'the two hashes must not be the same function under two names')
  })

  test('hammingHex counts bits, and refuses anything it cannot compare', () => {
    assert.equal(hammingHex('0123456789abcdef', '0123456789abcdef'), 0)
    assert.equal(hammingHex('ffffffffffffffff', '0000000000000000'), 64)
    assert.equal(hammingHex('0000000000000001', '0000000000000000'), 1)
    assert.equal(hammingHex('0000000000000000', '000000000000000f'), 4)

    assert.equal(hammingHex('0123456789abcdef', '0123456789abcde'), -1, 'different lengths are not comparable')
    assert.equal(hammingHex('zzzzzzzzzzzzzzzz', '0000000000000000'), -1, 'non-hex is not comparable')
    assert.equal(hammingHex('0000000000000000', 'not a hash'), -1)
    assert.equal(hammingHex('', ''), -1, 'empty is not a hash of anything')
  })

  test('sniffImageFormat reads the magic bytes, not the file name', () => {
    const tail = Buffer.from(noise(32, 3))
    const png = encodePng({ width: 2, height: 2, colourType: 0, raw: new Uint8Array([1, 2, 3, 4]) })

    assert.equal(sniffImageFormat(png), 'png')
    assert.equal(sniffImageFormat(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), tail])), 'jpeg')
    assert.equal(sniffImageFormat(Buffer.concat([Buffer.from('GIF89a', 'ascii'), tail])), 'gif')
    assert.equal(sniffImageFormat(Buffer.concat([Buffer.from('GIF87a', 'ascii'), tail])), 'gif')
    assert.equal(
      sniffImageFormat(Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), tail])),
      'webp'
    )
    assert.equal(sniffImageFormat(Buffer.concat([Buffer.from('BM', 'ascii'), tail])), 'bmp')
    assert.equal(sniffImageFormat(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>', 'utf8')), 'svg')
    assert.equal(sniffImageFormat(Buffer.from('{"error":"not found"}', 'utf8')), 'unknown')
    assert.equal(sniffImageFormat(Buffer.alloc(0)), 'unknown')
  })

  test('checkImageUrl allows a normal avatar and refuses everything that is not one', () => {
    assert.equal(checkImageUrl('https://avatars.githubusercontent.com/u/1024025?v=4'), null)
    assert.equal(checkImageUrl('https://cdn-images-1.medium.com/fit/c/64/64/1*abc.jpeg'), null)

    assert.equal(checkImageUrl('http://avatars.githubusercontent.com/u/1.png'), 'scheme')
    assert.equal(checkImageUrl('data:image/png;base64,iVBORw0KGgo='), 'scheme')
    assert.equal(checkImageUrl('file:///etc/passwd'), 'scheme')

    assert.equal(checkImageUrl('https://intranet/avatar.png'), 'private-host', 'a bare hostname is not the public web')
    assert.equal(checkImageUrl('https://localhost/avatar.png'), 'private-host')
    assert.equal(checkImageUrl('https://127.0.0.1/avatar.png'), 'private-host')
    assert.equal(checkImageUrl('https://10.0.0.5/avatar.png'), 'private-host')
    assert.equal(checkImageUrl('https://192.168.1.1/avatar.png'), 'private-host')
    assert.equal(checkImageUrl('https://169.254.169.254/latest/meta-data/'), 'private-host', 'the cloud metadata endpoint')
    assert.equal(checkImageUrl('https://printer.local/avatar.png'), 'private-host')
    assert.equal(checkImageUrl('https://example.onion/avatar.png'), 'private-host')
    // The URL parser normalises numeric hosts, so the obfuscated spellings land on the
    // same branch as the plain one.
    assert.equal(checkImageUrl('https://2130706433/avatar.png'), 'private-host')

    assert.equal(checkImageUrl('https://[::1]/avatar.png'), 'ip-literal')
    assert.equal(checkImageUrl('https://[2606:4700:4700::1111]/avatar.png'), 'ip-literal')

    assert.equal(checkImageUrl('https://user:pass@cdn.example.com/avatar.png'), 'credentials')
    assert.equal(checkImageUrl(`https://cdn.example.com/${'a'.repeat(2100)}.png`), 'too-long')
    assert.equal(checkImageUrl('not a url at all'), 'unparseable')
    assert.equal(checkImageUrl(''), 'unparseable')
  })

  test('a JPEG hashes to null outside Electron instead of throwing or faking it', () => {
    // A structurally plausible JPEG: SOI, an APP0 marker, filler, EOI. Nothing in plain
    // Node can decode it, and nothing may pretend to.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF\0', 'ascii'),
      Buffer.from(noise(256, 0xbeef)),
      Buffer.from([0xff, 0xd9])
    ])

    assert.equal(sniffImageFormat(jpeg), 'jpeg', 'it is recognisably a JPEG')
    assert.equal(decodeImage(jpeg), null)
    assert.equal(hashImage(jpeg), null, 'no fallback hash may be invented from the raw bytes')
  })

  test('fetchImage refuses a blocked URL without opening a socket', async () => {
    const res = await fetchImage('http://127.0.0.1:9/avatar.png', { timeoutMs: 50 })

    assert.equal(res.ok, false)
    assert.equal(res.status, 0)
    assert.equal(res.bytes, 0)
    assert.equal(res.sha256, null)
    assert.equal(res.hash, null)
    assert.equal(res.reason, 'blocked:scheme')

    const priv = await fetchImage('https://192.168.1.4/avatar.png', { timeoutMs: 50 })
    assert.equal(priv.reason, 'blocked:private-host')
    assert.ok(priv.durationMs < 50, 'a blocked URL must not have cost a request')
  })
}
