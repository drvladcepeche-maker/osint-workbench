import { useMemo, useState } from 'react'
import type { Entity, EntityKind } from '../../../shared/types'
import { ENTITY_KINDS } from '../../../shared/types'
import { normaliseEntityValue } from '../../../shared/normalise'
import {
  accountFromHandle,
  isParseFailure,
  PLATFORMS,
  parseTarget,
  type ParsedTarget
} from '../../../shared/platforms'
import { Data } from './Data'
import { Icon } from './Icon'

/**
 * Getting something into a case.
 *
 * This replaced a kind dropdown and one text box, which asked the operator to know two
 * things he does not: that an `account` is stored as the composite `platform/handle`, and
 * what this app thinks the platform is called. His words: *"it says GitHub slash whatever,
 * but that's just one account — I don't know how to do it for the rest, let's say their
 * Discord."* What he actually has in front of him is a URL he copied.
 *
 * So there are three ways in, in this order:
 *
 *  1. **A pasted link.** The primary path, because it is the thing that exists. What it
 *     parsed to is shown live, under the field, in the canonical form it will be stored
 *     as — so the composite is something he watches being built rather than something he
 *     has to compose. A link that names nobody says what it looked for and did not find:
 *     `discord.gg/x` is an invite to a server, a `/channel/UC…` link is an opaque id.
 *  2. **A platform and a handle**, for when there is no link. The `<select>` is the
 *     table in `shared/platforms.ts` plus a free-text host, and the resulting value is
 *     shown for the same reason: he learns the shape by seeing it produced.
 *  3. **The other kinds**, including a location with an explicit granularity.
 *
 * Two things this deliberately does not do. It never silently corrects a refusal into a
 * guess — route 2 exists precisely so a refusal has somewhere to go, and it does not
 * consult the reserved-word list. And it does not pretend a seeded location is a query:
 * nothing in this toolbelt takes a place as input, so the sentence saying what a location
 * is actually *for* sits at the point of entry rather than in a doc panel.
 *
 * ## The granularity is in the label, and that is a limitation
 *
 * `country | region | city | address | coordinates` is chosen, never inferred — "I know
 * the country and not the street" is a complete answer about a person, not a degraded one.
 * It belongs in `LocationEntity.attrs.granularity`, but `AddEntityRequest` in
 * `shared/ipc.ts` carries only `{ caseId, kind, value, label, seed }`: the store's
 * `upsertEntity` accepts `attrs`, and the IPC surface in front of it drops them. Widening
 * that means editing `shared/ipc.ts`, the preload and `service.addEntity`, which this
 * change does not own. So the granularity is appended to the label — visible, searchable,
 * and honest about itself — and the preview below the field shows exactly that, rather
 * than implying an attr was written.
 */

/** Coarsest to finest. Every one of these is a complete answer at its own scale. */
const GRANULARITIES = ['country', 'region', 'city', 'address', 'coordinates'] as const
type Granularity = (typeof GRANULARITIES)[number]

const GRANULARITY_PLACEHOLDER: Record<Granularity, string> = {
  country: 'Portugal',
  region: 'Alentejo',
  city: 'Porto',
  address: 'Rua Augusta 24, Lisbon',
  coordinates: '38.7223, -9.1393'
}

/**
 * Concrete rather than "value…". A placeholder is a free chance to show the expected form,
 * and none of these is anybody's real anything: documentation ranges (RFC 5737, RFC 2606)
 * and a public figure whose GitHub handle is already the smoke-test target of this repo.
 */
const PLACEHOLDER: Partial<Record<EntityKind, string>> = {
  person: 'Linus Torvalds',
  username: 'torvalds',
  email: 'name@example.com',
  phone: '+1 202 555 0143',
  domain: 'example.com',
  ipaddr: '203.0.113.7',
  image: 'C:\\photos\\IMG_0421.jpg',
  location: GRANULARITY_PLACEHOLDER.city,
  organisation: 'Example Holdings Ltd'
}

/** Route 2 covers `account`; route 3 would put the operator back in front of the composite. */
const OTHER_KINDS = ENTITY_KINDS.filter((k) => k !== 'account')

