# Architecture

Foundation of the OSINT workbench: data model, storage, adapter contract, orchestrator.
Written for the agent that adds the first real tool adapters — the **Adapter contract**
section is the one you must follow exactly.

Read `DECISIONS.md` first; it is binding and this document implements it.

---

## 1. Shape of the thing

```
Tray (resident)  --double-click-->  BrowserWindow (destroyed on close)
                                          |
                                     preload bridge          window.osint.*
                                          |  IPC
+-----------------------------------------v---------------------------------+
|  MAIN PROCESS                                                             |
|    service.ts        every operation, with no Electron import             |
|    orchestrator.ts   job queue: caps, rate limits, timeouts, cancellation |
|    adapters/         registry + one file per tool                         |
|    store/caseStore   FILES ARE TRUTH                                      |
|    db/               SQLite + FTS5, DERIVED, disposable                   |
+-----------------------------------------+---------------------------------+
                                          | spawn
                                   the toolkit root
```

Two rules run through everything:

1. **Files are the source of truth; SQLite is a rebuildable index.** Same model as the
   journal app. `rebuildIndex()` reconstructs the entire database from `cases/`, and a
   test asserts the rebuilt database is byte-identical to the original.
2. **A single tool hit is never better than `unverified`.** Enforced in code, not just
   in the type. This is the spine of the app.

`service.ts` deliberately imports nothing from `electron`. That is what lets the test
suite drive the whole application — cases, adapters, orchestrator, index — in plain Node
with no display.

---

## 2. Data model — `src/shared/types.ts`

### Entity

A discriminated union over `kind`. Common fields on every variant:

| Field | Type | Notes |
|---|---|---|
| `id` | `EntityId` | `ent_<20 hex>`, **derived from `(caseId, kind, canonical value)`** |
| `caseId` | `CaseId` | |
| `kind` | `EntityKind` | the discriminant |
| `value` | `string` | canonical form — see `normalise.ts` |
| `label` | `string` | display form, as originally typed |
| `createdAt` | `IsoTimestamp` | |
| `seed` | `boolean` | **user-supplied (`true`) vs discovered (`false`)** |
| `attrs` | kind-specific | always present, may be empty |

Kinds: `person | username | email | phone | domain | ipaddr | image | account |
location | organisation`.

Narrow with `EntityOf<'account'>`; get the attrs bag with `EntityAttrs<'account'>`.

**Entity ids are content-addressed.** `upsertEntity` is therefore idempotent: adding the
same email twice returns one entity, and an adapter that discovers something the operator
already seeded enriches that entity instead of forking a near-duplicate. `seed` is
sticky-true — once marked user-supplied it stays that way, because the self-audit's
adversary-level analysis ("what did this one seed unlock?") depends on that baseline.

**`username` vs `account`.** A `username` is a handle with no platform. An `account` is a
handle *on* a platform; its `value` is `platform/handle`. Username adapters accept
`username` and produce `account`.

### Finding

```ts
{ id, caseId, entityId, source, tool, claim, confidence, evidenceRef,
  firstSeen, lastVerified, raw }
```

A Finding is **not a fact**. It is "tool X, reading source Y, asserted Z".

- `source` — the origin as the outside world names it (a hostname, URL, dataset). **This
  is the corroboration independence key**, so it must name where the information came
  from, never the program that fetched it.
- `tool` — the adapter id.
- `evidenceRef` — `EvidenceId | null`.
- `lastVerified` — `null` until the same claim is re-observed.
- `raw` — a `RawPayload` pointing at the permanently stored, unparsed output.

**Finding ids are content-addressed over `(caseId, entityId, tool, source, claim)` and
deliberately exclude `raw`.** Re-running a tool that says the same thing updates
`lastVerified` and repoints `raw` at the newer capture; it does not create a second row.
Every capture stays on disk regardless.

### RawPayload — why it is a pointer

```ts
{ rawId, path, sha256, bytes, mediaType, excerpt }
```

The requirement is that the tool's unparsed output is kept permanently so a parser bug is
never data loss. The bytes live at `cases/<id>/raw/<rawId>.<ext>` rather than inline in
`findings.jsonl` so that a 40 MB Maigret dump does not have to be loaded to render a
table row. `excerpt` is the first 2 KB, used for previews and full-text search, and is
**never authoritative**.

Raw files are append-only. They are never deleted or rewritten, including when a finding
is deleted, and including for runs that failed, timed out, or crashed the parser.

### EntityCandidate — how the graph grows

```ts
{ id, caseId, kind, value, label, attrs, proposals[], state, firstProposedAt, decidedAt }
```

An adapter's `produces` is a declaration of *capability*; its `propose()` is the
declaration of *fact* for one run. **Neither creates an `Entity`.** A discovery lands
here, outside the graph, and becomes an entity only when a human promotes it.

That is not caution for its own sake. Every proposal descends from an `unverified`
finding, and the username tools' known, unsolved failure mode is a site answering an
anti-bot challenge with HTTP 200, which reads as "this account exists". Auto-promoting
would fill a case with accounts that were never there — and worse, later runs would be
pointed at them, so the second generation of findings would be about nothing at all. It is
also the same rule the confidence ladder already encodes: only a human moves something up.

- **`id` is content-addressed with the same formula as `entityId`.** Three consequences:
  two adapters discovering the same account converge on one candidate carrying two
  proposals; a candidate that duplicates an existing entity is detectable by primary key;
  and promotion yields an entity whose id was predictable before it existed.
- **A `CandidateProposal` stores `findingId`, not a confidence.** Confidence lives on the
  finding and changes when the finding is promoted; a copy would be wrong from the first
  promotion. `listCandidates()` joins it at read time and returns a `CandidateView` with
  `bestConfidence`, `independentSources` and the proposing claims.
- **A decided candidate stays decided.** A later run that re-proposes something the
  operator dismissed appends the proposal but does not resurrect it. A queue that re-asks
  an answered question every time a tool runs is a queue nobody reads.
