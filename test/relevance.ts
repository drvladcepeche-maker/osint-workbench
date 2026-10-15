/**
 * Ranking, contradiction, links and gender.
 *
 * ## What these are pointed at
 *
 * The scorer's whole value is in the *negative* half, so most of this file is about
 * signals that fire against a row. The cases are modelled directly on a real consented run
 * — synthetic names throughout, and deliberately so: no real person's details belong in
 * this repository, and the patterns are what matter, not the strings.
 *
 * Three properties are asserted as invariants rather than as examples, because they are
 * the rules that outrank the arithmetic and a numbers change must not be able to break
 * them quietly:
 *
 *   1. **Absent evidence is not evidence.** A row with no display name scores exactly the
 *      neutral base, whatever else is seeded.
 *   2. **A location can never sink a row.** Any number of place conflicts, with no other
 *      conflict, still leaves the row out of the contradicted band.
 *   3. **Nothing here touches confidence.** Asserted structurally: the assessment carries
 *      no confidence field and the ranking functions take findings by value.
 */

import assert from 'node:assert/strict'
import {
  AGE_BAND_LABEL,
  RELEVANCE_BASE,
  RELEVANCE_POINTS,
  RELEVANCE_SHORT,
  assessRelevance,
  bandOf,
  cleanSubject,
  emptyStatedFields,
  handleAdvice,
  minimumAgeFromJoinYear,
  resolveSubject,
  statedFields,
  type RelevanceRow,
  type SeedContext
} from '../src/shared/relevance'
import {
  MAX_LINK_LABEL,
  fusedPunctuation,
  linkHref,
  linkLabelFor,
  linkSpans,
  shortLinkLabel,
  sourceHref,
  trailingLink,
  trimUrlPunctuation
} from '../src/shared/links'
import { countryOfHost, countryOfPlace, countryOfPlatform } from '../src/shared/geo'
import { inferGender, surnameGender, tableGender } from '../src/shared/names'
import {
  anchorEntityIds,
  anchorsFor,
  contradictionSummary,
  rankBy,
  rowFromCandidate,
  seedContextFrom
} from '../src/shared/ranking'
import type { CandidateView, Entity } from '../src/shared/types'

type Test = (name: string, fn: () => void | Promise<void>) => void

/* ------------------------------------------------------------------ *
 * Fixtures — synthetic throughout
 * ------------------------------------------------------------------ */

const YEAR = 2026

function row(over: Partial<RelevanceRow> = {}): RelevanceRow {
  return {
    text: '',
    source: 'example.com',
    platform: 'example.com',
    handle: null,
    anchored: false,
    stated: emptyStatedFields(),
    ...over
  }
}

/** A masculine Bulgarian subject with a common given name, one country, one age band. */
function seeds(over: Partial<SeedContext> = {}): SeedContext {
  const names = over.names ?? ['Кристиян Иванов']
  return {
    names,
    relatives: [],
    handles: ['krisi'],
    accounts: ['steamcommunity.com/krisi_2007'],
    places: ['Варна'],
    literals: [],
    subject: resolveSubject({ gender: null, ageBand: null, countries: ['BG'] }, names),
    ...over
  }
}

