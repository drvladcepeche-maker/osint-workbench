# Design decisions

These are settled. Read this before changing the architecture; reopen a decision only with a reason.

---

## Product identity

The workbench is a **learning instrument first and a tool second**. A feature that produces a correct answer without teaching anything is worth less than one that shows its work.

Priorities, in order:
1. It is interesting to use and read, not merely functional.
2. It teaches the craft: mechanisms, not buttons.
3. It makes honest self-audits possible (what can a stranger find about me?).

---

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Shell | **Electron** + React + TypeScript |
| 2 | Case storage | Plain files under `cases/` (configurable data root). Files are truth, SQLite is a rebuildable index. **No encryption** (use disk encryption) |
| 3 | Self-audit | Everything publicly reachable, maximal depth. No hacking, no credential attacks. The app records consent per case |
| 4 | Global hotkey | Not wanted. Tray icon; double-click opens a normal window |
| 5 | UI language | English. Source material in other languages is shown as found, never translated |
| 6 | Paid services | **None.** Free tiers only; keys, when a free source needs one, go under `adapters.<id>.options` |
| 7 | Correlator | Built in (no SpiderFoot dependency) |
| 8 | Playwright | Yes, for reverse-image search and clean-view browsing, installed outside the project |
| 9 | Geolocation training | Yes, as a built-in range (see "Modes" in the README), with many techniques explained |
| 10 | Scoring | Basic and non-nagging. No streak or guilt mechanics |
| 11 | Real-world casework | The app is not built for sensitive real-world casework (for example missing-persons volunteering) |
| 12 | Sock puppets | Minimal version only (a clean-view browser profile); see below |
| 13 | Docs format | Markdown for working files |

---

## Hard constraints

### The app never calls an LLM

- **No outbound LLM calls from the app. Ever.** No "AI summary" buttons, no auto-profiling.
- Integration runs the other direction: an assistant such as Claude Code can drive the app from outside.
- Blackbird's "AI profiling" layer is disabled, because it needs a key.
- Any analysis feature must be **deterministic and local** (histograms, regex, hashing, statistics).

### Explain everything is a first-class feature

Every adapter, module, and technique carries a mandatory `doc` object:

```ts
doc: {
  what:        string   // one line
  how:         string   // the actual mechanism, e.g. "sends a password-reset
                        // request and reads the difference in the response"
  why:         string   // why that mechanism reveals anything
  betterAt:    string   // when to reach for this instead of the alternatives
  worseAt:     string   // its failure modes and blind spots
  falsePositives: string // how it lies to you
}
```

It is surfaced as an info panel next to every result. **An adapter without a filled-in `doc` does not ship.**

### No `.env` files

Config goes in a **non-dotted** file: `config/local.config.json` (gitignored), documented by `config/example.config.json`. Some tooling environments block `.env*` paths outright, so this project has no `.env` of any kind.

### Honest confidence

A hit is not an identity. Every finding carries a confidence level, a matcher classification and its provenance. A refusal, a block or a rate limit is reported as "unchecked", never as "no account". See ARCHITECTURE.md.

---

## Sock puppets

Full persona management (identity sets, burner emails, consistent fake histories) is for sustained investigations against organisations, and is out of scope.

**Decision: build the 10% that matters.** A **clean-view browser profile** is an isolated, logged-out Playwright context with no cookies and no session. Its purpose is to *see what a total stranger sees*, which is exactly the question the self-audit asks. Logged in as yourself, every platform shows a friendlier version of your own footprint and the audit lies to you.

---

## Self-audit: adversary knowledge levels

The audit lets you feed varying amounts of seed data and watch what changes.

| Level | The adversary knows | Simulates |
|---|---|---|
| **L0** | One username | A stranger from one platform |
| **L1** | All known usernames | Someone who has seen you across a few communities |
| **L2** | + real name | Anyone who has met you |
| **L3** | + email addresses | Someone who has had contact with you |
| **L4** | + phone, city, school or employer, family names | A determined acquaintance |

Each level runs independently and produces its own report. **The interesting output is the delta**: which single piece of seed data unlocks the biggest jump in what is findable. That is the actionable finding, for example "reusing one username on two sites is what connects your gaming identity to your real name".

---

## Tool and technique choices

### Built as adapters

| Tool | Assessment |
|---|---|
| **ExifTool** | Metadata inspection; also useful for video tampering hints (an editor named in `Creator Tool`). `ffprobe` can be added for container analysis |
| **Wayback Machine** | CDX API, free, keyless |
| **Sherlock** | Fast username sweeps. Kept next to Maigret on purpose, because the comparison is a good "betterAt/worseAt" demonstration |
| **Maigret, Blackbird** | Deeper username sweeps, slower and more rate-limit-prone |
| **holehe** | Automates the "does an account exist for this email" check that is otherwise done by hand |
| **theHarvester, subfinder** | Domain and subdomain enumeration from passive sources |
| **gallery-dl** | Media and profile metadata from supported sites |
| **Google dorking** | A dork builder: operator templates (`site:`, `filetype:`, `intext:`), a library of useful dorks, one-click open |
| **Reddit behavioural analysis** | Own implementation (timezone histogram, keyword frequency, subreddit distribution). **Correction:** unauthenticated Reddit JSON endpoints now return HTTP 403 behind an interstitial. The adapter is kept; it reports a 403 as a refusal aimed at the client, sourced `local:reddit-profile`, and concludes nothing about the account. A block is never rendered as absence |
| **QGIS** | Optional, later: the species cross-reference method (find coordinates where two plant genera grow side by side) fits the geolocation track |

### Built as native features

- **Timezone and activity fingerprinting**: post timestamps become an hour-of-day histogram and an inferred timezone and sleep schedule. Works on public GitHub and similar sources with free keyless APIs. A strong self-audit feature, because it shows your own schedule leaking.
- **Linguistic fingerprinting**: regional dialect markers, idiom quirks, typing habits. Deterministic stylometry, no LLM.
- **Evidence log and confidence assessment**: the report exporter follows the formal structure intelligence question, scope, evidence with timestamps and archive captures, confidence assessment.
- **Search and verify**: maps onto the `unverified` to `confirmed` confidence model, made visible in the UI.

### Explicitly out of scope

- **Paid background-check sites.** They are data-laundering with fake loading animations. Never integrated; the docs say why.
- **Dark web and Tor.** Meaningful risk surface and nothing in the feature list needs it.
- **Crypto tracing.** Out of scope for v1.
- **Mass logging of messaging channels** (for example Telegram scrapers). Bulk automated processing of third parties is categorically different from looking someone up, and is not built.

---

## Environment notes

- Python **3.12** for the OSINT tool venvs (newer interpreters break several of the tools; theHarvester needs its own newer one).
- Node 22+, npm 11+.
- Go is not required: use prebuilt binaries for subfinder.
- Tool locations are configurable (see the README); nothing in the code assumes a drive letter.