- **Promotion sets `seed: false`** and does *not* re-point the proposing findings at the
  new entity: a finding's id is content-addressed over the entity it was about, so moving
  it would mint a different finding and lose the original's history.

### Confidence

```
unverified -> corroborated -> confirmed        refuted (off the ladder)
```

| Level | Requires |
|---|---|
| `unverified` | nothing. **The default, and where most findings correctly stay** |
| `corroborated` | >= 2 findings with **distinct `source` values**, same entity, same case |
| `confirmed` | a **human** actor plus a non-empty note |
| `refuted` | a human with a note, or >= 2 independent contradicting sources |

Enforced in `src/shared/confidence.ts`:

- `adapterConfidence()` / `assertAdapterConfidence()` — **throws** if an adapter emits
  anything other than `unverified`. Applied by `finaliseFinding()` to everything
  `parse()` returns, including objects an adapter built by hand.
- `promote()` — the only path by which confidence changes. Throws when the evidence does
  not meet the bar; it never silently downgrades the request.
- `independenceKey()` — normalises a source to its host. `https://github.com/foo`,
  `github.com` and `GitHub.com/` are **one** source.

**Why independence keys on `source` and not `tool`:** Sherlock and Maigret both probing
`github.com` is one source, not two. Keying on the tool would make two wrappers around
the same site list "corroborate" every false positive in that list — which is precisely
the known, unresolved false-positive class those tools have (anti-bot redirects answering
200 and reading as "account exists"). A test asserts this case is rejected.

A negative result is **not** `refuted`. It is an `unverified` finding whose claim states
the negative ("holehe reports no account for this address on Spotify"), because one tool
failing to find something is exactly as fallible as one tool finding it.

Every change appends a `ConfidenceChange` to `confidence-log.jsonl` recording actor,
supporting findings, independent sources and note. That file is the answer to "why do I
believe this", and it is append-only.

### Case

```ts
{ id, name, basis, subjectConsent, createdAt, notes }
```

`basis: 'self' | 'consent' | 'ctf-fictional' | 'public-entity' | 'training'`.

`isPublishableBasis()` — **only `ctf-fictional`, `training` and `public-entity` are
publishable.**

- `self` is excluded because a self-audit report is by definition a complete dossier on
  yourself.
- `consent` is excluded because consent to be *investigated* is not consent to be
  *published*: publishing takes you out of the household exemption (*Lindqvist*,
  C-101/01) and makes you a controller with Art. 14 notice duties.

`createCase` **throws** if `basis === 'consent'` without `subjectConsent === true`, and
forces `subjectConsent` to `false` for every other basis. This is enforced at creation,
not trusted to the UI.

Case ids are readable and double as folder names:
`2026-08-30-self-audit-l0-01j9kq3f`.

### Evidence

```ts
{ id, findingId, type, path, sha256, capturedAt, sourceUrl }
```

`path` is relative to the case folder. `sha256` is over the stored bytes at capture time,
so `verifyEvidence()` can later show an artifact is unmodified.

---

## 3. Storage — `src/main/store/caseStore.ts`

```
cases/<case-id>/
  case.json               Case + schemaVersion, pretty-printed
  entities.json           Entity[], rewritten whole
  candidates.jsonl        discovered, NOT in the graph until a human promotes one
  findings.jsonl          one Finding per line
  confidence-log.jsonl    append-only audit of every confidence change
  removed-entities.jsonl  append-only tombstones — see "Removing an entity" below
  evidence/index.jsonl    one Evidence record per line
  evidence/<id>.<ext>     captured bytes
  raw/<raw-id>.<ext>      unparsed tool output, append-only
```

### Removing an entity

`entities.json` is the only file a removal touches. **Findings are kept and become
orphaned**; raw captures are never deleted. A finding is the record that a tool, reading
a source, asserted something at a moment in time, and its capture is permanent — deleting
the question does not unobserve the answer. The UI marks such a row `orphaned` rather
than hiding it, and an orphan is *derived* (a finding whose `entityId` is not in
`entities.json`) so the two can never disagree.

`removed-entities.jsonl` is what lets an orphaned row still name what it was about: kind,
value, label, when, why, how many findings it left, and — for a rename — the entity that
replaced it. It is written **only when the removal left something behind**. A seed the
operator mistyped and never ran anything against comes out clean, because a permanent
record that a typo was made is not an audit trail.

Two consequences that are decisions rather than details:

- **Runs pointed at the entity are cancelled first.** Otherwise the orchestrator fails
  them seconds later with "entity is not in case", which is true and reads as a bug.
- **A candidate that was promoted into it returns to `pending`.** This is the one
  deliberate exception to "a decided candidate stays decided": that rule stops a *tool*
  overturning a human's decision, and here the human is reversing his own. Without it,
  removing a promoted account would delete the discovery outright.

**Editing** a value is an add-and-remove, because entity ids are content-addressed over
`(caseId, kind, canonical value)`. The new value goes through `normaliseEntityValue`, so
a correction lands exactly where the value would have landed had it been typed right; the
`seed` flag is inherited, and the old id's findings are orphaned with a tombstone naming
the replacement. A change that normalises to the same value moves no id and orphans
nothing. Composite kinds (`account`) and digest-valued ones (`image`) refuse the edit and
say why — their value is built from parts, not typed.

JSONL for findings (high volume, append-heavy, one corrupt line costs one finding) and a
pretty-printed JSON array for entities (few, mutated in place, the thing you most often
want to hand-edit).

**Every write is atomic** — write to a unique temp file, then rename. The temp name
includes pid, timestamp and a counter: a fixed `<file>.tmp` *looks* atomic but two
concurrent writers share it and the second rename fails with ENOENT. The orchestrator
runs adapters in parallel by design, so that is routine, not a corner case.

**Read-modify-write is serialised per file** by `withFileLock`. Without it, two adapters
finishing simultaneously both read the old `findings.jsonl` and the second write erases
the first one's finding — silent, intermittent data loss that only appears under exactly
the concurrency the orchestrator exists to provide. There is a regression test. This
guards a single process; the single-instance lock in `main/index.ts` prevents two copies
of the app racing on the same folder.

