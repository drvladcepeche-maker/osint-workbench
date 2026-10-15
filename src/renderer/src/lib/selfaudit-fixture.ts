/**
 * Self-Audit fixture data. **Development only** — see `fixtures.ts`.
 *
 * Every string below was copied out of a real run of the engine against neutral test data
 * (`torvalds`, `test@example.com`, `Linus Torvalds`), trimmed to a size that fits in a
 * source file. It exists so the five Self-Audit screens can be opened in a plain browser
 * and measured at arbitrary viewport sizes, which is the only way to check the layout
 * without the Electron window.
 *
 * It is a **stage set, not a source of truth.** The analysis that produced these sentences
 * runs in the main process and cannot be exercised here; anything this file appears to
 * assert about the world is a copy of something a tool said once, on one machine, in
 * August 2026.
 *
 * It lives in its own file rather than inside `fixtures.ts` for one practical reason: it
 * is a large data blob and `fixtures.ts` is the file every renderer feature has to touch.
 */

import type {
  ExposureReport,
  GdprLetter,
  RescanDiff,
  SelfAuditDelta,
  SelfAuditProfile,
  SelfAuditState,
  SnapshotFinding
} from '../../../shared/selfaudit'

const CASE_L2 = '2026-08-30-self-audit-l2-bew6fhrp'
const AT = '2026-08-30T19:00:52.000Z'

export function emptySeedValues(): SelfAuditProfile['values'] {
  return {
    usernames: [],
    emails: [],
    domains: [],
    names: [],
    cities: [],
    schools: [],
    phones: [],
    family: []
  }
}

const CHECKS = [
  {
    adapterId: 'maigret',
    adapterTitle: 'maigret (username sweep with profile scraping)',
    entityId: 'ent_1',
    entityKind: 'username' as const,
    entityLabel: 'torvalds',
    outcome: 'answered' as const,
    detail: 'Ran to completion and reported results.',
    jobId: 'job_1',
    jobState: 'done' as const,
    findingIds: [],
    coverage: null
  },
  {
    adapterId: 'holehe',
    adapterTitle: 'holehe (email → account existence)',
    entityId: 'ent_2',
    entityKind: 'email' as const,
    entityLabel: 'test@example.com',
    outcome: 'no-answer' as const,
    detail:
      'Only 2 of 122 sites answered, and 120 refused. The few that answered said no. A run with this little coverage says essentially nothing about where the address is registered — repeat it from a different network before believing any of it.',
    jobId: 'job_2',
    jobState: 'done' as const,
    findingIds: [],
    coverage: { answered: 2, refused: 120, total: 122 }
  },
  {
    adapterId: 'reddit-profile',
    adapterTitle: 'Reddit profile (behavioural read of one account)',
    entityId: 'ent_1',
    entityKind: 'username' as const,
    entityLabel: 'torvalds',
    outcome: 'no-answer' as const,
    detail:
      'Reddit answered HTTP 403 and served its "blocked by network security" page instead of JSON. The block is aimed at unauthenticated clients generally, not at this account — nothing about the account follows from it.',
    jobId: 'job_3',
    jobState: 'done' as const,
    findingIds: [],
    coverage: { answered: 0, refused: 1, total: 1 }
  },
  {
    adapterId: 'blackbird',
    adapterTitle: 'blackbird (widest catalogue)',
    entityId: null,
    entityKind: null,
    entityLabel: null,
    outcome: 'unavailable' as const,
    detail:
      'blackbird was not found under <toolkitRoot>. Everything this tool would have covered is unchecked.',
    jobId: null,
    jobState: null,
    findingIds: [],
    coverage: null
  }
]

const PLATFORMS = [
  'bit.ly',
  'bsky.app',
  'dailymotion.com',
  'discord.com',
  'facebook.com',
  'github.com',
  'imgur.com',
  'instagram.com',
  'medium.com',
  'soundcloud.com',
  't.me',
  'tiktok.com',
  'tumblr.com',
  'twitter.com',
  'vk.com',
  'wikipedia.org',
  'wordpress.com'
]

export const FIXTURE_ACCOUNTS = PLATFORMS.map((platform) => ({
  key: `${platform}/torvalds`,
  platform,
  handle: 'torvalds',
  url: `https://${platform}/torvalds`,
  state: 'candidate' as const,
  confidence: 'unverified' as const,
  independentSources: 1,
  tools: ['maigret'],
  findingIds: [`fnd_${platform.replace(/\W/g, '')}`]
}))

