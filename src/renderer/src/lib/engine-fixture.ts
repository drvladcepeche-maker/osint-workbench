/**
 * A worked investigation, for driving the brief outside Electron. **Development only.**
 *
 * Same contract as `selfaudit-fixture.ts`: `fixtures.ts` is loaded dynamically behind
 * `import.meta.env.DEV && !window.osint`, so none of this reaches a production bundle.
 *
 * The subject is `github.com/torvalds` — a public account, deliberately neutral, and the
 * same anchor the engine was verified against on live data. Everything below has the shape
 * a real run produces: one route the account holder declared, one reached by a handle
 * sweep, one contradicted lead, one branch cut, and two questions nobody but the operator
 * can settle.
 */

import type {
  EngineDecision,
  InvestigationBrief,
  InvestigationRunState,
  NodeRef,
  PlannedAction,
  ProvenanceChain,
  ProvenanceHop,
  StopState
} from '../../../shared/engine'
import { chainLine } from '../../../shared/engine'

const CASE = '2026-08-30-self-audit-l0-01j9kq3f'
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

const ROOT: NodeRef = {
  id: 'ent_aa01bb02cc03dd04ee05',
  kind: 'account',
  value: 'github.com/torvalds',
  label: 'github.com/torvalds'
}
const PERSON: NodeRef = {
  id: 'ent_bb11cc22dd33ee44ff55',
  kind: 'person',
  value: 'linus torvalds',
  label: 'Linus Torvalds'
}
const AVATAR: NodeRef = {
  id: 'ent_cc21dd32ee43ff54aa65',
  kind: 'image',
  value: 'sha256:8f14e45fceea167a5a36dedd4bea2543',
  label: 'avatar from github.com/torvalds'
}
const MASTODON: NodeRef = {
  id: 'ent_dd31ee42ff53aa64bb75',
  kind: 'account',
  value: 'mastodon.social/kernelnotes',
  label: 'mastodon.social/kernelnotes'
}
const SOUNDCLOUD: NodeRef = {
  id: 'ent_ee41ff52aa63bb74cc85',
  kind: 'account',
  value: 'soundcloud.com/torvalds',
  label: 'soundcloud.com/torvalds'
}
const OTHER_NAME: NodeRef = {
  id: 'ent_ff51aa62bb73cc84dd95',
  kind: 'person',
  value: 'marta silva',
  label: 'Marta Silva'
}

function hop(
  to: NodeRef,
  from: NodeRef | null,
  mechanism: ProvenanceHop['mechanism'],
  detail: string,
  source: string | null,
  tool: string | null,
  offset: number
): ProvenanceHop {
  return {
    id: `hop_fixture_${to.id}_${mechanism}`,
    caseId: CASE,
    to,
    from,
    mechanism,
    findingId: tool ? `fnd_fixture_${to.id}` : null,
    tool,
    source,
    detail,
    at: iso(offset)
  }
}

const H_ROOT = hop(ROOT, null, 'seed', 'You put this into the case yourself.', null, null, -600_000)
const H_PERSON = hop(
  PERSON,
  ROOT,
  'profile-field',
  'github.com shows the display name "Linus Torvalds" on this profile.',
  'github.com',
  'profile-enrich',
  -540_000
)
const H_AVATAR = hop(
  AVATAR,
  ROOT,
  'profile-field',
  'The profile carries an avatar; the bytes were fetched and hashed so a re-encode elsewhere still matches.',
  'github.com',
  'profile-enrich',
  -535_000
)
const H_MASTODON = hop(
  MASTODON,
  ROOT,
  'declared-link',
  'The github.com profile links out to mastodon.social/kernelnotes with rel="me". The account holder put that link there.',
  'github.com',
  'profile-enrich',
  -520_000
)
const H_SOUNDCLOUD = hop(
  SOUNDCLOUD,
  ROOT,
  'handle-sweep',
  'maigret reports that the handle "torvalds" is taken on soundcloud.com.',
  'soundcloud.com',
  'maigret',
  -480_000
)
const H_OTHER = hop(
  OTHER_NAME,
  SOUNDCLOUD,
  'profile-field',
  'soundcloud.com shows the display name "Marta Silva" on this profile.',
  'soundcloud.com',
  'profile-enrich',
  -420_000
)

