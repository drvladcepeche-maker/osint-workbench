/**
 * Canonicalisation of entity values.
 *
 * Entity identity is derived from the canonical value, so this file decides what counts
 * as "the same thing". Every rule here is a judgement call about dedupe, and each one is
 * annotated with the trade-off, because getting these wrong is how a case file ends up
 * either fragmented (the same person as four entities) or wrong (two people merged).
 *
 * One rule lives elsewhere: an `account`'s canonical value is decided by
 * `platforms.ts`, because the same decision has to be made in the renderer to show the
 * operator what a pasted link will become before he commits to it. `normaliseAccount`
 * below delegates rather than reimplementing, so the preview and the stored value cannot
 * drift apart.
 */

import { isParseFailure, parseTarget } from './platforms'
import type { EntityKind } from './types'

export interface Normalised {
  value: string
  label: string
  attrs: Record<string, unknown>
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function normaliseEmail(raw: string): Normalised {
  const trimmed = raw.trim()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return { value: trimmed.toLowerCase(), label: trimmed, attrs: {} }
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1).toLowerCase()
  const value = `${local.toLowerCase()}@${domain}`

  // Gmail (and its aliases) ignore dots and everything after a `+`. Those are stored as
  // `canonicalForm` rather than folded into `value`: the address as written is what a
  // tool must be queried with, but the canonical form is what tells you two addresses
  // reach the same inbox. Folding them into `value` would lose the literal address.
  let canonicalForm = value
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const bare = local.toLowerCase().split('+')[0] ?? ''
    canonicalForm = `${bare.replace(/\./g, '')}@gmail.com`
  } else {
    const bare = local.toLowerCase().split('+')[0] ?? ''
    canonicalForm = `${bare}@${domain}`
  }

  return { value, label: trimmed, attrs: { local: local.toLowerCase(), domain, canonicalForm } }
}

function normaliseDomain(raw: string): Normalised {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split('/')[0] ?? s
  s = s.split('?')[0] ?? s
  s = s.split('@').pop() ?? s
  s = s.replace(/:\d+$/, '')
  s = s.replace(/\.+$/, '')
  // `www.` is dropped: www.example.com and example.com are never meaningfully different
  // subjects for OSINT purposes, and keeping both fragments every finding.
  const value = s.replace(/^www\./, '')
  return { value, label: raw.trim(), attrs: {} }
}

function normalisePhone(raw: string): Normalised {
  const trimmed = raw.trim()
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  // No libphonenumber dependency yet, so E.164 is only asserted when the caller already
  // wrote it that way. Guessing a country code from a bare national number is exactly
  // the kind of silent inference this app is supposed to refuse to make.
  const value = hasPlus ? `+${digits}` : digits
  return { value, label: trimmed, attrs: hasPlus ? { e164: value } : {} }
}

function normaliseIp(raw: string): Normalised {
  const s = raw.trim().toLowerCase()
  const m = IPV4.exec(s)
  if (m) {
    const octets = m.slice(1, 5).map((x) => Number(x))
    if (octets.every((o) => o >= 0 && o <= 255)) {
      const value = octets.join('.')
      const first = octets[0] ?? 0
      const second = octets[1] ?? 0
      const reserved =
        first === 10 ||
        first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 169 && second === 254) ||
        first === 0
      return { value, label: value, attrs: { version: 4, reserved } }
    }
  }
  // IPv6: lowercase and strip a bracketed form. Not fully compressed — a canonicaliser
  // is worth writing when an adapter actually needs it.
  const v6 = s.replace(/^\[|\]$/g, '')
  return { value: v6, label: v6, attrs: { version: 6, reserved: v6 === '::1' || v6.startsWith('fe80:') } }
}