function finding(sourceKey: string, claim: string, derived = false): SnapshotFinding {
  return {
    id: `fnd_${sourceKey.replace(/\W/g, '')}_${claim.length}`,
    entityId: 'ent_1',
    source: derived ? `local:${sourceKey}` : `https://${sourceKey}/torvalds`,
    sourceKey: derived ? `local:${sourceKey}` : sourceKey,
    tool: derived ? sourceKey : 'maigret',
    claim,
    confidence: 'unverified',
    firstSeen: AT,
    lastVerified: null,
    rawPath: 'raw/raw_01M1A0QXDTYZ5Q5FMWXVP7P767.json',
    derived
  }
}

const TELEMETRY: SnapshotFinding[] = [
  finding(
    'maigret',
    'Maigret probed 25 sites for the username "torvalds" in 7 s: 25 claimed, 0 available. Maigret reported bot-protection errors during this run, so the negative results are less trustworthy than the positive ones.',
    true
  ),
  finding(
    'holehe',
    'holehe queried 122 sites about test@example.com in 3.2 s: 0 say an account exists, 2 say it does not, and 120 did not answer (120 rate-limited). The sites that did not answer are unchecked, not clear. Almost every site refused to answer, which is the failure mode Phase 0 observed from this IP — this run carries essentially no signal and should be repeated from a different network before any of it is believed.',
    true
  ),
  finding(
    'reddit-profile',
    'Reddit answered HTTP 403 for u/torvalds and served its "blocked by network security" interstitial instead of JSON. That is a refusal aimed at this client, not a statement about the account.',
    true
  )
]

export const FIXTURE_DELTA: SelfAuditDelta = {
  from: {
    id: 'sas_l1',
    level: 1,
    caseId: '2026-08-30-self-audit-l1-583xf2kz',
    at: '2026-08-30T18:57:11.000Z',
    counts: { claims: 82, telemetry: 3, accounts: 25, sources: 25, silentChecks: 2 }
  },
  to: {
    id: 'sas_l2',
    level: 2,
    caseId: CASE_L2,
    at: AT,
    counts: { claims: 81, telemetry: 3, accounts: 24, sources: 24, silentChecks: 2 }
  },
  addedSeeds: [
    { entityId: 'ent_3', kind: 'person', value: 'linus torvalds', label: 'Linus Torvalds', field: 'names', level: 2 }
  ],
  /* A handle typed into the vault *after* L1 ran. It belongs to L0's entitlement, so it is
     evidence that the lower snapshot is stale rather than a cause L2 can be credited with. */
  staleSeeds: [
    { entityId: 'ent_9', kind: 'username', value: 'torvalds.dev', label: 'torvalds.dev', field: 'usernames', level: 1 }
  ],
  newReach: [],
  /* A site absent below because the tool behind it was refused there, not because the seed
     opened a door. Reported, and kept out of the count above. */
  incomparableReach: [
    {
      sourceKey: 'keybase.io',
      findings: [
        finding('keybase.io', 'Blackbird reports an account named "torvalds" on Keybase. Who holds it is a separate question this probe does not answer.')
      ],
      viaSeed: null
    }
  ],
  lostReach: [
    {
      sourceKey: 'launchpad.net',
      findings: [finding('launchpad.net', 'Maigret found a claimed account for "torvalds" on Launchpad at https://launchpad.net/~torvalds. HTTP 200.')],
      viaSeed: null
    }
  ],
  newAccounts: [],
  goneAccounts: [],
  promoted: [],
  demoted: [],
  newlyRunnable: [],
  /* blackbird accepts usernames, which L1 already held — so its arrival at L2 is the
     operator having re-selected it, or the binary having been installed since. Never the
     seed, and never part of the sentence at the top. */
  runnableForOtherReasons: [
    {
      adapterId: 'blackbird',
      adapterTitle: 'blackbird (widest catalogue)',
      entityId: 'ent_1',
      entityKind: 'username' as const,
      entityLabel: 'torvalds',
      outcome: 'answered' as const,
      detail: 'Ran to completion and reported results.',
      jobId: 'job_4',
      jobState: 'done' as const,
      findingIds: [],
      coverage: null,
      adapterAccepts: ['username' as const]
    }
  ],
  attributions: [
    {
      findingId: 'fnd_github',
      field: 'names',
      seedValue: 'Linus Torvalds',
      level: 2,
      where: 'claim',
      excerpt: 'GitHub shows the display name "Linus Torvalds" on this profile.',
      sourceKey: 'github.com',
      tool: 'maigret'
    },
    {
      findingId: 'fnd_raw1',
      field: 'names',
      seedValue: 'Linus Torvalds',
      level: 2,
      where: 'raw',
      excerpt: '… ├─follower_count: 319155 ├─following_count: 0 ├─fullname: Linus Torvalds …',
      sourceKey: '',
      tool: 'maigret'
    }
  ],
  headline:
    'The handle torvalds is on 23 sites — bit.ly, bsky.app and dailymotion.com among them — and the github.com one carries your real name. The handle is what connects those accounts to each other, and github.com is where they stop being anonymous.',
  headlineBasis: [
    'torvalds appears as the handle on 23 platforms: bit.ly, bsky.app, dailymotion.com, discord.com, facebook.com, github.com, imgur.com, instagram.com, medium.com, soundcloud.com, t.me, tiktok.com, tumblr.com, twitter.com, vk.com, wikipedia.org, wordpress.com.',
    '"Linus Torvalds" (real name, seeded at L2) appears in the github.com result: GitHub shows the display name "Linus Torvalds" on this profile.',
    'Both halves are unverified. The handle match is what a tool reported; the real name match is a string match this app made.'
  ],
  caveats: [
    'The two levels ran 4 minutes apart (L1 at 2026-08-30 18:57, L2 at 2026-08-30 19:00). These sites answer inconsistently — Sherlock alone returned a different count on two runs minutes apart — so part of any difference here is the internet having a different moment, not the seed.',
    '2 of 3 checks at L2 produced no answer at all — holehe (email → account existence) and Reddit profile (behavioural read of one account). Anything they would have covered is unchecked, not clear.',
    '1 source present at the lower level is absent here. That is far more likely to be a rate limit than a removal — check the run notes before reading it as progress.',
    'Attribution matches are string matches this app made, not claims a tool asserted. A common name or a city that is also an ordinary word will match strangers. Read the excerpt before believing the link.',
    'Every finding underneath this is unverified unless it says otherwise. Two independent sources make a claim corroborated; only you, with a note, can make one confirmed.'
  ]
}