A corrupt case folder is **skipped, not fatal** — one bad `case.json` must not take the
other twelve down with it. A corrupt JSONL line costs that line only.

### The SQLite index — `src/main/db/`

`data/index.db`. WAL, `synchronous = NORMAL`. Tables: `cases`, `entities`, `candidates`,
`candidate_proposals`, `findings`, `evidence`, `confidence_changes`, `meta`, plus
`findings_fts`. `INDEX_SCHEMA_VERSION` is **2**; the bump that added the two candidate
tables is a rebuild on next open, not a migration — which is the point of the files being
the truth.

Candidates are a separate table rather than a flag on `entities` deliberately: a query
that forgot the flag would silently treat unreviewed guesses as facts, and half the
queries in this app are about what the case actually holds. Separation makes forgetting
impossible instead of merely discouraged.

Everything here is derived. Visible consequences in the DDL: no surrogate keys, no
autoincrement, no cascade doing real work. `PRAGMA user_version` holds
`INDEX_SCHEMA_VERSION`; a mismatch triggers an automatic rebuild on open, so a schema
change is a rebuild rather than a migration.

Denormalised columns that carry rules:
- `cases.publishable` — so an export query cannot forget the basis rule.
- `findings.source_key` — the `independenceKey`, so "how many independent sources back
  this claim" is one indexed `GROUP BY`.

**FTS5** is external-content over `findings(claim, source, tool, raw_excerpt)` with
insert/update/delete triggers. `raw_excerpt` is indexed on purpose: it lets you search
text the parser did *not* turn into a claim, which is exactly what you want when you
suspect the parser missed something. Tokeniser is
`unicode61 remove_diacritics 2` because case material is often Bulgarian.
`searchFindings()` quotes user terms before handing them to FTS5, so pasted text
containing `-`, `:` or `"` cannot become an operator.

**`rebuildIndex(db, store)`** — drops everything, walks `cases/`, reinserts. All the async
file reading happens first and the whole write lands in one transaction, so a failed
rebuild leaves the previous index intact rather than half-populated. Returns `IndexStats`
including a `skipped[]` list. Proved by a test that snapshots every table, deletes
`index.db` and its WAL sidecars, rebuilds, and asserts equality — including that a
promoted `corroborated` finding is still `corroborated`, because its confidence lives in
the files.

---

## 4. Adapter contract — `src/main/adapters/types.ts`

**Read this section before writing an adapter.** `src/main/adapters/echo.ts` is the
reference implementation; copy its shape.

```ts
export interface Adapter {
  id: string                    // lowercase, filename-safe, STABLE (written into every Finding.tool)
  title?: string
  version?: string              // bump when parse() changes shape
  accepts: EntityKind[]         // must be non-empty
  produces: EntityKind[]        // may be empty (annotate-only adapters)
  requiresKey: boolean
  requiresNetwork: boolean
  secretOptions?: string[]      // option keys whose VALUES must never reach disk
  doc: AdapterDoc               // MANDATORY, all six fields
  concurrency?: number
  minIntervalMs?: number        // the politeness knob
  defaultTimeoutMs?: number
  check?(ctx): string | null    // cheap availability probe; string = unavailable reason
  run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult>
  parse(raw: RawResult): Finding[]
  propose?(raw: RawResult): EntityProposal[]   // names entities; creates none
}
```

### `doc` is mandatory and enforced

```ts
doc: {
  what:           // one line: what it does
  how:            // THE ACTUAL MECHANISM — "sends a password-reset request and reads
                  // the difference in the response"
  why:            // why that mechanism reveals anything
  betterAt:       // when to reach for this instead of the alternatives
  worseAt:        // its failure modes and blind spots
  falsePositives: // how it lies to you
}
```

`AdapterRegistry.register()` calls `assertAdapterDoc()` and **throws `AdapterDocError`**
on: a missing doc object, a missing or non-string field, a whitespace-only field, a
placeholder (`TODO`, `TBD`, `n/a`, `-`, `???`, `fixme`, `later`), or anything shorter
than `MIN_DOC_FIELD_LENGTH` (12 characters). The length floor is the part that bites — it
is what stops `how: 'scrapes'` from passing. Describe the mechanism; do not name it.

Registration happens at startup, so a bad doc is a **boot failure with a precise
message**, not a mystery at click time. There are tests for every rejection case.

This is not documentation hygiene. `HowThisWorks.tsx` renders all six fields in the right-hand context panel beside every
result, and the operator's stated priority is understanding mechanisms rather than
pressing buttons. An adapter without a filled-in doc does not ship.

Registration also rejects: a malformed or duplicate `id`, an empty `accepts`, a missing
`produces` array, a missing `run` or `parse`, and non-boolean `requiresKey` /
`requiresNetwork`.

### Lifecycle

```
run(input, ctx)          the tool executes. INTERPRET NOTHING here.
store.writeRaw(...)      output persisted verbatim — ALWAYS, including on
                         failure, timeout and non-zero exit
raw.raw = payload        the orchestrator attaches the RawPayload
parse(raw)               interpretation, and only now
finaliseFinding(...)     ids stamped, confidence forced to unverified
store.upsertFinding(...) written to the file, then to SQLite
```

`parse` takes only a `RawResult`, and must be **pure**: no I/O, no network, no clock
beyond `raw.finishedAt`. That purity is what makes fixing a parser bug a matter of
re-parsing raw files already on disk, with nothing re-run and nothing re-fetched.

`parse` must **never throw for bad input** — return `[]` instead. The orchestrator catches
a throwing parser and reports it, but a malformed payload is an expected condition.

### Building findings inside `parse`

```ts
return [ makeFinding(raw, { source: 'github.com', claim: 'An account named foo exists' }) ]
```

`makeFinding` takes no confidence parameter — it is `unverified` by construction. Pass
`entityId` only when the claim is about a *discovered* entity rather than the one the run
was pointed at.

`finaliseFinding()` is the last gate and **throws** (never silently corrects) on: a
mismatched `caseId`, a `tool` that is not this adapter, an empty `source`, an empty
`claim`, or any confidence above `unverified`.

