# OSINT Workbench

A local-first desktop app (Electron, React, TypeScript) for open-source investigation that
shows its work. It runs a set of well-known OSINT tools, merges everything they find into one
entity graph per case, and scores every claim with a confidence level that is deliberately
stingy: a username that exists on a site is **not** treated as "this is the same person".

Everything stays on your machine. Cases are plain files on disk (the files are the truth;
the SQLite database is a rebuildable index). The app never calls an LLM and needs no paid
service or API key.

## What it does

**Tool orchestration.** It wraps these as adapters, each with a built-in explanation of how it
works, what it is good and bad at, and how it produces false positives:

- [Maigret](https://github.com/soxoj/maigret), [Sherlock](https://github.com/sherlock-project/sherlock) and [Blackbird](https://github.com/p1ngul1n0/blackbird): username sweeps across thousands of sites
- [holehe](https://github.com/megadose/holehe): which sites have an account for an email address
- [theHarvester](https://github.com/laramies/theHarvester) and [subfinder](https://github.com/projectdiscovery/subfinder): domains, subdomains, associated emails
- [ExifTool](https://exiftool.org/): metadata in photos, video and documents
- [gallery-dl](https://github.com/mikf/gallery-dl): profile and media metadata from supported sites

It also ships native adapters that need no external tool: Wayback Machine and archive.today
lookups, search-engine dork building and querying, Pwned Passwords (k-anonymity range API),
reverse-image search through a real browser, a Reddit behavioural profile, and
posting-time (timezone) analysis.

**One entity graph, honest confidence.** Results from all adapters are merged into entities
(usernames, accounts, emails, people, places, images) with provenance for every link. Each
finding carries a confidence level (`unverified`, `corroborated`, `confirmed`, `refuted`),
and a block, captcha or rate limit is recorded as "unchecked", never as "no account found".
See `ARCHITECTURE.md` for the model and `DECISIONS.md` for why.

## Three modes

1. **Self-audit.** Feed in what you know about yourself (handles, emails, name, city) and see
   what a stranger could find, at increasing adversary knowledge levels (L0: one username,
   up to L4: phone, city, school and family names). The interesting output is the *delta*:
   which single piece of information unlocks the most. It also generates data-subject
   (GDPR) request letters and includes a metadata scrubber view for your own photos.
2. **Case work.** Create a case, state the basis for it (self, consent, public entity,
   CTF/fictional), add seeds, run adapters, review candidates, prune or confirm links, and
   export a report. Raw tool output is stored append-only next to the case.
3. **Geolocation training range.** A built-in practice range: guess where a street-level
   image was taken, then see which clues were available (driving side, script, plates,
   bollards, vegetation...) with a written atlas of those clues. Imagery comes from
   [Panoramax](https://panoramax.fr/); nothing is uploaded.

## Install

Requirements: Node.js 22+, npm 11+, Git. Windows is the primary target (the adapters look for
`.exe` shims and `Scripts\` folders; Linux and macOS paths such as `venv/bin/...` are also
probed but less tested).

```bash
git clone <this-repo-url> osint-workbench
cd osint-workbench
npm ci
npm run dev        # run the app from source
npm test           # unit and integration tests (no network, no external tools needed)
npm run build      # typecheck + production bundle
npm run dist       # Windows installer into release/ (unsigned)
```

The app starts and works with none of the external tools installed. Adapters whose tool is
missing show up as unavailable, with the exact install hint.

### Setting up the external tools

All CLI tools are expected under one **toolkit root**. It is found in this order:

1. `toolkitRoot` in `config/local.config.json`
2. the `OSINT_TOOLKIT_ROOT` environment variable
3. `./osint-kit`, `./tools/osint-kit`, then `~/osint-kit`

Layout (only create what you want to use):

```
<toolkitRoot>/
  venv/            Python 3.12 venv:  pip install maigret sherlock-project holehe gallery-dl
  venv-bb/         separate venv for Blackbird (it pins old package versions)
  blackbird/       git clone of Blackbird
  venv-th/         separate venv, Python 3.14+: pip install git+https://github.com/laramies/theHarvester.git
  bin/             exiftool.exe (+ exiftool_files/), subfinder.exe
  data/wmn-data.json   WhatsMyName dataset (optional; enables match classification)
```

Create a config file to override anything (it is gitignored, and deliberately not a dotfile):

```bash
cp config/example.config.json config/local.config.json
```

Every adapter's binary can also be pinned with `adapters.<id>.bin`. Optional extras:
`OSINT_PLAYWRIGHT_MODULE` / `PLAYWRIGHT_BROWSERS_PATH` for reverse-image search,
`OSINT_OPSEC_KIT_ROOT` (or `opsecKitRoot`) for the Scrub view's external scrubber checkout,
`OSINT_CACHE_DIR` to move build caches. Case data lives in `cases/` when running from source;
the packaged app defaults to `Documents/OSINT Workbench` and lets you change it in Settings.

## Known limitation: false positives on common usernames

Username sweeps are the weakest part, and it is worth being plain about it. Tools like Maigret
and Sherlock report that *an account with that name exists*, not that *it belongs to your
subject*. For a common handle, most hits belong to strangers. The workbench does not hide
this: hits start `unverified`, matcher quality is recorded per site, a ranking step scores
candidates against the other facts you supplied, and nothing is promoted without independent
corroboration. But the filtering is still the main area for improvement. Expect to review
candidates by hand for any non-unique handle, and treat the ranking as a triage aid.

## Ethics and law

Only investigate yourself, or people who have given consent, or public entities and
fictional/CTF targets. Do not use this to stalk, harass, or profile private individuals. Laws
about collecting and processing personal data (GDPR and its national equivalents, computer
misuse and terms-of-service rules) differ by country and by purpose; you are responsible for
following the ones that apply to you. Each case records its basis. The app performs no
hacking, no credential attacks and no bulk surveillance, and these are out of scope.

## Project layout

```
src/main/       Electron main process: adapters, orchestrator, case store, SQLite index, exports
src/renderer/   React UI
src/shared/     types and pure logic shared by both (confidence, ranking, matching, names)
test/           test suite and fixtures (synthetic or from public figures)
scripts/        build, icon, contrast and design-lint scripts
resources/      bundled geolocation range data
```

## License

MIT, see `LICENSE`. External tools and data keep their own licenses, see
`THIRD-PARTY-NOTICES.md`.