function chain(hops: ProvenanceHop[], overrides: Partial<ProvenanceChain> = {}): ProvenanceChain {
  const last = hops[hops.length - 1]!
  return {
    node: last.to,
    root: hops[0]!.to,
    hops,
    depth: hops.length - 1,
    rootIsSeed: true,
    rootIsAnchor: true,
    fullyDeclared: hops.every((h) => h.mechanism === 'seed' || h.mechanism === 'declared-link'),
    weakest: 'observed',
    alternates: 0,
    pruned: false,
    line: chainLine(hops),
    ...overrides
  }
}

export const FIXTURE_CHAINS: ProvenanceChain[] = [
  chain([H_ROOT], { weakest: 'declared', fullyDeclared: true }),
  chain([H_ROOT, H_MASTODON], { weakest: 'declared', fullyDeclared: true, alternates: 1 }),
  chain([H_ROOT, H_PERSON]),
  chain([H_ROOT, H_AVATAR]),
  chain([H_ROOT, H_SOUNDCLOUD], { weakest: 'inferred' }),
  chain([H_ROOT, H_SOUNDCLOUD, H_OTHER], { weakest: 'inferred', pruned: true })
]

const STOPS: StopState = {
  runsUsed: 9,
  elapsedMs: 214_000,
  depthReached: 2,
  quietExpansions: 3,
  contradictedShare: 0.18,
  conditions: [
    { id: 'budget-runs', fired: false, pressure: 0.38, detail: '9 of 24 runs used.' },
    { id: 'budget-time', fired: false, pressure: 0.24, detail: '214s of 900s used.' },
    {
      id: 'depth',
      fired: false,
      pressure: 1,
      detail: '2 actions sit past the 2-hop cap. Depth 3 opens only from an anchor you have confirmed.'
    },
    {
      id: 'novelty',
      fired: true,
      pressure: 1,
      detail:
        '3 of the last 3 expansions produced no lead the engine may act on — nothing corroborated, and no link the subject declared. At 3 it stops: more of the same sweep will not turn into a different answer.'
    },
    {
      id: 'contradiction',
      fired: false,
      pressure: 0.36,
      detail:
        '1 branch cut for contradiction density so far. The most contradicted branch still standing is "keybase.io/torvalds": 2 of 11 leads under it disagree with your seeds (18%). At 50% over 4 leads that branch is cut — the branch, not the investigation. A handle collision producing eleven strangers should cost the branch it is on and nothing else.'
    },
    { id: 'exhausted', fired: false, pressure: 0, detail: 'Actions remain.' },
    { id: 'cancelled', fired: false, pressure: 0, detail: 'Running.' },
    { id: 'failed', fired: false, pressure: 0, detail: 'No failure.' }
  ],
  fired: {
    id: 'novelty',
    fired: true,
    pressure: 1,
    detail:
      '3 of the last 3 expansions produced no lead the engine may act on — nothing corroborated, and no link the subject declared. At 3 it stops: more of the same sweep will not turn into a different answer.'
  }
}

const NEXT: PlannedAction[] = [
  {
    key: 'profile-enrich:' + MASTODON.id,
    adapterId: 'profile-enrich',
    adapterTitle: 'Profile enrichment',
    node: MASTODON,
    nodeState: 'candidate',
    depth: 1,
    gain: 88,
    basis: 'prior',
    blocked: null,
    reason:
      'Every hop that reached it is the subject’s own assertion: seed:account(github.com/torvalds) → declared link → mastodon.social/kernelnotes. Nothing has read the page behind this yet.',
    signals: [
      {
        id: 'declared-hop',
        points: 12,
        detail:
          'Every hop that reached it is the subject’s own assertion: seed:account(github.com/torvalds) → declared link → mastodon.social/kernelnotes'
      },
      {
        id: 'unenriched',
        points: 20,
        detail:
          'Nothing has read the page behind this yet. A sweep establishes that a handle is taken; the profile is where the name, the picture and the declared links are.'
      },
      { id: 'never-probed', points: 6, detail: 'Nothing has been pointed at this at all, so anything it says will be new.' },
      {
        id: 'adapter-yield',
        points: 8,
        detail:
          'Estimated, not measured — the engine has not run this here yet. The prior says 0.80 because it is the only adapter that answers "who is this" rather than "does this exist".'
      }
    ]
  },
  {
    key: 'reverse-image:' + AVATAR.id,
    adapterId: 'reverse-image',
    adapterTitle: 'Reverse image search',
    node: AVATAR,
    nodeState: 'candidate',
    depth: 1,
    gain: 61,
    basis: 'prior',
    blocked: null,
    reason:
      'Nothing has been pointed at this at all, so anything it says will be new. One source and nothing else. Unverified by construction, and most things here correctly stay that way.',
    signals: [
      { id: 'never-probed', points: 6, detail: 'Nothing has been pointed at this at all, so anything it says will be new.' },
      {
        id: 'single-unverified',
        points: -12,
        detail: 'One source and nothing else. Unverified by construction, and most things here correctly stay that way.'
      },
      {
        id: 'adapter-yield',
        points: 1,
        detail:
          'Estimated, not measured — the engine has not run this here yet. The prior says 0.55 because an avatar match is among the strongest links an unauthenticated lookup can produce, and it also returns nothing at all a good share of the time.'
      }
    ]
  }
]