function normaliseAccount(raw: string): Normalised {
  // Accepted forms: `platform/handle`, or a profile URL.
  const trimmed = raw.trim()

  /*
   * A URL is handed to `platforms.ts` first, and only its failures fall through to the
   * generic parse below.
   *
   * The reason is that the renderer previews the canonical value under the paste field
   * before anything is added, and that preview comes from `parseTarget`. If the store then
   * normalised the same string differently, the preview would be a lie about what was
   * written — the one thing a canonical-value preview must never be. Delegating makes them
   * the same function rather than two functions that agree today.
   *
   * It also brings the platform knowledge with it: `github.com/torvalds/linux` is the
   * account `github.com/torvalds` and not one called `linux`, and `www.reddit.com/u/spez`
   * is `reddit.com/spez`. The old rule — last path segment, host with `www.` stripped —
   * got both wrong.
   *
   * The fallback below is kept and is load-bearing: `parseTarget` refuses anything it
   * cannot place, including every `platform/handle` composite an adapter emits, and those
   * must keep normalising exactly as they always have or entity ids would move.
   */
  const parsed = parseTarget(trimmed)
  if (!isParseFailure(parsed) && parsed.kind === 'account') {
    return { value: parsed.value, label: parsed.label, attrs: parsed.attrs ?? {} }
  }

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.hostname.includes('.')) {
      const platform = url.hostname.toLowerCase().replace(/^www\./, '')
      const handle = url.pathname.split('/').filter(Boolean).pop() ?? ''
      if (handle) {
        return {
          value: `${platform}/${handle.toLowerCase()}`,
          label: `${handle} on ${platform}`,
          attrs: { platform, handle, url: url.toString() }
        }
      }
    }
  } catch {
    /* not a URL */
  }
  const [platform = '', ...rest] = trimmed.split('/')
  const handle = rest.join('/')
  return {
    value: `${platform.toLowerCase()}/${handle.toLowerCase()}`,
    label: handle ? `${handle} on ${platform}` : trimmed,
    attrs: { platform: platform.toLowerCase(), handle }
  }
}

function normaliseLocation(raw: string): Normalised {
  const trimmed = raw.trim()
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(trimmed)
  if (m) {
    const lat = Number(m[1])
    const lon = Number(m[2])
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      // 6dp is ~11 cm. Rounding here means two adapters reporting the same point at
      // different precisions converge instead of forking.
      const value = `${lat.toFixed(6)},${lon.toFixed(6)}`
      return { value, label: value, attrs: { lat, lon } }
    }
  }
  return { value: trimmed.toLowerCase(), label: trimmed, attrs: { placeName: trimmed } }
}

function normalisePerson(raw: string): Normalised {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  // Names are folded on whitespace and case only. Nothing clever: transliterating
  // Bulgarian to Latin, reordering given/family, or stripping diacritics would merge
  // distinct people, and a wrong merge is far more damaging than a duplicate.
  return { value: trimmed.toLowerCase(), label: trimmed, attrs: { fullName: trimmed } }
}

function normaliseUsername(raw: string): Normalised {
  const trimmed = raw.trim().replace(/^@/, '')
  return {
    value: trimmed.toLowerCase(),
    label: trimmed,
    attrs: trimmed === trimmed.toLowerCase() ? {} : { caseSensitiveForm: trimmed }
  }
}

function normaliseImage(raw: string): Normalised {
  const trimmed = raw.trim()
  // Windows paths are case-insensitive; URLs are not. Only the path form is folded.
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  return {
    value: isUrl ? trimmed : trimmed.replace(/\\/g, '/').toLowerCase(),
    label: trimmed.split(/[\\/]/).pop() ?? trimmed,
    attrs: isUrl ? { sourceUrl: trimmed } : { path: trimmed }
  }
}

function normaliseOrganisation(raw: string): Normalised {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  return { value: trimmed.toLowerCase(), label: trimmed, attrs: { legalName: trimmed } }
}

/**
 * Canonicalise a raw user- or tool-supplied value for a given entity kind.
 * Returns the value used for identity, a display label, and any attrs the parse yielded.
 */
export function normaliseEntityValue(kind: EntityKind, raw: string): Normalised {
  switch (kind) {
    case 'email':
      return normaliseEmail(raw)
    case 'domain':
      return normaliseDomain(raw)
    case 'phone':
      return normalisePhone(raw)
    case 'ipaddr':
      return normaliseIp(raw)
    case 'account':
      return normaliseAccount(raw)
    case 'location':
      return normaliseLocation(raw)
    case 'person':
      return normalisePerson(raw)
    case 'username':
      return normaliseUsername(raw)
    case 'image':
      return normaliseImage(raw)
    case 'organisation':
      return normaliseOrganisation(raw)
  }
}

/**
 * Best-effort type detection for a pasted string.
 *
 * Order matters: the more specific patterns must win. Returns `null` when nothing is
 * confident enough — the UI then asks rather than guessing, which is the whole ethos.
 */
export function detectEntityKind(raw: string): EntityKind | null {
  const s = raw.trim()
  if (!s) return null
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email'
  if (IPV4.test(s)) return 'ipaddr'
  if (/^[0-9a-f:]+$/i.test(s) && s.includes('::')) return 'ipaddr'
  if (/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(s)) return 'location'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return 'account'
  if (/\.(jpe?g|png|gif|webp|heic|tiff?|mp4|mov)$/i.test(s)) return 'image'
  if (/^\+?[\d\s().-]{7,20}$/.test(s) && (s.replace(/\D/g, '').length >= 7)) return 'phone'
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) return 'domain'
  if (/^@?[a-z0-9._-]{2,40}$/i.test(s)) return 'username'
  if (/\s/.test(s)) return 'person'
  return null
}
