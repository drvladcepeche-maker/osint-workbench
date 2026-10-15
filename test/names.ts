/**
 * Name matching — the rules, and the weight each one is allowed to carry.
 *
 * Two things are under test here, and the second one matters more than the first.
 *
 *  1. **Recall.** That `Сашо` finds `Александър`, that `Георги` finds `Gueorgui`, that a
 *     reversed name and an initial-plus-surname are found at all. These are the misses
 *     that made literal matching close to useless against Bulgarian case material.
 *  2. **That recall is paid for out loud.** Every fuzzy rule is asserted to report a
 *     strength strictly below the literal full-name hit, and the deliberate false
 *     positives — `bill` the invoice matching `William`, `Chris` matching `Christian` —
 *     are asserted to come back `weak` rather than to be absent. A matcher that quietly
 *     returned them at full weight would pass a recall test and fail the product.
 *
 * All test data is either a public figure or invented. `Blimborg` is the suite's existing
 * invented token; the Bulgarian names built on it are invented for the same reason.
 */

import assert from 'node:assert/strict'

import {
  cyrillicFormsOf,
  latinFormsOf,
  matchName,
  matchNameAll,
  prepareText,
  MIN_NAME_LENGTH,
  NAME_RULE_FLOOR,
  strengthRank
} from '../src/shared/names'
import { seedHits } from '../src/main/selfaudit/match'

