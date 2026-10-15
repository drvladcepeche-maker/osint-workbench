/**
 * `holehe` — email address -> which sites have an account for it.
 *
 * The cleanest demonstration in the toolbelt of an *oracle* attack: you never log in, you
 * never guess a password, you just ask a public form a question it is obliged to answer
 * honestly and read the difference in the reply.
 *
 * **The Phase 0 caveat, unresolved:** on this machine every one of holehe's 121 modules
 * came back `rateLimit=True` — 121 sites "checked" in 1.25 seconds, which is far too fast
 * to be real. `rateLimit=True` means *no answer was obtained*, not *no account exists*,
 * and this parser reports it that way rather than quietly counting it as a negative.
 */

import type { Finding } from '../../shared/types'
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
  readEnvelope,
  recordSpawn,
  stderrSummary,
  type RunEnvelope
} from './support/envelope'
import { parseCsv, pyBool } from './support/csv'
import { localSource, siteOrigin } from './support/sources'
import {
  checkBinary,
  findFiles,
  makeWorkdir,
  mergedOptions,
  optionBoolean,
  optionNumber,
  osintEnv,
  readTextIfExists,
  removeWorkdir,
  resolveBinary
} from './support/toolkit'

const ID = 'holehe'
const VERSION = '1.0.0'
const BIN_CANDIDATES = ['venv/Scripts/holehe.exe', 'venv/bin/holehe'] as const

interface Tally {
  total: number
  registered: number
  notRegistered: number
  rateLimited: number
  unanswered: number
}

