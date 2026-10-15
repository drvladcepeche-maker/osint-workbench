/**
 * Seed matching — the mechanism behind L2, L3 and L4.
 *
 * ## Why this exists
 *
 * Nothing in the toolbelt accepts a `person`, a `location` or an `organisation`. Point
 * the adapter registry at a real name and it has nothing to run. Taken literally, that
 * would mean L2 through L4 add no tools and therefore no delta, and the whole upper half
 * of the ladder would be theatre.
 *
 * It is not, and the reason is worth stating plainly, because it is the most interesting
 * thing the self-audit teaches: **the upper levels do not add reach, they add
 * attribution.** L1 finds forty accounts with your handle. It cannot tell you which of
 * them are yours. Knowing your real name turns some of those hits from "an account with
 * this handle exists" into "an account with this handle carries your name" — and that is
 * the step that connects a gaming identity to a person.
 *
 * So the upper levels are measured by how many already-found things a newly added fact
 * makes attributable. That is deterministic, local, and requires no LLM, which is what
 * DECISIONS.md demands of every analysis in this app.
 *
 * ## Two matchers, and why they are not one
 *
 * A seeded **name** and a seeded **email address** are not the same kind of string, and
 * matching them the same way is what made this module miss most of what the operator will
 * actually type. An address is high-entropy and is written exactly one way; a name is
 * low-entropy, is spelled several ways in two scripts, and is shortened by everyone who
 * knows the person. So:
 *
 *  - `person` seeds go through `shared/names.ts`, which knows about transliteration,
 *    diminutives and partial forms, and **reports the strength of every rule it used**.
 *  - Everything else keeps the literal path below, unchanged. Diminutive logic must never
 *    touch an address, and a transliterated phone number is not a thing.
 *
 * ## How the literal path is kept honest
 *
 * - **Whole values only.** A multi-word value matches as a phrase. A single token matches
 *   as a token. `Reading` never matches inside `spreading`, and never matches `reading` used as an
 *   English noun with a lowercase r — it does, however, match `Reading` used as one, and
 *   that is a false positive this module cannot rule out. It is labelled as a lead.
 * - **Boundaries are Unicode-aware.** `\b` is ASCII-only in JavaScript and would fail on
 *   every Bulgarian name in the case material, so the boundary test is written out
 *   against `\p{L}` and `\p{N}`.
 * - **Diacritics are folded, scripts are not** — on this path. `Йорданов` and `Yordanov`
 *   stay different values here, because merging two scripts for an *identifier* would
 *   merge distinct people, which `normalise.ts` already refuses to do for the same reason.
 *   The name path folds scripts deliberately and pays for it in `strength`.
 * - **Short values are refused outright.** Under four characters a match is noise.
 * - **A seed never matches a claim about itself.** The finding produced by pointing
 *   holehe at an address obviously contains that address; counting it would fill the view
 *   with things the operator typed. (Enforced by the caller, which knows the entity ids.)
 *
 * Every match is a lead. Nothing here promotes anything, mints a finding, or writes to a
 * case file — the confidence ladder is untouched, exactly as it is everywhere else.
 */

import type { EntityKind } from '../../shared/types'
import {
  fold,
  matchNameAll,
  prepareText,
  type NameMatchRule,
  type NameMatchStrength,
  type PreparedText
} from '../../shared/names'

export { fold, prepareText }
export type { PreparedText }

/** Under this many characters, a match is noise rather than signal. */
export const MIN_MATCH_LENGTH = 4

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !LETTER_OR_DIGIT.test(ch)
}

/**
 * Every whole-value occurrence of `needle` in `haystack`, as start indices.
 *
 * Both arguments must already be folded. Returns indices into the *folded* haystack;
 * because folding only removes combining marks and lowercases, those indices line up with
 * the original for every script this app sees, and the excerpt is cut from the original
 * so the operator reads what the tool actually wrote.
 */
export function occurrences(haystack: string, needle: string): number[] {
  if (needle.length < MIN_MATCH_LENGTH) return []
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    const before = at > 0 ? haystack[at - 1] : undefined
    const after = haystack[at + needle.length]
    if (isBoundary(before) && isBoundary(after)) out.push(at)
    from = at + needle.length
  }
  return out
}

export function containsValue(haystack: string, needle: string): boolean {
  return occurrences(fold(haystack), fold(needle)).length > 0
}

/** A window of the original text around a match, for the operator to read in context. */
export function excerptAround(original: string, at: number, length: number, radius = 70): string {
  const start = Math.max(0, at - radius)
  const end = Math.min(original.length, at + length + radius)
  const head = start > 0 ? '…' : ''
  const tail = end < original.length ? '…' : ''
  return (head + original.slice(start, end) + tail).replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ *
 * One seed against one piece of text
 * ------------------------------------------------------------------ */

export interface SeedHit {
  /** Index into the folded text. Folding preserves offsets, so it indexes the original too. */
  at: number
  length: number
  rule: NameMatchRule
  strength: NameMatchStrength
  /** One phrase naming the mechanism, for the row the operator reads. */
  why: string
}

/**
 * How much weight a *literal* hit on a non-name seed deserves.
 *
 * A literal match is not automatically a strong one, and the difference is entropy. An
 * address, a handle, a domain or a phone number is close to unique to one person, so
 * finding it written out in a result is about as good as this app's evidence gets short of
 * a human opening the page. A city or a school is a word that tens of thousands of people
 * share — the whole reason L3 is described as a *discriminator between two people with the
 * same name* rather than as an identifier. Rendering both at the same weight would tell
 * the operator that "lives in Sofia" is as attributing as "uses this exact address", which
 * is the sort of quiet overstatement the confidence ladder exists to prevent.
 */
function literalStrength(kind: EntityKind): NameMatchStrength {
  switch (kind) {
    case 'email':
    case 'phone':
    case 'username':
    case 'account':
    case 'domain':
    case 'ipaddr':
      return 'strong'
    default:
      return 'moderate'
  }
}

/**
 * Where and how one seed value appears in one piece of text, strongest first.
 *
 * `kind` decides which matcher runs, and it is taken from the seed field rather than
 * guessed from the string: `person` gets the name matcher in `shared/names.ts`, everything
 * else gets the literal path above. Pass a `PreparedText` when the same text is searched
 * for several seeds — a raw capture is up to half a megabyte and tokenising it once per
 * seed is the difference between a snapshot taking a moment and taking a minute.
 */
export function seedHits(
  kind: EntityKind,
  seedValue: string,
  text: string | PreparedText,
  limit = 1
): SeedHit[] {
  if (limit <= 0) return []
  const prepared = typeof text === 'string' ? prepareText(text) : text

  if (kind === 'person') {
    return matchNameAll(seedValue, prepared, limit).map((m) => ({
      at: m.at,
      length: m.length,
      rule: m.rule,
      strength: m.strength,
      why: m.why
    }))
  }

  const needle = fold(seedValue)
  const strength = literalStrength(kind)
  return occurrences(prepared.folded, needle)
    .slice(0, limit)
    .map((at) => {
      const matched = prepared.original.slice(at, at + needle.length)
      // Literal only when neither side needed folding — the difference between a result
      // that wrote `Ivanović` and one that wrote `Ivanovic`.
      const exact = matched.toLowerCase() === seedValue.trim().toLowerCase()
      return {
        at,
        length: needle.length,
        rule: (exact ? 'exact' : 'diacritic') as NameMatchRule,
        strength,
        why: exact ? `exact match: ${matched}` : `diacritics folded: ${matched} → ${seedValue.trim()}`
      }
    })
}
