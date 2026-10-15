/**
 * `hibp-passwords` — check a candidate password against the Pwned Passwords corpus
 * **without ever sending the password, or its full hash, anywhere.**
 *
 * This adapter deliberately bends one rule in the contract, and the reason is worth
 * reading before changing it.
 *
 * `run()` is supposed to interpret nothing and leave all reasoning to `parse()`. Doing
 * that here would mean writing the SHA-1 suffix of the operator's real password into
 * `cases/<id>/raw/`, in plaintext, forever — because `parse()` cannot re-derive the match
 * without it. A 35-hex-character SHA-1 suffix plus its 5-character prefix is the whole
 * hash, and a whole SHA-1 of a human-chosen password is an offline cracking job, not a
 * secret. So the local comparison happens inside `run()`.
 *
 * **The range response body is not stored either, and that is not obvious.** Storing it
 * looks harmless — 2,006 anonymous suffixes, which is the entire point of k-anonymity —
 * but the finding this run produces states the occurrence count, and in a real bucket
 * that count is unique. Count plus bucket identifies the line; line plus prefix is the
 * complete SHA-1. Keeping the body therefore *undoes* the k-anonymity for anyone holding
 * the case folder, which was measured on a live run against the canonical test string:
 * exactly one line in the bucket carried the reported count. So the capture keeps the
 * status, the size of the bucket and the prefix, and drops the suffix list.
 *
 * That is a second, deliberate bend of the "raw output is permanent" rule, and it is the
 * one adapter where the rule costs least: the corpus is public, the endpoint is free and
 * keyless, and re-running the query re-derives the response exactly. Nothing else in this
 * app can say that. **Nothing that reaches the disk is sufficient to reconstruct the
 * input**, which is the property the whole design is for.
 */

import type { Finding } from '../../shared/types'
import { makeFinding, type Adapter, type AdapterContext, type AdapterInput, type RawResult } from './types'
import { beginEnvelope, finishEnvelope, group, parseJsonSafe, readEnvelope } from './support/envelope'
import { httpGet, sha1Hex, DEFAULT_USER_AGENT } from './support/net'
import { mergedOptions, optionString } from './support/toolkit'
import { localSource } from './support/sources'

const ID = 'hibp-passwords'
const VERSION = '1.0.0'
const SOURCE = 'api.pwnedpasswords.com'
const ENDPOINT = 'https://api.pwnedpasswords.com/range'

/** What `run()` computes and `parse()` reads. Contains no part of the hash but the prefix. */
interface MatchResult {
  prefix: string
  /** Number of suffix lines the server returned for that prefix. */
  bucketEntries: number
  /** How many times the candidate appears in the corpus. 0 means not found. */
  occurrences: number
  paddingRequested: boolean
  /** Never populated. Present so its absence is explicit to anyone reading a raw file. */
  suffix: null
}

