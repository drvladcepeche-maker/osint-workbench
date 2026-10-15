import type {
  AdapterInfo,
  CandidateView,
  Case,
  ConfidenceChange,
  Entity,
  Finding,
  IndexStats,
  Job,
  RemovedEntity,
  AppConfig
} from '../../../shared/types'
import { independenceKey, promote } from '../../../shared/confidence'
import type { CaseSummary, OsintApi, RunPlan } from '../../../shared/ipc'
import { idleKindReason } from '../../../shared/ipc'
import { seedField } from '../../../shared/selfaudit'
import { cleanSubject } from '../../../shared/relevance'
import {
  FIXTURE_DELTA,
  FIXTURE_LETTER,
  FIXTURE_REPORT,
  FIXTURE_RESCAN,
  FIXTURE_STATE,
  emptySeedValues
} from './selfaudit-fixture'
import {
  FIXTURE_BRIEF,
  FIXTURE_CHAINS,
  FIXTURE_ENGINE_RUN
} from './engine-fixture'

/**
 * A fixture bridge for design work. **Development only.**
 *
 * The real `window.osint` is installed by the preload script, which only exists inside
 * Electron. Opening the renderer in a plain browser — which is the only way to drive it
 * with Playwright, resize it to 1280 and 1920, force `prefers-reduced-motion`, and
 * screenshot every state including a live run — leaves `window.osint` undefined and the
 * first `cases.list()` throws.
 *
 * So this stands in, and only then: `main.tsx` imports it dynamically behind
 * `import.meta.env.DEV && !window.osint`. Vite replaces `import.meta.env.DEV` with
 * `false` in a production build, so the whole module is dead code and never reaches the
 * bundle. Inside Electron the preload has already defined `window.osint`, so even in dev
 * this never loads.
 *
 * It is NOT an adapter registry and nothing here is real. The five adapters below are
 * plausible `doc` blocks written to exercise the panel's typography at realistic length;
 * the actual adapters live in `src/main/adapters/`. `hibp-passwords` is among them only
 * because it is the one adapter with a per-run form, and that form — the k-anonymity
 * panel — has to be drivable outside Electron to be measured.
 *
 * `?run=1` starts a simulated maigret sweep so the live states — honest progress, the
 * safelight, findings streaming in — can be captured.
 */

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

const CASES: Case[] = [
  {
    id: '2026-08-30-self-audit-l0-01j9kq3f',
    name: 'Self-audit L0 — one username',
    basis: 'self',
    subjectConsent: false,
    createdAt: iso(-1000 * 60 * 60 * 26),
    notes: ''
  },
  {
    id: '2026-08-28-hackthebox-persona-01j8mm2a',
    name: 'HTB persona — sneaky_panda',
    basis: 'ctf-fictional',
    subjectConsent: false,
    createdAt: iso(-1000 * 60 * 60 * 74),
    notes: ''
  },
  {
    id: '2026-08-24-acme-dairy-ltd-01j7zz9c',
    name: 'Example dairy supplier — public register check',
    basis: 'public-entity',
    subjectConsent: false,
    createdAt: iso(-1000 * 60 * 60 * 160),
    notes: ''
  },
  /*
   * The ranking fixture. Entirely invented — a synthetic Bulgarian subject with a common
   * given name — and shaped to reproduce the situation the ranking exists for: one handle,
   * one anchor the operator supplied himself, two true positives, two profiles reading the
   * other gender, and two carrying a different personal name. No real person's details are
   * in this repository and none belong here.
   */
  {
    id: '2026-08-31-consented-common-name-01j9zzr4',
    name: 'Consented audit — a very common given name',
    basis: 'consent',
    subjectConsent: true,
    createdAt: iso(-1000 * 60 * 60 * 3),
    notes: '',
    subject: { gender: null, ageBand: '18-24', countries: ['BG'] }
  }
]

const ENTITIES: Record<string, Entity[]> = {
  [CASES[0]!.id]: [
    {
      id: 'ent_1a2b3c4d5e6f70819a2b',
      caseId: CASES[0]!.id,
      kind: 'username',
      value: 'exampleuser',
      label: 'exampleuser',
      createdAt: iso(-1000 * 60 * 60 * 26),
      seed: true,
      attrs: {}
    },
    {
      id: 'ent_2b3c4d5e6f70819a2b3c',
      caseId: CASES[0]!.id,
      kind: 'account',
      value: 'github/exampleuser',
      label: 'github/exampleuser',
      createdAt: iso(-1000 * 60 * 60 * 25),
      seed: false,
      attrs: { platform: 'github', handle: 'exampleuser' }
    },
    {
      id: 'ent_3c4d5e6f70819a2b3c4d',
      caseId: CASES[0]!.id,
      kind: 'email',
      value: 'alex.example@example.com',
      label: 'alex.example@example.com',
      createdAt: iso(-1000 * 60 * 60 * 25),
      seed: true,
      attrs: {}
    }
  ],
  [CASES[1]!.id]: [
    {
      id: 'ent_9f8e7d6c5b4a39281706',
      caseId: CASES[1]!.id,
      kind: 'username',
      value: 'sneaky_panda',
      label: 'sneaky_panda',
      createdAt: iso(-1000 * 60 * 60 * 74),
      seed: true,
      attrs: {}
    }
  ],
  [CASES[2]!.id]: [],
  [CASES[3]!.id]: [
    {
      id: 'ent_rank01a2b3c4d5e6f708',
      caseId: CASES[3]!.id,
      kind: 'username',
      value: 'krisi',
      label: 'krisi',
      createdAt: iso(-1000 * 60 * 60 * 3),
      seed: true,
      attrs: {}
    },
    {
      id: 'ent_rank02a2b3c4d5e6f708',
      caseId: CASES[3]!.id,
      kind: 'person',
      value: 'кристиян иванов',
      label: 'Кристиян Иванов',
      createdAt: iso(-1000 * 60 * 60 * 3),
      seed: true,
      attrs: {}
    },
    {
      id: 'ent_rank03a2b3c4d5e6f708',
      caseId: CASES[3]!.id,
      kind: 'account',
      value: 'steamcommunity.com/krisi_2007',
      label: 'krisi_2007 on Steam',
      createdAt: iso(-1000 * 60 * 60 * 3),
      seed: true,
      attrs: { platform: 'steamcommunity.com', handle: 'krisi_2007' }
    },
    {
      id: 'ent_rank04a2b3c4d5e6f708',
      caseId: CASES[3]!.id,
      kind: 'location',
      value: 'варна',
      label: 'Варна',
      createdAt: iso(-1000 * 60 * 60 * 3),
      seed: true,
      attrs: {}
    }
  ]
}