### `propose()` — naming what was discovered, creating nothing

```ts
propose(raw) => [{ fromFindingId, kind, value, label?, attrs?, rationale }]
```

Pure and re-derivable from the raw capture, exactly like `parse`, so the candidate queue
can be rebuilt from files years later and a proposal bug is a re-derivation rather than a
lost discovery. Must never throw — return `[]`.

**Write it as one walk.** The adapters that implement it factor their parser into a
module-level `interpret(raw) => { findings, proposals }` and expose
`parse: (raw) => interpret(raw).findings` / `propose: (raw) => interpret(raw).proposals`.
That is what lets a proposal carry the id of the finding beside it without either side
rebuilding the other's claim string — the finding id is derived from that string, so two
copies of it are two ids that diverge the first time one is edited.

The orchestrator checks three things rather than trusting them: the kind must be a real
`EntityKind`; `fromFindingId` must name a finding *this run* produced (anything else is
dropped and logged, because a candidate without visible evidence cannot be reviewed); and
anything already an `Entity` is skipped. Registration throws if `propose` exists with an
empty `produces`.

Account proposals are always built as `` `${siteOrigin(url)}/${handle}` `` — the same
folded origin that goes into `Finding.source` — so a sherlock proposal and a maigret
proposal about one site converge on one candidate carrying two proposals, and the view's
`independentSources` correctly reports **1**.

### `secretOptions` — inputs that must not survive the run

`hibp-passwords` takes a live password. Its own `run()` never puts it in the envelope, but
that is a property of one author on one afternoon. Declaring the key makes the orchestrator
scrub the value — **and its SHA-1, in both cases** — out of the raw body, the stderr, the
command line and the job's error message before any of them is written or shown, leaving
`[redacted: never written to disk]` in its place. The hash is included because a full SHA-1
of a human-chosen password is an offline cracking job rather than a secret, which is the
exact property the k-anonymity design exists to provide. A test drives a deliberately leaky
adapter and greps every byte of the case folder.

The scrub runs **before `parse()`**, which is load-bearing rather than incidental: `parse`
is pure and sees nothing but that object, so a parser physically cannot put a secret into a
claim. Findings inherit the guarantee from the structure instead of from every parser
author remembering it.

The replacement is a blind substring swap and therefore over-redacts: testing the string
`password` rewrites the recorded URL as `https://api.pwned[redacted…]s.com/range/5BAA6`.
That error direction is chosen the same way `support/sources.ts` chooses its folding — a
mangled URL is visible, self-describing and recoverable; a leaked password is permanent.

> **Found by auditing a live run, not by reading the code.** `hibp-passwords` used to
> persist the whole range response, which looks obviously safe: 2,145 anonymous suffixes is
> the entire point of k-anonymity. But the finding states the occurrence count, that count
> is unique within the bucket, and count + bucket + prefix is the complete SHA-1. The case
> folder was an offline cracking target while the adapter's header comment claimed it was
> not. The capture now keeps the status, the prefix and the bucket size and drops the
> suffix list — the one place in this app where "raw output is permanent" is bent twice,
> and the only capture that is free to re-derive by re-running the query.

### `AdapterContext`

Adapters never import `fs`, `net` or `child_process`. They get:

- `spawn(file, { args, cwd, env, timeoutMs, stdin, onStdout, onStderr })` — timeout,
  **process-tree kill**, output capping and cancellation all handled. Never rejects: a
  missing binary comes back as `spawnError` with `exitCode: null`, because that is a normal
  condition in a hand-assembled toolbelt. `onStdout` receives each chunk verbatim as it
  arrives — not line-buffered, because a progress bar redrawn with `\r` never emits a
  newline and a line-buffered handler would sit silent for a whole minute. It also sees
  output past `maxOutputBytes`: the cap protects the capture, not the reader. A throwing
  handler is caught and ignored, so a progress bug cannot kill a working run.
- `signal: AbortSignal` — honour it. Cancellation is a user-facing feature.
- `progress({ pct, note, done, total, current, hits })` — shown on the job row.
  **Structured, and none of it may be invented.** `done`/`total` are the tool's own
  counter, `current` is the unit being worked on, `hits` is what the tool has announced
  (not findings, which exist only after `parse`). An adapter that cannot count reports
  nothing and the UI shows an indeterminate rule, which is the honest rendering of "no
  idea". `note` survives as the last resort for prose the fields cannot carry.
  `adapters/support/progress.ts` has the scanner both username sweeps use.
- `log(level, message, data?)`, `now()`, `caseDir`, `toolkitRoot`, `config`, `timeoutMs`.

### Adding an adapter

1. Create `src/main/adapters/<tool>.ts` exporting an `Adapter`.
2. Fill in all six `doc` fields properly.
3. Add it to `BUILT_IN` in `src/main/adapters/index.ts`.
4. Config overrides live under `config.adapters['<tool>']`:
   `enabled`, `concurrency`, `minIntervalMs`, `timeoutMs`, `bin`, `options`.
   API keys go in `options`. **There is no `.env` file in this project** — a global
   permission hook freezes agents for hours on any `.env*` path.

---

## 4a. The adapters

Sixteen registered: `echo` (the self-test), eight wrappers around the Phase 0 toolbelt
in the toolkit root (`toolkitRoot` in config; auto-detected, see the README), and seven native ones that need no external tool at all. None
requires a paid key.

The three newest — `websearch`, `dorks` and `archive-today` — close the gap identified in the project strategy notes
diagnosed: **every other adapter takes a username, an email, a domain or a file, and not
one takes a person.** A name seed therefore changed nothing about what got queried. For a
human being a search over `"name" + town` / `"name" + school` / `"name" + handle` is the
primary technique and a username sweep is the supporting one; the toolbelt had that
backwards.