export const FIXTURE_REPORT: ExposureReport = {
  caseId: CASE_L2,
  level: 2,
  at: AT,
  snapshotId: 'sas_01M1A0QXEJAWTGT36YHZTQYM3W',
  appearances: PLATFORMS.map((platform) => ({
    sourceKey: platform,
    platform,
    handles: ['torvalds'],
    urls: [`https://${platform}/torvalds`],
    confidence: 'unverified' as const,
    tools: ['maigret'],
    findingIds: [`fnd_${platform.replace(/\W/g, '')}`],
    attributed: platform === 'github.com'
  })),
  unchecked: CHECKS.filter((c) => c.outcome !== 'answered'),
  telemetry: TELEMETRY,
  /* One claim left behind by a seed the operator purged out of this case. The observation
     happened and its capture is permanent, but nothing here still names what caused it —
     so it gets its own section and is counted nowhere above. */
  orphaned: [
    {
      ...finding('launchpad.net', 'Maigret found a claimed account for "torvalds" on Launchpad at https://launchpad.net/~torvalds.'),
      orphaned: true
    }
  ],
  remediation: [
    {
      id: 'handle:torvalds',
      kind: 'handle-reuse',
      action:
        'Retire the handle torvalds on the accounts you want kept separate. No site is confirmed to use it yet: all 17 hits — bit.ly, bsky.app, dailymotion.com among them — rest on one tool and nobody’s judgement.',
      effect:
        'Anyone who finds one of these finds the rest by typing the same string into a username sweep. One of them also carries a fact you seeded, so the chain ends at a person rather than at another pseudonym.',
      reach: 0,
      unverifiedReach: 17,
      effort: 'an evening',
      targets: PLATFORMS,
      evidence: [],
      confidence: 'unverified',
      caveat:
        'Username hits are the single most false-positive-prone thing this app produces — an anti-bot page answering 200 reads as "account exists". Open each one before you act on it.'
    },
    {
      id: 'account:github.com/torvalds',
      kind: 'account',
      action: 'Delete or lock the github.com account (torvalds)',
      effect:
        'Removes one of the 24 accounts this level found. GitHub has a published erasure route, so this is a request you can actually send.',
      reach: 0,
      unverifiedReach: 1,
      effort: 'minutes',
      targets: ['github.com'],
      evidence: [],
      confidence: 'unverified',
      caveat:
        'This is still a candidate — no human has confirmed the account exists. Open it before you write to anyone about it.'
    },
    {
      id: 'unchecked',
      kind: 'unchecked',
      action: 'Re-run 3 tools from a different network before trusting the shape of this report.',
      effect:
        'This does not reduce exposure. 3 of 4 checks produced no answer at all, so the report below is a floor, not a total — and a floor built mostly from refusals is close to meaningless.',
      reach: 3,
      unverifiedReach: 0,
      effort: 'minutes',
      targets: ['holehe', 'Reddit profile', 'blackbird'],
      evidence: [],
      confidence: 'unverified',
      caveat: null
    }
  ],
  resetPaths: {
    edges: [],
    hubs: [],
    unchecked: [
      {
        platform: 'spotify.com',
        reason:
          'holehe was rate-limited here and got no verdict. Whether this address recovers an account on this site is unknown.',
        tool: 'holehe'
      },
      {
        platform: 'github.com',
        reason:
          'An account was reported here, and no recovery oracle in this build covers this site. What recovers it is unknown.',
        tool: 'none'
      }
    ],
    chains: [],
    degraded: true,
    degradedNote:
      'The recovery oracle was refused more than it was answered: Only 2 of 122 sites answered, and 120 refused. The few that answered said no. Absent edges on this map mean "not checked", not "not recoverable".'
  }
}