export const holeheAdapter: Adapter = {
  id: ID,
  title: 'holehe (email → account existence)',
  version: VERSION,

  accepts: ['email'],
  produces: ['account', 'phone', 'email'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 1,
  // Rate limiting is holehe's dominant failure mode, so the politeness gap is long by
  // default. Running it back to back is how you turn a weak signal into no signal.
  minIntervalMs: 30_000,
  defaultTimeoutMs: 180_000,

  doc: {
    what: 'Takes an email address and reports which of about 120 websites already have an account registered to it, without ever logging in.',

    how: 'For each site it submits the address to a public, unauthenticated endpoint that has to behave differently for a known address than for an unknown one, and reads the difference. Usually that is the password-reset form: a site that answers "we have sent you an email" is telling you the address is registered, while "no account matches that address" is telling you it is not. Where a site has hardened its reset flow, holehe uses the registration form instead — submitting an address that is already taken produces "that email is already in use" — or the login endpoint, which sometimes distinguishes "wrong password" from "no such user". Nothing is sent to the address owner beyond, in the reset case, one password-reset email that they can ignore; no password is ever guessed and no session is created.',

    why: 'The leak is structural and mostly cannot be closed without breaking the product. A password-reset form that says "if that address exists we have emailed you" is deliberately vague and defeats this attack, but a form that says "unknown email" is being helpful to a legitimate user who mistyped, and that helpfulness is the oracle. Registration forms are worse: they must reject a duplicate address to work at all. The result is that an email address you use for signups quietly accumulates a public, queryable membership list, and this is exactly the mechanism behind the manual "does a Facebook account exist for this address" trick — automated across a hundred sites at once.',

    betterAt: 'Answering a question about an address rather than a handle. Where the username tools ask "is this name taken", holehe asks "is this *person\'s address* registered here", which is a far stronger link — a username collision can be coincidence, but an email address is essentially unique to one person. It is also the right tool when you already have an address and want to know where to look next, and its output distinguishes the checking method per site, so you can see which answers came from a reset form and which from a registration form.',

    worseAt: 'Working at all, much of the time. Rate limiting is severe and is the normal outcome, not the exception: in the Phase 0 test every single module returned a rate-limit result from this IP. Its site list is around 120 entries — a fifth of what the username tools carry — and it skews towards services that were popular when the modules were written, so the coverage is both narrow and ageing. Individual modules break silently whenever a site changes its reset flow, and because a broken module usually fails closed, the failure looks identical to "no account here".',

    falsePositives: 'The dangerous reading is the negative one. `rateLimit=True` means the site refused to answer, and treating that as "no account" is the single most common way to misread this tool — this adapter reports rate-limited sites as unchecked and never as absent. In the other direction, a site that has switched to the privacy-preserving "if that address exists we have emailed you" wording will look like a hit to a module that has not been updated, and a site with a shared identity provider can answer for a *different* product than the one named. Any positive is also time-sensitive in an awkward way: it tells you an account exists now, not who created it, so a shared or recycled address will attribute someone else\'s accounts to your subject.'
  },

  check(ctx) {
    return checkBinary(
      ctx.config,
      ctx.toolkitRoot,
      ID,
      BIN_CANDIDATES,
      'Install it into the toolkit venv: <toolkitRoot>\\venv\\Scripts\\pip.exe install holehe'
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const target = input.entity.value
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })

    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN_CANDIDATES)
    // `-C` writes `holehe_<epoch>_<email>_results.csv` into the cwd. The epoch in the name
    // cannot be predicted from here, so the run gets an empty directory to write into.
    const workdir = await makeWorkdir(ctx.caseDir, ID)

    try {
      const args: string[] = [
        target,
        '--no-clear',
        '--no-color',
        '-C',
        '-T',
        String(optionNumber(options, 'siteTimeoutSeconds', 10, { min: 3, max: 60 }))
      ]
      // Off by default would be safer still, but the password-recovery modules are most of
      // holehe's coverage; the operator can disable them when a reset email to the subject
      // would be unwelcome.
      if (optionBoolean(options, 'noPasswordRecovery', false)) args.push('-NP')
      if (optionBoolean(options, 'onlyUsed', false)) args.push('--only-used')

      ctx.progress({ pct: 10, note: `querying registration oracles for ${target}` })

      const res = await ctx.spawn(bin.file, {
        args,
        cwd: workdir,
        env: osintEnv(ctx.toolkitRoot),
        timeoutMs: ctx.timeoutMs
      })
      recordSpawn(env, { file: bin.file, args }, res)

      ctx.progress({ pct: 90, note: 'collecting CSV' })

      const csvs = await findFiles(workdir, (name) => /^holehe_.*_results\.csv$/i.test(name) || name.toLowerCase().endsWith('.csv'))
      for (const file of csvs.slice(0, 4)) {
        const body = await readTextIfExists(file.path)
        if (body !== null) env.artifacts[file.name] = body
      }
      if (!csvs.length) env.notes.push(`No holehe_*_results.csv appeared in the scratch directory ${workdir}.`)

      const haveCsv = csvs.length > 0
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: haveCsv,
        error: res.spawnError
          ? `holehe did not run: ${res.spawnError}`
          : `holehe exited ${res.exitCode} without writing a CSV. ${stderrSummary(env)}`,
        finishedAt: ctx.now(),
        startedMs
      })
    } finally {
      await removeWorkdir(workdir)
    }
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * The accounts this address is registered to, and any *complete* contact detail a site
   * handed back with them.
   *
   * The masked columns are deliberately not here. `te****@e*****.com` and `+33 6 ** ** **
   * 12` are the two most useful things holehe ever returns, and neither is an entity: a
   * mask is a constraint on a value, not the value. They stay findings, where a human can
   * read them against an address he already has, and they never become a candidate whose
   * promotion would put a fragment into the graph as though it were an address.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the CSV, producing the findings and the proposals together, so a proposal
 * can carry the id of the finding beside it rather than rebuilding that finding's claim
 * string — the id is derived from the claim, and two copies of a claim diverge.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const csvName = Object.keys(env.artifacts).find((n) => n.toLowerCase().endsWith('.csv'))
  const table = parseCsv(csvName ? env.artifacts[csvName] : null)

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  const tally: Tally = { total: 0, registered: 0, notRegistered: 0, rateLimited: 0, unanswered: 0 }
  // The address the run was pointed at. It is the handle on every site that answers yes,
  // and it is the one value that must never be proposed back to itself.
  const address = (env.target ?? '').trim()

  for (const row of table.rows) {
    tally.total++
    const site = row['name'] || row['domain'] || 'unknown site'
    const domain = row['domain'] || site
    const source = siteOrigin(domain) || domain.toLowerCase()
    const method = (row['method'] ?? '').trim()
    const exists = pyBool(row['exists'])
    const limited = pyBool(row['rateLimit'])

    // Order matters: a rate-limited row often also carries `exists=False`, and reading
    // that False as a negative result is the classic way to misreport this tool.
    if (limited === true) {
      tally.rateLimited++
      continue
    }
    if (exists === true) {
      tally.registered++
      const via = method ? ` The answer came from the site's ${method} flow.` : ''
      const account = makeFinding(raw, {
        source,
        claim: `holehe reports that an account is registered to ${env.target} on ${site} (${domain}).${via}`
      })
      findings.push(account)
      if (isPlatform(source) && address) {
        // Same `platform/handle` shape, off the same folded origin as `Finding.source`, so
        // this converges with a username tool's proposal about the same site instead of
        // sitting beside it as a near-duplicate.
        proposals.push({
          fromFindingId: account.id,
          kind: 'account',
          value: `${source}/${address}`,
          label: `${address} on ${site}`,
          attrs: { platform: source, handle: address, ...(method ? { method } : {}) },
          rationale: `${site}'s ${method || 'public'} endpoint behaved as though ${address} were already registered. That is the endpoint's behaviour today, not a profile anyone has seen, and a module that has not kept up with a reworded reply says this about everybody.`
        })
      }
      const recovery = (row['emailrecovery'] ?? '').trim()
      if (recovery) {
        findings.push(
          makeFinding(raw, {
            source,
            claim: `${site} shows the partially masked recovery address "${recovery}" for the account registered to ${env.target}.`
          })
        )
      }
      const phone = (row['phoneNumber'] ?? '').trim()
      if (phone) {
        findings.push(
          makeFinding(raw, {
            source,
            claim: `${site} shows the partially masked recovery phone number "${phone}" for the account registered to ${env.target}.`
          })
        )
      }
      const others = (row['others'] ?? '').trim()
      if (others) {
        const extra = makeFinding(raw, {
          source,
          claim: `${site} returned additional account details for ${env.target}: ${others.slice(0, 300)}`
        })
        findings.push(extra)
        for (const contact of unmaskedContacts(others, address)) {
          proposals.push({
            fromFindingId: extra.id,
            kind: contact.kind,
            value: contact.value,
            attrs: { platform: source },
            rationale:
              contact.kind === 'email'
                ? `${site} returned this address in full, unmasked, alongside the account registered to ${address}. Whose recovery address it is, the site did not say.`
                : `${site} returned this number in full, unmasked, alongside the account registered to ${address}. A recovery number can belong to a partner, a parent or a previous owner of the account.`
          })
        }
      }
      continue
    }
    if (exists === false) {
      tally.notRegistered++
      continue
    }
    tally.unanswered++
  }

  findings.push(summaryFinding(raw, env, tally))
  return { findings, proposals }
}

