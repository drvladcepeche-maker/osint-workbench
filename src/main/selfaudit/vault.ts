/**
 * The seed vault: what the operator knows about himself.
 *
 * This is the one file in the application that holds real personal data as *input* rather
 * than as a finding. Everything about how it is written is a deliberate choice, so the
 * reasoning is here rather than in a commit message.
 *
 * ## Where it lives, and why not in a case
 *
 * `cases/_selfaudit/profile.json`.
 *
 * Not inside any one level's case folder, because the profile spans five of them and a
 * copy per level would mean L0's folder — the folder that is supposed to model a stranger
 * who knows one username — contained the operator's phone number. That is not a
 * theoretical objection: the whole value of L0 is that it is an honest simulation, and a
 * folder you could grep for a phone number is not one.
 *
 * The leading underscore is load-bearing. `isSafeIdSegment` requires an alphanumeric first
 * character, so `CaseStore.listCaseIds()` skips this directory, `rebuildIndex()` never
 * walks it, and it can never be mistaken for a case. It sits under `casesDir` so that the
 * operator has exactly one directory to delete when he wants all of this gone, and
 * `SelfAuditState.vaultPath` shows him where it is.
 *
 * ## What is never done with it
 *
 * - It is never logged. Not at debug level, not in an error message, not in a thrown
 *   `Error` that some outer layer might print. Every failure message in this module names
 *   the *field*, never the value.
 * - It never leaves the machine except as an argument to a tool that needs it, which is
 *   the same path any seed entity takes and is the point of seeding at all.
 * - A level's case folder receives only the fields that level is entitled to. That is
 *   enforced in `seedsForLevel` below and asserted by a test that greps L0's folder for
 *   L4's values.
 *
 * Writes are atomic — temp file with a unique name, then rename — for the same reason the
 * case store's are: a killed process must leave the old profile or the new one, never
 * half of a file the operator would have to retype from memory.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  SEED_FIELDS,
  emptyProfile,
  fieldsUpTo,
  seedField,
  seedLevelOfValue,
  type SeedFieldId,
  type SelfAuditLevel,
  type SelfAuditProfile
} from '../../shared/selfaudit'
import type { EntityKind } from '../../shared/types'

/** Skipped by `listCaseIds` because it does not start with an alphanumeric. Deliberate. */
export const VAULT_DIR = '_selfaudit'
export const PROFILE_FILE = 'profile.json'
export const LEVELS_FILE = 'levels.json'

/** A single seed value may not be longer than this. Guards a paste of a whole document. */
const MAX_VALUE_LENGTH = 200
/** Nor may one field hold more than this many. */
const MAX_VALUES_PER_FIELD = 64

export interface LevelLinks {
  /** `L0` … `L4` -> the case id that level's runs live in. */
  cases: Partial<Record<string, string>>
  updatedAt: string | null
}

export interface MaterialisedSeed {
  field: SeedFieldId
  kind: EntityKind
  value: string
  level: SelfAuditLevel
}

let tmpCounter = 0