export const FIXTURE_RESCAN: RescanDiff = {
  level: 2,
  caseId: CASE_L2,
  previous: {
    id: 'sas_prev',
    level: 2,
    caseId: CASE_L2,
    at: '2026-08-24T09:12:00.000Z',
    counts: { claims: 84, telemetry: 3, accounts: 26, sources: 26, silentChecks: 1 }
  },
  current: {
    id: 'sas_l2',
    level: 2,
    caseId: CASE_L2,
    at: AT,
    counts: { claims: 81, telemetry: 3, accounts: 24, sources: 24, silentChecks: 2 }
  },
  appeared: [finding('kick.com', 'Maigret found a claimed account for "torvalds" on Kick at https://kick.com/torvalds. HTTP 200.')],
  disappeared: [
    finding('spotify.com', 'holehe reports that an account is registered to test@example.com on Spotify (spotify.com).'),
    finding('launchpad.net', 'Maigret found a claimed account for "torvalds" on Launchpad at https://launchpad.net/~torvalds. HTTP 200.')
  ],
  stillThere: 80,
  unexplained: [
    finding('launchpad.net', 'Maigret found a claimed account for "torvalds" on Launchpad at https://launchpad.net/~torvalds. HTTP 200.')
  ],
  explainedBySilence: [
    {
      finding: finding(
        'spotify.com',
        'holehe reports that an account is registered to test@example.com on Spotify (spotify.com).'
      ),
      because:
        'Only 2 of 122 sites answered, and 120 refused. The few that answered said no. A run with this little coverage says essentially nothing about where the address is registered.'
    }
  ],
  verdict:
    'Over 6 days: 1 claim disappeared while the tool that used to report it answered normally. That is the only kind of disappearance that supports "it worked", and it still supports it weakly — these tools miss things they found the day before. 1 disappeared because the tool was refused this time, not because anything was removed. Read those as unchecked. 1 claim appeared that was not there before. 80 unchanged.'
}

export const FIXTURE_STATE: SelfAuditState = {
  profile: {
    values: {
      ...emptySeedValues(),
      usernames: ['torvalds'],
      emails: ['test@example.com'],
      names: ['Linus Torvalds']
    },
    updatedAt: '2026-08-30T18:56:00.000Z'
  },
  hasProfile: true,
  levels: [0, 1, 2, 3, 4].map((n) => ({
    level: n as 0 | 1 | 2 | 3 | 4,
    code: `L${n}`,
    caseId: n <= 2 ? `2026-08-30-self-audit-l${n}-bew6fhrp` : null,
    seedCount: n === 0 ? 1 : n === 1 ? 2 : 3,
    missing: n === 3 ? ['cities', 'schools'] : n === 4 ? ['cities', 'schools', 'phones', 'family'] : [],
    latest:
      n <= 2
        ? {
            id: `sas_l${n}`,
            level: n as 0 | 1 | 2 | 3 | 4,
            caseId: `2026-08-30-self-audit-l${n}-bew6fhrp`,
            at: n === 2 ? AT : '2026-08-30T18:57:11.000Z',
            counts: {
              claims: n === 0 ? 82 : n === 1 ? 82 : 81,
              telemetry: n === 0 ? 2 : 3,
              accounts: n === 2 ? 24 : 25,
              sources: n === 2 ? 24 : 25,
              silentChecks: n === 0 ? 1 : 2
            }
          }
        : null,
    snapshotCount: n <= 2 ? (n === 2 ? 2 : 1) : 0
  })),
  run: null,
  vaultPath: '/home/user/osint-workbench/cases/_selfaudit/profile.json'
}