/**
 * Did the fold produce something that is actually a site operator?
 *
 * A row missing its `domain` column falls back to the module's short name, and `imgur`
 * folded is still `imgur`. That is a fine `Finding.source` — nothing else collides with
 * it — and a useless platform half of `platform/handle`, where it would name a site that
 * no other tool can ever converge on.
 */
function isPlatform(source: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(source)
}

/** A complete contact value pulled out of holehe's free-text `others` column. */
interface Contact {
  kind: 'email' | 'phone'
  value: string
}

/** Characters holehe (and the sites it reads) use to redact the middle of a value. */
const MASK_CHARS = /[*•·×]/

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/**
 * International form only. A bare national number is not a complete value — it cannot be
 * dialled and it cannot be compared with another number — and guessing its country from
 * the site's TLD is exactly the silent inference this app refuses to make.
 */
const PHONE_IN_TEXT = /\+\d[\d\s().-]{6,20}\d/g

/**
 * The complete, unmasked contact values in one `others` cell.
 *
 * `others` is free text: holehe modules drop whatever a site handed back into it, which is
 * occasionally a full recovery address or a full phone number and far more often a masked
 * hint, a status word or a JSON fragment. Anything touching a mask character is refused
 * outright — a fragment promoted into the graph is a value that looks like an address and
 * matches nothing forever.
 */
function unmaskedContacts(others: string, selfAddress: string): Contact[] {
  const out: Contact[] = []
  const seen = new Set<string>()
  const self = selfAddress.trim().toLowerCase()

  for (const m of others.matchAll(EMAIL_IN_TEXT)) {
    const value = m[0]
    if (touchesMask(others, m.index ?? -1, value.length)) continue
    const key = `email:${value.toLowerCase()}`
    // The address the run was pointed at is already in the graph; proposing it back would
    // only ask the operator to approve what he typed.
    if (value.toLowerCase() === self || seen.has(key)) continue
    seen.add(key)
    out.push({ kind: 'email', value })
  }

  for (const m of others.matchAll(PHONE_IN_TEXT)) {
    if (touchesMask(others, m.index ?? -1, m[0].length)) continue
    const digits = m[0].replace(/\D/g, '')
    // E.164 allows 15 digits at most and no real number has fewer than 8 with its country
    // code attached; anything outside that is a date, an id or a price, not a phone number.
    if (digits.length < 8 || digits.length > 15) continue
    const value = `+${digits}`
    const key = `phone:${value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: 'phone', value })
  }

  return out
}

/** True when a match sits directly against a redaction character on either side. */
function touchesMask(text: string, index: number, length: number): boolean {
  if (index < 0) return true
  const before = index > 0 ? text[index - 1] : ''
  const after = text[index + length] ?? ''
  return MASK_CHARS.test(before ?? '') || MASK_CHARS.test(after)
}

function summaryFinding(raw: RawResult, env: RunEnvelope, t: Tally): Finding {
  if (t.total === 0) {
    return makeFinding(raw, {
      source: localSource(ID),
      claim: `holehe produced no readable rows for ${env.target}; nothing can be concluded about where this address is registered. ${stderrSummary(env)}`.trim()
    })
  }
  const noAnswer = t.rateLimited + t.unanswered
  const suspicious =
    t.total > 0 && t.rateLimited / t.total > 0.8
      ? ' Almost every site refused to answer, which is the failure mode Phase 0 observed from this IP — this run carries essentially no signal and should be repeated from a different network before any of it is believed.'
      : ''
  return makeFinding(raw, {
    source: localSource(ID),
    claim:
      `holehe queried ${group(t.total)} sites about ${env.target} in ${(env.durationMs / 1000).toFixed(1)} s: ` +
      `${group(t.registered)} say an account exists, ${group(t.notRegistered)} say it does not, and ${group(noAnswer)} did not answer ` +
      `(${group(t.rateLimited)} rate-limited). The sites that did not answer are unchecked, not clear.${suspicious}`
  })
}