async function writeAtomic(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${(tmpCounter++).toString(36)}.tmp`
  try {
    await fsp.writeFile(tmp, data, 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Clean one field's values.
 *
 * Trims, drops blanks, de-duplicates case-insensitively while keeping the first spelling
 * the operator typed, and caps both the length of a value and the number of them. The cap
 * exists because this form is the natural place to paste a block of text by accident, and
 * a 40 kB "username" would become a 40 kB argv entry.
 *
 * Nothing here rejects a value for looking wrong. A username with a space in it is a
 * username the operator says he uses, and this app does not know better than he does
 * about his own accounts.
 */
export function cleanValues(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const v = raw.trim().slice(0, MAX_VALUE_LENGTH)
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= MAX_VALUES_PER_FIELD) break
  }
  return out
}

export function cleanProfile(input: unknown): SelfAuditProfile {
  const profile = emptyProfile()
  const src = (input && typeof input === 'object' ? (input as Record<string, unknown>) : {}) as {
    values?: Record<string, unknown>
  }
  const values = src.values && typeof src.values === 'object' ? src.values : {}
  for (const field of SEED_FIELDS) {
    profile.values[field.id] = cleanValues((values as Record<string, unknown>)[field.id])
  }
  return profile
}

export function profileIsEmpty(profile: SelfAuditProfile): boolean {
  return SEED_FIELDS.every((f) => (profile.values[f.id] ?? []).length === 0)
}

/**
 * The seeds one level is entitled to, and nothing else.
 *
 * This is the function that makes the whole exercise honest. L4 gets everything. A level
 * never sees a field from above it, so its case folder cannot contain a value it was not
 * supposed to know — which is exactly the property being simulated.
 *
 * The entitlement is **per value**, not per field, and `usernames` is why. L0 models a
 * stranger who saw you on one platform, so it gets one handle; the rest arrive at L1,
 * where handle reuse across your own accounts can finally show up as a jump instead of
 * being folded invisibly into the baseline. `seedLevelOfValue` owns that rule and every
 * other field returns its own level for every index, so nothing else changes shape.
 *
 * The seed's recorded `level` is the level *that value* entered at, not the field's — so a
 * snapshot can tell L0's one handle apart from the two L1 added, and the delta can refuse
 * to credit a level with a seed that belongs below it.
 */
export function seedsForLevel(profile: SelfAuditProfile, level: SelfAuditLevel): MaterialisedSeed[] {
  const allowed = new Set(fieldsUpTo(level))
  const out: MaterialisedSeed[] = []
  for (const field of SEED_FIELDS) {
    if (!allowed.has(field.id)) continue
    const values = profile.values[field.id] ?? []
    for (let i = 0; i < values.length; i++) {
      const at = seedLevelOfValue(field, i)
      if (at > level) continue
      out.push({ field: field.id, kind: field.kind, value: values[i] as string, level: at })
    }
  }
  return out
}

/**
 * Fields a level needs that the profile does not supply.
 *
 * Optional fields are excluded: only `domains` is one, and a level reported as
 * permanently "missing domains" because the operator owns none would be an incomplete
 * badge that never goes away.
 */
export function missingFor(profile: SelfAuditProfile, level: SelfAuditLevel): SeedFieldId[] {
  return fieldsUpTo(level).filter(
    (id) => !seedField(id).optional && (profile.values[id] ?? []).length === 0
  )
}

/**
 * Every distinct seed value at or below a level, for the attribution matcher.
 * Returned longest-first so a full name is matched before either of its halves.
 *
 * The level carried here is the value's own entry level, straight from `seedsForLevel` —
 * not the field's. An attribution says *when* a fact became knowable, and for a split
 * field the second handle became knowable a rung above the first.
 */
export function seedValuesUpTo(
  profile: SelfAuditProfile,
  level: SelfAuditLevel
): { field: SeedFieldId; value: string; level: SelfAuditLevel }[] {
  return seedsForLevel(profile, level)
    .map((s) => ({ field: s.field, value: s.value, level: s.level }))
    .sort((a, b) => b.value.length - a.value.length)
}

export class SeedVault {
  constructor(private readonly casesDir: string) {}

  get dir(): string {
    return path.join(this.casesDir, VAULT_DIR)
  }

  get profilePath(): string {
    return path.join(this.dir, PROFILE_FILE)
  }

  get levelsPath(): string {
    return path.join(this.dir, LEVELS_FILE)
  }

  /**
   * Read the profile. A missing or unreadable file is an empty profile, never a throw:
   * the Self-Audit view has to be able to render before anything has been typed into it,
   * and a corrupt vault must be recoverable by retyping rather than by editing JSON.
   */
  async read(): Promise<SelfAuditProfile> {
    let text: string
    try {
      text = await fsp.readFile(this.profilePath, 'utf8')
    } catch {
      return emptyProfile()
    }
    try {
      const parsed = JSON.parse(text) as { updatedAt?: unknown }
      const profile = cleanProfile(parsed)
      profile.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
      return profile
    } catch {
      return emptyProfile()
    }
  }

  /**
   * Take one value out of one field.
   *
   * Case-insensitive, because that is how `cleanValues` de-duplicates on the way in: the
   * operator sees one spelling in the form and it must be the one that comes out.
   *
   * The vault is his typing, so this is clean — the file no longer holds it, and every
   * level reads the vault at the moment it runs, which is what makes the level
   * immediately re-runnable without it. What was already materialised into a level's case
   * folder is a separate decision and is not touched here.
   */
  async removeValue(field: SeedFieldId, value: string): Promise<SelfAuditProfile> {
    const profile = await this.read()
    const target = value.trim().toLowerCase()
    profile.values[field] = (profile.values[field] ?? []).filter((v) => v.toLowerCase() !== target)
    return this.write(profile)
  }

  async write(input: unknown): Promise<SelfAuditProfile> {
    const profile = cleanProfile(input)
    profile.updatedAt = new Date().toISOString()
    await writeAtomic(this.profilePath, JSON.stringify(profile, null, 2) + '\n')
    return profile
  }

  /**
   * Delete the profile.
   *
   * This removes the vault only. It deliberately does **not** touch the level case
   * folders: those hold findings, raw captures and confidence history, and silently
   * destroying an audit trail because someone cleared a form is not a thing this app
   * does. The UI says which one this button is.
   */
  async clear(): Promise<SelfAuditProfile> {
    await fsp.rm(this.profilePath, { force: true })
    return emptyProfile()
  }

  async readLinks(): Promise<LevelLinks> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.levelsPath, 'utf8')) as LevelLinks
      const cases: Partial<Record<string, string>> = {}
      for (const [k, v] of Object.entries(parsed?.cases ?? {})) {
        if (typeof v === 'string' && v) cases[k] = v
      }
      return { cases, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null }
    } catch {
      return { cases: {}, updatedAt: null }
    }
  }

  async linkLevel(code: string, caseId: string): Promise<LevelLinks> {
    const links = await this.readLinks()
    links.cases[code] = caseId
    links.updatedAt = new Date().toISOString()
    await writeAtomic(this.levelsPath, JSON.stringify(links, null, 2) + '\n')
    return links
  }
}