/**
 * A real letter, copied verbatim out of the engine's own output for `reddit.com`.
 *
 * Here so the letter column can be measured at the length a real Article 17 request
 * actually runs to. The generator lives in the main process; this is a photograph of what
 * it produced on 2026-08-30.
 */
export const FIXTURE_LETTER: GdprLetter = {
  subject: 'Request for erasure of personal data — Article 17 GDPR — torvalds',
  body: `To: Reddit
    Reddit, Inc., with an EU representative designated under Art. 27 GDPR
    privacy@reddit.com
    https://www.reddit.com/settings/data-request
Date: 2026-08-30

Dear Sir or Madam,

I am a data subject residing in the European Union and I am exercising my rights under Regulation (EU) 2016/679 (GDPR).

My account is identified by:
  Username / profile:  torvalds
  Registered email:    test@example.com
  Name on the account: Linus Torvalds

Under Article 17(1) GDPR I request the erasure, without undue delay, of all personal data concerning me that Reddit processes in connection with the account identified above. This includes the account record itself, the content posted from it, profile and contact details, device and location data, and any inferred or derived data such as interest, behavioural or advertising profiles built from my activity.

This account was created while I was a child. Article 17(1)(f) applies: the personal data were collected in relation to the offer of information society services referred to in Article 8(1), and Recital 65 states expressly that the right to erasure is of particular relevance where consent was given as a child and the data subject later wishes to remove such data. I ask that this be taken into account in assessing any claimed overriding interest in retention.

In addition, I request that you:

  1. Confirm, under Article 12(3), within one month of receipt what has been erased and what has been retained;
  2. State the specific legal ground under Article 17(3) for anything you retain, rather than a general reference to legal obligations — a categorical refusal without identifying the obligation is not a reasoned answer;
  3. Communicate the erasure to each recipient to whom the data were disclosed, as Article 19 requires, and inform me of those recipients on request;
  4. Cease any further processing of the data for training, fine-tuning or evaluating machine-learning or artificial intelligence models, and confirm whether my data have already been used for that purpose and what has been done about it;
  5. Confirm whether backups have been excluded from the erasure and, if so, when the retention period on those backups expires.

Under Article 12(6) you may request additional information necessary to confirm my identity. I ask that any such request be proportionate: I am not willing to supply a government identity document to a service that never held one, and Recital 64 does not require me to.

This request is free of charge under Article 12(5).

Yours faithfully,

Linus Torvalds

Reply to: test@example.com`,
  contact: {
    key: 'reddit',
    name: 'Reddit',
    controller: 'Reddit, Inc., with an EU representative designated under Art. 27 GDPR',
    email: 'privacy@reddit.com',
    form: 'https://www.reddit.com/settings/data-request',
    postal: null,
    note: 'Deleting a Reddit account leaves the comments in place as [deleted].',
    verified: false
  },
  escalation: `If no substantive reply arrives within one month, or the reply refuses the request without the reasoning Art. 12(4) requires, the complaint goes to the Bulgarian supervisory authority:

Commission for Personal Data Protection (Комисия за защита на личните данни)
2 Prof. Tsvetan Lazarov Blvd., Sofia 1592, Bulgaria
kzld@cpdp.bg · +359 2 915 3518 · www.cpdp.bg

Under Art. 38(1) of the Bulgarian Personal Data Protection Act a complaint is filed within six months of becoming aware of the infringement and no later than two years after it occurred.`,
  warnings: [
    "The contact below was transcribed from Reddit's published privacy documentation and is not verified. Privacy addresses move. Confirm it on the platform's own page before you send.",
    'Deleting a Reddit account leaves the comments in place as [deleted]. If you want the content gone as well as the account, the letter has to say so — the default deletion is not erasure of the posts.',
    'Send it in a way that produces a timestamp you keep. The one-month clock in Article 12(3) runs from receipt, and you have to be able to show when that was.'
  ]
}

export const FIXTURE_CHECKS = CHECKS