const raw = (n: number, bytes: number): Finding['raw'] => ({
  rawId: `raw_01J9KQ3F${n.toString().padStart(4, '0')}`,
  path: `raw/raw_01J9KQ3F${n.toString().padStart(4, '0')}.json`,
  sha256: `${n}c4f8a17e93b6205d1f7ae8c34b90d6e5127a4f0938bc2e6a5d81403f9b7c${n}e2`.slice(0, 64),
  bytes,
  mediaType: 'application/json',
  excerpt: '{"site":"github","status":"claimed","http_status":200}'
})

let nextFinding = 0
function finding(
  caseId: string,
  entityId: string,
  source: string,
  tool: string,
  claim: string,
  confidence: Finding['confidence'],
  minutesAgo: number,
  verified = false
): Finding {
  nextFinding += 1
  return {
    id: `fnd_${nextFinding.toString().padStart(4, '0')}a7c3e91b5d2f6084`,
    caseId,
    entityId,
    source,
    tool,
    claim,
    confidence,
    evidenceRef: null,
    firstSeen: iso(-1000 * 60 * minutesAgo),
    lastVerified: verified ? iso(-1000 * 60 * (minutesAgo - 30)) : null,
    raw: raw(nextFinding, 1200 + nextFinding * 831)
  }
}

const C0 = CASES[0]!.id
const E0 = 'ent_1a2b3c4d5e6f70819a2b'
const E0M = 'ent_3c4d5e6f70819a2b3c4d'

/** Tombstones, filled in as the fixture bridge removes things. Empty to start with. */
const REMOVED: Record<string, RemovedEntity[]> = {}

/**
 * The fixture's confidence log, empty until something in the browser session promotes.
 *
 * Empty rather than pre-seeded on purpose: the panel's history section only appears once a
 * finding has actually moved, so starting it empty is what makes the "before" state
 * screenshottable — and the fixture's one `confirmed` finding is there to show the *level*
 * rendering, not to imply a decision nobody made.
 */
const CONFIDENCE_LOG: Record<string, ConfidenceChange[]> = {}

/**
 * Findings making the same claim about the same entity from a different origin.
 *
 * Mirrors `findCorroborationCandidates` in src/main/db/index.ts, including its exact-claim
 * equality — two adapters phrasing the same fact differently are not candidates there
 * either, and a fixture that matched more loosely would show a corroborate button the real
 * app would not.
 */
function sameClaimElsewhere(list: readonly Finding[], target: Finding): Finding[] {
  return list.filter(
    (f) =>
      f.entityId === target.entityId &&
      f.claim === target.claim &&
      f.id !== target.id &&
      independenceKey(f.source) !== independenceKey(target.source)
  )
}

const FINDINGS: Record<string, Finding[]> = {
  [C0]: [
    finding(C0, E0, 'github.com', 'maigret', 'An account named exampleuser exists on GitHub.', 'confirmed', 1500, true),
    finding(C0, E0, 'gitlab.com', 'maigret', 'An account named exampleuser exists on GitLab.', 'corroborated', 1495, true),
    finding(C0, E0M, 'spotify.com', 'holehe', 'Spotify recognises this address at password reset.', 'corroborated', 1490),
    finding(C0, E0, 'news.ycombinator.com', 'maigret', 'An account named exampleuser exists on Hacker News.', 'unverified', 1480),
    finding(C0, E0, 'reddit.com', 'maigret', 'An account named exampleuser exists on Reddit.', 'unverified', 1478),
    finding(C0, E0, 'steamcommunity.com', 'maigret', 'An account named exampleuser exists on Steam Community.', 'unverified', 1471),
    finding(C0, E0, 'pinterest.com', 'maigret', 'An account named exampleuser exists on Pinterest.', 'refuted', 1470),
    finding(C0, E0, 'last.fm', 'maigret', 'An account named exampleuser exists on Last.fm.', 'unverified', 1466),
    finding(C0, E0, 'about.me', 'maigret', 'An account named exampleuser exists on about.me.', 'unverified', 1460),
    finding(C0, E0M, 'imgur.com', 'holehe', 'Imgur does not recognise this address at password reset.', 'unverified', 1452),
    finding(C0, E0M, 'twitter.com', 'holehe', 'Twitter recognises this address at password reset.', 'unverified', 1448),
    finding(C0, E0, 'keybase.io', 'maigret', 'An account named exampleuser exists on Keybase.', 'unverified', 1440),
    // The one corroboratable pair in the fixture: the same claim from two genuinely
    // different origins — a direct probe of keybase.io above, and the linked-accounts
    // block on the GitHub profile below. Without a pair like this the corroborate
    // affordance is unreachable outside Electron and cannot be screenshotted at all.
    finding(C0, E0, 'github.com', 'blackbird', 'An account named exampleuser exists on Keybase.', 'unverified', 1438),
    finding(C0, E0, 'codeberg.org', 'maigret', 'An account named exampleuser exists on Codeberg.', 'unverified', 1436),
    finding(C0, E0, 'bitbucket.org', 'maigret', 'An account named exampleuser exists on Bitbucket.', 'refuted', 1430),
    finding(C0, E0, 'hub.docker.com', 'maigret', 'An account named exampleuser exists on Docker Hub.', 'unverified', 1424),
    finding(C0, E0, 'npmjs.com', 'maigret', 'An account named exampleuser exists on npm.', 'unverified', 1418),
    finding(C0, E0, 'gravatar.com', 'maigret', 'A Gravatar profile exists for the hash of this handle.', 'unverified', 1410),
    finding(C0, E0, 'medium.com', 'maigret', 'An account named exampleuser exists on Medium.', 'unverified', 1402)
  ],
  [CASES[1]!.id]: [
    finding(
      CASES[1]!.id,
      'ent_9f8e7d6c5b4a39281706',
      'instagram.com',
      'maigret',
      'An account named sneaky_panda exists on Instagram.',
      'unverified',
      3200
    ),
    finding(
      CASES[1]!.id,
      'ent_9f8e7d6c5b4a39281706',
      'tiktok.com',
      'maigret',
      'An account named sneaky_panda exists on TikTok.',
      'unverified',
      3195
    )
  ],
  [CASES[2]!.id]: [],
  /*
   * The ranking fixture's findings, invented to reproduce every branch of the scorer at
   * once. Reading top to bottom: an anchor whose own location disagrees with the seed (and
   * stays at the top anyway, because that is the point), a true positive carrying the
   * seeded name, two rows whose display name reads feminine against a masculine seed, two
   * carrying a different Bulgarian name entirely, and one that says nothing about anybody.
   */
  [CASES[3]!.id]: [
    finding(
      CASES[3]!.id,
      'ent_rank03a2b3c4d5e6f708',
      'steamcommunity.com',
      'profile-enrich',
      'Steam Community shows the location "София, Bulgaria" on this profile — a value the account holder typed, not a measured position. Profile: https://steamcommunity.com/id/krisi_2007',
      'corroborated',
      140,
      true
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'youtube.com',
      'maigret',
      'YouTube shows the display name "Кристиян Иванов" on this profile. Profile: https://www.youtube.com/@krisi',
      'unverified',
      138
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'twitter.com',
      'maigret',
      'Twitter shows the display name "Мария Петрова" on this profile. Profile: https://twitter.com/krisi',
      'unverified',
      136
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'pscp.tv',
      'maigret',
      'Periscope shows the display name "Даниела Стоянова" on this profile. Profile: https://www.pscp.tv/krisi',
      'unverified',
      134
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'facebook.com',
      'maigret',
      'Facebook shows the display name "Петър Драганов" on this profile. Profile: https://www.facebook.com/krisi',
      'unverified',
      132
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'vk.com',
      'maigret',
      'VK shows the display name "Николай Тодоров" on this profile. Profile: https://vk.com/krisi',
      'unverified',
      130
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'last.fm',
      'sherlock',
      'Sherlock reports that an account named "krisi" exists on Last.fm. HTTP 200. Who holds that account is a separate question this probe does not answer. Profile: https://www.last.fm/user/krisi',
      'unverified',
      128
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'about.me',
      'sherlock',
      'Sherlock reports that an account named "krisi" exists on about.me. HTTP 200. Who holds that account is a separate question this probe does not answer. Profile: https://about.me/krisi',
      'unverified',
      126
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'github.com',
      'maigret',
      'GitHub reports the account was created at 2009-04-11. Profile: https://github.com/krisi',
      'unverified',
      124
    ),
    finding(
      CASES[3]!.id,
      'ent_rank01a2b3c4d5e6f708',
      'local:pattern-timezone',
      'pattern-timezone',
      'Across 214 captured timestamps the quietest six-hour window is 01:00–07:00 UTC+3, which is the ordinary sleep window for that offset. Derived locally; it corroborates nothing on its own.',
      'unverified',
      120
    )
  ]
}

