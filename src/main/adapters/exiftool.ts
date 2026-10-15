/**
 * `exiftool` — read every piece of metadata embedded in a local file.
 *
 * The only adapter here that touches no network at all, cannot be rate-limited, cannot be
 * blocked, and gives the same answer every time. It is also the one whose output most
 * often contains something the subject did not know was there.
 *
 * Two installation facts from Phase 0, both of which will hang or break a spawn if
 * ignored: the shipped Windows binary is named `exiftool(-k).exe`, and the `(-k)` suffix
 * makes it **pause for a keypress**, which would hang a child process forever — it must be
 * renamed to `exiftool.exe`. And the executable must stay next to its `exiftool_files\`
 * directory, so it is invoked at `bin\exiftool-13.59_64\exiftool.exe` rather than copied
 * into `bin\`.
 */

import type { EntityKind, Finding } from '../../shared/types'
import {
  makeFinding,
  type Adapter,
  type AdapterContext,
  type AdapterInput,
  type EntityProposal,
  type RawResult
} from './types'
import {
  beginEnvelope,
  finishEnvelope,
  group,
  parseJsonSafe,
  readEnvelope,
  recordSpawn,
  stderrSummary
} from './support/envelope'
import { fileSource, localSource } from './support/sources'
import { checkBinary, mergedOptions, optionBoolean, resolveBinary } from './support/toolkit'

const ID = 'exiftool'
const VERSION = '1.0.0'
const BIN_CANDIDATES = [
  'bin/exiftool-13.59_64/exiftool.exe',
  'bin/exiftool/exiftool.exe',
  'bin/exiftool.exe',
  'bin/exiftool'
] as const

type ExifRecord = Record<string, unknown>

/**
 * Tags that answer a real investigative question, in the order a human wants them.
 *
 * `proposes` is the narrow part. Almost nothing here names a *thing*: a lens model, a
 * capture time, an XMP document id and a serial number are all facts about a file rather
 * than entities in their own right, and the camera's `Make`/`Model` names a product line,
 * not an organisation anyone is investigating. Only the fields that carry a human or
 * corporate name carry a proposal, and each one gets to look at which of its keys matched
 * — `Author` in a document's properties is a person, `Producer` beside it is a PDF
 * library.
 */