export function nameTests(test: (name: string, fn: () => void | Promise<void>) => void): void {
  /* ---------------------------------------------------------------- *
   * The literal baseline
   * ---------------------------------------------------------------- */

  test('names: a full literal name is the only thing that scores strong on its own', () => {
    const m = matchName('Linus Torvalds', 'Signed-off-by: Linus Torvalds <torvalds@example.org>')
    assert.ok(m, 'a literal full name must match')
    assert.equal(m.rule, 'exact')
    assert.equal(m.strength, 'strong')
    assert.equal(m.matched, 'Linus Torvalds')
    assert.ok(m.why.includes('exact match'), m.why)
  })

  test('names: a bare given name never reaches the weight of a full name', () => {
    const full = matchName('Linus Torvalds', 'Linus Torvalds wrote the first version.')
    const bare = matchName('Linus', 'Linus wrote the first version.')
    assert.ok(full && bare)
    assert.equal(full.strength, 'strong')
    assert.ok(
      strengthRank(bare.strength) < strengthRank(full.strength),
      `a single token scored ${bare.strength}, which is not below ${full.strength}`
    )
  })

  test('names: a span under the floor matches nothing at all', () => {
    assert.equal(MIN_NAME_LENGTH, 4)
    assert.equal(matchName('Nim', 'Nim Blimborgov posted a screenshot.'), null)
    assert.equal(matchName('Ян', 'Ян Блимборгов е автор на темата.'), null)
    // The floor is on the matched span, not on the seed: a short seed may still find a
    // long form of itself, and cannot find itself written out.
    assert.equal(matchName('Bob', 'bob is the name of the character'), null)
    assert.ok(matchName('Bob', 'reviewed by Robert Blimborgov'), 'Bob must still reach Robert')
  })

  test('names: a longer word is not a match for the name inside it', () => {
    assert.equal(matchName('Christian Blimborgov', 'a christianity forum thread'), null)
    assert.equal(matchName('Mira Blimborgova', 'the mirage was convincing'), null)
    assert.equal(matchName('Alexander Blimborgov', 'shipped to Alexandria last week'), null)
  })

  test('names: folding diacritics is a match, and it says which it was', () => {
    const m = matchName('Jorgen Blimborgov', 'commit by Jörgen Blimborgov, reviewed')
    assert.ok(m)
    assert.equal(m.rule, 'diacritic')
    assert.equal(m.strength, 'strong')
    assert.ok(m.why.includes('Jörgen Blimborgov'), m.why)
  })

  /* ---------------------------------------------------------------- *
   * Diminutives
   * ---------------------------------------------------------------- */

  test('names: Сашо finds Александър, and Александър finds Сашо', () => {
    const forward = matchName('Сашо', 'В профила се подписва като Александър Блимборгов.')
    assert.ok(forward, 'a seeded diminutive must find the formal name')
    assert.equal(forward.rule, 'diminutive')
    assert.equal(forward.matched, 'Александър')
    assert.equal(forward.why, 'diminutive: Сашо → Александър')

    const back = matchName('Александър', 'Всички му викат Сашо.')
    assert.ok(back, 'a seeded formal name must find the diminutive')
    assert.equal(back.rule, 'diminutive')
    assert.equal(back.matched, 'Сашо')
    assert.equal(back.why, 'diminutive: Сашо → Александър')
  })

  test('names: the Bulgarian table covers the forms no rule could derive', () => {
    const pairs: [string, string][] = [
      ['Георги', 'Гошо'],
      ['Георги', 'Жоро'],
      ['Димитър', 'Митко'],
      ['Иван', 'Ванчо'],
      ['Николай', 'Кольо'],
      ['Христо', 'Ицо'],
      ['Стефан', 'Цецо'],
      ['Петър', 'Пешо'],
      ['Тодор', 'Тошо'],
      ['Васил', 'Васко'],
      ['Мария', 'Мими'],
      ['Елена', 'Ленче'],
      ['Ивайло', 'Ивчо']
    ]
    for (const [formal, short] of pairs) {
      const m = matchName(formal, `Темата е започната от ${short} миналата седмица.`)
      assert.ok(m, `${formal} should find ${short}`)
      assert.equal(m.rule, 'diminutive')
      assert.equal(m.matched, short)
    }
  })

  test('names: Chris finds Christian, and it is only ever a weak lead', () => {
    const m = matchName('Chris', 'maintained by Christian Blimborgov since 2019')
    assert.ok(m)
    assert.equal(m.rule, 'diminutive')
    assert.equal(m.strength, 'weak')
    assert.equal(m.why, 'diminutive: Chris → Christian')

    const literal = matchName('Linus Torvalds', 'Linus Torvalds')
    assert.ok(literal)
    assert.ok(
      strengthRank(m.strength) < strengthRank(literal.strength),
      'a diminutive must never render at the weight of a literal full-name hit'
    )
  })

  test('names: the English table is bidirectional across the usual set', () => {
    const pairs: [string, string][] = [
      ['Christopher', 'Chris'],
      ['Michael', 'Mike'],
      ['Alexander', 'Alex'],
      ['Nicholas', 'Nick'],
      ['Robert', 'Bob'],
      ['William', 'Bill'],
      ['David', 'Dave'],
      ['Thomas', 'Tom'],
      ['Katherine', 'Kate']
    ]
    for (const [formal, short] of pairs) {
      assert.ok(matchName(formal, `posted by ${short} Blimborgov`), `${formal} should find ${short}`)
      assert.ok(matchName(short, `posted by ${formal} Blimborgov`), `${short} should find ${formal}`)
    }
  })

  test('names: an ordinary word that happens to be a nickname comes back weak, not absent', () => {
    // This is a false positive, and it is the honest kind: the table cannot know that
    // "bill" here is an invoice. It is reported, at the lowest weight there is.
    const m = matchName('William Blimborgov', 'please pay the bill by Friday')
    assert.ok(m, 'the match is real even though the reading is wrong')
    assert.equal(m.rule, 'diminutive')
    assert.equal(m.strength, 'weak')
  })

  /* ---------------------------------------------------------------- *
   * Transliteration
   * ---------------------------------------------------------------- */

  test('names: Георги is found in the Latin spellings people actually carry', () => {
    for (const spelling of ['Georgi', 'Gueorgui', 'Giorgi', 'Georgy', 'George']) {
      const m = matchName('Георги', `Profile display name: ${spelling} Blimborgov`)
      assert.ok(m, `Георги should be found as ${spelling}`)
      assert.equal(m.rule, 'transliteration')
      assert.equal(m.matched, spelling)
      assert.equal(m.strength, 'weak', 'a transliterated bare given name is a weak lead')
    }
  })

  test('names: the same spellings resolve back to Георги from a Latin seed', () => {
    for (const spelling of ['Georgi', 'Gueorgui', 'George']) {
      const m = matchName(spelling, 'Собственик на профила: Георги Блимборгов')
      assert.ok(m, `${spelling} should be found as Георги`)
      assert.equal(m.matched, 'Георги')
    }
  })

  test('names: a transliterated FULL name is strong, a transliterated given name is weak', () => {
    const full = matchName('Георги Блимборгов', 'Committer: Gueorgui Blimborgov')
    assert.ok(full, 'the full name must be found across the script boundary')
    assert.equal(full.rule, 'transliteration')
    assert.equal(full.strength, 'strong')
    assert.equal(full.matched, 'Gueorgui Blimborgov')

    const given = matchName('Георги', 'Committer: Gueorgui Blimborgov')
    assert.ok(given)
    assert.ok(
      strengthRank(given.strength) < strengthRank(full.strength),
      'one transliterated token must not weigh what two do'
    )
  })

  test('names: the transliterator covers the ambiguities it claims to', () => {
    const forms = latinFormsOf('Георги')
    for (const want of ['georgi', 'georgy', 'gueorgui']) {
      assert.ok(forms.includes(want), `latinFormsOf(Георги) should contain ${want}: ${forms.join(', ')}`)
    }
    assert.equal(forms[0], 'georgi', 'the official 2009 form must come first, so a cap truncates the tail')

    assert.ok(latinFormsOf('Живко').includes('jivko'), 'ж → j is the French-influenced spelling')
    assert.ok(latinFormsOf('Цветан').some((f) => f === 'tzvetan' || f === 'cvetan'), 'ц → tz / c')
    assert.ok(latinFormsOf('Александър').includes('alexandar'), 'кс → x')
    assert.ok(latinFormsOf('Христо').includes('christo'), 'х → ch')
    assert.ok(latinFormsOf('Кольо').includes('kolyo'), 'ьо → yo')
    assert.ok(latinFormsOf('Ясен').includes('iasen'), 'я → ia')

    assert.ok(cyrillicFormsOf('Gueorgui').includes('георги'))
    assert.ok(cyrillicFormsOf('Yordan').includes('йордан'), 'the greedy reading of yo- is not the only one')
    assert.ok(cyrillicFormsOf('Tsvetan').includes('цветан'))
  })

  test('names: a transliterated diminutive reports the fuzzier rule of the two', () => {
    // Only one inference: `Сашо` written `Sasho` is a spelling of the seed, nothing more.
    const spelled = matchName('Сашо', 'GitHub bio: Sasho Blimborgov')
    assert.ok(spelled)
    assert.equal(spelled.rule, 'transliteration')

    // Two stacked: the table has to be walked *and* the script crossed. The label names
    // the weaker link, so the row does not read as a plain spelling difference.
    const stacked = matchName('Александър', 'GitHub bio: Sasho Blimborgov')
    assert.ok(stacked, 'a diminutive should survive a script change')
    assert.equal(stacked.rule, 'diminutive', 'the fuzzier of the two inferences takes the label')
    assert.equal(stacked.strength, 'weak')
    assert.ok(stacked.why.includes('Sasho'), stacked.why)
  })

  /* ---------------------------------------------------------------- *
   * Partial forms
   * ---------------------------------------------------------------- */

  test('names: family name first is still the same name', () => {
    const m = matchName('Linus Torvalds', 'Author: Torvalds Linus, kernel mailing list')
    assert.ok(m)
    assert.equal(m.rule, 'reversed')
    assert.equal(m.strength, 'strong')
    assert.equal(m.matched, 'Torvalds Linus')
  })

  test('names: an initial and a surname match, and are weak', () => {
    const m = matchName('Georgi Blimborgov', 'Reported by G. Blimborgov on the forum.')
    assert.ok(m)
    assert.equal(m.rule, 'initials')
    assert.equal(m.strength, 'weak')
    assert.equal(m.matched, 'G. Blimborgov')
    assert.ok(NAME_RULE_FLOOR.initials === 5)
  })

  test('names: half of a compound surname is a moderate lead, not a strong one', () => {
    const m = matchName('Мария Блимборгова-Дренска', 'Автор: Мария Дренска')
    assert.ok(m)
    assert.equal(m.rule, 'compound')
    assert.equal(m.strength, 'moderate')
    assert.equal(m.matched, 'Мария Дренска')

    const whole = matchName('Мария Блимборгова-Дренска', 'Автор: Мария Блимборгова-Дренска')
    assert.ok(whole)
    assert.equal(whole.strength, 'strong')
  })

  test('names: a middle initial in the seed does not stop the two real names matching', () => {
    const m = matchName('Linus B. Torvalds', 'Linus Torvalds, again')
    assert.ok(m)
    assert.equal(m.strength, 'strong')
    assert.equal(m.matched, 'Linus Torvalds')
  })

  test('names: the given name alone is found, and only weakly', () => {
    const m = matchName('Georgi Blimborgov', 'Nice work Georgi, thanks for the patch.')
    assert.ok(m)
    assert.equal(m.rule, 'given-name')
    assert.equal(m.strength, 'weak')
    assert.ok(m.why.includes('given name only'), m.why)
  })

  /* ---------------------------------------------------------------- *
   * Not fabricating a name out of two fields
   * ---------------------------------------------------------------- */

  test('names: two tokens separated by a field boundary are not one name', () => {
    // A raw capture is JSON. If any separator were allowed between the tokens of a name,
    // adjacent unrelated fields would read as a full-name hit — the exact quiet
    // fabrication this app exists to be the opposite of.
    const m = matchName('Georgi Blimborgov', 'dump fragment: Georgi","Blimborgov end')
    assert.ok(m, 'the given name is still there on its own')
    assert.notEqual(m.rule, 'exact')
    assert.notEqual(m.strength, 'strong')

    // A soft wrap between the two, on the other hand, is just a wrap.
    const wrapped = matchName('Georgi Blimborgov', 'signed by Georgi\nBlimborgov, maintainer')
    assert.ok(wrapped)
    assert.equal(wrapped.rule, 'exact')

    const spaced = matchName('Georgi Blimborgov', 'signed Georgi  Blimborgov today')
    assert.ok(spaced)
    assert.equal(spaced.rule, 'exact')

    // Far enough apart and it is two entries in a list, not one name.
    const listed = matchName('Georgi Blimborgov', 'members:\n  - Georgi\n  - Blimborgov\n')
    assert.notEqual(listed?.rule, 'exact', 'two bulleted lines are not an adjacent pair')
  })

  /* ---------------------------------------------------------------- *
   * The strongest match, not the first one
   * ---------------------------------------------------------------- */

  test('names: the strongest match wins, wherever it sits in the text', () => {
    // "Chris" is a diminutive hit at the front; the full literal name is further in. The
    // matcher must return the second, or the row will understate what was found.
    const m = matchName(
      'Christian Blimborgov',
      'Thread started by Chris. Later signed off as Christian Blimborgov in full.'
    )
    assert.ok(m)
    assert.equal(m.rule, 'exact')
    assert.equal(m.strength, 'strong')
  })

  test('names: matchNameAll returns distinct places, strongest first', () => {
    const text =
      'Chris opened the issue. Christian Blimborgov reviewed it. Chris merged it afterwards.'
    const all = matchNameAll('Christian Blimborgov', text, 5)
    assert.ok(all.length >= 2, `expected several hits, got ${all.length}`)
    assert.equal(all[0]?.strength, 'strong')
    const offsets = new Set(all.map((m) => m.at))
    assert.equal(offsets.size, all.length, 'the same offset must not be reported twice')
    for (let i = 1; i < all.length; i++) {
      assert.ok(
        strengthRank(all[i - 1]!.strength) >= strengthRank(all[i]!.strength),
        'results must be ordered strongest first'
      )
    }
  })

  test('names: a prepared text can be reused across seeds and gives the same answers', () => {
    const raw = 'bio: Гошо Блимборгов, joined 2018. contact: Мими Дренска.'
    const prepared = prepareText(raw)
    const a = matchName('Георги', prepared)
    const b = matchName('Мария', prepared)
    assert.equal(a?.matched, 'Гошо')
    assert.equal(b?.matched, 'Мими')
    assert.deepEqual(matchName('Георги', raw), a, 'preparing the text must not change the answer')
  })

  /* ---------------------------------------------------------------- *
   * The seam with the rest of the self-audit
   * ---------------------------------------------------------------- */

  test('names: seedHits routes people through the name rules and everything else literally', () => {
    const person = seedHits('person', 'Георги Блимборгов', 'Committer: Gueorgui Blimborgov')[0]
    assert.ok(person, 'a person seed must reach the name matcher')
    assert.equal(person.rule, 'transliteration')
    assert.equal(person.strength, 'strong')

    // An address is not a name: no diminutive, no transliteration, no partial form.
    const email = seedHits('email', 'chris@example.org', 'reset link sent to chris@example.org')[0]
    assert.ok(email)
    assert.equal(email.rule, 'exact')
    assert.equal(email.strength, 'strong')
    assert.equal(seedHits('email', 'chris@example.org', 'a note about Christian').length, 0)

    // A city is a word tens of thousands of people share, so a literal hit on one is
    // deliberately not worth what a literal hit on an address is worth.
    const city = seedHits('location', 'Blimborg', 'Location field says Blimborg')[0]
    assert.ok(city)
    assert.equal(city.strength, 'moderate')
    assert.ok(strengthRank(city.strength) < strengthRank(email.strength))
  })

  test('names: seedHits reports offsets that index the original text', () => {
    const text = 'Signed: Linus Torvalds, maintainer'
    const hit = seedHits('person', 'Linus Torvalds', text)[0]
    assert.ok(hit)
    assert.equal(text.slice(hit.at, hit.at + hit.length), 'Linus Torvalds')
  })

  test('names: a big capture is searched without falling over', () => {
    const filler = '{"site":"example.com","status":"not found"},'.repeat(6000)
    const text = `${filler}{"site":"forum.example","display":"Гошо Блимборгов"}`
    const started = Date.now()
    const prepared = prepareText(text)
    const hits = ['Георги', 'Мария', 'Димитър', 'Николай'].map((seed) => matchName(seed, prepared))
    const elapsed = Date.now() - started
    assert.equal(hits[0]?.matched, 'Гошо')
    assert.equal(hits[1], null)
    assert.ok(elapsed < 5000, `four seeds against a ${text.length} character capture took ${elapsed} ms`)
  })
}