| Adapter | Accepts | Discovers | Network | Emits `source` as | What it is for |
|---|---|---|---|---|---|
| `maigret` | username | account, person, location, organisation, image, email | yes | the site's domain | Username sweep **with profile scraping** — real names, employers, account ages, follower counts. The deep one. |
| `sherlock` | username | account | yes | the site's domain | Username sweep, fast and plain. Cleanest exit codes; a URL and a status, nothing more. |
| `blackbird` | username, email | account, image | yes | the site's domain | Widest catalogue (716 sites / ~35 s), and the only one that takes an email. Requires *both* a status code and a body marker to call a hit. |
| `holehe` | email | account, phone, email | yes | the site's domain | Which sites have an account for an address, read out of password-reset and registration responses. |
| `theharvester` | domain | email, domain, ipaddr, person | yes | the aggregator's host | Emails, hosts and IPs for a domain, from search engines, CT logs and passive DNS. Emits one finding per *source execution*. |
| `subfinder` | domain | domain | yes | the aggregator's host | Subdomains from ~30 passive datasets. No traffic to the target. 24,948 results for `example.com` with no keys. |
| `exiftool` | image | location, person, organisation, image | **no** | `file:<name>` | Every metadata block in a local file: GPS, capture time, camera serial, editing history. |
| `gallery-dl` | image, account | image, account, username, location | yes | the site's domain | Resolves a gallery/profile URL into its files and the site's metadata, in simulate mode — downloads nothing. |
| `wayback` | domain, account, image | domain | yes | `web.archive.org` | The Internet Archive CDX index. The only adapter that can show a previous state of anything. |
| `reddit-profile` | username, account | account, location | yes | `reddit.com` | Reddit's own JSON, then local analysis: hour histogram, inferred time zone, subreddit and word distributions. |
| `hibp-passwords` | email, username, person, account | — | yes | `api.pwnedpasswords.com` | Pwned Passwords by k-anonymity. Five hex characters leave the machine; nothing else. |
| `pattern-timezone` | most kinds | — | **no** | `local:pattern-timezone` | Re-analyses timestamps already in the case folder. Makes no requests at all. |
| `websearch` | person, username, email, domain | account, domain | yes | the **engine's** host | The only adapter that can act on a name. Welds the subject to every other seed in the case and asks a search engine each combination. |
| `dorks` | person, username, email, domain, account, organisation, phone | account, domain | yes | the engine's host, or `local:dorks` | Prepared search operators (`site:`, `filetype:`, `inurl:`, `intitle:`) with the mechanism written beside each. Runs a few, hands over the rest as URLs to open. |
| `archive-today` | domain, account, image | — | yes | `archive.today` | The Memento TimeMap of the other archive — the one that holds social media and deleted posts, because it saves what a person clicked rather than what a crawler reached. |

### Rules the whole set follows

- **`PYTHONIOENCODING=utf-8` on every Python spawn.** Maigret prints a `♥` in a banner
  before doing any work and dies on cp1252 without it. `osintEnv()` in
  `adapters/support/toolkit.ts` sets it; nothing spawns a Python process any other way.
- **Success is never read off the exit code.** Sherlock, Maigret and theHarvester all exit
  `0` on zero results, and theHarvester exits `0` when every source failed. `ok` is decided
  by whether a parseable artifact exists, and per-source telemetry is turned into findings
  where the tool provides it.
- **`Finding.source` is the site or dataset, never the tool.** Maigret's
  `https://github.com/x`, Sherlock's `https://www.github.com/x` and Blackbird's
  `https://api.github.com/users/x` all emit `github.com`, so the confidence rules see one
  source and refuse to corroborate. `support/sources.ts` does the folding and errs towards
  folding: a missed promotion is recoverable, a fabricated one is not.
- **A search result's source is the engine, never the page.** `websearch` and `dorks`
  record `duckduckgo.com`, not `github.com`, for a hit about `github.com/x` — because
  nothing fetched that page. Recording the result's host would let a stale index entry
  corroborate a live probe of the same profile, which is precisely the fabricated
  agreement `support/sources.ts` exists to prevent. Two different *engines* returning one
  URL is real corroboration and still works.
- **A refusal is never rendered as an absence.** DuckDuckGo serves its CAPTCHA with
  **HTTP 202**, so a parser that trusts a 2xx reports "no results" for a search that never
  happened. Both search adapters detect it from the body, strike the whole host off for the
  rest of the run, and emit a finding saying the engine refused *this client*.
- **Results are checked against the operators the query used.** An engine that does not
  support `site:` or a quoted phrase drops it silently and answers a broader question at a
  normal status code. The one public SearXNG instance that answered a JSON query searched
  only the first word: `"John Smith" Chicago` came back as ten results about John the
  Apostle. `complianceOf()` catches that class, reports it, and keeps those hits out of the
  candidate queue — a silently rewritten query is more dangerous than a refusal, because it
  looks like an answer.
- **Derived claims use a `local:<adapter>` source.** Run summaries, histograms and
  inferences can never be counted as one of the two independent sources corroboration
  needs — analysis must not be able to promote itself.
- **Negative and unresolved results are distinguished.** "The site said no" and "the site
  refused to answer" are different facts; a rate-limited holehe row is reported as
  unchecked, never as absent.
- **Progress is the tool's own count or nothing.** maigret's `--no-progressbar` is off by
  default now, because that bar is the only place it states how many of the 38 (or 3000)
  sites it has finished; sherlock's `--print-all` gives one line per site, which is a
  count but never a denominator, so its job row shows `probing 247 sites` with an
  indeterminate rule rather than a percentage of a number nobody printed.

### The run envelope

Every adapter's raw output is one JSON document — `support/envelope.ts` — holding the
tool's artifact bytes *verbatim* alongside the exact command line, exit code, stdout,
stderr and collection notes. It exists because five of the eight CLI tools write their
structured output to a file whose name they choose, and `parse()` must stay pure: a
parser fixed next month has to be able to re-derive everything from a capture made today,
with nothing re-run. `parse()` therefore reads the envelope out of `raw.stdout` and never
touches the filesystem.