const NOTABLE: {
  keys: string[]
  describe: (value: string, file: string) => string
  proposes?: (value: string, file: string, key: string) => { kind: EntityKind; value: string; rationale: string } | null
}[] = [
  {
    keys: ['CreatorTool', 'Software', 'ProcessingSoftware', 'HistorySoftwareAgent'],
    describe: (v, f) =>
      `${f} names "${v}" as the software that produced or last wrote it. Editing software here means the file is not a straight-from-camera original.`
  },
  {
    keys: ['DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate'],
    describe: (v, f) => `${f} carries the capture timestamp ${v} in its metadata.`
  },
  {
    keys: ['OffsetTimeOriginal', 'OffsetTime', 'TimeZone'],
    describe: (v, f) => `${f} records the UTC offset ${v} at the moment of capture, which places the camera's clock in a specific time zone.`
  },
  {
    keys: ['Artist', 'Creator', 'By-line', 'OwnerName', 'CameraOwnerName', 'XPAuthor'],
    describe: (v, f) => `${f} names "${v}" as its author or camera owner.`,
    proposes: (v, f) => {
      const name = personName(v)
      return name
        ? {
            kind: 'person',
            value: name,
            rationale: `${truncate(f, 80)} carries this in its own author field. Free text that ExifTool itself can write, so it names whoever last set it — and a camera body is not a person; bodies are sold, borrowed and shared.`
          }
        : null
    }
  },
  {
    keys: ['Copyright', 'Rights', 'CopyrightNotice'],
    describe: (v, f) => `${f} carries the copyright notice "${v}".`,
    proposes: (v, f) => {
      const owner = copyrightOwner(v)
      return owner
        ? {
            kind: 'organisation',
            value: owner,
            rationale: `The rights holder named in ${truncate(f, 80)}'s copyright notice, with the year and the boilerplate stripped. A notice as often names an individual as a company, and asserting it is free.`
          }
        : null
    }
  },
  {
    keys: ['SerialNumber', 'InternalSerialNumber', 'BodySerialNumber', 'LensSerialNumber'],
    describe: (v, f) =>
      `${f} contains the device serial number ${v}. A serial number links every photograph ever taken with that body, across accounts and years.`
  },
  {
    keys: ['ImageDescription', 'Description', 'Caption-Abstract', 'XPComment', 'UserComment'],
    describe: (v, f) => `${f} carries the embedded description "${truncate(v, 300)}".`
  },
  {
    keys: ['Keywords', 'Subject', 'XPKeywords'],
    describe: (v, f) => `${f} carries the embedded keywords "${truncate(v, 300)}".`
  },
  {
    keys: ['LensModel', 'LensID'],
    describe: (v, f) => `${f} reports the lens "${v}".`
  },
  {
    keys: ['DocumentID', 'OriginalDocumentID', 'InstanceID'],
    describe: (v, f) => `${f} carries the XMP identifier ${v}, which survives re-saves and links derived copies back to one original.`
  },
  {
    keys: ['Author', 'Producer', 'Company'],
    describe: (v, f) => `${f} names "${v}" in its document properties.`,
    proposes: (v, f, key) => {
      // `Producer` is the library that wrote the PDF, never a person. It stays a finding.
      if (key === 'Producer') return null
      if (key === 'Company') {
        const org = organisationName(v)
        return org
          ? {
              kind: 'organisation',
              value: org,
              rationale: `${truncate(f, 80)}'s document properties name this as the company it was authored at. Written by whichever installation of the editor produced the file, so it describes the machine's licence as much as the author.`
            }
          : null
      }
      const name = personName(v)
      return name
        ? {
            kind: 'person',
            value: name,
            rationale: `${truncate(f, 80)}'s document properties name this as its author. That field is filled in from the editing application's own settings, so it names the account the file was authored under.`
          }
        : null
    }
  }
]

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Any letter, in the alphabets this app is realistically pointed at. */
const LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/
const TWO_LETTERS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]{2}/

/**
 * Application names that turn up in `Creator` and `Author` because the editor wrote
 * itself there. Naming a piece of software as a person is the single most likely way this
 * adapter could put nonsense in the review queue, so the obvious ones are refused.
 */
const SOFTWARE_WORDS =
  /\b(adobe|microsoft|apple|google|photoshop|lightroom|indesign|illustrator|acrobat|distiller|ghostscript|imagemagick|gimp|inkscape|scribus|affinity|capture one|snapseed|picasa|canva|figma|libreoffice|openoffice|word|excel|powerpoint|pages|latex|pdflatex|quartz|skia|chrome|chromium|firefox|camera|scanner|version|build)\b/i

/**
 * A value that is worth proposing as a person.
 *
 * Two tokens are required, exactly as the maigret adapter requires them of a display
 * name: a single token is a handle, a brand or a first name, and none of the three is
 * something a reviewer can act on. Anything carrying a four-digit year, an address, a URL
 * or a software word is refused outright — those are the shapes a copyright line and an
 * editor's self-attribution take.
 */