const BLOCKED: PlannedAction[] = [
  {
    key: 'maigret:' + ROOT.id,
    adapterId: 'maigret',
    adapterTitle: 'maigret',
    node: ROOT,
    nodeState: 'entity',
    depth: 0,
    gain: 52,
    basis: 'prior',
    blocked: 'maigret has already been run against this in this investigation. Running it again would re-read the same page.',
    reason: 'You put github.com/torvalds into the case yourself. It is the ground the rest of the case hangs from.',
    signals: []
  },
  {
    key: 'profile-enrich:' + SOUNDCLOUD.id,
    adapterId: 'profile-enrich',
    adapterTitle: 'Profile enrichment',
    node: SOUNDCLOUD,
    nodeState: 'candidate',
    depth: 1,
    gain: 34,
    basis: 'prior',
    blocked:
      'Waiting on you. One independent source so far (soundcloud.com), so it is unverified and stays that way until something else says the same thing. Whether this is the same person is the call the engine cannot make.',
    reason: 'One source and nothing else. Unverified by construction, and most things here correctly stay that way.',
    signals: []
  }
]

const DECISIONS: EngineDecision[] = [
  {
    id: 'dec_f6',
    caseId: CASE,
    kind: 'stopped',
    at: iso(-60_000),
    reason:
      'Stopped: 3 of the last 3 expansions produced no lead the engine may act on — nothing corroborated, and no link the subject declared. At 3 it stops: more of the same sweep will not turn into a different answer.',
    node: null,
    adapterId: null,
    gain: null
  },
  {
    id: 'dec_f5',
    caseId: CASE,
    kind: 'pruned',
    at: iso(-120_000),
    reason:
      '4 of 6 leads under "soundcloud.com/torvalds" state a name, a gender or a place that disagrees with your seeds — 67%, above the 50% at which a branch is being shared by several different people. Cut 3 nodes; 3 candidates dismissed. Nothing was deleted and restoring the node puts every one of them back.',
    node: SOUNDCLOUD,
    adapterId: null,
    gain: null
  },
  {
    id: 'dec_f4',
    caseId: CASE,
    kind: 'expanded',
    at: iso(-300_000),
    reason:
      'account mastodon.social/kernelnotes, reached from account github.com/torvalds. 2 independent sources agree: github.com, mastodon.social. Independence is folded to the site operator, so this is two different sites and not one site answering twice. Expanding without asking.',
    node: MASTODON,
    adapterId: null,
    gain: null
  },
  {
    id: 'dec_f3',
    caseId: CASE,
    kind: 'ran',
    at: iso(-420_000),
    reason:
      'Chose Profile enrichment on account github.com/torvalds at 0 hops out, expected gain 91 (estimated, not measured). You put github.com/torvalds into the case yourself.',
    node: ROOT,
    adapterId: 'profile-enrich',
    gain: 91
  },
  {
    id: 'dec_f2',
    caseId: CASE,
    kind: 'skipped',
    at: iso(-425_000),
    reason:
      'Ranked 52 against 91 for Profile enrichment on account github.com/torvalds. Thousands of probes of which a handful mean anything.',
    node: ROOT,
    adapterId: 'maigret',
    gain: 52
  },
  {
    id: 'dec_f1',
    caseId: CASE,
    kind: 'seeded',
    at: iso(-600_000),
    reason: 'account github.com/torvalds is where this investigation starts.',
    node: ROOT,
    adapterId: null,
    gain: null
  }
]