Three tools (sherlock, holehe, blackbird) name their own output files with embedded
timestamps, so each run gets an empty scratch directory at
`cases/<id>/.work/<adapter>-<ulid>/`, which is removed when the run finishes. Blackbird is
the exception: it must run with its clone as the working directory and keeps its own copy
under `blackbird/results/`, which this app reads but does not delete.

### Per-adapter `options`

All optional; every one has a working default. Set them under
`config.adapters['<id>'].options` in `config/local.config.json`, or pass them per run.

| Adapter | Options |
|---|---|
| `maigret` | `topSites` (50), `allSites`, `sites[]`, `tags[]`, `siteTimeoutSeconds` (10), `connections` (20), `retries` (1), `recursion`, `extracting`, `progressBar` (true) |
| `sherlock` | `sites[]`, `siteTimeoutSeconds` (15), `nsfw`, `local`, `ignoreExclusions` |
| `blackbird` | `maxConcurrentRequests` (15), `siteTimeoutSeconds` (15), `updateSites` (false), `excludeNsfw` (true), `filter` |
| `holehe` | `siteTimeoutSeconds` (10), `noPasswordRecovery`, `onlyUsed` |
| `theharvester` | `sources[]` (the eight keyless ones), `limit` (200), `sourceWorkers` (3) |
| `subfinder` | `sources[]`, `excludeSources[]`, `allSources`, `maxResultsPerSource` (0), `sourceTimeoutSeconds` (30), `maxMinutes` (5) |
| `exiftool` | `groupNames` |
| `gallery-dl` | `url`, `range` (`1-100`), `cookiesFile`, `retries` (1) |
| `wayback` | `url`, `matchType`, `collapse`, `limit` (500), `from`, `to`, `filter`, `userAgent` |
| `reddit-profile` | `handle`, `maxPages` (3), `perPage` (100), `requestGapMs` (1200), `userAgent` |
| `hibp-passwords` | `password` **or** `sha1` — required, and never stored |
| `pattern-timezone` | `timestamps[]`, `allEntities`, `maxCaptures` (200), `maxCaptureBytes` |
| `websearch` | `backends[]` (`ddg-html`, `ddg-lite`, `wiby`), `instances[]`, `queries[]`, `maxQueries` (6), `maxResultsPerQuery` (10), `requestGapMs` (6000), `maxRetries` (1), `userAgent` |
| `dorks` | `mode` (`both`), `engine` (`google`), `dorks[]`, `maxRun` (4), `backends[]`, `instances[]`, `requestGapMs` (6000) |
| `archive-today` | `url`, `mirrors[]`, `requestGapMs` (2000), `userAgent` |

`RunJobRequest` carries `options` and `timeoutMs` and `service.runJob` threads them into
`EnqueueRequest`, so every knob above is reachable per run. Both are sanitised at that
boundary — the renderer is the only untrusted caller in the app — by
`sanitiseRunRequest()`: `options` must be a plain object of JSON values with no
prototype-polluting key, and `timeoutMs` must be finite and between 1 s and 2 h. A `NaN`
deadline would otherwise turn the orchestrator's watchdog into `NaN` and the run would
never be killed at all.

`hibp-passwords` is the one adapter with a UI form (`RunOptions.tsx`), because its input
is a live password that must be typed at the moment of use and forgotten immediately
after. The form is inline disclosure under the launcher, the field is `type="password"`,
and the k-anonymity mechanism is rendered beside it with the **live SHA-1 prefix computed
from what has been typed** — the five characters on screen are literally the entire
request. See `secretOptions` above for what stops the value reaching disk.

---

## 5. Orchestrator — `src/main/orchestrator.ts`

`enqueue(req)` returns `{ job, whenSettled }` immediately.

- **Per-adapter concurrency caps** matter more than the global cap: without them a
  3000-site Maigret sweep occupies every slot and nothing else in the case starts. The
  queue is scanned in order but entries blocked by their *own* adapter's cap are skipped,
  so a saturated adapter never head-of-line-blocks a different one.
- **Rate limiting** via `minIntervalMs`. When a job is blocked only by a rate limit, a
  timer is armed for exactly when it becomes eligible rather than polling.
- **Timeouts**: per-job deadline, then `taskkill /T /F` on Windows (a `maigret.exe` shim
  spawns `python.exe`; killing the shim leaves Python running). A watchdog at
  `timeout + 5 s` aborts even an adapter that ignores its signal and never spawns a child.
- **Cancellation**: `cancel(jobId)` and `cancelCase(caseId)`, both killing the child tree.
- **Progress** pushed over IPC as `event:job:update` — never polled.

Job states: `queued | running | done | failed | cancelled | timeout`.

### Running many at once — `planRuns` / `runPlan`

Every run used to be one adapter against one entity, which made a case with five seeds and
six applicable tools thirty deliberate clicks in an order the operator had to hold in his
head. `service.planRuns(req)` answers the whole question in one shape: an omitted or empty
`entityIds` means every entity, an omitted or empty `adapterIds` means every adapter fit to
run unattended, and the four things the launcher offers — run everything, one adapter
across every entity it accepts, one entity across every adapter, and the intersection of
two selections — are that call with different halves left blank.

It is **pure**: nothing is queued by asking. `runPlan` enqueues the result one entry at a
time and never awaits, because the orchestrator already owns the caps and the rate limits;
throttling here as well would be a second, disagreeing scheduler.

**The lists that are not `runs` carry the honest half.** An adapter that does not accept an
entity's kind has not failed — it cannot answer that question — so `idleEntities`,
`idleAdapters` and `excluded` each come back with the reason written next to them, and
`alreadyQueued` names pairs already in flight so a second click cannot duplicate a probe.
`attributionOnlyKind()` in `shared/ipc.ts` supplies the *design* reason for the kinds where
the absence is deliberate: a name, a place and an organisation are matched against text
other adapters read off profiles rather than queried. This matters because pointing "run
everything" at a name correctly enqueues nothing, and a silent nothing is indistinguishable
from a bug.