function personName(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ')
  if (v.length < 3 || v.length > 80) return ''
  if (!/\s/.test(v)) return ''
  if (!LETTER.test(v)) return ''
  if (/\d{4}/.test(v)) return ''
  if (/^https?:\/\//i.test(v) || v.includes('@') || v.includes('/')) return ''
  if (/\(c\)|©|copyright|all rights reserved/i.test(v)) return ''
  if (SOFTWARE_WORDS.test(v)) return ''
  return v
}

/** A value worth proposing as an organisation. One token is allowed; "Nikon" is a company. */
function organisationName(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ')
  if (v.length < 2 || v.length > 80) return ''
  if (!LETTER.test(v)) return ''
  if (/^https?:\/\//i.test(v)) return ''
  if (!/\s/.test(v) && v.includes('.')) return ''
  return v
}

/**
 * The name inside a copyright notice, or `''`.
 *
 * A notice is boilerplate wrapped around a name, and the boilerplate is what makes it
 * unusable as an entity value: `Copyright 2019 Example Ltd.` and `© Example Ltd` are one
 * rights holder written twice. Stripping the marks, the year and the reserved-rights
 * phrase leaves either a name or nothing — and `Copyright 2019` correctly leaves nothing.
 */
function copyrightOwner(raw: string): string {
  const stripped = raw
    .replace(/\b(all rights reserved|used with permission|creative commons|public domain)\b/gi, ' ')
    .replace(/copyright|copr\.?|\(c\)|©/gi, ' ')
    .replace(/\b(19|20)\d{2}(\s*[-–—]\s*((19|20)?\d{2}))?\b/g, ' ')
    .replace(/[.,;:|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!TWO_LETTERS.test(stripped)) return ''
  return organisationName(stripped)
}

export const exiftoolAdapter: Adapter = {
  id: ID,
  title: 'ExifTool (file → embedded metadata)',
  version: VERSION,

  accepts: ['image'],
  produces: ['location', 'person', 'organisation', 'image'],

  requiresKey: false,
  requiresNetwork: false,

  concurrency: 3,
  minIntervalMs: 0,
  defaultTimeoutMs: 60_000,

  doc: {
    what: 'Reads every metadata block embedded in a local image, video or document and reports the tags verbatim, including GPS coordinates, capture time, camera serial numbers and editing history.',

    how: 'It parses the file\'s container structure directly rather than decoding the picture. A JPEG is a sequence of labelled segments, and the ones that matter here are APP1 (holding an EXIF block written by the camera and often an XMP block written by editing software) and APP13 (holding IPTC fields written by publishing tools). ExifTool walks those segments, decodes each maker\'s tag tables — including the proprietary MakerNotes blocks that Canon, Nikon and Sony write in their own undocumented formats — and prints what it finds. MP4 and MOV are read the same way through their atom tree, PDFs through their document-information dictionary and XMP packet. Nothing is inferred: every value it prints was literally written into the file by the device or the program that made it.',

    why: 'Metadata is written by default, by devices whose owners never see it, and it survives every step of a workflow that does not deliberately strip it. A phone records the coordinates of the shot, the exact second, the device model and often the camera body\'s serial number, then attaches all of it to the picture. Emailing, backing up, and most editing preserves that block. The result is that a single photograph can carry a home address, a daily routine and a device fingerprint that ties together every other photograph from the same camera. It is also the cheapest tampering check available: a video whose metadata names Adobe Premiere was not filmed by the phone it claims to come from, and a file with a capture time later than its modification time has been through something.',

    betterAt: 'Certainty and cost. It is offline, instantaneous, free, and its output is a direct transcription rather than an inference, so unlike every other adapter here it cannot be blocked, rate-limited or fooled by an anti-bot page. It reads more formats and more proprietary tag dialects than anything else in existence, including MakerNotes that other libraries silently skip. When it says a file contains GPS coordinates, the file contains GPS coordinates.',

    worseAt: 'Files that have been anywhere. Every major social platform strips metadata on upload — a photo saved from Instagram, Facebook, Twitter or WhatsApp will have essentially nothing left, and an empty result there says nothing about the original. Screenshots and re-encodes carry the editing tool\'s metadata rather than the camera\'s. It also only reads what is inside the file: it cannot tell you where a picture was taken from its content, so a stripped image needs visual geolocation instead, which is a different discipline entirely.',

    falsePositives: 'Every field here is trivially forgeable — ExifTool itself writes metadata as readily as it reads it — so a value is evidence of what the file *claims*, never of what happened. Timestamps are the most misleading in practice: EXIF capture times are usually written in the camera\'s local time with no zone at all, so a bare `DateTimeOriginal` is unanchored and comparing two cameras\' timestamps can be off by hours. Filesystem dates (`FileModifyDate`, `FileCreateDate`) describe the copy on this disk and get rewritten by downloading, unzipping or moving the file — they are routinely mistaken for capture dates and mean nothing about the original. GPS coordinates can be stale from a last-known fix, or wrong by hundreds of metres indoors. And a device serial number identifies a camera body, which is not the same thing as a person: bodies are sold, borrowed and shared.'
  },

  check(ctx) {
    return checkBinary(
      ctx.config,
      ctx.toolkitRoot,
      ID,
      BIN_CANDIDATES,
      'Unpack the Windows build into <toolkitRoot>\\bin\\ and rename exiftool(-k).exe to exiftool.exe — the (-k) suffix makes it wait for a keypress and would hang the spawn. Keep it beside its exiftool_files\\ directory.'
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const attrs = input.entity.attrs as { path?: string; sourceUrl?: string }
    const file = (attrs.path ?? '').trim() || input.entity.label || input.entity.value
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target: file, startedAt })

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
      env.notes.push('The entity is a remote URL. ExifTool reads local files only; download it first (gallery-dl can) and add the local path as the image entity.')
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: `ExifTool reads local files, and this image entity is a URL (${file}). Download it and point the entity at the file on disk.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN_CANDIDATES)
    const args: string[] = [
      '-json',
      // Every tag, including duplicates and ones ExifTool has no name for. The point of
      // this adapter is to show what is in the file, not a curated subset.
      '-a',
      '-u',
      // Signed decimal coordinates. Because the format contains a `+`, ExifTool emits the
      // sign instead of the N/S/E/W suffix, which makes the value directly parseable.
      '-c',
      '%+.8f'
    ]
    if (optionBoolean(options, 'groupNames', false)) args.push('-G1')
    args.push(file)

    const res = await ctx.spawn(bin.file, { args, timeoutMs: ctx.timeoutMs })
    recordSpawn(env, { file: bin.file, args }, res)

    const looksJson = res.stdout.trim().startsWith('[')
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: looksJson,
      error: res.spawnError
        ? `exiftool did not run: ${res.spawnError}`
        : `exiftool exited ${res.exitCode} without JSON output. ${stderrSummary(env) || 'The file may be missing or unreadable.'}`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * The place and the people a file names, as candidates.
   *
   * The GPS proposal is the strongest thing this app produces. Every other adapter
   * proposes something a website *said*; this one is read out of the file's own bytes,
   * written by the device that took the picture, and it cannot be an anti-bot page
   * answering 200. It is still only a candidate, because the fix can be a stale
   * last-known position and because metadata is trivially forged — but the failure modes
   * are the file's, not the network's.
   *
   * Names are the conservative half. A camera `Make`/`Model` is a product, not an
   * organisation; `Producer` is a PDF library, not an author; and `Copyright 2019` names
   * nobody. All three are findings and none of them is a candidate.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the metadata records, producing the findings and the proposals together.
 *
 * Single walk rather than two, so a proposal can carry the id of the finding standing
 * beside it. That id is derived from the claim string, so a second walk that rebuilt the
 * claim would be a second copy of it — and two copies diverge the first time one is
 * edited, which the orchestrator would see as a proposal citing evidence that does not
 * exist and would silently drop.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const records = parseJsonSafe<ExifRecord[]>(env.stdout)
  if (!Array.isArray(records) || !records.length) {
    return {
      findings: [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `ExifTool returned no readable metadata record for ${env.target}. ${stderrSummary(env)}`.trim()
        })
      ],
      proposals: []
    }
  }

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const fileName = str(rec['FileName']) || str(rec['SourceFile']) || env.target
    const source = fileSource(fileName)

    // --- GPS, the headline ---
    const coords = readCoordinates(rec)
    if (coords) {
      const alt = str(rec['GPSAltitude'])
      const when = str(rec['GPSDateTime']) || str(rec['GPSDateStamp'])
      const fix = makeFinding(raw, {
        source,
        claim:
          `${fileName} contains GPS coordinates ${coords.lat.toFixed(6)},${coords.lon.toFixed(6)}` +
          `${alt ? ` at altitude ${alt}` : ''}${when ? `, fixed at ${when}` : ''}. ` +
          'This is the position the device recorded, which may be a stale last-known fix rather than where the shutter fired.'
      })
      findings.push(fix)
      // `lat,lon` unrounded: `normaliseEntityValue` rounds a coordinate pair to 6dp, so
      // two adapters reporting the same point at different precisions land on one
      // candidate instead of forking into two that look like two places.
      proposals.push({
        fromFindingId: fix.id,
        kind: 'location',
        value: `${coords.lat},${coords.lon}`,
        attrs: { lat: coords.lat, lon: coords.lon, ...(when ? { fixedAt: when } : {}) },
        rationale: `Read out of ${truncate(fileName, 80)}'s own bytes rather than asserted by a website — the strongest thing in this app. It is still the position the device believed it was at, which can be a stale fix or hundreds of metres out indoors.`
      })
    }

    // --- camera identity ---
    const make = str(rec['Make'])
    const model = str(rec['Model'])
    if (make || model) {
      // Deliberately no proposal. `Nikon` and `NIKON D750` name a manufacturer and a
      // product line; putting either in the graph as an organisation would fill the case
      // file with companies nobody is investigating.
      findings.push(
        makeFinding(raw, {
          source,
          claim: `${fileName} was written by a device identifying itself as ${[make, model].filter(Boolean).join(' ')}.`
        })
      )
    }

    // --- everything else worth a row ---
    const seen = new Set<string>()
    let notableCount = 0
    for (const spec of NOTABLE) {
      for (const key of spec.keys) {
        const value = str(rec[key])
        if (!value || seen.has(value)) continue
        seen.add(value)
        notableCount++
        const detail = makeFinding(raw, { source, claim: spec.describe(value, fileName) })
        findings.push(detail)
        const proposed = spec.proposes?.(value, fileName, key)
        if (proposed) {
          proposals.push({
            fromFindingId: detail.id,
            kind: proposed.kind,
            value: proposed.value,
            rationale: proposed.rationale
          })
        }
      }
    }

    // --- file shape and the honest summary ---
    const tagCount = Object.keys(rec).length
    const type = str(rec['FileType'])
    const size = str(rec['FileSize'])
    const dims = str(rec['ImageSize'])
    // "Stripped" is decided by what is *absent*, not by a tag count: a JPEG with nothing
    // but container tags still reports two dozen of them (dimensions, encoding, file
    // dates), and counting those would call an untouched file stripped.
    const stripped = !coords && !make && !model && notableCount === 0
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim:
          `ExifTool read ${group(tagCount)} tags from ${fileName}` +
          `${type ? ` (${type}${dims ? `, ${dims}` : ''}${size ? `, ${size}` : ''})` : ''}. ` +
          (stripped
            ? 'Only container-level tags are present: no camera block, no GPS, no editing history. That is what a file looks like after a social platform has stripped it, so it says nothing about the original.'
            : 'Every value is what the file claims about itself and is trivially forgeable; treat it as a claim, not as a fact.')
      })
    )
  }

  return { findings, proposals }
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/**
 * Coordinates come out of `-c '%+.8f'` as signed decimal strings such as `+48.85840000`.
 * The composite `GPSPosition` holds both in one field; the individual tags are the
 * fallback. Anything that does not parse to a valid pair is ignored rather than guessed.
 */
function readCoordinates(rec: ExifRecord): { lat: number; lon: number } | null {
  const position = str(rec['GPSPosition'])
  if (position) {
    const parts = position.split(/[\s,]+/).filter(Boolean)
    const lat = Number(parts[0])
    const lon = Number(parts[1])
    if (valid(lat, lon)) return { lat, lon }
  }
  const lat = Number(str(rec['GPSLatitude']))
  const lon = Number(str(rec['GPSLongitude']))
  if (valid(lat, lon)) return { lat, lon }
  return null
}

function valid(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  )
}