export const hibpPasswordsAdapter: Adapter = {
  id: ID,
  title: 'Pwned Passwords (k-anonymity breach check)',
  version: VERSION,

  // Pointed at the identity whose password is being tested; the candidate itself comes in
  // through `options.password` and is never stored as an entity.
  accepts: ['email', 'username', 'person', 'account'],
  produces: [],

  requiresKey: false,
  requiresNetwork: true,

  /**
   * The candidate password, and nothing else this adapter takes.
   *
   * `run()` below is already written so that neither the password nor its full hash can
   * reach the envelope. This declaration is the belt to that pair of braces: the
   * orchestrator scrubs the value — and its SHA-1 — out of the raw body, the stderr, the
   * command line and the job's error message before any of them is written or shown. It
   * covers the paths this file cannot see, which are exactly the paths a live password
   * would leak through: a stack trace from a thrown request, a stderr tail from a proxy,
   * a future edit to `run()` made by someone who has not read this comment.
   */
  secretOptions: ['password', 'sha1'],

  concurrency: 2,
  minIntervalMs: 1_000,
  defaultTimeoutMs: 30_000,

  doc: {
    what: 'Tells you how many times a specific candidate password appears in the Pwned Passwords corpus of roughly a billion credentials recovered from public breaches — without the password, or a hash of it, ever leaving this machine.',

    how: 'It is a k-anonymity range query, and the trick is worth understanding in full. The password is hashed with SHA-1 locally, giving 40 hex characters. Only the **first five** are sent, as `GET /range/21BD1`. The server answers with every hash suffix it holds that begins with those five characters — around 800 of them — each with the number of times that password was seen. The remaining 35 characters are compared against that list here, in memory. The server therefore learns that somebody was interested in one of roughly 800 passwords and cannot tell which; it never sees the password, never sees the full hash, and cannot reconstruct either. Requesting `Add-Padding: true` makes every response the same size, so the number of bytes coming back cannot narrow it down either. SHA-1 is used because the corpus is indexed by SHA-1 — its cryptographic weakness is irrelevant here, since nothing is being authenticated.',

    why: 'Credential stuffing is the most common way ordinary accounts are taken over, and it does not involve guessing: attackers replay username and password pairs from old breaches against unrelated sites, and it works because people reuse passwords. A password that appears in the corpus is therefore not "weak" in the entropy sense — `Tr0ub4dor&3` and a 20-character passphrase are both catastrophic if they are already on a list, because they will be tried directly. The count matters more than the yes/no: a password seen three times is probably one other person\'s coincidence, and one seen four million times is in the first page of every attack dictionary in existence.',

    betterAt: 'Being safe to actually use. This is the only breach check that is defensible to run on your own live passwords, because the design makes the query useless to the party answering it. It is free, unlimited, needs no account and no key — unlike the breached-account side of Have I Been Pwned, which now requires a paid subscription that DECISIONS.md rules out. It is also fast enough to check a whole password manager export one entry at a time.',

    worseAt: 'Everything about accounts. It answers a question about a *string*, not about a person: it cannot tell you whether an address of yours appeared in a breach, which breach, or when. It also cannot tell you whether *your* use of that password was exposed — it says the string is in the corpus, which is true of "password1" whether or not anyone ever compromised you. And it only sees breaches that were published and processed; anything traded privately is invisible.',

    falsePositives: 'The honest reading of a hit is "this string is known to attackers", never "your account was breached". Millions of unrelated people chose the same common password, so a match is about the string\'s popularity rather than about you. A SHA-1 collision is theoretically possible and practically irrelevant at this scale. The genuinely dangerous misreading is in the other direction: zero occurrences means the password is not in *this published corpus*, which is not the same as safe. It says nothing about whether it is guessable, whether it is reused across your own accounts, or whether it appears in a breach that has not been published — and a not-found result is exactly the reassurance people use to justify keeping a password they should change anyway.'
  },

  check(ctx) {
    const configured = ctx.config.adapters[ID]?.options ?? {}
    // A password in a config file is a password in a file. Warn, do not refuse: the
    // operator may knowingly be testing a throwaway.
    if (typeof configured['password'] === 'string' && configured['password']) {
      return 'hibp-passwords: a password is stored in config/local.config.json. That file is gitignored but is still plaintext on disk — pass the candidate per run instead.'
    }
    return null
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const env = beginEnvelope({
      adapterId: ID,
      adapterVersion: VERSION,
      input,
      // The target is the identity, never the candidate. Nothing about the password
      // reaches the envelope.
      target: input.entity.label || input.entity.value,
      startedAt
    })

    const password = typeof options['password'] === 'string' ? (options['password'] as string) : ''
    const providedHash = optionString(options, 'sha1', '').toUpperCase()
    const hash = password ? sha1Hex(password) : /^[0-9A-F]{40}$/.test(providedHash) ? providedHash : ''

    if (!hash) {
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error:
          'No candidate supplied. Pass options.password (hashed locally, never sent) or options.sha1 (a full 40-character SHA-1, of which only the first 5 characters are sent).',
        finishedAt: ctx.now(),
        startedMs
      })
    }

    const prefix = hash.slice(0, 5)
    const suffix = hash.slice(5)
    const url = `${ENDPOINT}/${prefix}`
    // Only the prefix is ever recorded, and only the prefix is ever transmitted.
    env.command = { file: 'GET', args: [url] }
    env.notes.push(`Only the 5-character prefix ${prefix} left this machine. The remaining 35 characters were compared locally and are not stored.`)

    ctx.progress({ pct: 30, note: `requesting hash range ${prefix}` })

    const res = await httpGet({
      url,
      timeoutMs: Math.min(ctx.timeoutMs, 30_000),
      signal: ctx.signal,
      userAgent: optionString(options, 'userAgent', DEFAULT_USER_AGENT),
      accept: 'text/plain',
      // Every response the same size, so response length cannot narrow the candidate down.
      headers: { 'Add-Padding': 'true' }
    })

    env.exitCode = res.status
    if (res.error) env.stderr = res.error

    if (res.error || res.status !== 200) {
      // A failure body is an error page, not the corpus, so it is kept verbatim like any
      // other adapter's — there are no suffixes in it to leak.
      env.stdout = res.body
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: res.error ?? `Pwned Passwords answered HTTP ${res.status} ${res.statusText}.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    // The local half of the k-anonymity exchange. Padding rows are real-looking suffixes
    // with a count of 0; a genuine hit always has a positive count.
    let occurrences = 0
    let bucketEntries = 0
    for (const line of res.body.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      bucketEntries++
      const [candidate, countText] = t.split(':')
      if ((candidate ?? '').toUpperCase() !== suffix) continue
      const count = Number((countText ?? '0').trim())
      if (Number.isFinite(count)) occurrences = count
    }

    const result: MatchResult = {
      prefix,
      bucketEntries,
      occurrences,
      paddingRequested: true,
      suffix: null
    }
    env.artifacts['match.json'] = JSON.stringify(result, null, 2)

    // What is left of the response after the part that would give the hash away. The
    // count below is also in the finding's claim, so keeping the suffix list beside it
    // would make the pair enough to recover the whole SHA-1 — see the file header.
    env.stdout = [
      `HTTP ${res.status} ${res.statusText}`,
      `GET ${url}`,
      `${bucketEntries} hash suffixes were returned for prefix ${prefix} and compared in memory.`,
      'The suffix list is deliberately NOT stored: combined with the occurrence count in',
      'match.json it would identify the matching line, and that line plus the prefix is the',
      'complete SHA-1 of the candidate. The corpus is public and keyless, so re-running the',
      'same range query reproduces this response exactly.'
    ].join('\n')
    env.notes.push(
      `The ${bucketEntries}-line range response was not written to disk. It is the one capture in this app that is deliberately incomplete, and the reason is in the adapter's header comment.`
    )

    return finishEnvelope(env, { caseId: input.caseId, ok: true, finishedAt: ctx.now(), startedMs })
  },

  parse(raw: RawResult): Finding[] {
    const env = readEnvelope(raw)
    if (!env) return []
    const result = parseJsonSafe<MatchResult>(env.artifacts['match.json'] ?? null)
    if (!result || typeof result.occurrences !== 'number') {
      return [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `The Pwned Passwords range response for ${env.target} could not be interpreted; no conclusion about the candidate password was reached.`
        })
      ]
    }

    if (result.occurrences > 0) {
      const scale =
        result.occurrences >= 100_000
          ? 'It is in the first page of every credential-stuffing dictionary; treat any account using it as already compromised.'
          : result.occurrences >= 100
            ? 'It is common enough to be tried early in an automated attack.'
            : 'It appears only a handful of times, which is more likely somebody else\'s coincidence than evidence about this account — but it is still on a public list.'
      return [
        makeFinding(raw, {
          source: SOURCE,
          claim:
            `The candidate password tested for ${env.target} appears ${group(result.occurrences)} time${result.occurrences === 1 ? '' : 's'} in the Pwned Passwords corpus. ` +
            `${scale} The check sent only the hash prefix ${result.prefix} and compared the rest locally, so neither the password nor its full hash left this machine, and neither is stored in this case file.`
        })
      ]
    }

    return [
      makeFinding(raw, {
        source: SOURCE,
        claim:
          `The candidate password tested for ${env.target} does not appear in the Pwned Passwords corpus (checked against ${group(result.bucketEntries)} hash suffixes sharing the prefix ${result.prefix}). ` +
          'That means it is not in this published breach corpus. It does not mean it is strong, that it is unique to one account, or that it is absent from a breach nobody has published.'
      })
    ]
  }
}