const ADAPTERS: AdapterInfo[] = [
  {
    id: 'maigret',
    title: 'Maigret',
    version: '0.4.4',
    accepts: ['username'],
    produces: ['account'],
    requiresKey: false,
    requiresNetwork: true,
    secretOptions: [],
    proposes: true,
    concurrency: 1,
    minIntervalMs: 0,
    defaultTimeoutMs: 900_000,
    available: true,
    unavailableReason: null,
    doc: {
      what: 'Checks roughly three thousand sites for an account using a given handle, and collects whatever profile text each one returns.',
      how: 'For each site in its list it builds the profile URL from a template, requests it, and compares the response against a per-site rule — a status code, a string that appears only on real profiles, or a string that appears only on the 404 page. Nothing is scraped from a search engine; every hit is a direct request to the site itself.',
      why: 'Handle reuse is the single most productive assumption in this field. People pick one name in their teens and carry it across a decade of services, and each service exposes a slightly different slice of the same person — a bio here, a join date there, an avatar that is the same file in three places.',
      betterAt: 'Breadth. Reach for it first when you have a handle and nothing else, because three thousand sites in one pass is coverage no manual search matches.',
      worseAt: 'Anything that requires a login to view, anything behind Cloudflare, and any site whose profile URL pattern has changed since the rule was written. It also cannot tell you that two accounts with the same handle are the same person.',
      falsePositives: 'This is its known, tracked, unsolved problem. A site that answers an anti-bot challenge or a soft redirect with HTTP 200 looks identical to a site returning a real profile, so the matcher reads "account exists". Popular handles on large sites are the worst case: a four-letter name will come back claimed almost everywhere, and almost all of it is wrong.'
    }
  },
  {
    id: 'holehe',
    title: 'Holehe',
    version: '1.61',
    accepts: ['email'],
    produces: ['account'],
    requiresKey: false,
    requiresNetwork: true,
    secretOptions: [],
    proposes: true,
    concurrency: 2,
    minIntervalMs: 1200,
    defaultTimeoutMs: 240_000,
    available: true,
    unavailableReason: null,
    doc: {
      what: 'Tells you which of about a hundred services have an account registered to an email address, without sending the address a single message.',
      how: 'It starts a password reset — or a registration — for the address on each service and reads the difference in the response. A service that says "we have sent you a link" behaves measurably differently from one that says "no account found", even when both return HTTP 200, and the difference is in the body, the redirect, or the timing.',
      why: 'Registration state is something a service has to tell the person at the keyboard in order to be usable, and it cannot tell them without also telling anyone who asks. It is a leak that follows from the feature working, which is why it is durable.',
      betterAt: 'Confirming that an address is real and in use, and mapping which services someone actually signed up for rather than which handles happen to exist.',
      worseAt: 'Anything with an email-enumeration defence, which is now most of the large platforms. A growing share of its site list returns the same answer for every address on purpose.',
      falsePositives: 'A rate limit, a captcha or a soft block reads as "no account" rather than as an error, so a negative is often just the service refusing to talk to you. Treat every negative as unknown, and re-run from a different network before believing one.'
    }
  },
  {
    id: 'whois',
    title: 'WHOIS / RDAP',
    version: '1.0.0',
    accepts: ['domain'],
    produces: ['organisation'],
    requiresKey: false,
    requiresNetwork: true,
    secretOptions: [],
    proposes: false,
    concurrency: 4,
    minIntervalMs: 500,
    defaultTimeoutMs: 30_000,
    available: false,
    unavailableReason: 'whois not found on PATH or in the toolkit root',
    doc: {
      what: 'Reads the registration record for a domain from the registry that issued it.',
      how: 'It asks the registry for the RDAP record, falling back to the older WHOIS text protocol when no RDAP endpoint is published. The registry answers from its own database — this is the authoritative record, not a scrape of a lookup site.',
      why: 'Registration dates, nameserver changes and registrar moves are a timeline nobody thinks to curate, and the same private-registration service across two unrelated domains is a weak but real link between them.',
      betterAt: 'Establishing when something started existing, and spotting infrastructure shared between domains that present themselves as unrelated.',
      worseAt: 'Learning who owns anything. GDPR redaction removed registrant details from almost every European record after 2018, and privacy proxies cover most of the rest.',
      falsePositives: 'A cached or proxied answer can be years stale, and some registrars return a boilerplate record for domains they do not actually hold. Creation dates are also reset by some registrars on transfer, so an old domain can appear new.'
    }
  },
  {
    id: 'hibp-passwords',
    title: 'Pwned Passwords (k-anonymity breach check)',
    version: '1.0.0',
    accepts: ['username', 'email'],
    produces: [],
    requiresKey: false,
    requiresNetwork: true,
    // The one adapter with a per-run form, present here so the k-anonymity panel can be
    // driven and screenshotted in a plain browser. Nothing behind it is real.
    secretOptions: ['password', 'sha1'],
    proposes: false,
    concurrency: 2,
    minIntervalMs: 1000,
    defaultTimeoutMs: 30_000,
    available: true,
    unavailableReason: null,
    doc: {
      what: 'Tells you how many times a candidate password appears in a corpus of roughly a billion credentials recovered from public breaches, without the password or a hash of it ever leaving this machine.',
      how: 'The password is hashed with SHA-1 locally and only the first five hex characters are sent, as a range query. The server returns every suffix it holds beginning with those five — around eight hundred — and the remaining thirty-five characters are compared here, in memory.',
      why: 'Credential stuffing does not involve guessing. Attackers replay username and password pairs from old breaches against unrelated sites, so a password already on a list will be tried directly no matter how much entropy it has.',
      betterAt: 'Being safe to run on your own live passwords, because the design makes the query useless to the party answering it. Free, unlimited, no account and no key.',
      worseAt: 'Everything about accounts. It answers a question about a string, not about a person, and it cannot tell you whether any address of yours appeared in a breach.',
      falsePositives: 'A hit means the string is known to attackers, never that this account was breached. The dangerous misreading is the other one: zero occurrences means absent from this published corpus, which is not the same as safe.'
    }
  },
  {
    id: 'echo',
    title: 'Echo (self-test)',
    version: '1.0.0',
    accepts: ['username', 'email', 'domain'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    secretOptions: [],
    proposes: false,
    concurrency: 4,
    minIntervalMs: 0,
    defaultTimeoutMs: 10_000,
    available: true,
    unavailableReason: null,
    doc: {
      what: 'Repeats the entity it was given back as a single finding, touching nothing outside the process.',
      how: 'It spawns no child, opens no socket and reads no file. It builds one finding whose source is the literal string "echo" and returns it, so the path from run through raw capture to parse to storage is exercised end to end.',
      why: 'Every other adapter fails in ways that look like the harness failing. A run that cannot fail for external reasons is how you tell a broken parser from a broken network.',
      betterAt: 'Proving the orchestrator, the raw capture and the index are working after a change to any of them.',
      worseAt: 'Telling you anything whatsoever about the world.',
      falsePositives: 'It always claims exactly what you gave it, so it is right by construction and therefore worth nothing as evidence. Its finding is still born unverified, because the rule has no exceptions.'
    }
  }
]

/**
 * The review queue.
 *
 * Discovered by an adapter, cited to the finding that proposed it, and NOT in the case.
 * Two proposals on one candidate is what two tools agreeing looks like — and because
 * both read the same site, `independentSources` is still 1, which is the honest number.
 */
const CANDIDATES: Record<string, CandidateView[]> = {
  [C0]: [
    {
      id: 'ent_cand01a2b3c4d5e6f708',
      caseId: C0,
      kind: 'account',
      value: 'jsfiddle.net/exampleuser',
      label: 'exampleuser on JSFiddle',
      attrs: { platform: 'jsfiddle.net', handle: 'exampleuser' },
      state: 'pending',
      firstProposedAt: iso(-1000 * 60 * 41),
      decidedAt: null,
      bestConfidence: 'unverified',
      independentSources: 1,
      proposals: [
        {
          findingId: 'fnd_0001a7c3e91b5d2f6084',
          tool: 'maigret',
          source: 'jsfiddle.net',
          rationale: 'JSFiddle served a profile page for this handle. A responding URL, not a verified account.',
          at: iso(-1000 * 60 * 41)
        }
      ],
      claims: [
        {
          findingId: 'fnd_0001a7c3e91b5d2f6084',
          claim: 'Maigret found a claimed account for "exampleuser" on JSFiddle at https://jsfiddle.net/user/exampleuser. HTTP 200.',
          confidence: 'unverified',
          source: 'jsfiddle.net',
          tool: 'maigret'
        }
      ]
    },
    {
      id: 'ent_cand02b3c4d5e6f70819',
      caseId: C0,
      kind: 'email',
      value: 'exampleuser@example.com',
      label: 'exampleuser@example.com',
      attrs: { domain: 'example.com' },
      state: 'pending',
      firstProposedAt: iso(-1000 * 60 * 39),
      decidedAt: null,
      bestConfidence: 'confirmed',
      independentSources: 2,
      proposals: [
        {
          findingId: 'fnd_0002a7c3e91b5d2f6084',
          tool: 'maigret',
          source: 'github.com',
          rationale: 'GitHub published this address on the profile page.',
          at: iso(-1000 * 60 * 39)
        },
        {
          findingId: 'fnd_0003a7c3e91b5d2f6084',
          tool: 'theharvester',
          source: 'certspotter.com',
          rationale: 'A certificate transparency log lists this address for the domain.',
          at: iso(-1000 * 60 * 30)
        }
      ],
      claims: [
        {
          findingId: 'fnd_0002a7c3e91b5d2f6084',
          claim: 'GitHub exposes the address exampleuser@example.com on this profile.',
          confidence: 'confirmed',
          source: 'github.com',
          tool: 'maigret'
        },
        {
          findingId: 'fnd_0003a7c3e91b5d2f6084',
          claim: 'certspotter.com lists exampleuser@example.com in a certificate issued for example.com.',
          confidence: 'unverified',
          source: 'certspotter.com',
          tool: 'theharvester'
        }
      ]
    }
  ]
}

const summarise = (c: Case): CaseSummary => {
  const f = FINDINGS[c.id] ?? []
  const count = (k: Finding['confidence']): number => f.filter((x) => x.confidence === k).length
  return {
    ...c,
    publishable: c.basis !== 'self' && c.basis !== 'consent',
    counts: {
      entities: (ENTITIES[c.id] ?? []).length,
      findings: f.length,
      unverified: count('unverified'),
      corroborated: count('corroborated'),
      confirmed: count('confirmed'),
      refuted: count('refuted'),
      evidence: 0,
      candidates: (CANDIDATES[c.id] ?? []).filter((x) => x.state === 'pending').length
    }
  }
}

/* A simulated sweep, so the live states can be captured: honest progress with a real
   denominator, a current target that changes, and findings arriving mid-run. */
const SWEEP_SITES = [
  'github.com',
  'gitlab.com',
  'reddit.com',
  'last.fm',
  'keybase.io',
  'codeberg.org',
  'npmjs.com',
  'medium.com'
]

function makeJob(caseId: string): Job {
  return {
    id: 'job_01J9KQ3FSIM',
    caseId,
    entityId: E0,
    adapterId: 'maigret',
    state: 'running',
    queuedAt: iso(-45_000),
    startedAt: iso(-42_000),
    finishedAt: null,
    progress: { pct: 8, note: 'probing 247 / 3000 · github.com' },
    findingIds: FINDINGS[caseId]?.slice(0, 11).map((f) => f.id) ?? [],
    error: null,
    rawId: null
  }
}

/**
 * The rest of a wave, so the aggregate queue can be captured.
 *
 * `?run=1` alone is one job, which is the state that keeps its full progress card. A
 * batch is a different component with a different failure mode — fourteen stacked cards
 * — so it needs its own drivable state. One of each terminal kind is included on purpose:
 * a wave whose settled rows are invisible has a denominator nobody can check.
 */
function makeWave(caseId: string): Job[] {
  const base = (
    id: string,
    adapterId: string,
    entityId: string,
    state: Job['state'],
    offset: number
  ): Job => ({
    id,
    caseId,
    entityId,
    adapterId,
    state,
    queuedAt: iso(-45_000 + offset),
    startedAt: state === 'queued' ? null : iso(-42_000 + offset),
    finishedAt: state === 'queued' || state === 'running' ? null : iso(-8_000 + offset),
    progress:
      state === 'running' ? { done: 412, current: 'steamcommunity.com', hits: 3 } : { pct: 100 },
    findingIds: [],
    error: state === 'failed' ? 'holehe exited 1: rate limited after 44 of 122 modules.' : null,
    rawId: null
  })
  return [
    base('job_01J9KQ3FSHE', 'sherlock', E0, 'running', 200),
    base('job_01J9KQ3FHOL', 'holehe', E0M, 'failed', 400),
    base('job_01J9KQ3FECH', 'echo', E0, 'done', 600),
    base('job_01J9KQ3FPWN', 'hibp-passwords', E0M, 'queued', 800)
  ]
}

export function installFixtureBridge(): void {
  const params = new URLSearchParams(window.location.search)
  const simulate = params.get('run') === '1'
  // `?sarun=1` puts a self-audit level mid-sweep, so the run bar, the safelight and the
  // in-flight adapter line can be captured. Same idea as `?run=1` for a maigret sweep.
  if (params.get('sarun') === '1') {
    SELF_AUDIT_STATE.run = {
      level: 0,
      caseId: '2026-08-30-self-audit-l0-bew6fhrp',
      phase: 'running',
      startedAt: iso(-42_000),
      finishedAt: null,
      planned: 5,
      finished: 2,
      running: [{ adapterId: 'maigret', entityLabel: 'torvalds' }],
      message: '2 of 5 checks finished.',
      error: null,
      snapshotId: null
    }
  }
  const listeners = new Set<(job: Job) => void>()
  // `?run=1` is one job and keeps its full progress card. `?wave=1` adds the rest of a
  // batch so the aggregate queue — the component that replaces four stacked cards — can
  // be driven and measured at a real viewport.
  const jobs: Job[] = simulate
    ? params.get('wave') === '1'
      ? [makeJob(C0), ...makeWave(C0)]
      : [makeJob(C0)]
    : []

  if (simulate) {
    let n = 247
    let i = 0
    let batch = 0
    window.setInterval(() => {
      const job = jobs[0]
      if (!job) return
      n += 37
      i = (i + 1) % SWEEP_SITES.length
      // Structured, the way a real adapter now reports: the count, the denominator and
      // the site being hit are fields, not a sentence the UI has to parse back out.
      job.progress = {
        pct: (n / 3000) * 100,
        done: n,
        total: 3000,
        current: SWEEP_SITES[i],
        hits: job.findingIds.length
      }

      // Every third tick, land a small batch of findings so the 20ms stagger and the
      // "hits" counter can be seen doing their job. This is the shape a streaming
      // adapter would produce; a spawn-based one lands everything at once instead.
      batch += 1
      if (batch % 3 === 0) {
        const arriving = ['jsfiddle.net', 'flickr.com', 'vimeo.com', 'soundcloud.com'].map((host) =>
          finding(C0, E0, host, 'maigret', `An account named exampleuser exists on ${host}.`, 'unverified', 1)
        )
        FINDINGS[C0] = [...(FINDINGS[C0] ?? []), ...arriving]
        job.findingIds = [...job.findingIds, ...arriving.map((f) => f.id)]
      }

      // Cloned, because real IPC structured-clones across the process boundary. A
      // shared array reference here would make the renderer's growth check compare a job
      // against itself.
      for (const cb of listeners) cb(structuredClone(job))
    }, 2200)
  }

  const api: OsintApi = {
    cases: {
      list: async () => CASES.map(summarise),
      create: async (req) => {
        const c: Case = {
          id: `2026-08-30-${req.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}-01jnew`,
          name: req.name,
          basis: req.basis,
          subjectConsent: req.basis === 'consent' ? !!req.subjectConsent : false,
          createdAt: iso(0),
          notes: req.notes ?? ''
        }
        CASES.unshift(c)
        ENTITIES[c.id] = []
        FINDINGS[c.id] = []
        return summarise(c)
      },
      get: async (id) => {
        const c = CASES.find((x) => x.id === id)
        return c ? summarise(c) : null
      },
      setSubject: async (id, subject) => {
        const c = CASES.find((x) => x.id === id)
        if (!c) throw new Error(`No case ${id}`)
        c.subject = cleanSubject(subject)
        return summarise(c)
      }
    },
    entities: {
      list: async (caseId) => ENTITIES[caseId] ?? [],
      add: async (req) => {
        const e = {
          id: `ent_${Math.random().toString(16).slice(2, 22)}`,
          caseId: req.caseId,
          kind: req.kind,
          value: req.value.toLowerCase(),
          label: req.label ?? req.value,
          createdAt: iso(0),
          seed: req.seed ?? true,
          attrs: {}
        } as Entity
        ;(ENTITIES[req.caseId] ??= []).push(e)
        return e
      },
      usage: async (caseId, entityId) => {
        const e = (ENTITIES[caseId] ?? []).find((x) => x.id === entityId)
        if (!e) return null
        const findings = (FINDINGS[caseId] ?? []).filter((f) => f.entityId === entityId).length
        return {
          caseId,
          entityId,
          kind: e.kind,
          value: e.value,
          label: e.label,
          seed: e.seed,
          findings,
          evidence: 0,
          activeJobs: 0,
          returnsCandidate: (CANDIDATES[caseId] ?? []).some(
            (c) => c.id === entityId && c.state === 'promoted'
          ),
          attached: findings > 0,
          // Mirrors EDITABLE_KINDS in service.ts: a composite or a digest is not free text.
          editable: e.kind !== 'account' && e.kind !== 'image'
        }
      },
      edit: async (req) => {
        const list = ENTITIES[req.caseId] ?? []
        const idx = list.findIndex((x) => x.id === req.entityId)
        const prev = list[idx]
        if (idx < 0 || !prev) throw new Error(`No entity ${req.entityId}.`)
        const next = {
          ...prev,
          value: req.value.trim().toLowerCase(),
          label: req.label ?? req.value.trim()
        } as Entity
        const renamed = next.value !== prev.value
        list[idx] = next
        const orphaned = renamed
          ? (FINDINGS[req.caseId] ?? []).filter((f) => f.entityId === prev.id).length
          : 0
        return {
          entity: next,
          renamed,
          removal: renamed
            ? {
                caseId: req.caseId,
                entityId: prev.id,
                kind: prev.kind,
                label: prev.label,
                orphanedFindings: orphaned,
                cancelledJobs: 0,
                candidateReturned: false,
                provenanceCut: 0,
                tombstone: null
              }
            : null
        }
      },
      delete: async (req) => {
        const list = ENTITIES[req.caseId] ?? []
        const idx = list.findIndex((x) => x.id === req.entityId)
        const prev = list[idx]
        if (idx < 0 || !prev) {
          return {
            caseId: req.caseId,
            entityId: req.entityId,
            kind: 'username',
            label: req.entityId,
            orphanedFindings: 0,
            cancelledJobs: 0,
            candidateReturned: false,
            provenanceCut: 0,
            tombstone: null
          }
        }
        list.splice(idx, 1)
        const orphaned = (FINDINGS[req.caseId] ?? []).filter((f) => f.entityId === prev.id).length
        const candidate = (CANDIDATES[req.caseId] ?? []).find((c) => c.id === prev.id)
        if (candidate?.state === 'promoted') {
          candidate.state = 'pending'
          candidate.decidedAt = null
        }
        const tombstone = {
          entityId: prev.id,
          caseId: req.caseId,
          kind: prev.kind,
          value: prev.value,
          label: prev.label,
          seed: prev.seed,
          removedAt: iso(0),
          reason: 'deleted' as const,
          replacedBy: null,
          orphanedFindings: orphaned
        }
        if (orphaned > 0) (REMOVED[req.caseId] ??= []).push(tombstone)
        return {
          caseId: req.caseId,
          entityId: prev.id,
          kind: prev.kind,
          label: prev.label,
          orphanedFindings: orphaned,
          cancelledJobs: 0,
          candidateReturned: candidate?.state === 'pending',
          // Nothing in the browser stand-in has a provenance graph to cut.
          provenanceCut: 0,
          tombstone: orphaned > 0 ? tombstone : null
        }
      },
      removed: async (caseId) => REMOVED[caseId] ?? []
    },
    candidates: {
      list: async (caseId, state = 'pending') =>
        (CANDIDATES[caseId] ?? []).filter((c) => state === 'all' || c.state === state),
      promote: async ({ caseId, candidateId }) => {
        const c = (CANDIDATES[caseId] ?? []).find((x) => x.id === candidateId)
        if (!c) throw new Error(`No candidate ${candidateId}.`)
        c.state = 'promoted'
        c.decidedAt = iso(0)
        const e = {
          id: c.id,
          caseId,
          kind: c.kind,
          value: c.value,
          label: c.label,
          createdAt: iso(0),
          // Discovered, never supplied. The self-audit's whole question is what a given
          // seed set unlocked, and a promoted discovery counted as a seed answers it wrong.
          seed: false,
          attrs: c.attrs
        } as Entity
        ;(ENTITIES[caseId] ??= []).push(e)
        return e
      },
      dismiss: async ({ caseId, candidateId }) => {
        const c = (CANDIDATES[caseId] ?? []).find((x) => x.id === candidateId)
        if (!c) throw new Error(`No candidate ${candidateId}.`)
        c.state = 'dismissed'
        c.decidedAt = iso(0)
        return c
      },
      promoteConfirmed: async (caseId) => {
        const out: Entity[] = []
        for (const c of CANDIDATES[caseId] ?? []) {
          if (c.state !== 'pending' || c.bestConfidence !== 'confirmed') continue
          out.push(await api.candidates.promote({ caseId, candidateId: c.id }))
        }
        return out
      }
    },
    findings: {
      list: async (caseId) => FINDINGS[caseId] ?? [],
      search: async (caseId, q) =>
        (FINDINGS[caseId] ?? []).filter((f) =>
          `${f.claim} ${f.source} ${f.tool} ${f.raw.excerpt}`.toLowerCase().includes(q.toLowerCase())
        ),
      raw: async (_caseId, findingId) =>
        JSON.stringify(
          {
            note: 'Fixture bytes. In the real app these are the tool output, byte for byte.',
            findingId,
            site: 'github',
            url_user: 'https://github.com/exampleuser',
            http_status: 200,
            status: { status: 'claimed', ids: { username: 'exampleuser' } }
          },
          null,
          2
        ),
      /**
       * A real promotion against the fixture's in-memory findings.
       *
       * It runs the *actual* `promote()` from shared/confidence.ts rather than
       * short-circuiting to the requested level, so the browser bridge refuses exactly
       * what Electron refuses — a `confirmed` without a note, a `corroborated` backed by
       * two tools reading one site — and the error copy under the form is the real error
       * copy. A fixture that always said yes would make this the one path in the app that
       * looks verified outside Electron and is not.
       */
      promote: async (req) => {
        const list = FINDINGS[req.caseId] ?? []
        const idx = list.findIndex((f) => f.id === req.findingId)
        const target = list[idx]
        if (!target) throw new Error(`No finding ${req.findingId} in case ${req.caseId}.`)
        const wanted = new Set(req.supportingFindingIds ?? [])
        const supporting = wanted.size
          ? list.filter((f) => wanted.has(f.id))
          : req.actor === 'corroborator'
            ? sameClaimElsewhere(list, target)
            : []
        const { finding: updated, change } = promote({
          finding: target,
          to: req.to,
          actor: req.actor,
          supporting,
          note: req.note,
          idFactory: () => `cch_fixture_${(CONFIDENCE_LOG[req.caseId]?.length ?? 0) + 1}`
        })
        // A new array, not an in-place splice. Real IPC structured-clones its reply, so
        // every `findings.list` in Electron hands back fresh objects and React always
        // sees a change; a fixture that mutated one array in place would let the table
        // keep rendering the old level while the margin panel showed the new one — a
        // difference between the two bridges that would look exactly like a UI bug.
        FINDINGS[req.caseId] = list.map((f) => (f.id === updated.id ? updated : f))
        CONFIDENCE_LOG[req.caseId] = [...(CONFIDENCE_LOG[req.caseId] ?? []), change]
        return updated
      },
      corroborationCandidates: async (caseId, findingId) => {
        const list = FINDINGS[caseId] ?? []
        const target = list.find((f) => f.id === findingId)
        return target ? sameClaimElsewhere(list, target) : []
      }
    },
    evidence: { list: async () => [] },
    confidence: { log: async (caseId) => CONFIDENCE_LOG[caseId] ?? [] },
    adapters: { list: async () => ADAPTERS },
    jobs: {
      run: async () => {
        throw new Error(
          'maigret is not reachable from a browser. Run the app under Electron to start a real job.'
        )
      },
      // The planner is pure — it queues nothing — so it is worth simulating properly:
      // the launcher's whole point is showing what a click would do before it does it,
      // and that panel has to be drivable outside Electron to be measured.
      plan: async (req) => {
        const all = ENTITIES[req.caseId] ?? []
        const chosen = req.entityIds?.length ? all.filter((e) => req.entityIds?.includes(e.id)) : all
        const named = (req.adapterIds ?? []).length > 0
        const excluded: RunPlan['excluded'] = []
        const usable = ADAPTERS.filter((a) => {
          if (named && !req.adapterIds?.includes(a.id)) return false
          // Mirrors FANOUT_SKIPS_BY_DEFAULT in service.ts. A default skip is a default:
          // naming the adapter explicitly is an instruction and overrides it.
          if (!named && a.id === 'echo') {
            excluded.push({
              adapterId: a.id,
              adapterTitle: a.title,
              reason:
                'The self-test adapter. It accepts every kind and asserts nothing about the world, so a sweep would only add a row per entity saying the plumbing works.'
            })
            return false
          }
          if (a.secretOptions.length) {
            excluded.push({
              adapterId: a.id,
              adapterTitle: a.title,
              reason: `Its input is a secret typed at the moment of use and never stored, so there is nowhere in a batch to supply it. Run ${a.title} on its own.`
            })
            return false
          }
          if (!a.available) {
            excluded.push({
              adapterId: a.id,
              adapterTitle: a.title,
              reason: a.unavailableReason ?? 'Unavailable, with no reason given.'
            })
            return false
          }
          return true
        })
        const runs = chosen.flatMap((e) =>
          usable
            .filter((a) => a.accepts.includes(e.kind))
            .map((a) => ({
              adapterId: a.id,
              adapterTitle: a.title,
              entityId: e.id,
              entityKind: e.kind,
              entityLabel: e.label
            }))
        )
        const covered = new Set(runs.map((r) => r.entityId))
        const used = new Set(runs.map((r) => r.adapterId))
        return {
          caseId: req.caseId,
          runs,
          entitiesCovered: covered.size,
          adaptersUsed: used.size,
          idleEntities: chosen
            .filter((e) => !covered.has(e.id))
            .map((e) => {
              // The same four branches the service picks between, so the copy the design
              // pass measures is the copy that ships.
              const runnable = ADAPTERS.filter(
                (a) => a.accepts.includes(e.kind) && !a.secretOptions.length && a.id !== 'echo'
              )
              return {
                entityId: e.id,
                kind: e.kind,
                label: e.label,
                reason: idleKindReason({
                  kind: e.kind,
                  runnable: runnable.map((a) => a.title),
                  available: runnable.filter((a) => a.available).map((a) => a.title),
                  named: named && !usable.some((a) => a.accepts.includes(e.kind))
                })
              }
            }),
          idleAdapters: usable
            .filter((a) => !used.has(a.id))
            .map((a) => ({
              adapterId: a.id,
              adapterTitle: a.title,
              accepts: a.accepts,
              reason: `${a.title} takes ${a.accepts.join(', ')}. Nothing selected is one.`
            })),
          excluded,
          alreadyQueued: []
        }
      },
      runPlan: async () => {
        throw new Error(
          'Tools are not reachable from a browser. Run the app under Electron to start real jobs.'
        )
      },
      cancel: async () => true,
      cancelCase: async () => jobs.length,
      list: async (caseId) =>
        structuredClone(caseId ? jobs.filter((j) => j.caseId === caseId) : jobs),
      onUpdate: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    index: {
      rebuild: async (): Promise<IndexStats> => ({
        cases: CASES.length,
        entities: Object.values(ENTITIES).flat().length,
        findings: Object.values(FINDINGS).flat().length,
        evidence: 0,
        confidenceChanges: 4,
        candidates: Object.values(CANDIDATES).flat().length,
        durationMs: 63,
        skipped: [],
        at: iso(0)
      })
    },
    settings: {
      get: async () => ({}) as AppConfig,
      getLaunchAtStartup: async () => false,
      setLaunchAtStartup: async (enabled: boolean) => enabled,
      getDataRoot: async () => ({
        root: '/home/user/osint-workbench/appdata',
        effective: '/home/user/osint-workbench/appdata',
        pointerFile: '/home/user/.config/osint-workbench/data-location.json',
        requiresRestart: false
      }),
      pickDataRoot: async () => null,
      setDataRoot: async (dir: string) => ({
        root: dir,
        effective: '/home/user/osint-workbench/appdata',
        pointerFile: '/home/user/.config/osint-workbench/data-location.json',
        requiresRestart: true
      })
    },
    /*
     * The Range and the Scrub view outside Electron.
     *
     * Both are deliberately *unavailable* rather than faked. The Range's whole content —
     * 20 reviewed rounds, 151 atlas clues, 15,232 frames — is bundled in the main
     * process, and a plausible-looking stand-in for it would be a lie about the one part
     * of the app whose value is that the data is real. The Scrub view drives a Python
     * program that a browser cannot spawn at all. So each says what it needs and where
     * to get it, which is what the views' error states are built to render.
     */
    range: {
      data: async () => {
        throw new Error(
          'The Range reads its atlas, its reviewed rounds and its frame index from bundled app resources. Run the app under Electron.'
        )
      },
      index: async () => {
        throw new Error('The frame index is a bundled app resource. Run the app under Electron.')
      },
      live: async () => null,
      imageUrl: (url: string) => url
    },
    scrub: {
      pathForFile: () => '',
      env: async () => ({
        ok: false,
        python: {
          path: null,
          version: null,
          how: 'not available in a browser',
          error: 'The scrubber spawns a Python program, which a browser cannot do. Run the app under Electron.'
        },
        kitRoot: { path: '/home/user/opsec-kit', present: false },
        exiftool: { path: null, version: null, present: false },
        ffmpeg: { path: null, present: false },
        ffprobe: { path: null, present: false },
        problems: [
          'The scrubber spawns a Python program, which a browser cannot do. Run the app under Electron.'
        ]
      }),
      pick: async () => [],
      pickFolder: async () => null,
      inspect: async () => [],
      run: async () => [],
      audit: async () => []
    },
    app: {
      info: async () => ({
        version: '0.1.0',
        electron: '43.2.0',
        node: '24.4.0',
        chrome: '142.0.7444.52',
        paths: {
          root: '/home/user/osint-workbench',
          casesDir: '/home/user/osint-workbench/cases',
          dataDir: '/home/user/osint-workbench/data',
          dbFile: '/home/user/osint-workbench/data/index.db',
          toolkitRoot: '<toolkitRoot>',
          opsecKitRoot: '/home/user/opsec-kit',
          configFile: '/home/user/osint-workbench/config/local.config.json'
        },
        configSource: 'defaults',
        configWarnings: [],
        adapterCount: ADAPTERS.length
      }),
      openExternal: async () => {},
      revealInFolder: async () => {},
      quit: async () => {},
      restart: async () => {},
      onNavigate: () => () => {}
    },
    /**
     * Self-Audit, standing in.
     *
     * Deliberately thin: the vault holds neutral placeholder values, one level has been
     * "run", and the delta carries a worked headline so the view's typography can be
     * measured at realistic length. Everything real about this feature — the coverage
     * classifier, the attribution matcher, the reset-path map — lives in the main process
     * and cannot be exercised here, which is why the browser harness is for looking at the
     * layout and never for judging whether the analysis is right.
     */
    // The export and the gallery are pure readers over a case folder, and the fixture has
    // no case folder — so outside Electron they answer "nothing here" rather than
    // pretending. Enough for the panel to render its own empty state, which is what a
    // screenshot pass needs it to do.
    exports: {
      gallery: async () => ({
        groups: [],
        singles: [],
        defaults: [],
        unreadable: [],
        notFetched: [],
        capturesRead: 0,
        enrichRuns: 0,
        note: 'This is the browser fixture. No case folder exists here, so no picture has been read.'
      }),
      preview: async () => '<!doctype html><title>fixture</title><p>No case folder in the browser fixture.</p>',
      write: async (req) => ({
        path: `/fixture/${req.caseId}.${req.format === 'html' ? 'html' : 'md'}`,
        bytes: 0,
        format: req.format,
        imagesInlined: 0,
        imageBytes: 0
      })
    },
    selfAudit: {
      state: async () => SELF_AUDIT_STATE,
      saveProfile: async (profile) => {
        SELF_AUDIT_STATE.profile = { ...profile, updatedAt: iso(0) }
        SELF_AUDIT_STATE.hasProfile = Object.values(profile.values).some((v) => v.length > 0)
        return SELF_AUDIT_STATE.profile
      },
      clearProfile: async () => {
        SELF_AUDIT_STATE.profile = { values: emptySeedValues(), updatedAt: null }
        SELF_AUDIT_STATE.hasProfile = false
        return SELF_AUDIT_STATE.profile
      },
      seedUsage: async (field, value) => ({
        field,
        value,
        kind: seedField(field).kind,
        inVault: (SELF_AUDIT_STATE.profile.values[field] ?? []).includes(value),
        cases: [],
        findings: 0
      }),
      removeSeed: async (req) => {
        const values = SELF_AUDIT_STATE.profile.values
        values[req.field] = (values[req.field] ?? []).filter(
          (v) => v.toLowerCase() !== req.value.trim().toLowerCase()
        )
        SELF_AUDIT_STATE.profile = { ...SELF_AUDIT_STATE.profile, updatedAt: iso(0) }
        SELF_AUDIT_STATE.hasProfile = Object.values(values).some((v) => v.length > 0)
        return {
          field: req.field,
          value: req.value,
          profile: SELF_AUDIT_STATE.profile,
          purged: [],
          kept: []
        }
      },
      plan: async (level) => ({
        level,
        caseId: level === 0 ? C0 : null,
        seeds: [{ kind: 'username' as const, label: 'torvalds', field: 'usernames' as const }],
        runs: [
          { adapterId: 'maigret', adapterTitle: 'maigret', entityKind: 'username' as const, entityLabel: 'torvalds' },
          { adapterId: 'sherlock', adapterTitle: 'sherlock', entityKind: 'username' as const, entityLabel: 'torvalds' }
        ],
        unavailable: [
          {
            adapterId: 'blackbird',
            adapterTitle: 'blackbird',
            reason: 'blackbird was not found under <toolkitRoot>.'
          }
        ],
        /* Only L0, and deliberately: this is the state a real L0 folder is in after the
           ladder split the username rung. The folder was seeded with every handle when L0
           took the whole list; L0 now takes one, so the rest are seeds the level would not
           add today and that nothing deletes on its own. */
        strayCaseSeeds:
          level === 0
            ? [
                { entityId: 'ent_stray_1', kind: 'username' as const, label: 'linus.torvalds' },
                { entityId: 'ent_stray_2', kind: 'username' as const, label: 'ltorvalds' }
              ]
            : []
      }),
      run: async (req) => ({
        level: req.level,
        caseId: C0,
        phase: 'done' as const,
        startedAt: iso(-4000),
        finishedAt: iso(0),
        planned: 2,
        finished: 2,
        running: [],
        message: 'Fixture run. Nothing was executed.',
        error: null,
        snapshotId: 'sas_fixture'
      }),
      cancel: async () => false,
      snapshots: async () => SELF_AUDIT_STATE.levels.flatMap((l) => (l.latest ? [l.latest] : [])),
      delta: async () => FIXTURE_DELTA,
      report: async () => FIXTURE_REPORT,
      resetPaths: async () => FIXTURE_REPORT.resetPaths,
      rescan: async () => FIXTURE_RESCAN,
      lastRescan: async () => FIXTURE_RESCAN,
      contacts: async () => [],
      letter: async () => FIXTURE_LETTER,
      saveLetter: async () => ({ path: '/home/user/osint-workbench/cases/fixture/letters/fixture.txt', bytes: 0 }),
      onRun: () => () => {}
    },
    /* The investigation engine, as one finished run. Nothing here executes: the loop is
       main-process code and the point of the fixture is to be able to read the brief, at
       1280 and at 1920, with reduced motion forced, outside Electron. */
    engine: {
      plan: async (caseId) => ({
        caseId,
        at: iso(0),
        actions: FIXTURE_BRIEF.next,
        blocked: FIXTURE_BRIEF.blocked,
        nodesConsidered: 6,
        exhausted: false
      }),
      run: async () => FIXTURE_ENGINE_RUN,
      cancel: async () => false,
      state: async () => FIXTURE_ENGINE_RUN,
      brief: async (caseId) => ({ ...FIXTURE_BRIEF, caseId }),
      chains: async () => FIXTURE_CHAINS,
      chain: async (_caseId, nodeId) => FIXTURE_CHAINS.find((c) => c.node.id === nodeId) ?? null,
      prune: async (req) => ({
        caseId: req.caseId,
        node: FIXTURE_CHAINS.find((c) => c.node.id === req.nodeId)?.node ?? null,
        action: 'prune' as const,
        cut: [],
        candidatesDismissed: 0,
        entitiesAffected: [],
        reason: req.reason,
        at: iso(0)
      }),
      restore: async (caseId) => ({
        caseId,
        node: null,
        action: 'restore' as const,
        cut: [],
        candidatesDismissed: 0,
        entitiesAffected: [],
        reason: 'Fixture. Nothing was restored.',
        at: iso(0)
      }),
      decisions: async () => FIXTURE_BRIEF.decisions,
      onRun: () => () => {}
    }
  }

  window.osint = api
}

/** Lifted from a real run against neutral test data. Never the operator's own details. */
const SELF_AUDIT_STATE = structuredClone(FIXTURE_STATE)