Two adapters are skipped when the caller did not name them: `echo`, which accepts every
kind and asserts nothing, and any adapter with `secretOptions` — the latter is refused even
when named, because its input has to be typed at the moment of use and a batch has nowhere
to type it. Naming an adapter is otherwise an instruction, not something the planner vetoes.

In the UI, one active run keeps the full `RunProgress` card; two or more collapse into
`RunQueue`, one 30px row per job under an aggregate line with a real denominator. The
"wave" it counts over is derived — every job queued at or after the oldest one still in
flight — so it needs nothing stored and survives the window being closed mid-run.

Failure policy: **a job never throws out of the orchestrator.** Everything becomes a
terminal state with an `error` string, because in this domain failure is the common case
and is itself informative. `ok: false` is not exceptional — "Maigret was blocked by
Cloudflare" is a finding about the world.

After findings are written, `propose()` runs and its results become `EntityCandidate`
records. **A failure there never fails the job** — the findings are already on disk and a
proposal is re-derivable from the raw capture by definition, so a throwing `propose` is a
`job:log` at error level naming the raw path.

Raw output is persisted **before** parsing and **regardless of outcome**. When a run
throws, a `RawResult` is synthesised so the failure is still recorded — "this tool
crashes on this input" is a durable fact about the tool, and losing it means
rediscovering it every time. When a parser throws, the job fails with a message naming
the raw path and saying it can be re-parsed.

> **Timers are deliberately not `unref`'d.** The pump timer owns the promise of every
> rate-limited job still queued; unref'ing it lets Node exit with work silently
> abandoned. Invisible under Electron (the app holds the loop) and fatal anywhere else —
> it was a real bug caught by the test suite.

---

## 6. UI shell

`src/renderer/` — React 19, no CSS framework, English throughout,
`contextIsolation: true`, `nodeIntegration: false`, and a CSP that blocks all remote
loads. **`DESIGN.md` ("The Darkroom") is the authority for everything visual**; the design
pass has landed and the placeholder tokens are gone.

Three zones: a collapsible left nav (**Cases / Self-Audit / Range / Settings**), the main
content, and a right **context panel** holding the adapter `doc` block. The panel is a
persistent margin annotation, never a modal — it is on screen from the first frame
because the product's premise is understanding the mechanism. Both side zones fold on
their own below 1180px and 980px and stop folding once the operator touches either
toggle. Self-Audit and Range are honest empty states describing what goes there.

Between the seeds panel and the findings table sits the **review queue**
(`Candidates.tsx`), shown only once a case has something in it: each row is a discovered
thing that is *not* in the case, with the finding that proposed it, its source, and that
finding's confidence, expandable inline. Promote and Dismiss are per row; "Promote *n*
confirmed" is the only bulk action, and it is safe precisely because `confirmed` cannot be
reached without a human and a written note. There is deliberately no "promote all" and no
bulk action on `corroborated` — two tools agreeing about an anti-bot redirect is the
failure mode, not the guard.

Findings are a 30px-row table on hairlines. Confidence is carried by **lightness and
font-weight, never hue**, so it survives greyscale and every form of colour blindness:
the `--ink-latent / developing / developed / fixed` tokens, weights 400/450/600/400, and a
glyph that is a print developing. Promotion transitions colour and the variable font's
weight axis over 280ms. Selecting a row fills the context panel with the finding, its raw
output on demand, and the producing adapter's six doc fields.

### The design system

```
src/renderer/src/styles/    tokens.css is the only file that may contain a colour
src/renderer/src/assets/    Geist Sans + Geist Mono, variable woff2, OFL, vendored
```

Two scripts keep it honest, and both are wired into `npm run design`:

- **`scripts/contrast.mjs`** parses `tokens.css` directly, converts every OKLCH
  declaration through OKLab to sRGB, and asserts WCAG ratios for all 63 pairs the app can
  produce — including a `FORBIDDEN` list that asserts certain pairs still *fail*, so a
  usage rule is measured rather than remembered. Exits non-zero on any regression.
- **`scripts/design-lint.mjs`** fails on a literal colour outside `tokens.css`, a font
  stack outside `fonts.css`, any rule that reaches for `--font-mono` without being listed
  in `MONO_SELECTORS` (that allowlist is what makes the monospace ration enforceable), and
  the project's banned patterns.

Two measured deviations from DESIGN.md, both documented at the token:

- `--ink-fixed` is L 0.61, not 0.52. At 0.52 it measures 3.52:1 on `--bg` — under the
  4.5:1 floor and under `--ink-subtle`, which the same document calls the floor nothing
  dimmer may cross. "Discarded" is carried by the strike-through and by `--row-refuted`
  sinking the row instead.
- `--ink-subtle` is canvas-only. It clears 4.5:1 on `--bg` (4.53) and `--bg-sunken` (4.69)
  but measures 4.14 on `--surface`, so panels use `--ink-muted`.

DESIGN.md's ramp table gives `corroborated` "an amber marker"; that is overruled by the
same document's accent discipline, which reserves amber for a live run. The glyph marks
it instead.

### Driving the renderer outside Electron

`src/renderer/src/lib/fixtures.ts` installs a stand-in `window.osint` when the renderer is
opened in a plain browser, behind `import.meta.env.DEV && !window.osint`, so it is dead
code in a production build and never loads under Electron. It exists so the UI can be
screenshotted, measured and driven at arbitrary viewport sizes; `?run=1` simulates a
maigret sweep so the live states can be captured. **It is not an adapter registry and
nothing in it is real.**

### Window and tray

Per DECISIONS.md #7: **no global hotkey**. The tray icon is the app; double-click opens a
normal window; closing hides to tray.

**Hiding destroys the `BrowserWindow`** rather than hiding it. A hidden-but-alive Chromium
renderer is ~120 MB doing nothing; destroying it takes idle down to roughly the main
process alone, and the window rebuilds in well under a second.

> Consequence for anyone adding features: **renderer state does not survive a close.**
> Anything worth keeping belongs in the case files, which is where it belongs anyway.

---

## 7. Config

`config/local.config.json`, gitignored, documented by the committed
`config/example.config.json`. **Non-dotted on purpose** — see DECISIONS.md.