function entity(over: Partial<Entity> & Pick<Entity, 'kind' | 'value'>): Entity {
  return {
    id: `ent_${over.value}`,
    caseId: 'case',
    label: over.value,
    createdAt: '2026-01-01T00:00:00.000Z',
    seed: true,
    attrs: {},
    ...over
  } as Entity
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

export function relevanceTests(test: Test): void {
  /* ---------------- links ---------------- */

  test('links: a full stop is given back to the sentence, not kept in the URL', () => {
    assert.equal(trimUrlPunctuation('https://github.com/krisi.'), 'https://github.com/krisi')
    assert.equal(trimUrlPunctuation('https://github.com/krisi,'), 'https://github.com/krisi')
    assert.equal(trimUrlPunctuation('https://github.com/krisi…'), 'https://github.com/krisi')
    // A trailing slash is part of the address and some servers serve a different page.
    assert.equal(trimUrlPunctuation('https://reddit.com/r/x/'), 'https://reddit.com/r/x/')
  })

  test('links: a bracket the URL opened itself is kept; one the prose opened is not', () => {
    assert.equal(
      trimUrlPunctuation('https://en.wikipedia.org/wiki/Foo_(disambiguation)'),
      'https://en.wikipedia.org/wiki/Foo_(disambiguation)'
    )
    assert.equal(trimUrlPunctuation('https://example.com/x).'), 'https://example.com/x')
  })

  test('links: only http and https are openable', () => {
    assert.ok(linkHref('https://example.com'))
    assert.ok(linkHref('http://old-forum.example.com/user/x'))
    assert.equal(linkHref('file:///home/someone/secret.txt'), null)
    assert.equal(linkHref('javascript:alert(1)'), null)
    assert.equal(linkHref('data:text/html,<script>x</script>'), null)
    assert.equal(linkHref('ftp://example.com/x'), null)
    assert.equal(linkHref('not a url at all'), null)
  })

  test('links: a claim splits into spans that concatenate back to the original', () => {
    const claim =
      'Maigret reports that an account named "krisi" exists on GitHub. Profile: https://github.com/krisi'
    const spans = linkSpans(claim)
    assert.equal(spans.map((s) => s.text).join(''), claim)
    const links = spans.filter((s) => s.kind === 'link')
    assert.equal(links.length, 1)
    assert.equal(links[0]!.text, 'https://github.com/krisi')
  })

  test('links: a scheme the app will not open stays visible as prose', () => {
    const claim = 'The bio contains file:///home/someone/secret.txt, which is itself a finding.'
    const spans = linkSpans(claim)
    assert.equal(spans.map((s) => s.text).join(''), claim)
    assert.ok(spans.every((s) => s.kind === 'text'))
  })

  test('links: a source is a link only when it is a place', () => {
    assert.equal(sourceHref('github.com'), 'https://github.com/')
    assert.equal(sourceHref('local:pattern-timezone'), null)
    assert.equal(sourceHref('file:photo.jpg'), null)
    assert.equal(sourceHref('unknown site'), null)
  })

  test('links: fusedPunctuation names exactly the runs that carry sentence punctuation', () => {
    assert.deepEqual(fusedPunctuation('see https://a.example/x and https://b.example/y'), [])
    assert.deepEqual(fusedPunctuation('exists at https://a.example/x.'), ['https://a.example/x.'])
  })

  test('links: the address a claim ends with is split off, and the parts rebuild it', () => {
    const claim =
      'Maigret reports that an account named "krisi" exists on GitHub. Profile: https://github.com/krisi'
    const split = trailingLink(claim)
    assert.ok(split)
    assert.equal(split.link.href, 'https://github.com/krisi')
    assert.equal(split.after, '')
    // Nothing is dropped and nothing is reordered: the three parts are the claim.
    assert.equal(split.prose + split.link.text + split.after, claim)
    assert.ok(split.prose.endsWith('Profile: '))
  })

  test('links: a claim written the old way keeps its full stop, against the link', () => {
    // Findings already on disk from before the adapters were reworded still end in one.
    // They must still get a pinned link, and the character must still be drawn.
    const claim = 'Sherlock reports an account exists at https://about.me/krisi.'
    const split = trailingLink(claim)
    assert.ok(split)
    assert.equal(split.link.href, 'https://about.me/krisi')
    assert.equal(split.after, '.')
    assert.equal(split.prose + split.link.text + split.after, claim)
  })

  test('links: a URL with a sentence after it is not pinned, because that would reorder it', () => {
    assert.equal(
      trailingLink('The bio links https://example.com/x and the profile does not link back.'),
      null
    )
    assert.equal(trailingLink('No address in this claim at all.'), null)
  })

  test('links: the last address wins when a claim carries several', () => {
    const split = trailingLink('https://a.example/one redirects to https://b.example/two')
    assert.ok(split)
    assert.equal(split.link.href, 'https://b.example/two')
    // The earlier one stays in the prose and is still rendered as a link there.
    assert.ok(split.prose.includes('https://a.example/one'))
  })

  test('links: a short label drops the noise and keeps what identifies the page', () => {
    assert.equal(shortLinkLabel('https://github.com/krisi'), 'github.com/krisi')
    assert.equal(shortLinkLabel('https://www.youtube.com/@krisi'), 'youtube.com/@krisi')
    // A bare host keeps no trailing slash — it carries no information.
    assert.equal(shortLinkLabel('https://about.me/'), 'about.me')
  })

  test('links: an over-long address loses its middle, never its last segment', () => {
    const label = shortLinkLabel(
      'https://web.archive.org/web/20090411000000/http://example.com/users/krisi-profile'
    )
    assert.ok(label.length <= MAX_LINK_LABEL)
    assert.ok(label.startsWith('web.archive.org/'))
    // The identifying tail survives — truncating from the right would render every
    // snapshot in a case as the same prefix.
    assert.ok(label.endsWith('krisi-profile'))
    assert.ok(label.includes('…'))
  })

  test('links: a row does not print the same host twice', () => {
    // The Source cell already says `steamcommunity.com`; the pinned address says the rest.
    assert.equal(
      linkLabelFor('https://steamcommunity.com/id/krisi_2007', 'steamcommunity.com'),
      '/id/krisi_2007'
    )
    // `www.` is not a difference.
    assert.equal(linkLabelFor('https://www.youtube.com/@krisi', 'youtube.com'), '/@krisi')
  })

  test('links: a different host is the interesting thing on the row and is kept', () => {
    // A media file served off a CDN, a snapshot of another site: the host is the finding.
    assert.equal(
      linkLabelFor('https://cdn.example.net/media/1.jpg', 'gallery.example.com'),
      'cdn.example.net/media/1.jpg'
    )
    // A source that is not a host at all cannot be elided against.
    assert.equal(
      linkLabelFor('https://github.com/krisi', 'local:pattern-timezone'),
      'github.com/krisi'
    )
    // Nothing to say beyond the host the row already prints.
    assert.equal(linkLabelFor('https://about.me/', 'about.me'), 'about.me')
  })

  test('links: a host that fills the budget on its own is simply cut', () => {
    const label = shortLinkLabel('https://an-extremely-long-hostname-for-one-site.example.org/a/b')
    assert.ok(label.length <= MAX_LINK_LABEL)
    assert.ok(label.startsWith('an-extremely-long-hostname'))
  })

  /* ---------------- gender ---------------- */

  test('gender: the tables answer for a formal name and stay honest about a shared short form', () => {
    assert.equal(tableGender('Кристиян'), 'masculine')
    assert.equal(tableGender('Мария'), 'feminine')
    // `Тони` is the short form of both Антон and Антоанета, and says so.
    assert.equal(tableGender('Тони'), 'ambiguous')
    assert.equal(tableGender('Alex'), 'ambiguous')
    assert.equal(tableGender('Qwertyuiop'), 'unknown')
  })

  test('gender: a Bulgarian surname inflects, in both scripts', () => {
    assert.equal(surnameGender('Иванова').gender, 'feminine')
    assert.equal(surnameGender('Иванов').gender, 'masculine')
    assert.equal(surnameGender('Ivanova').gender, 'feminine')
    assert.equal(surnameGender('Petkovski').gender, 'masculine')
    assert.equal(surnameGender('Petkovska').gender, 'feminine')
    // Guards: too short, and a given name the tables already know.
    assert.equal(surnameGender('Ева').gender, 'unknown')
    assert.equal(surnameGender('Nova').gender, 'unknown')
  })

  test('gender: the surname wins over the given name, and the disagreement is recorded', () => {
    // A given name that is unambiguously masculine, against a surname that inflects
    // feminine. `Сашо` would not do here: it is a short form of both Александър and
    // Александра, so the tables correctly call it ambiguous and there is no clash to name.
    const reading = inferGender('Георги Иванова')
    assert.equal(reading.gender, 'feminine')
    assert.equal(reading.basis, 'surname-inflection')
    assert.ok(reading.why.includes('though'), `expected the clash to be named: ${reading.why}`)
  })

  test('gender: a Latin spelling of a Bulgarian name is read through transliteration', () => {
    const reading = inferGender('Georgi')
    assert.equal(reading.gender, 'masculine')
    assert.equal(reading.basis, 'transliteration')
  })

  test('gender: the -а ending rule fires on Cyrillic only, and knows its exceptions', () => {
    assert.equal(inferGender('Веселка').gender, 'feminine')
    // Masculine despite the ending. Without the exception list this is the failure the
    // operator complained about, in the other direction.
    assert.equal(inferGender('Никола').gender, 'masculine')
    assert.equal(inferGender('Илия').gender, 'masculine')
    // Latin is left alone: `Luca` and `Joshua` are not Bulgarian feminines.
    assert.equal(inferGender('Zzyzxa').gender, 'unknown')
  })

  test('gender: two seeded names that read differently produce ambiguous, not a coin toss', () => {
    const subject = resolveSubject(null, ['Кристиян Иванов', 'Мария Иванова'])
    assert.equal(subject.gender, 'ambiguous')
  })

  test('gender: an operator override beats every inference and says so', () => {
    const subject = resolveSubject({ gender: 'feminine', ageBand: null, countries: [] }, ['Кристиян Иванов'])
    assert.equal(subject.gender, 'feminine')
    assert.equal(subject.genderBasis, 'operator')
  })

  /* ---------------- stated fields ---------------- */

  test('statedFields reads this app\u2019s own claim templates', () => {
    // These strings are the templates in maigret.ts ID_FIELDS and profile-enrich.ts
    // PROFILE_FIELDS. If either is reworded without updating relevance.ts, this fails —
    // which is the point: a reworded claim would silently switch the strongest negative off.
    const f = statedFields(
      'GitHub shows the display name "Мария Петрова" on this profile. ' +
        'GitHub shows the location "Rio de Janeiro, Brazil" on this profile. ' +
        'GitHub records the gender "female" on this profile. ' +
        'GitHub reports the account was created at 2009-04-11.'
    )
    assert.deepEqual(f.displayNames, ['Мария Петрова'])
    assert.deepEqual(f.locations, ['Rio de Janeiro, Brazil'])
    assert.deepEqual(f.genders, ['female'])
    assert.deepEqual(f.created, ['2009-04-11'])
  })

  test('statedFields says nothing about a claim that states nothing', () => {
    const f = statedFields(
      'Sherlock reports that an account named "krisi" exists on Last.fm. Profile: https://last.fm/user/krisi'
    )
    assert.deepEqual(f.displayNames, [])
    assert.deepEqual(f.locations, [])
  })

  /* ---------------- geography ---------------- */

  test('geo: a country is read from a place, a ccTLD and a national platform', () => {
    assert.equal(countryOfPlace('Sofia, Bulgaria'), 'BG')
    assert.equal(countryOfPlace('Rio de Janeiro, Brazil'), 'BR')
    assert.equal(countryOfPlace('София, България'), 'BG')
    assert.equal(countryOfHost('abv.bg'), 'BG')
    assert.equal(countryOfPlatform('vk.com'), 'RU')
    // Not countries, whatever the two letters look like.
    assert.equal(countryOfHost('github.com'), null)
    assert.equal(countryOfHost('example.io'), null)
    assert.equal(countryOfHost('example.me'), null)
    assert.equal(countryOfHost('example.co.uk'), 'GB')
  })

  test('geo: a city is not mistaken for a country whose name contains it', () => {
    // `Rusk` must not find `Russia`, and `IN` inside `Indianapolis` must not find India.
    assert.equal(countryOfPlace('Rusk'), null)
    assert.equal(countryOfPlace('Indianapolis'), null)
  })

  /* ---------------- the scorer: absence ---------------- */

  test('absent evidence scores exactly the neutral base and lands in silent', () => {
    const r = assessRelevance(
      row({ text: 'Sherlock reports that an account named "krisi" exists on Last.fm.' }),
      seeds(),
      { year: YEAR }
    )
    assert.equal(r.band, 'silent')
    assert.equal(r.score, RELEVANCE_BASE)
    assert.equal(r.why, null)
    assert.deepEqual(r.signals, [])
  })

  /* ---------------- the scorer: the strong negatives ---------------- */

  test('a different recognisable personal name is a strong conflict, not missing evidence', () => {
    const r = assessRelevance(
      row({
        text: 'Facebook shows the display name "Петър Драганов" on this profile.',
        stated: { ...emptyStatedFields(), displayNames: ['Петър Драганов'] }
      }),
      seeds(),
      { year: YEAR }
    )
    assert.equal(r.band, 'contradicted')
    assert.ok(r.score < RELEVANCE_BASE)
    assert.ok(r.signals.some((s) => s.id === 'name-conflict' && s.weight === 'strong'))
    assert.ok(r.why && r.why.includes('Петър Драганов'))
  })

  test('a display name reading the other gender is a strong conflict', () => {
    const r = assessRelevance(
      row({
        text: 'Twitter shows the display name "Даниела Стоянова" on this profile.',
        stated: { ...emptyStatedFields(), displayNames: ['Даниела Стоянова'] }
      }),
      seeds(),
      { year: YEAR }
    )
    assert.equal(r.band, 'contradicted')
    assert.ok(r.signals.some((s) => s.id === 'gender-conflict' || s.id === 'name-conflict'))
    const gender = r.signals.find((s) => s.id === 'gender-conflict')
    assert.ok(gender, 'the gender signal must fire on a feminine name against a masculine seed')
    assert.equal(gender!.weight, 'strong')
  })

  test('a site\u2019s own gender field outranks the display name', () => {
    const r = assessRelevance(
      row({
        text: 'A site records the gender "female" on this profile.',
        stated: { ...emptyStatedFields(), genders: ['female'] }
      }),
      seeds(),
      { year: YEAR }
    )
    const g = r.signals.find((s) => s.id === 'gender-conflict')
    assert.ok(g)
    assert.ok(g!.detail.includes("gender field"), g!.detail)
  })

  test('a name of the right shape but nothing recognisable is only a moderate conflict', () => {
    const r = assessRelevance(
      row({
        text: 'Medium shows the display name "Marco Migozzi" on this profile.',
        stated: { ...emptyStatedFields(), displayNames: ['Marco Migozzi'] }
      }),
      seeds(),
      { year: YEAR }
    )
    assert.ok(r.signals.some((s) => s.id === 'name-shape-conflict'))
    // Moderate, so it lowers the score without putting the row in the bottom group.
    assert.notEqual(r.band, 'contradicted')
    assert.ok(r.score < RELEVANCE_BASE)
    assert.ok(r.why)
  })

  /* ---------------- the scorer: location may never sink a row ---------------- */

  test('a location conflict lowers a row and can never put it in the contradicted band', () => {
    const r = assessRelevance(
      row({
        text: 'A site shows the location "Rio de Janeiro, Brazil" on this profile.',
        stated: { ...emptyStatedFields(), locations: ['Rio de Janeiro, Brazil'] }
      }),
      seeds(),
      { year: YEAR }
    )
    const place = r.signals.find((s) => s.id === 'place-conflict')
    assert.ok(place, 'the place signal must fire')
    assert.equal(place!.weight, 'weak')
    assert.notEqual(r.band, 'contradicted')
    assert.ok(r.score < RELEVANCE_BASE)
    assert.ok(r.why && r.why.includes('Brazil'))
  })

  test('a weak or moderate conflict lands in questioned, never in silent', () => {
    // "Nothing either way" next to a visible negative number is the interface arguing with
    // itself. A row with a location that disagrees gets its own band, below silence.
    const r = assessRelevance(
      row({
        text: 'A site shows the location "Rio de Janeiro, Brazil" on this profile.',
        stated: { ...emptyStatedFields(), locations: ['Rio de Janeiro, Brazil'] }
      }),
      seeds(),
      { year: YEAR }
    )
    assert.equal(r.band, 'questioned')
  })

  test('bandOf: no number of weak or moderate conflicts reaches contradicted', () => {
    const weak = [
      { id: 'place-conflict', verdict: 'conflicts', weight: 'weak', points: -8, detail: '' },
      { id: 'place-conflict', verdict: 'conflicts', weight: 'weak', points: -8, detail: '' },
      { id: 'age-conflict', verdict: 'conflicts', weight: 'moderate', points: -18, detail: '' },
      { id: 'name-shape-conflict', verdict: 'conflicts', weight: 'moderate', points: -16, detail: '' }
    ] as const
    assert.notEqual(bandOf(weak as never), 'contradicted')
    assert.equal(
      bandOf([
        ...weak,
        { id: 'gender-conflict', verdict: 'conflicts', weight: 'strong', points: -34, detail: '' }
      ] as never),
      'contradicted'
    )
  })

  /* ---------------- the scorer: the anchor ---------------- */

  test('an anchor stays at the top even when its own location disagrees', () => {
    // This is the measured case: a Steam profile the operator supplied himself, genuinely
    // his, whose location field names a city he has never lived in. A naive country filter
    // would have deleted the best row in the run.
    const r = assessRelevance(
      row({
        anchored: true,
        source: 'steamcommunity.com',
        platform: 'steamcommunity.com',
        text: 'Steam Community shows the location "Rio de Janeiro, Brazil" on this profile.',
        stated: { ...emptyStatedFields(), locations: ['Rio de Janeiro, Brazil'] }
      }),
      seeds(),
      { year: YEAR }
    )
    assert.equal(r.band, 'anchor')
    assert.ok(r.signals.some((s) => s.id === 'place-conflict'), 'the conflict is still recorded')
    assert.ok(r.why, 'and it is still shown')
  })

  test('a seeded handle is never an anchor — that is what fans out to fifty strangers', () => {
    const entities = [
      entity({ kind: 'username', value: 'krisi' }),
      entity({ kind: 'account', value: 'steamcommunity.com/krisi_2007' }),
      entity({ kind: 'person', value: 'Кристиян Иванов', seed: false })
    ]
    const anchors = anchorEntityIds(entities)
    assert.ok(!anchors.has('ent_krisi'))
    assert.ok(anchors.has('ent_steamcommunity.com/krisi_2007'))
  })

  /**
   * The second anchor route, which was unreachable until a finding could be confirmed at
   * all. It has to honour the same exclusion as the first, or the rule above is a rule
   * about seeds that any single confirmation walks straight around.
   */
  test('confirming a finding about a handle does not turn the handle into an anchor', () => {
    const entities = [
      entity({ kind: 'username', value: 'krisi' }),
      entity({ kind: 'person', value: 'Кристиян Иванов' }),
      entity({ kind: 'account', value: 'steamcommunity.com/krisi_2007', seed: false })
    ]

    // One human confirmation about each of the three.
    const anchors = anchorsFor(entities, [
      { entityId: 'ent_krisi', confidence: 'confirmed' },
      { entityId: 'ent_Кристиян Иванов', confidence: 'confirmed' },
      { entityId: 'ent_steamcommunity.com/krisi_2007', confidence: 'confirmed' }
    ])

    // A handle stays what it is: the thing fifty strangers share. Confirming one sentence
    // about one site does not make it an identity, and must not open the deeper expansion
    // that anchoring buys for everything descending from it.
    assert.ok(!anchors.has('ent_krisi'), 'a confirmed finding must not anchor a username')
    assert.ok(!anchors.has('ent_Кристиян Иванов'), 'nor a person — a common name is the same problem')

    // An account names one thing, so confirming something about it is a claim about an
    // identity and does anchor — this is the route the engine's depth-3 unlock rides on,
    // and it must still work.
    assert.ok(
      anchors.has('ent_steamcommunity.com/krisi_2007'),
      'a confirmed finding about an account anchors it, even though it was never seeded'
    )

    // And an unconfirmed finding anchors nothing at all.
    assert.ok(
      !anchorsFor(entities, [{ entityId: 'ent_steamcommunity.com/krisi_2007', confidence: 'corroborated' }]).has(
        'ent_steamcommunity.com/krisi_2007'
      ),
      'corroborated is two tools agreeing; it is not a human vouching, and it does not anchor'
    )
  })

  test('only seeded entities feed the scorer, never promoted candidates', () => {
    const ctx = seedContextFrom(
      [
        entity({ kind: 'person', value: 'Кристиян Иванов' }),
        entity({ kind: 'person', value: 'Мария Петрова', seed: false })
      ],
      null
    )
    assert.deepEqual(ctx.names, ['Кристиян Иванов'])
  })

  /* ---------------- the scorer: the positives ---------------- */

  test('the seeded name found on a row is a strong positive', () => {
    const r = assessRelevance(
      row({
        text: 'YouTube shows the display name "Кристиян Иванов" on this profile.',
        stated: { ...emptyStatedFields(), displayNames: ['Кристиян Иванов'] }
      }),
      seeds(),
      { year: YEAR }
    )
    assert.equal(r.band, 'supported')
    assert.ok(r.score > RELEVANCE_BASE)
    assert.equal(r.why, null)
  })

  test('a diminutive of the seeded name matches and does not fire a name conflict', () => {
    const r = assessRelevance(
      row({
        text: 'A site shows the display name "Крис Иванов" on this profile.',
        stated: { ...emptyStatedFields(), displayNames: ['Крис Иванов'] }
      }),
      seeds({ names: ['Кристиян Иванов'] }),
      { year: YEAR }
    )
    assert.ok(!r.signals.some((s) => s.id === 'name-conflict'), 'a short form is not a different person')
  })

  /* ---------------- the scorer: age ---------------- */

  test('a join date bounds the age from below, and only from below', () => {
    assert.equal(minimumAgeFromJoinYear(2009, 2026), 30)
    assert.equal(minimumAgeFromJoinYear(2026, 2026), 13)

    const s = seeds()
    s.subject.ageBand = 'under-18'
    const old = assessRelevance(
      row({ stated: { ...emptyStatedFields(), created: ['2009-04-11'] } }),
      s,
      { year: YEAR }
    )
    assert.ok(old.signals.some((x) => x.id === 'age-conflict'))
    assert.ok(old.why && old.why.includes(AGE_BAND_LABEL['under-18']))

    // A recent account says nothing about an upper bound, so it must not conflict.
    const fresh = assessRelevance(
      row({ stated: { ...emptyStatedFields(), created: ['2025-01-02'] } }),
      s,
      { year: YEAR }
    )
    assert.ok(!fresh.signals.some((x) => x.id === 'age-conflict'))
  })

  /* ---------------- ordering ---------------- */

  test('ranking puts plausible rows above implausible ones and contradicted rows last', () => {
    const rows: { id: string; row: RelevanceRow }[] = [
      {
        id: 'feminine',
        row: row({
          text: 'Twitter shows the display name "Даниела Стоянова" on this profile.',
          stated: { ...emptyStatedFields(), displayNames: ['Даниела Стоянова'] }
        })
      },
      { id: 'silent', row: row({ text: 'An account named "krisi" exists on Last.fm.' }) },
      {
        id: 'questioned',
        row: row({
          text: 'A site shows the location "Rio de Janeiro, Brazil" on this profile.',
          stated: { ...emptyStatedFields(), locations: ['Rio de Janeiro, Brazil'] }
        })
      },
      {
        id: 'named',
        row: row({
          text: 'YouTube shows the display name "Кристиян Иванов" on this profile.',
          stated: { ...emptyStatedFields(), displayNames: ['Кристиян Иванов'] }
        })
      },
      { id: 'anchor', row: row({ anchored: true, text: 'Steam Community answered.' }) }
    ]
    const ranked = rankBy(
      rows,
      (r) => assessRelevance(r.row, seeds(), { year: YEAR }),
      (r) => r.id
    )
    assert.deepEqual(
      ranked.map((r) => r.item.id),
      ['anchor', 'named', 'silent', 'questioned', 'feminine']
    )
  })

  test('the contradicted summary carries a count and a reason, never a bare count', () => {
    const items = [
      { item: 1, relevance: assessRelevance(row({ stated: { ...emptyStatedFields(), displayNames: ['Петър Драганов'] } }), seeds(), { year: YEAR }) },
      { item: 2, relevance: assessRelevance(row({ stated: { ...emptyStatedFields(), displayNames: ['Даниела Стоянова'] } }), seeds(), { year: YEAR }) }
    ]
    const summary = contradictionSummary(items)
    assert.ok(summary.includes('2 row'), summary)
    assert.ok(/different personal name|other gender/.test(summary), summary)
    assert.ok(summary.includes('Nothing is deleted'), summary)
  })

  /* ---------------- candidates ---------------- */

  test('a person candidate\u2019s value is read as a display name', () => {
    const c: CandidateView = {
      id: 'ent_x',
      caseId: 'case',
      kind: 'person',
      value: 'мария петрова',
      label: 'Мария Петрова',
      attrs: {},
      proposals: [],
      state: 'pending',
      firstProposedAt: '2026-01-01T00:00:00.000Z',
      decidedAt: null,
      bestConfidence: 'unverified',
      independentSources: 1,
      claims: []
    }
    const r = assessRelevance(rowFromCandidate(c, seeds()), seeds(), { year: YEAR })
    assert.equal(r.band, 'contradicted')
  })

  /* ---------------- the common-handle advice ---------------- */

  test('a short handle that is also a given name is named as a weak starting point', () => {
    const advice = handleAdvice('krisi', [])
    assert.ok(advice)
    const ids = advice!.reasons.map((r) => r.id)
    assert.ok(ids.includes('short'))
    assert.ok(ids.includes('given-name'))
  })

  test('a run full of contradictions is itself the evidence', () => {
    const contradicted = assessRelevance(
      row({ stated: { ...emptyStatedFields(), displayNames: ['Петър Драганов'] } }),
      seeds(),
      { year: YEAR }
    )
    const silent = assessRelevance(row(), seeds(), { year: YEAR })
    const rows = [...Array(4).fill(contradicted), ...Array(6).fill(silent)]
    const advice = handleAdvice('unremarkablehandle', rows)
    assert.ok(advice, 'ten rows, four contradicted, is the pattern being named')
    assert.ok(advice!.reasons.some((r) => r.id === 'contradicted-results'))
    assert.equal(advice!.contradicted, 4)
  })

  test('an ordinary long handle with a clean run says nothing at all', () => {
    assert.equal(handleAdvice('unremarkablehandle', []), null)
  })

  /* ---------------- the untrusted boundary ---------------- */

  test('cleanSubject drops anything the app cannot name', () => {
    const s = cleanSubject({
      gender: 'other',
      ageBand: 'ancient',
      countries: ['bg', 'ZZZ', 42, 'BG', 'de']
    })
    assert.equal(s.gender, null)
    assert.equal(s.ageBand, null)
    assert.deepEqual(s.countries, ['BG', 'DE'])
  })

  test('every conflict has a short tag for the row and a sentence for the margin', () => {
    const r = assessRelevance(
      row({ stated: { ...emptyStatedFields(), displayNames: ['Петър Драганов'] } }),
      seeds(),
      { year: YEAR }
    )
    assert.ok(r.why && r.why.length > 20, 'the margin gets the whole sentence')
    assert.ok(r.whyShort && r.whyShort.length <= 20, 'the row gets two or three words')
    assert.equal(r.whyShort, RELEVANCE_SHORT['name-conflict'])
    // Every signal id has one, so a new signal cannot ship without a row label.
    for (const id of Object.keys(RELEVANCE_POINTS) as (keyof typeof RELEVANCE_POINTS)[]) {
      assert.ok(RELEVANCE_SHORT[id], `no short label for ${id}`)
    }
  })

  test('relevance carries no confidence and cannot express one', () => {
    const r = assessRelevance(row(), seeds(), { year: YEAR })
    assert.ok(!('confidence' in r), 'a relevance assessment must never carry a confidence')
    for (const s of r.signals) {
      assert.ok(!('confidence' in s))
    }
  })
}