const OTHER_HOST = '__other__'

export function EntityAdd({
  caseId,
  onAdded,
  onError
}: {
  caseId: string
  onAdded: (entity: Entity) => void
  /** Add failures go to the view's notice, beside every other refusal in the case. */
  onError: (message: string | null) => void
}): React.JSX.Element {
  const [link, setLink] = useState('')
  const [platformId, setPlatformId] = useState<string>(PLATFORMS[0]?.id ?? 'github')
  const [otherHost, setOtherHost] = useState('')
  const [handle, setHandle] = useState('')
  const [kind, setKind] = useState<EntityKind>('username')
  const [value, setValue] = useState('')
  const [granularity, setGranularity] = useState<Granularity>('country')
  const [busy, setBusy] = useState<'link' | 'handle' | 'other' | null>(null)

  const platform = PLATFORMS.find((p) => p.id === platformId) ?? null

  const linkResult = useMemo(() => (link.trim() ? parseTarget(link) : null), [link])
  const handleResult = useMemo<ParseState>(() => {
    if (!handle.trim()) return null
    if (platformId === OTHER_HOST && !otherHost.trim()) {
      return { error: 'Name the site first — a host, like forum.example.org.' }
    }
    return accountFromHandle(platformId === OTHER_HOST ? otherHost.trim() : platformId, handle)
  }, [platformId, otherHost, handle])

  /* The third route previews its canonical value too. `normaliseEntityValue` is the same
     function the store calls, so what is shown is what lands in entities.json — including
     the parts that surprise: a coordinate pair is rounded to 6dp, an address is lowercased. */
  const otherResult = useMemo<ParsedTarget | null>(() => {
    const v = value.trim()
    if (!v) return null
    const norm = normaliseEntityValue(kind, v)
    const label = kind === 'location' ? `${norm.label} (${granularity})` : norm.label
    return { kind, value: norm.value, label, attrs: norm.attrs, note: '' }
  }, [kind, value, granularity])

  /** True when `coordinates` is claimed but the value is not a pair normalise can read. */
  const coordsUnparsed =
    kind === 'location' &&
    granularity === 'coordinates' &&
    !!value.trim() &&
    (otherResult?.attrs as { lat?: number } | undefined)?.lat === undefined

  const add = async (which: 'link' | 'handle' | 'other', target: ParsedTarget): Promise<void> => {
    onError(null)
    setBusy(which)
    try {
      const created = await window.osint.entities.add({
        caseId,
        kind: target.kind,
        value: target.value,
        label: target.label,
        seed: true
      })
      if (which === 'link') setLink('')
      if (which === 'handle') setHandle('')
      if (which === 'other') setValue('')
      onAdded(created)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const commit = (which: 'link' | 'handle' | 'other', result: ParseState): void => {
    if (!result || isParseFailure(result) || busy) return
    void add(which, result)
  }

  return (
    <div className="entity-add">
      {/* 1 — the link. */}
      <div className="entity-add__route">
        <label className="label" htmlFor="add-link">
          Paste a profile link
        </label>
        <div className="entity-add__row">
          <input
            id="add-link"
            className="input input--data"
            value={link}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit('link', linkResult)}
            placeholder="https://github.com/torvalds"
            aria-describedby="add-link-read"
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => commit('link', linkResult)}
            disabled={!linkResult || isParseFailure(linkResult) || busy !== null}
            data-loading={busy === 'link' ? 'true' : undefined}
          >
            {busy === 'link' ? 'Adding…' : 'Add'}
          </button>
        </div>
        <Readout id="add-link-read" result={linkResult} />
      </div>

      {/* 2 — a platform and a handle. */}
      <div className="entity-add__route">
        <label className="label" htmlFor="add-handle">
          Or a platform and a handle, when there is no link
        </label>
        <div className="entity-add__row">
          <select
            className="select"
            value={platformId}
            onChange={(e) => setPlatformId(e.target.value)}
            aria-label="Platform the handle is on"
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={OTHER_HOST}>Somewhere else…</option>
          </select>
          {platformId === OTHER_HOST && (
            <input
              className="input input--data entity-add__host"
              value={otherHost}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setOtherHost(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit('handle', handleResult)}
              placeholder="forum.example.org"
              aria-label="Site the account is on"
            />
          )}
          <input
            id="add-handle"
            className="input input--data"
            value={handle}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit('handle', handleResult)}
            placeholder="torvalds"
            aria-describedby="add-handle-read"
          />
          <button
            type="button"
            className="btn"
            onClick={() => commit('handle', handleResult)}
            disabled={!handleResult || isParseFailure(handleResult) || busy !== null}
            data-loading={busy === 'handle' ? 'true' : undefined}
          >
            {busy === 'handle' ? 'Adding…' : 'Add'}
          </button>
        </div>
        <Readout id="add-handle-read" result={handleResult} />
        {!handleResult && platform?.handleShape && (
          <p className="entity-add__note">{platform.handleShape}</p>
        )}
      </div>

      {/* 3 — everything that is not an account. */}
      <div className="entity-add__route">
        <label className="label" htmlFor="add-value">
          Or something that is not an account
        </label>
        <div className="entity-add__row">
          <select
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as EntityKind)}
            aria-label="Kind of entity to add"
          >
            {OTHER_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {kind === 'location' && (
            <select
              className="select"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
              aria-label="How precisely this place is known"
            >
              {GRANULARITIES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
          <input
            id="add-value"
            className="input input--data"
            value={value}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit('other', otherResult)}
            placeholder={kind === 'location' ? GRANULARITY_PLACEHOLDER[granularity] : PLACEHOLDER[kind]}
            aria-describedby="add-value-read"
          />
          <button
            type="button"
            className="btn"
            onClick={() => commit('other', otherResult)}
            disabled={!otherResult || busy !== null}
            data-loading={busy === 'other' ? 'true' : undefined}
          >
            {busy === 'other' ? 'Adding…' : 'Add'}
          </button>
        </div>
        <Readout id="add-value-read" result={otherResult} />
        {kind === 'location' && (
          <p className="entity-add__note">
            Nothing in this toolbelt takes a place as a query — a seeded location is used for
            attribution, matched against text an adapter has already read off a profile. A
            country on its own is a complete answer at its own scale; the granularity is
            recorded as you chose it, never inferred from how the name is spelled.
            {coordsUnparsed && (
              <>
                {' '}
                This value is not a coordinate pair, so it will be stored as a place name:
                write it as <Data>38.7223, -9.1393</Data> to store a point.
              </>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

type ParseState = ParsedTarget | { error: string } | null

/**
 * What the field in front of it produced, in the canonical form it will be stored as.
 *
 * A refusal is rendered in the muted register with an icon and a word rather than in
 * `--danger`: half of these appear while a URL is still being typed, and a form that turns
 * red at every keystroke teaches the operator to ignore it. The refusals that matter — an
 * invite that names nobody, a channel id that is not a handle — read as calm statements of
 * what the link does not contain, which is what they are.
 */
function Readout({ id, result }: { id: string; result: ParseState }): React.JSX.Element {
  if (!result) {
    return <div className="entity-add__out" id={id} aria-live="polite" />
  }
  if (isParseFailure(result)) {
    return (
      <div className="entity-add__out" id={id} aria-live="polite">
        <div className="entity-add__read entity-add__read--miss">
          <Icon name="info" size={11} />
          <span>Nothing to add yet</span>
        </div>
        <p className="entity-add__note">{result.error}</p>
      </div>
    )
  }
  return (
    <div className="entity-add__out" id={id} aria-live="polite">
      <div className="entity-add__read">
        <span className="entity-add__kind">{result.kind}</span>
        <span className="dot-sep">·</span>
        <Data>{result.value}</Data>
        {/* The label is only worth repeating when it says something the value does not. An
            account's is "torvalds on github.com", which is the value read aloud; a
            location's carries the granularity, which is the whole point of it. */}
        {result.kind !== 'account' && result.label !== result.value && (
          <>
            <span className="dot-sep">·</span>
            <span className="entity-add__kind">{result.label}</span>
          </>
        )}
      </div>
      {result.note && <p className="entity-add__note">{result.note}</p>}
    </div>
  )
}