Every key is optional; a fresh clone runs on defaults. Unknown keys are ignored and
`$comment` keys are stripped, so the example file stays self-documenting. A broken config
is a warning surfaced in Settings, never a failure to start — you would otherwise have no
UI in which to fix it.

---

## 8. Commands

```
npm run dev         electron-vite dev (main + preload watched, renderer on :5173)
npm run build       typecheck, then build all three targets
npm run typecheck   tsc over node and web projects, strict
npm test            esbuild-bundle test/index.ts and run it in plain Node
npm run design      design:lint then design:contrast, both exit non-zero on a regression
npm run design:lint     literal colours, font stacks, the monospace ration, the bans
npm run design:contrast measured WCAG ratios for every pair tokens.css can produce
npm run dist        icons, build, then the NSIS installer and the portable exe
npm run dist:dir    the unpacked app only, no installer — much faster for a smoke check
npm run icons       regenerate build/ and resources/ icons from the aperture geometry
npm run icons:preview   the above, plus magnified 16-48px sheets on both taskbar greys
```

`better-sqlite3` v13 ships **N-API prebuilds**, so the same binary loads under Node and
Electron with no `electron-rebuild` step. That is why the test suite can exercise the real
database in plain Node.

---

## 8a. Packaging

`electron-builder.yml` produces two artifacts into `release/`, both x64:

| Artifact | What it is |
|---|---|
| `OSINT Workbench <v> Setup.exe` | NSIS installer. **Per-user**, so no UAC prompt; installs to `%LOCALAPPDATA%\Programs\OSINT Workbench`, creates a desktop shortcut and a Start-menu entry. |
| `OSINT Workbench <v> Portable.exe` | One self-extracting exe. Runs from anywhere and shares the same data root. |

`files` is an **allowlist** (`out/**` plus `package.json`), not a list of exclusions. An
exclusion list has to be right about everything in the repo and stops being right the
moment anything new appears — which it did: a stray Chromium profile directory left behind
by a dev run held two files open and every build died with a bare `EBUSY` and no filename.
Production `node_modules` are collected separately by electron-builder, so `better-sqlite3`
still ships regardless.

### The data root

**The packaged app does not keep data in `%APPDATA%`.** Raw tool output is permanent and
append-only, a maigret sweep over 3,000 sites is a large capture, and one self-audit run
creates five case folders and is meant to be re-run — so the directory grows without
bound and does not belong on the system drive.

`src/main/index.ts` resolves the root before `whenReady` and calls
`app.setPath('userData', …)`, so Chromium's caches follow it too. The default is
`Documents/OSINT Workbench`, and Settings can repoint it through a directory picker.

The location has to be known before any config inside it can be read, so a **pointer** —
`data-location.json`, a few hundred bytes naming the real directory — sits at the OS
userData path. **It is the only thing this app puts in the OS profile.** Measured on a clean install:
268 bytes there, everything else (cases, `data/index.db`, config, every Chromium cache) in
the data root. The startup log prints all of it, because "the config says X" and "it wrote
to X" are different claims.

Uninstalling never touches the data root: it is nowhere near the install directory, and
`deleteAppDataOnUninstall: false` keeps NSIS away from the pointer as well.

### The icon

A **camera aperture** — six blades on a hexagonal opening, in the DESIGN.md oxblood and
safelight amber. Not a magnifying glass: every OSINT tool uses one, and an icon you
recognise your own tool by has to not look like the other forty.

`scripts/make-icons.mjs` holds the geometry as a hand-written table and emits both
`build/icon.svg` and every raster from it, so the vector source and the PNGs cannot drift.
No image dependency — a polygon scan-converter, a PNG writer and an ICO packer are about
150 lines of `node:zlib` and arithmetic.

Two size variants, because 16px is the real constraint: below 24px the opening grows
(0.168 → 0.205 of the canvas) and the blade seams and housing ring are dropped, since a
0.3px seam is not detail, it is grey mud spread over the ring. What survives at 16px is
the silhouette: dark tile, oxblood ring, amber centre.

### Code signing

**There is no certificate, and none is faked.** Both exes report `NotSigned`.

A build produced locally has no Mark-of-the-Web, so Windows runs it without comment — that
is why a local `Setup.exe` installs with no prompt at all. **Copy it to another machine,
or download it, and it acquires MOTW; SmartScreen then shows "Windows protected your PC"
and hides the run button behind "More info" → "Run anyway."** The publisher will read
"Unknown publisher". That is accurate — nobody has vouched for this binary — and the only
real fix is an EV certificate, which costs more per year than this project is worth.

To clear MOTW on a copy you trust:
`Unblock-File "OSINT Workbench <v> Setup.exe"`

### Disk

Optional: redirect big downloads with `ELECTRON_CACHE` (must be exported in the shell —
npm 11 rejects unknown `.npmrc` keys) or `OSINT_CACHE_DIR` for `npm run dist`. Test scratch
goes to `.tmp-test/` inside the repo, never the system temp dir.

If `npm run dev` fails with `Error: Electron uninstall`, the binary was never downloaded:
set `ELECTRON_CACHE` and run `node node_modules/electron/install.js`.

---

## 9. What is deliberately not here

- **No automatic entity creation.** Discovery is a proposal; promotion is a human act. See
  `EntityCandidate` in §2 for why.
- **No LLM calls, ever.** No API budget exists (DECISIONS.md). Analysis is deterministic
  and local, or it is something Claude Code does from outside via a future MCP server.
- **No `ghunt` and no `amass`.** Both were cut in Phase 0 with reasons: ghunt needs an
  authenticated Google session before any lookup, and amass v5 removed JSON output and
  returned nothing that subfinder did not return better.
- **No graph *view*, no report exporter, no Self-Audit wizard, no Range.** Phases 3–5. The
  graph itself now grows, one reviewed promotion at a time; nothing draws it yet.
- **No auto-update.** There is no update server and no code signing certificate, so an
  updater would be a channel with nothing on the other end. Reinstalling over the top
  works and keeps the data root.