export const FIXTURE_ENGINE_RUN: InvestigationRunState = {
  caseId: CASE,
  phase: 'done',
  startedAt: iso(-600_000),
  finishedAt: iso(-60_000),
  budget: {
    maxRuns: 24,
    maxWallClockMs: 900_000,
    maxDepth: 2,
    noveltyWindow: 3,
    contradictionShare: 0.5,
    contradictionFloor: 4
  },
  runsUsed: 9,
  running: [],
  depthReached: 2,
  quietExpansions: 3,
  leads: { expanded: 3, probed: 1, asked: 4, parked: 2 },
  pruned: 3,
  stop: STOPS.fired,
  message:
    '9 runs, 2 hops out. 3 expanded on two sources, 1 read once on a link the subject published, 4 waiting on you, 2 parked. Stopped on novelty: 3 of the last 3 expansions produced no lead the engine may act on.',
  error: null
}

export const FIXTURE_BRIEF: InvestigationBrief = {
  caseId: CASE,
  generatedAt: iso(0),
  headline: '4 established, 5 pending, 2 contradicted, 3 pruned. 2 questions for you. Stopped on novelty.',
  established: [
    {
      node: ROOT,
      route: chainLine([H_ROOT]),
      depth: 0,
      independentSources: 2,
      note: '11 claims from 2 independent sources. At least one claim is corroborated.',
      inGraph: true
    },
    {
      node: MASTODON,
      route: chainLine([H_ROOT, H_MASTODON]),
      depth: 1,
      independentSources: 2,
      note:
        '2 independent sources agree: github.com, mastodon.social. Independence is folded to the site operator, so this is two different sites and not one site answering twice. Expanding without asking.',
      inGraph: false
    },
    {
      node: PERSON,
      route: chainLine([H_ROOT, H_PERSON]),
      depth: 1,
      independentSources: 2,
      note: 'Two sites print the same display name on profiles reached from the anchor.',
      inGraph: false
    },
    {
      node: AVATAR,
      route: chainLine([H_ROOT, H_AVATAR]),
      depth: 1,
      independentSources: 1,
      note: 'The picture is on disk and hashed, so a re-encode of it elsewhere would still match.',
      inGraph: false
    }
  ],
  pending: [
    {
      node: SOUNDCLOUD,
      route: chainLine([H_ROOT, H_SOUNDCLOUD]),
      depth: 1,
      independentSources: 1,
      note:
        'One independent source so far (soundcloud.com), so it is unverified and stays that way until something else says the same thing. Whether this is the same person is the call the engine cannot make.',
      inGraph: false
    }
  ],
  contradicted: [
    {
      node: OTHER_NAME,
      route: chainLine([H_ROOT, H_SOUNDCLOUD, H_OTHER]),
      depth: 2,
      independentSources: 1,
      note:
        'Parked: it states something that disagrees with your seeds — a different personal name, or a gender the seeded name does not read as. Nothing is deleted and the seed could be the thing that is wrong, but the engine will not spend runs down this route.',
      inGraph: false
    }
  ],
  pruned: [
    {
      node: SOUNDCLOUD,
      route: chainLine([H_ROOT, H_SOUNDCLOUD]),
      depth: 1,
      independentSources: 1,
      note:
        '4 of 6 leads under "soundcloud.com/torvalds" state a name, a gender or a place that disagrees with your seeds — 67%. Cut rather than spent on further.',
      inGraph: false
    }
  ],
  next: NEXT,
  blocked: BLOCKED,
  questions: [
    {
      node: SOUNDCLOUD,
      question: 'Is soundcloud.com/torvalds the same person as account github.com/torvalds?',
      why:
        'Two profiles can carry the same handle, the same picture and the same city and still belong to two people. What settles it is knowing the subject, and that is the one thing here that is not on a page the engine can fetch.',
      route: chainLine([H_ROOT, H_SOUNDCLOUD]),
      unlocks: 'Say yes and 2 actions against it open up, including anything one hop further out.',
      weight: 58,
      url: 'https://soundcloud.com/torvalds'
    },
    {
      node: OTHER_NAME,
      question: 'Is "Marta Silva" the subject’s real name?',
      why:
        'Two profiles can carry the same handle, the same picture and the same city and still belong to two people. What settles it is knowing the subject, and that is the one thing here that is not on a page the engine can fetch.',
      route: chainLine([H_ROOT, H_SOUNDCLOUD, H_OTHER]),
      unlocks: 'Answering it settles the lead; nothing further is waiting on it right now.',
      weight: 12,
      url: null
    }
  ],
  questionsTotal: 4,
  stops: STOPS,
  decisions: DECISIONS,
  chains: FIXTURE_CHAINS,
  neverRun: false
}
