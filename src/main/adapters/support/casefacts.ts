/**
 * Reading the case's own entity list, so a search can combine what is already known.
 *
 * This is the piece that makes a name seed matter. `AdapterInput` hands an adapter exactly
 * one entity, which is correct for every tool that takes a username or a domain and wrong
 * for the one technique that needs *two* facts to work at all: a person's name is only a
 * query once a town, a school or a handle is welded to it.
 *
 * `pivot` already reads `entities.json` out of the case directory for the same reason, and
 * this follows that precedent rather than inventing a second one. Two rules keep it honest:
 *
 *  - **It happens in `run()`, never in `parse()`.** `parse` is pure and must be able to
 *    re-derive everything from the raw capture years later, when there may be no case
 *    folder at all. So the queries this produces are written into the run envelope, and the
 *    parser reads them back from there rather than rebuilding them.
 *  - **Seeds outrank discoveries.** A place the operator typed in is ground truth; a place
 *    an adapter guessed from a profile bio at depth 2 is a hypothesis, and welding a
 *    hypothesis to a name produces a query whose hits look like corroboration and are
 *    actually an echo. Discovered values are used only where nothing was seeded, and the
 *    envelope records which was which.
 */

import path from 'node:path'

import { isRelative, type Entity } from '../../../shared/types'
import { parseJsonSafe } from './envelope'
import { readTextIfExists } from './toolkit'
import { emptyContext, type DorkContext } from './dorks'

/** Where each value in a `DorkContext` came from. Written into the envelope for the record. */
export interface FactProvenance {
  /** Values the operator supplied. */
  seeded: string[]
  /** Values an adapter discovered and a human promoted into the graph. */
  discovered: string[]
}

export interface CaseFacts {
  context: DorkContext
  provenance: Record<string, FactProvenance>
  /** How many entities were read. `0` means the case file was absent or unreadable. */
  entitiesRead: number
}

const MAX_PER_LIST = 4

/**
 * Build the query context for a run, from the case's entities plus the run's own subject.
 *
 * Never throws and never rejects: a missing or corrupt `entities.json` degrades to a
 * context holding only the subject, which still produces a usable (if weaker) search
 * rather than a failed run.
 */
export async function readCaseFacts(caseDir: string, entity: Entity): Promise<CaseFacts> {
  const ctx = emptyContext(entity.value, entity.kind)
  const prov: Record<string, FactProvenance> = {}
  const bucket = (key: string): FactProvenance => (prov[key] ??= { seeded: [], discovered: [] })

  const text = await readTextIfExists(path.join(caseDir, 'entities.json'))
  const entities = text === null ? null : parseJsonSafe<Entity[]>(text)
  const list = Array.isArray(entities) ? entities : []

  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.kind !== 'string') continue
    const label = (e.label || e.value || '').trim()
    if (!label) continue
    const where = e.seed === true ? 'seeded' : 'discovered'
    switch (e.kind) {
      case 'person':
        // A relative is a `person` too, and welding one into the subject's queries makes
        // the tool ask the web about "<brother's name> <subject's school> <subject's
        // city>" and then record the hits on the subject's case. The self-audit marks
        // relatives at materialisation (`attrs.role: 'relative'`) precisely so this
        // distinction survives into the entity file, which is all this function reads.
        if (isRelative(e)) break
        bucket('names')[where].push(label)
        break
      case 'location':
        // A `lat,lon` value is not a search term; the place name is.
        bucket('places')[where].push(placeNameOf(e, label))
        break
      case 'organisation':
        bucket('organisations')[where].push(label)
        break
      case 'username':
        bucket('handles')[where].push(e.value)
        break
      case 'account': {
        const handle = e.value.includes('/') ? e.value.slice(e.value.indexOf('/') + 1) : e.value
        if (handle) bucket('handles')[where].push(handle)
        break
      }
      case 'email':
        bucket('emails')[where].push(e.value)
        break
      case 'domain':
        bucket('domains')[where].push(e.value)
        break
      case 'phone':
        bucket('phones')[where].push(e.value)
        break
      default:
        break
    }
  }

  // The entity the run was pointed at is always available, seed or not — it is the one
  // fact the operator definitely meant.
  const self = bucket(listKeyFor(entity.kind))
  if (listKeyFor(entity.kind) !== 'other') self.seeded.unshift(entity.label || entity.value)

  for (const key of ['names', 'places', 'organisations', 'handles', 'emails', 'domains', 'phones'] as const) {
    const p = prov[key]
    if (!p) continue
    p.seeded = unique(p.seeded)
    p.discovered = unique(p.discovered).filter((v) => !p.seeded.includes(v))
    // Seeds first, discoveries only to fill the remaining slots.
    ctx[key] = [...p.seeded, ...p.discovered].slice(0, MAX_PER_LIST)
  }

  return { context: ctx, provenance: prov, entitiesRead: list.length }
}

/** Which `DorkContext` list an entity of this kind belongs in. */
function listKeyFor(kind: string): keyof DorkContext | 'other' {
  switch (kind) {
    case 'person':
      return 'names'
    case 'location':
      return 'places'
    case 'organisation':
      return 'organisations'
    case 'username':
    case 'account':
      return 'handles'
    case 'email':
      return 'emails'
    case 'domain':
      return 'domains'
    case 'phone':
      return 'phones'
    default:
      return 'other'
  }
}

/**
 * A location's human name.
 *
 * A `location` entity's `value` is `lat,lon` when coordinates are known, and searching for
 * `48.858370,2.294481` finds nothing at all. The place name in `attrs` is the searchable
 * form; the label is the fallback.
 */
function placeNameOf(e: Entity, label: string): string {
  const attrs = (e.attrs ?? {}) as { placeName?: unknown; admin1?: unknown }
  const name = typeof attrs.placeName === 'string' ? attrs.placeName.trim() : ''
  if (name) return name
  return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(label) ? '' : label
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))]
}
