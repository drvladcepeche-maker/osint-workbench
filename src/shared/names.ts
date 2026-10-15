/**
 * Names, and the forms a name is actually written in.
 *
 * ## Why this exists
 *
 * `selfaudit/match.ts` matched a seeded value literally: diacritics folded, whole values
 * only, a four-character floor. That is correct, and against the material this app is
 * pointed at it is also close to useless for one field — the real name. Three reasons, in
 * the order they cost recall:
 *
 *  1. **Script.** A Bulgarian subject's accounts are split across Cyrillic and Latin, and
 *     the Latin half is not spelled one way. `Георги` is written Georgi, Gueorgui, Giorgi,
 *     Georgy and George on five different accounts belonging to one person, because the
 *     official 2009 streamlined system, the French-influenced spelling on an older
 *     passport, and whatever the sign-up form accepted are three different answers.
 *     Literal matching sees five strangers.
 *  2. **Diminutives.** A Bulgarian hypocoristic is not a truncation. `Александър` is
 *     `Сашо`, `Георги` is `Гошо` or `Жоро`, `Христо` is `Ицо`. No algorithm derives those
 *     from the formal name; only a table does. The English cases (`Christian` → `Chris`)
 *     are milder but the same shape.
 *  3. **Partial forms.** Sources give a given name alone, an initial and a surname, or the
 *     family name first — Eastern European sources vary between "Given Family" and
 *     "Family Given" within one dataset.
 *
 * ## The trade-off every rule here encodes
 *
 * Each of those rules buys recall by spending precision, so each one **carries the price
 * of its own trade in the strength it reports**. That is the whole design:
 *
 * > A fuzzy hit may never render as strongly as a literal one.
 *
 * The same rule the confidence ladder enforces for findings, applied to names. `Chris`
 * matching `Chris` is a *weak* hit — it is a common given name and half the population's
 * substring — while `Linus Torvalds` matching `Linus Torvalds` is strong. A transliterated
 * full name is strong; a transliterated bare given name is weak. Initials are always weak.
 * Nothing here promotes anything or mints a finding: a match is a lead, and a fuzzy match
 * is a weaker lead.
 *
 * When two inferences stack — a transliterated diminutive, say — the reported rule is the
 * **fuzzier** of the two and the strength is the **weaker** of the two. `Сашо` found as
 * `Sasho` in a Latin bio is reported as a diminutive, weak, not as a transliteration.
 *
 * ## What it still misses
 *
 * A bare surname is deliberately not matched on its own (only the given name is, and only
 * weakly), because the seed field holds "Given Family" and a lone family name is where the
 * false positives live in a country with a few thousand distinct surnames. Feminine
 * surname inflection (`Иванов` / `Иванова`) is not modelled. Cognate translation
 * (`Михаил` / `Michael`, `Иван` / `John`) is not transliteration and is not attempted.
 * Cities and organisations still match literally — `Пловдив` will not find `Plovdiv`.
 */

/* ------------------------------------------------------------------ *
 * Folding
 * ------------------------------------------------------------------ */

/**
 * Lowercase and strip combining marks, leaving the script alone.
 *
 * NFD then dropping the combining range turns `Ĝ` into `g` and `й` into `и`. The second
 * one is a real trade-off: Bulgarian `й` is a distinct letter, not an accented `и`, so
 * folding it merges `Йорданов` with `Иорданов`. That direction is chosen deliberately —
 * these are leads for a human to read, and a lead that is one letter too generous is
 * recoverable where a missed match is invisible.
 *
 * Folding changes no character's length for any script this app sees, so an index into a
 * folded string is also an index into the original. Everything below relies on that, as
 * `match.ts` already did.
 */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

const CYRILLIC = /\p{Script=Cyrillic}/u
const LATIN = /\p{Script=Latin}/u

export function hasCyrillic(s: string): boolean {
  return CYRILLIC.test(s)
}

export function hasLatin(s: string): boolean {
  return LATIN.test(s)
}

/* ------------------------------------------------------------------ *
 * The rule set
 * ------------------------------------------------------------------ */

export type NameMatchRule =
  | 'exact'
  | 'diacritic'
  | 'diminutive'
  | 'transliteration'
  | 'given-name'
  | 'initials'
  | 'reversed'
  | 'compound'

export type NameMatchStrength = 'strong' | 'moderate' | 'weak'

export interface NameMatch {
  rule: NameMatchRule
  strength: NameMatchStrength
  /** The text in the haystack that matched, exactly as the haystack wrote it. */
  matched: string
  /** One phrase for the UI: "diminutive: Сашо → Александър". */
  why: string
  /** Index of the match in the haystack. Folding preserves offsets, so this indexes both. */
  at: number
  /** Length of the matched span, in characters. */
  length: number
}

/**
 * How fuzzy each rule is. When two inferences stack the higher number wins the label, so
 * a transliterated diminutive is reported as a diminutive rather than as a transliteration
 * — the operator needs to see the weaker link, not the more impressive one.
 */
const FUZZINESS: Record<NameMatchRule, number> = {
  exact: 0,
  diacritic: 1,
  reversed: 2,
  transliteration: 3,
  compound: 4,
  initials: 5,
  diminutive: 6,
  'given-name': 7
}

const STRENGTH_RANK: Record<NameMatchStrength, number> = { weak: 1, moderate: 2, strong: 3 }

export function strengthRank(s: NameMatchStrength): number {
  return STRENGTH_RANK[s]
}

function weaker(a: NameMatchStrength, b: NameMatchStrength): NameMatchStrength {
  return STRENGTH_RANK[a] <= STRENGTH_RANK[b] ? a : b
}

/**
 * The base floor, and the reason it is measured on the **matched text** rather than on the
 * seed.
 *
 * `match.ts` has always refused a seed value under four characters, and the obvious way to
 * carry that over is to refuse a short seed here too. It is the wrong way. `Bob` is three
 * characters and is a perfectly good thing to type into the seed field; what it finds is
 * `Robert`, which is six, and there is nothing noisy about that. What *would* be noisy is
 * `Bob` matching the word `bob` — and that is caught by the same floor applied where it
 * belongs, to the span in the document.
 *
 * The consequence is an asymmetry worth knowing about: a three-character seed can find a
 * longer form of itself and cannot find itself written out. `Иво` finds `Ивчо` and does not
 * find `Иво`. That is the honest reading of a floor whose job is to describe what counts as
 * a signal in a body of text.
 */
export const MIN_NAME_LENGTH = 4

/**
 * The shortest matched span each rule will accept, counted in letters across the matched
 * tokens (separators excluded). Each floor is a judgement about where that rule stops
 * being signal, and each is deliberately different:
 *
 *  - `exact` / `diacritic` / `transliteration` / `given-name` — **4**, the floor
 *    `match.ts` already enforced for every seed value. Under four characters a literal hit
 *    is noise, and a transliteration of noise is worse noise.
 *  - `diminutive` — **3**, lower than the rest and the only floor that is. `Ицо`, `Ели`,
 *    `Ачо` and `Гого` are the real, complete forms of real names, and a table entry is not
 *    an arbitrary three-character substring: it only fires on a curated string. The price
 *    is that `ели` is also an ordinary Bulgarian word, so this floor buys false positives
 *    that the `weak` strength is there to carry.
 *  - `initials` — **5**, one initial plus a surname of at least four. The initial itself
 *    is one character and carries almost nothing; the floor is really on the surname.
 *  - `reversed` / `compound` — **6**, because both need two tokens by construction and a
 *    two-token name shorter than six letters is not a name that identifies anybody.
 */
export const NAME_RULE_FLOOR: Record<NameMatchRule, number> = {
  exact: MIN_NAME_LENGTH,
  diacritic: MIN_NAME_LENGTH,
  transliteration: MIN_NAME_LENGTH,
  'given-name': MIN_NAME_LENGTH,
  diminutive: 3,
  initials: 5,
  reversed: 6,
  compound: 6
}

/* ------------------------------------------------------------------ *
 * Gender
 * ------------------------------------------------------------------ */

/**
 * What a name reads as. Never what a person *is*.
 *
 * This distinction is the whole reason the type has four members instead of two. A given
 * name is a string somebody's parents chose, and the inference below reads that string;
 * it does not read the person. `ambiguous` is for a form that genuinely belongs to both —
 * `Alex`, `Тони`, `Сани` — and `unknown` is for a form nothing in this module recognises.
 * Those two must never render the same: "this name is used by men and women" and "I have
 * never seen this name" are different facts, and collapsing them would let the second one
 * quietly masquerade as evidence.
 *
 * Nothing here is used to filter anybody out. It is one signal among several in
 * `shared/relevance.ts`, it is always shown as an inference with the rule that produced
 * it written next to it, and the operator can override it outright — because he may
 * simply know, and a heuristic that cannot be overruled by knowledge is a bad heuristic.
 */
export type NameGender = 'masculine' | 'feminine' | 'ambiguous' | 'unknown'

/**
 * One row of a diminutive table: the gender the formal name reads as, then its short forms.
 *
 * A tuple rather than an object so the tables stay one line per name and remain scannable
 * as data — 201 rows of `{ gender: 'm', short: [...] }` is the same information wearing
 * forty per cent more punctuation.
 */
export type NameEntry = readonly [gender: 'm' | 'f', ...shortForms: string[]]

/**
 * How a gender was arrived at, strongest first.
 *
 * The basis travels with every answer because the answers are not equally good and the UI
 * has to be able to say which kind it is showing.
 *
 *  - `surname-inflection` — Bulgarian (and the wider Slavic) surname agrees with the
 *    bearer's gender as a matter of grammar: `Иванов` / `Иванова`, `Петковски` /
 *    `Петковска`. This is the strongest signal available on a name, because it is a
 *    morphological rule rather than a naming fashion, and it survives transliteration
 *    (`Ivanova` inflects exactly as `Иванова` does).
 *  - `table` — the given name is one of the 201 in the diminutive tables.
 *  - `transliteration` — the Latin given name folds back to a Cyrillic spelling the table
 *    knows. One notch weaker because the fold-back can land on more than one name.
 *  - `given-name-ending` — the residual Bulgarian rule: a Cyrillic given name ending in
 *    `-а` or `-я` reads feminine, one ending in a consonant reads masculine. Weakest of
 *    the four and the one with real exceptions, which is why they are enumerated below.
 */
export type GenderBasis =
  | 'surname-inflection'
  | 'table'
  | 'transliteration'
  | 'given-name-ending'
  | 'none'

export interface GenderReading {
  gender: NameGender
  basis: GenderBasis
  /** One phrase for the row: "surname Иванова inflects feminine". Empty when unknown. */
  why: string
}

const UNKNOWN_GENDER: GenderReading = { gender: 'unknown', basis: 'none', why: '' }

/**
 * Bulgarian given names that end in `-а` or `-я` and are masculine anyway.
 *
 * Short, closed, and worth enumerating: without it the ending rule mislabels four of the
 * most common male names in the country, and `Никола Иванов` reading feminine is exactly
 * the failure the operator complained about, only in the other direction.
 */
const MASCULINE_DESPITE_ENDING = new Set(['никола', 'илия', 'тома', 'лука', 'сава'])

/**
 * Surname endings that inflect, in both scripts.
 *
 * Ordered longest-first so `-ова` is tested before `-ов` — otherwise `Иванова` would match
 * the masculine rule on its first three-quarters. The Latin halves matter more than the
 * Cyrillic ones in practice: a profile that spells the subject's name at all usually
 * spells it in Latin.
 *
 * `-ин` / `-ина` is deliberately absent. It inflects the same way, but `-ina` is an
 * ordinary ending in half a dozen European languages and firing a *strong* signal on
 * `Marina` or `Molina` would buy one Bulgarian surname at the price of many wrong answers.
 */
const SURNAME_ENDINGS: readonly { suffix: string; gender: 'masculine' | 'feminine' }[] = ([
  { suffix: 'ова', gender: 'feminine' },
  { suffix: 'ева', gender: 'feminine' },
  { suffix: 'ска', gender: 'feminine' },
  { suffix: 'ova', gender: 'feminine' },
  { suffix: 'eva', gender: 'feminine' },
  { suffix: 'ska', gender: 'feminine' },
  { suffix: 'ов', gender: 'masculine' },
  { suffix: 'ев', gender: 'masculine' },
  { suffix: 'ски', gender: 'masculine' },
  { suffix: 'ski', gender: 'masculine' },
  { suffix: 'ov', gender: 'masculine' },
  { suffix: 'ev', gender: 'masculine' }
] as const).toSorted((a, b) => b.suffix.length - a.suffix.length)

/* ------------------------------------------------------------------ *
 * Diminutives
 * ------------------------------------------------------------------ */

/**
 * Bulgarian formal names and the short forms people are actually called by.
 *
 * Each row opens with the gender the formal name reads as — see `NameEntry`. The short
 * forms deliberately carry no gender of their own: a short form's gender is the union of
 * the formal names that own it, so `Сашо` (Александър **and** Александра) and `Тони`
 * (Антон and Антоанета) come out `ambiguous`, which is the truth about them.
 *
 * **How this table was built, and why it has to be a table.** A Bulgarian hypocoristic is
 * formed by irregular truncation plus one of the `-о / -чо / -ко / -и / -е` suffixes, and
 * the truncation is not predictable: `Александър` keeps a syllable that is not in the
 * formal name's first two (`Сашо`), `Георги` yields both `Гошо` and `Жоро`, `Стефан`
 * yields `Цецо`. There is no generative rule, so this was assembled by hand from ordinary
 * Bulgarian naming practice — the names in general circulation and the forms they are
 * called by — rather than derived from anything.
 *
 * **It is necessarily incomplete, and cannot be finished.** Diminutives are regional, they
 * are generational, and families invent their own. A name absent from this table simply
 * does not get the diminutive rule; it still matches literally, by transliteration and by
 * every partial-form rule. Adding an entry is the cheapest possible improvement to this
 * file and should be done whenever a miss is noticed.
 *
 * Both directions are indexed: a seeded formal name finds its short forms, and a seeded
 * short form finds the formal names it could belong to. The second direction is
 * many-to-one on purpose — `Ачо` is `Александър`, `Ангел` and `Андрей`, and all three are
 * offered as weak leads rather than one being guessed.
 */
export const BULGARIAN_DIMINUTIVES: Readonly<Record<string, NameEntry>> = {
  Александър: ['m', 'Сашо', 'Сашко', 'Ачо', 'Сани', 'Алекс', 'Санди', 'Сашето'],
  Александра: ['f', 'Сашка', 'Ася', 'Сани', 'Алекс', 'Сашо'],
  Ангел: ['m', 'Ачо', 'Ангелчо', 'Гелчо', 'Анги'],
  Анастасия: ['f', 'Ася', 'Наси', 'Тася', 'Ная', 'Стаси'],
  Андрей: ['m', 'Ачо', 'Андо', 'Анди', 'Андрешко'],
  Антон: ['m', 'Тони', 'Тошко', 'Анто', 'Тончо'],
  Антоанета: ['f', 'Тони', 'Нети', 'Ани'],
  Асен: ['m', 'Асо', 'Аси', 'Асенчо'],
  Атанас: ['m', 'Наско', 'Начо', 'Нако', 'Тачо', 'Наси'],
  Богдан: ['m', 'Бончо', 'Бого', 'Данчо', 'Боби', 'Дани'],
  Богомил: ['m', 'Боби', 'Мишо', 'Мичо', 'Бого'],
  Борис: ['m', 'Боби', 'Борко', 'Бончо', 'Бобо', 'Борко'],
  Борислав: ['m', 'Боби', 'Борко', 'Слави', 'Борко'],
  Бойко: ['m', 'Бойчо', 'Бобо', 'Бой'],
  Валентин: ['m', 'Вальо', 'Тино', 'Вали', 'Валко'],
  Валентина: ['f', 'Вали', 'Тина', 'Валя'],
  Валери: ['m', 'Вальо', 'Вали', 'Валко'],
  Васил: ['m', 'Васко', 'Вачо', 'Вили', 'Васо', 'Вало'],
  Величка: ['f', 'Вили', 'Вела', 'Вельо'],
  Венелин: ['m', 'Венци', 'Вени', 'Венко'],
  Венцислав: ['m', 'Венци', 'Цецо', 'Вени'],
  Веселин: ['m', 'Весо', 'Веско', 'Веси', 'Веско'],
  Виктор: ['m', 'Вики', 'Вико', 'Вичо'],
  Виолета: ['f', 'Вили', 'Вета', 'Виолетка', 'Виоле'],
  Владимир: ['m', 'Владо', 'Влади', 'Вили', 'Влатко'],
  Владислав: ['m', 'Владо', 'Влади', 'Слави'],
  Габриела: ['f', 'Габи', 'Габе'],
  Галина: ['f', 'Гали', 'Галя'],
  Георги: ['m', 'Гошо', 'Жоро', 'Гого', 'Гоце', 'Геро', 'Гошко', 'Жорж'],
  Григор: ['m', 'Гришо', 'Гриша', 'Григо'],
  Даниел: ['m', 'Дани', 'Данчо', 'Данко', 'Дачо'],
  Даниела: ['f', 'Дани', 'Дида', 'Данчето'],
  Десислава: ['f', 'Деси', 'Десо', 'Деска'],
  Диана: ['f', 'Диди', 'Дия', 'Дида'],
  Димитър: ['m', 'Митко', 'Мичо', 'Мито', 'Митак', 'Димо', 'Мишо', 'Дими', 'Такси'],
  Димитрина: ['f', 'Дида', 'Мими', 'Тина', 'Дими'],
  Добромир: ['m', 'Добри', 'Добчо', 'Доби'],
  Драгомир: ['m', 'Драго', 'Драгош'],
  Евгени: ['m', 'Жени', 'Гени', 'Ежи', 'Ени'],
  Евгения: ['f', 'Жени', 'Ева', 'Ени'],
  Елена: ['f', 'Ели', 'Ленче', 'Нели', 'Ена', 'Леле'],
  Елеонора: ['f', 'Нора', 'Ели', 'Ено'],
  Елисавета: ['f', 'Ели', 'Вета', 'Лиза', 'Ети'],
  Емил: ['m', 'Емо', 'Мичо', 'Емчо', 'Ети'],
  Емилия: ['f', 'Еми', 'Мими', 'Емче'],
  Живко: ['m', 'Живо', 'Жико', 'Жи'],
  Захари: ['m', 'Захо', 'Заки', 'Захчо'],
  Здравко: ['m', 'Здравко', 'Зори', 'Здравчо'],
  Златка: ['f', 'Злати', 'Зика'],
  Иван: ['m', 'Ванко', 'Ванчо', 'Ивчо', 'Ицо', 'Ванка', 'Ванюша'],
  Ивайло: ['m', 'Ивчо', 'Иво', 'Вальо', 'Ивко'],
  Иво: ['m', 'Ивчо', 'Ивко'],
  Илиян: ['m', 'Или', 'Илко', 'Илчо'],
  Илия: ['m', 'Илко', 'Или', 'Илчо'],
  Йордан: ['m', 'Данчо', 'Дани', 'Данко', 'Йордо', 'Дачо'],
  Йорданка: ['f', 'Данка', 'Дани', 'Данче'],
  Калин: ['m', 'Кало', 'Кали', 'Калчо'],
  Камен: ['m', 'Ками', 'Камчо', 'Камо'],
  Кирил: ['m', 'Киро', 'Кико', 'Кирчо'],
  Константин: ['m', 'Косьо', 'Коце', 'Коси', 'Дино', 'Коко'],
  Красимир: ['m', 'Краси', 'Мирчо', 'Крачо'],
  Кристиян: ['m', 'Крис', 'Криси', 'Кико', 'Кристи'],
  Кристина: ['f', 'Кристи', 'Криси', 'Тина', 'Кики'],
  Лъчезар: ['m', 'Лъчо', 'Лъки'],
  Любомир: ['m', 'Любо', 'Люби', 'Мирчо'],
  Людмил: ['m', 'Людо', 'Люси', 'Мичо'],
  Магдалена: ['f', 'Маги', 'Мага', 'Лена', 'Мадж'],
  Малина: ['f', 'Мали', 'Мина'],
  Мариана: ['f', 'Мари', 'Мими', 'Яна', 'Мая'],
  Марин: ['m', 'Марчо', 'Мачо', 'Марко'],
  Мария: ['f', 'Мими', 'Мара', 'Мери', 'Маша', 'Маги', 'Мая'],
  Мартин: ['m', 'Марто', 'Марти', 'Марчо'],
  Милен: ['m', 'Мишо', 'Мили', 'Миленчо'],
  Милена: ['f', 'Мили', 'Миле', 'Мина'],
  Мирослав: ['m', 'Миро', 'Мирчо', 'Слави'],
  Михаил: ['m', 'Мишо', 'Мишко', 'Михо', 'Мичо'],
  Надежда: ['f', 'Надя', 'Наде', 'Нади'],
  Наталия: ['f', 'Наташа', 'Нати', 'Ната'],
  Невена: ['f', 'Неве', 'Нени', 'Нева'],
  Никола: ['m', 'Кольо', 'Ники', 'Нико', 'Ниче', 'Николчо'],
  Николай: ['m', 'Кольо', 'Ники', 'Ниче', 'Нико', 'Николчо'],
  Николина: ['f', 'Ники', 'Лина', 'Нина'],
  Огнян: ['m', 'Оги', 'Огнянчо', 'Огне'],
  Павел: ['m', 'Павко', 'Паво', 'Пафи', 'Пацо'],
  Пенка: ['f', 'Пепа', 'Пени'],
  Петър: ['m', 'Пешо', 'Пепи', 'Перо', 'Пеци', 'Петьо', 'Пецо'],
  Петя: ['f', 'Пепи', 'Пепа', 'Пецка'],
  Пламен: ['m', 'Плами', 'Пламчо', 'Пепи'],
  Радослав: ['m', 'Радо', 'Слави', 'Радко'],
  Радка: ['f', 'Ради', 'Радче'],
  Румен: ['m', 'Руми', 'Румчо', 'Румко'],
  Румяна: ['f', 'Руми', 'Мими', 'Румче'],
  Светлана: ['f', 'Свети', 'Лана', 'Цвети'],
  Светослав: ['m', 'Светльо', 'Слави', 'Цецо'],
  Силвия: ['f', 'Сили', 'Сил', 'Силви'],
  Симеон: ['m', 'Симо', 'Мони', 'Симчо'],
  Станимир: ['m', 'Станко', 'Стани', 'Мирчо'],
  Станислав: ['m', 'Станко', 'Стани', 'Слави'],
  Стефан: ['m', 'Цецо', 'Стефчо', 'Стефо', 'Фичо', 'Стенли'],
  Стефка: ['f', 'Цеца', 'Стефи', 'Стефче'],
  Стоян: ['m', 'Стойчо', 'Стойо', 'Янчо', 'Стойко'],
  Татяна: ['f', 'Таня', 'Танче', 'Тани'],
  Теодор: ['m', 'Тео', 'Тошко', 'Дори', 'Тедо'],
  Теодора: ['f', 'Тео', 'Дори', 'Теди', 'Тошка'],
  Тихомир: ['m', 'Тишо', 'Тихо', 'Мирчо'],
  Тодор: ['m', 'Тошо', 'Тошко', 'Дорчо', 'Тото'],
  Тодорка: ['f', 'Дори', 'Тошка', 'Тодорче'],
  Трифон: ['m', 'Фонди', 'Трифи'],
  Христо: ['m', 'Ицо', 'Христе', 'Хрис', 'Ристо'],
  Христина: ['f', 'Криси', 'Тина', 'Ина', 'Христи'],
  Цветан: ['m', 'Цецо', 'Цвети', 'Цоко'],
  Цветелина: ['f', 'Цвети', 'Цеци', 'Цеца'],
  Юлия: ['f', 'Юли', 'Юле', 'Юлче'],
  Явор: ['m', 'Явчо', 'Яво'],
  Яна: ['f', 'Янче', 'Яни'],
  Янко: ['m', 'Янчо', 'Яни']
}

/**
 * English formal names and their short forms.
 *
 * Same construction and the same caveat: assembled by hand from ordinary usage, and
 * incomplete by nature. Milder than the Bulgarian case because most English hypocoristics
 * *are* truncations — but not all of them are, which is why `Robert` → `Bob` and
 * `Margaret` → `Peggy` need a table rather than a prefix rule.
 */
export const ENGLISH_DIMINUTIVES: Readonly<Record<string, NameEntry>> = {
  Albert: ['m', 'Al', 'Bert', 'Albie'],
  Alexander: ['m', 'Alex', 'Al', 'Sandy', 'Xander', 'Lex', 'Sasha'],
  Alexandra: ['f', 'Alex', 'Sandra', 'Sandy', 'Lexi', 'Sasha'],
  Alfred: ['m', 'Alf', 'Fred', 'Freddie'],
  Amanda: ['f', 'Mandy', 'Manda'],
  Andrew: ['m', 'Andy', 'Drew'],
  Anthony: ['m', 'Tony', 'Ant'],
  Arthur: ['m', 'Art', 'Artie'],
  Barbara: ['f', 'Barb', 'Babs', 'Barbie'],
  Benjamin: ['m', 'Ben', 'Benny', 'Benji'],
  Bradley: ['m', 'Brad'],
  Cassandra: ['f', 'Cass', 'Sandy', 'Cassie'],
  Catherine: ['f', 'Kate', 'Cathy', 'Cat', 'Katie'],
  Charles: ['m', 'Charlie', 'Chuck', 'Chas', 'Charley'],
  Charlotte: ['f', 'Lottie', 'Charlie', 'Char'],
  Christian: ['m', 'Chris', 'Christy'],
  Christopher: ['m', 'Chris', 'Kit', 'Topher'],
  Constantine: ['m', 'Costa', 'Gus', 'Dino'],
  Daniel: ['m', 'Dan', 'Danny'],
  David: ['m', 'Dave', 'Davey'],
  Deborah: ['f', 'Deb', 'Debbie', 'Debra'],
  Donald: ['m', 'Don', 'Donnie'],
  Douglas: ['m', 'Doug', 'Dougie'],
  Edward: ['m', 'Ed', 'Eddie', 'Ted', 'Ned', 'Teddy'],
  Eleanor: ['f', 'Ellie', 'Nell', 'Nora'],
  Elizabeth: ['f', 'Liz', 'Beth', 'Betty', 'Eliza', 'Lizzie', 'Libby', 'Bess'],
  Emmanuel: ['m', 'Manny', 'Manu'],
  Eugene: ['m', 'Gene'],
  Francis: ['m', 'Frank', 'Fran'],
  Frederick: ['m', 'Fred', 'Freddie', 'Rick'],
  Gabriel: ['m', 'Gabe', 'Gabby'],
  Georgina: ['f', 'Georgie', 'Gina'],
  Gerald: ['m', 'Jerry', 'Gerry'],
  Gregory: ['m', 'Greg', 'Gregg'],
  Harold: ['m', 'Harry', 'Hal'],
  Henry: ['m', 'Hank', 'Harry'],
  Herbert: ['m', 'Herb', 'Bert'],
  Isabella: ['f', 'Bella', 'Izzy', 'Belle'],
  James: ['m', 'Jim', 'Jimmy', 'Jamie'],
  Jeffrey: ['m', 'Jeff', 'Geoff'],
  Jennifer: ['f', 'Jen', 'Jenny'],
  Jessica: ['f', 'Jess', 'Jessie'],
  John: ['m', 'Jack', 'Johnny', 'Jon'],
  Jonathan: ['m', 'Jon', 'Jonny', 'Nathan'],
  Joseph: ['m', 'Joe', 'Joey'],
  Josephine: ['f', 'Jo', 'Josie'],
  Katherine: ['f', 'Kate', 'Kathy', 'Katie', 'Kat', 'Kitty'],
  Kenneth: ['m', 'Ken', 'Kenny'],
  Lawrence: ['m', 'Larry', 'Laurie'],
  Leonard: ['m', 'Leo', 'Lenny', 'Len'],
  Margaret: ['f', 'Maggie', 'Meg', 'Peggy', 'Marge', 'Greta'],
  Martin: ['m', 'Marty', 'Mart'],
  Matthew: ['m', 'Matt', 'Matty'],
  Maximilian: ['m', 'Max', 'Maxi'],
  Melissa: ['f', 'Mel', 'Missy', 'Lissa'],
  Michael: ['m', 'Mike', 'Mick', 'Micky', 'Mikey'],
  Miranda: ['f', 'Mira', 'Randy', 'Mandy'],
  Nathaniel: ['m', 'Nat', 'Nate'],
  Nicholas: ['m', 'Nick', 'Nicky', 'Cole'],
  Nicole: ['f', 'Nikki', 'Nici'],
  Norman: ['m', 'Norm', 'Normie'],
  Oliver: ['m', 'Ollie', 'Olly'],
  Patricia: ['f', 'Pat', 'Patty', 'Trish', 'Tricia'],
  Patrick: ['m', 'Pat', 'Paddy', 'Rick'],
  Peter: ['m', 'Pete', 'Petey'],
  Philip: ['m', 'Phil', 'Pip'],
  Raymond: ['m', 'Ray'],
  Rebecca: ['f', 'Becca', 'Becky', 'Bex'],
  Richard: ['m', 'Rick', 'Dick', 'Rich', 'Richie'],
  Robert: ['m', 'Bob', 'Rob', 'Bobby', 'Robbie', 'Bert'],
  Ronald: ['m', 'Ron', 'Ronnie'],
  Russell: ['m', 'Russ', 'Rusty'],
  Samuel: ['m', 'Sam', 'Sammy'],
  Sebastian: ['m', 'Seb', 'Bas', 'Baz'],
  Stephen: ['m', 'Steve', 'Stevie'],
  Steven: ['m', 'Steve', 'Stevie'],
  Susan: ['f', 'Sue', 'Susie', 'Suzy'],
  Terrence: ['m', 'Terry', 'Tel'],
  Theodore: ['m', 'Ted', 'Teddy', 'Theo'],
  Thomas: ['m', 'Tom', 'Tommy'],
  Timothy: ['m', 'Tim', 'Timmy'],
  Victoria: ['f', 'Vicky', 'Tori', 'Vic'],
  Vincent: ['m', 'Vince', 'Vinny'],
  Walter: ['m', 'Walt', 'Wally'],
  William: ['m', 'Bill', 'Will', 'Billy', 'Willie', 'Liam'],
  Zachary: ['m', 'Zach', 'Zack', 'Zac']
}

/** folded form -> the spelling the table uses, for the `why` phrase. */
const DISPLAY = new Map<string, string>()
/** folded formal name -> folded short forms. */
const SHORT_OF = new Map<string, string[]>()
/** folded short form -> folded formal names. */
const FORMAL_OF = new Map<string, string[]>()
/**
 * folded form -> every gender the tables attach to it.
 *
 * A set rather than a value, because a short form inherits from every formal name that
 * owns it. Two members means `ambiguous`, and that is a finding about the name rather than
 * a gap in the table.
 */
const GENDERS_OF = new Map<string, Set<'masculine' | 'feminine'>>()

function markGender(folded: string, gender: 'masculine' | 'feminine'): void {
  const set = GENDERS_OF.get(folded) ?? new Set<'masculine' | 'feminine'>()
  set.add(gender)
  GENDERS_OF.set(folded, set)
}

function indexDiminutives(table: Readonly<Record<string, NameEntry>>): void {
  for (const [formal, entry] of Object.entries(table)) {
    const [tag, ...shorts] = entry
    const gender = tag === 'f' ? 'feminine' : 'masculine'
    const f = fold(formal)
    if (!DISPLAY.has(f)) DISPLAY.set(f, formal)
    markGender(f, gender)
    const bucket = SHORT_OF.get(f) ?? []
    for (const short of shorts) {
      const s = fold(short)
      if (s === f) continue
      if (!DISPLAY.has(s)) DISPLAY.set(s, short)
      if (!bucket.includes(s)) bucket.push(s)
      // A short form is only as gendered as the formal names that use it.
      markGender(s, gender)
      const back = FORMAL_OF.get(s) ?? []
      if (!back.includes(f)) back.push(f)
      FORMAL_OF.set(s, back)
    }
    SHORT_OF.set(f, bucket)
  }
}

indexDiminutives(BULGARIAN_DIMINUTIVES)
indexDiminutives(ENGLISH_DIMINUTIVES)

/** The short forms of a name, folded. Empty when the table does not know it. */
export function diminutivesOf(name: string): string[] {
  return [...(SHORT_OF.get(fold(name)) ?? [])]
}

/** The formal names a short form could belong to, folded. Many-to-one on purpose. */
export function formalNamesOf(name: string): string[] {
  return [...(FORMAL_OF.get(fold(name)) ?? [])]
}

/* ------------------------------------------------------------------ *
 * Reading a gender off a name
 * ------------------------------------------------------------------ */

/** What the tables alone say about one token. `unknown` when they have never seen it. */
export function tableGender(token: string): NameGender {
  const set = GENDERS_OF.get(fold(token))
  if (!set || set.size === 0) return 'unknown'
  if (set.size > 1) return 'ambiguous'
  return set.has('feminine') ? 'feminine' : 'masculine'
}

/** True when the tables know this token at all, in either direction. */
export function isKnownGivenName(token: string): boolean {
  return GENDERS_OF.has(fold(token))
}

/**
 * True when a token is a personal given name the tables recognise, in either script.
 *
 * Tighter than `givenNameGender` in two ways, and both are deliberate, because this
 * predicate gates the strongest **negative** signal in `shared/relevance.ts` — a stated
 * name that is not the seeded one. A detector that over-fires there sinks true positives.
 *
 *  1. The `-а` / `-я` ending heuristic is excluded. It is a good tiebreak on a token
 *     already believed to be a name and a bad detector of whether something *is* one:
 *     `София`, `сряда` and half the ordinary Bulgarian nouns end in `-а`.
 *  2. A transliteration must land on a **formal** name, not on a short form. `Georgi`
 *     folds back to `Георги`, a formal name, and that is a real recognition. `Marco` folds
 *     back to `Марчо`, a three-letter hypocoristic, and that is a spelling coincidence —
 *     the Latin-to-Cyrillic expansion generates dozens of short strings and some of them
 *     land on diminutives by arithmetic rather than by meaning.
 */
export function looksLikeGivenName(token: string): boolean {
  const t = fold(token.trim())
  if (SHORT_OF.has(t) || FORMAL_OF.has(t)) return true
  if (!hasLatin(t) || hasCyrillic(t) || t.length < 3) return false
  return cyrillicFormsOf(t).some((form) => SHORT_OF.has(form))
}

/**
 * The gender a *surname* inflects to, or unknown.
 *
 * Guarded three ways, because this rule is the strongest one here and a strong rule that
 * fires on the wrong strings is worse than no rule:
 *  - the token must be at least six characters, so `Ева` and `Lev` are not surnames;
 *  - the stem left after the ending must be at least three, so `Nova` is not `Nov` + `a`;
 *  - a token the tables know as a *given* name is refused outright, which is what stops
 *    `Иво` and `Yana` being read as truncated surnames.
 */
export function surnameGender(token: string): GenderReading {
  const t = fold(token.trim())
  if (t.length < 6 || isKnownGivenName(t)) return UNKNOWN_GENDER
  for (const { suffix, gender } of SURNAME_ENDINGS) {
    if (!t.endsWith(suffix)) continue
    if (t.length - suffix.length < 3) continue
    return {
      gender,
      basis: 'surname-inflection',
      why: `the surname "${token.trim()}" ends in -${suffix}, which is the ${gender} inflection`
    }
  }
  return UNKNOWN_GENDER
}

/**
 * The gender a *given name* reads as, and how that was decided.
 *
 * Four rules in descending order of trust; the first that produces an answer wins, and
 * the answer names its own rule. The transliteration step is the one worth pointing at:
 * a Latin `Georgi` is folded back through `cyrillicFormsOf` and every spelling that lands
 * in the table votes. Unanimity gives an answer, disagreement gives `ambiguous`, and
 * neither is presented as more than an inference.
 */
export function givenNameGender(token: string): GenderReading {
  const raw = token.trim()
  const t = fold(raw)
  if (!t) return UNKNOWN_GENDER

  const direct = tableGender(t)
  if (direct !== 'unknown') {
    return {
      gender: direct,
      basis: 'table',
      why:
        direct === 'ambiguous'
          ? `"${raw}" is a short form of both masculine and feminine names`
          : `"${raw}" is a known ${direct} given name`
    }
  }

  // A Latin spelling of a Cyrillic name. Only worth trying when there is no Cyrillic in
  // the token — otherwise the table lookup above would already have answered.
  if (hasLatin(t) && !hasCyrillic(t) && t.length >= 3) {
    const votes = new Set<NameGender>()
    for (const form of cyrillicFormsOf(t)) {
      const g = tableGender(form)
      if (g !== 'unknown') votes.add(g)
    }
    if (votes.size === 1) {
      const [only] = [...votes]
      return {
        gender: only!,
        basis: 'transliteration',
        why: `"${raw}" transliterates to a known ${only} Bulgarian name`
      }
    }
    if (votes.size > 1) {
      return {
        gender: 'ambiguous',
        basis: 'transliteration',
        why: `"${raw}" transliterates to both masculine and feminine Bulgarian names`
      }
    }
  }

  // The residual morphological rule, Cyrillic only. Applying it to Latin text would read
  // `Sara`, `Luca` and `Joshua` as Bulgarian, which they are not.
  if (hasCyrillic(t) && t.length >= 3) {
    const last = t[t.length - 1]
    if ((last === 'а' || last === 'я') && !MASCULINE_DESPITE_ENDING.has(t)) {
      return {
        gender: 'feminine',
        basis: 'given-name-ending',
        why: `"${raw}" ends in -${last}, which is the ordinary Bulgarian feminine ending`
      }
    }
    if (MASCULINE_DESPITE_ENDING.has(t)) {
      return {
        gender: 'masculine',
        basis: 'table',
        why: `"${raw}" is one of the few Bulgarian masculine names ending in a vowel`
      }
    }
  }

  return UNKNOWN_GENDER
}

/**
 * Read a whole name — "Given Family", "Family Given", one token, or three.
 *
 * The surname rule wins when both fire, and it wins even when they disagree, because a
 * `-ова` surname is grammar and a given name is fashion: `Сашо Иванова` is a woman called
 * by a unisex short form, not a man with an inflected surname. The disagreement is
 * recorded in `why` rather than hidden, so the row can say what it saw.
 *
 * Order-agnostic on purpose. Eastern European sources vary between "Given Family" and
 * "Family Given" inside a single dataset — `parseName` already deals with that for
 * matching — so every token is offered to the surname rule and every token to the given
 * name rule, and the strongest reading wins.
 */
export function inferGender(fullName: string): GenderReading {
  const tokens = fullName.split(TOKEN_SPLIT).filter((t) => t.length > 0)
  if (!tokens.length) return UNKNOWN_GENDER

  for (const token of tokens) {
    const s = surnameGender(token)
    if (s.gender === 'masculine' || s.gender === 'feminine') {
      // Look for a given name that disagrees, and say so rather than swallowing it.
      const clash = tokens
        .map((t) => givenNameGender(t))
        .find(
          (g) =>
            (g.gender === 'masculine' || g.gender === 'feminine') && g.gender !== s.gender
        )
      if (!clash) return s
      return { ...s, why: `${s.why}, though ${clash.why}` }
    }
  }

  let best: GenderReading = UNKNOWN_GENDER
  for (const token of tokens) {
    const g = givenNameGender(token)
    if (g.gender === 'unknown') continue
    if (g.gender === 'ambiguous') {
      if (best.gender === 'unknown') best = g
      continue
    }
    if (best.gender === 'masculine' || best.gender === 'feminine') {
      if (best.gender !== g.gender) {
        return {
          gender: 'ambiguous',
          basis: g.basis,
          why: `"${fullName.trim()}" reads both ways: ${best.why}, and ${g.why}`
        }
      }
      continue
    }
    best = g
  }
  return best
}

/** Splits a name into tokens. Unicode-aware, so it works on both scripts. */
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u

/** The table's own spelling of a folded form, for display. Falls back to what was given. */
export function displayName(folded: string): string {
  return DISPLAY.get(folded) ?? folded
}

/* ------------------------------------------------------------------ *
 * Transliteration
 * ------------------------------------------------------------------ */

/**
 * How many spellings one name may expand into, per direction, per shape.
 *
 * **This cap is the reason the file is usable.** The alternatives below multiply: a
 * six-letter Cyrillic name with three plausible renderings for four of its letters is 81
 * spellings before anything else is tried, and a two-token name squares that. So variants
 * are generated in **breadth-first order by number of departures from the canonical
 * spelling** — the official 2009 streamlined form first, then every spelling one letter
 * away from it, then two — and the enumeration stops at this many. The cap therefore
 * truncates the implausible tail rather than an arbitrary slice.
 */
export const MAX_TRANSLITERATIONS = 48

/** Beyond this many single-letter departures a spelling is not a spelling of this name. */
const MAX_DEVIATIONS = 5

/**
 * A ceiling on the whole candidate set for one seed, across every rule.
 *
 * Generous, because a candidate costs one hash lookup against a text that was tokenised
 * once — the expensive part is generating the spellings, not trying them. `shapesFor`
 * returns the literal shapes before the fuzzy ones, so when this cap does bite it drops
 * the least trustworthy spellings of the least trustworthy rule.
 */
export const MAX_NAME_CANDIDATES = 512

/**
 * Bulgarian Cyrillic to Latin. **The first entry of each list is the official 2009
 * streamlined transliteration**; the rest are the spellings people actually carry.
 *
 * The alternatives are not decoration. `ж → j` and `у → ou` are French-influenced and sit
 * on older passports; `х → ch` is German; `ц → tz` is German-influenced and `ц → c` is the
 * Slavic-Latin convention; `ъ → u` was the pre-2009 Bulgarian standard and `ъ → ă` is the
 * academic one; `и → y` is what produces `Georgy`. Each one is a spelling this app has to
 * recognise because some sign-up form in 2014 accepted it.
 */
const CYRILLIC_LETTERS: Readonly<Record<string, readonly string[]>> = {
  а: ['a'],
  б: ['b'],
  в: ['v', 'w'],
  г: ['g', 'gh'],
  д: ['d'],
  е: ['e', 'ie'],
  ж: ['zh', 'j', 'g'],
  з: ['z'],
  и: ['i', 'y', 'ee'],
  й: ['y', 'i', 'j'],
  к: ['k', 'c'],
  л: ['l'],
  м: ['m'],
  н: ['n'],
  о: ['o'],
  п: ['p'],
  р: ['r'],
  с: ['s', 'ss'],
  т: ['t'],
  у: ['u', 'ou', 'oo'],
  ф: ['f', 'ph'],
  х: ['h', 'kh', 'ch'],
  ц: ['ts', 'tz', 'c'],
  ч: ['ch', 'tch', 'c'],
  ш: ['sh', 'sch', 'ch'],
  щ: ['sht', 'shcht', 'scht'],
  ъ: ['a', '', 'u', 'y', 'ă'],
  ь: ['', 'y', 'i'],
  ю: ['yu', 'iu', 'ju'],
  я: ['ya', 'ia', 'ja', 'a'],
  ы: ['y'],
  э: ['e'],
  ё: ['yo']
}

/** Cyrillic pairs that transliterate as a unit. `кс → x` is what makes `Alexandar` work. */
const CYRILLIC_DIGRAPHS: Readonly<Record<string, readonly string[]>> = {
  кс: ['ks', 'x'],
  дж: ['dzh', 'j'],
  дз: ['dz'],
  ьо: ['yo', 'io', 'jo'],
  йо: ['yo', 'io', 'jo']
}

/**
 * Latin back to Cyrillic, longest match first — and shorter segmentations are offered as
 * departures rather than discarded, because the greedy reading is often wrong: `Yordan`
 * greedily reads `yo` as `ьо`, and only the one-letter reading gives `Йордан`.
 */
const LATIN_SEGMENTS: Readonly<Record<string, readonly string[]>> = {
  shcht: ['щ'],
  shch: ['щ'],
  scht: ['щ'],
  sht: ['щ'],
  tch: ['ч'],
  sch: ['ш', 'щ'],
  zh: ['ж'],
  ch: ['ч', 'х', 'ш'],
  sh: ['ш'],
  kh: ['х'],
  ph: ['ф'],
  gh: ['г'],
  gu: ['г', 'гу'],
  ts: ['ц'],
  tz: ['ц'],
  ya: ['я'],
  ia: ['я', 'ия'],
  ja: ['я'],
  yu: ['ю'],
  iu: ['ю'],
  ju: ['ю'],
  yo: ['йо', 'ьо'],
  io: ['ьо', 'ио'],
  ou: ['у'],
  oo: ['у'],
  ss: ['с'],
  ee: ['и'],
  a: ['а', 'ъ'],
  b: ['б'],
  c: ['к', 'ц', 'ч'],
  d: ['д'],
  e: ['е'],
  f: ['ф'],
  g: ['г', 'ж'],
  h: ['х'],
  i: ['и', 'й'],
  j: ['ж', 'й', 'дж'],
  k: ['к'],
  l: ['л'],
  m: ['м'],
  n: ['н'],
  o: ['о'],
  p: ['п'],
  q: ['к'],
  r: ['р'],
  s: ['с'],
  t: ['т'],
  u: ['у', 'ъ'],
  v: ['в'],
  w: ['в', 'у'],
  x: ['кс'],
  y: ['й', 'и', 'ъ'],
  z: ['з']
}

/**
 * Spellings no rule above produces, because they are not transliterations at all.
 *
 * `Гeорги` on a passport is sometimes `George`; `Александър` is sometimes `Alexander`
 * with an `e` where the `ъ` is; `Петър` is `Peter`. These are assimilations to the English
 * or French form of the same name, and encoding them as letter rules would generate
 * thousands of wrong spellings for every right one. A short exception table is the honest
 * shape for them. Keyed on the folded Cyrillic; the reverse index is built from it.
 */
const IRREGULAR_LATIN: Readonly<Record<string, readonly string[]>> = {
  георги: ['giorgi', 'george', 'gueorgui', 'gjorgi'],
  александър: ['alexander', 'alexandre', 'aleksander'],
  александра: ['alexandra', 'alexandre'],
  петър: ['peter', 'petar'],
  димитър: ['dimiter', 'dimitre', 'dimitri', 'dimitar'],
  стефан: ['stephan', 'stephane', 'stefann'],
  евгени: ['eugene', 'evgueni'],
  теодор: ['theodore', 'theodor'],
  тодор: ['todor', 'theodor'],
  христо: ['christo', 'hristo', 'kristo'],
  христина: ['christina', 'hristina'],
  николай: ['nicolai', 'nikolay', 'nicolay'],
  никола: ['nicola', 'nikola'],
  йордан: ['jordan', 'yordan', 'iordan'],
  васил: ['vassil', 'vasil', 'wassil'],
  цветан: ['tsvetan', 'tzvetan', 'cvetan'],
  мария: ['maria', 'mariya', 'marie'],
  елена: ['elena', 'helena'],
  иван: ['ivan', 'yvan', 'ivane'],
  ивайло: ['ivailo', 'ivaylo'],
  михаил: ['mihail', 'michail', 'mihael'],
  анастасия: ['anastasia', 'anastassia'],
  константин: ['constantin', 'konstantin', 'constantine'],
  екатерина: ['ekaterina', 'catherine', 'katerina']
}

const IRREGULAR_CYRILLIC = new Map<string, string[]>()
for (const [cyr, latins] of Object.entries(IRREGULAR_LATIN)) {
  for (const lat of latins) {
    const bucket = IRREGULAR_CYRILLIC.get(lat) ?? []
    if (!bucket.includes(cyr)) bucket.push(cyr)
    IRREGULAR_CYRILLIC.set(lat, bucket)
  }
}

interface Segment {
  len: number
  out: string
}

/**
 * Every spelling of `s`, in breadth-first order by how far it departs from the canonical
 * one, capped at `cap`.
 *
 * Option 0 at each position is free; every other option costs one departure. The outer
 * loop raises the budget one departure at a time, so the canonical spelling comes out
 * first and the cap truncates the least plausible end of the list. `steps` is a hard
 * ceiling on work, so a pathological input degrades to fewer spellings rather than to a
 * hang.
 */
function expandForms(s: string, segment: (at: number) => Segment[], cap: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let steps = 0

  const walk = (i: number, budget: number, acc: string): void => {
    if (out.length >= cap || steps > 200_000) return
    steps++
    if (i >= s.length) {
      if (budget === 0 && !seen.has(acc)) {
        seen.add(acc)
        out.push(acc)
      }
      return
    }
    const options = segment(i)
    for (let k = 0; k < options.length; k++) {
      const cost = k === 0 ? 0 : 1
      if (cost > budget) break
      const option = options[k]
      if (!option) break
      walk(i + option.len, budget - cost, acc + option.out)
      if (out.length >= cap) return
    }
  }

  for (let budget = 0; budget <= MAX_DEVIATIONS && out.length < cap; budget++) walk(0, budget, '')
  return out
}

/** The plausible Latin spellings of a Cyrillic name, canonical first. */
export function latinFormsOf(cyrillic: string, cap = MAX_TRANSLITERATIONS): string[] {
  const s = fold(cyrillic)
  return expandForms(
    s,
    (i) => {
      const options: Segment[] = []
      const pair = s.slice(i, i + 2)
      for (const alt of CYRILLIC_DIGRAPHS[pair] ?? []) options.push({ len: 2, out: alt })
      const ch = s[i] ?? ''
      const alts = CYRILLIC_LETTERS[ch]
      if (alts) for (const alt of alts) options.push({ len: 1, out: alt })
      else options.push({ len: 1, out: ch })
      // French orthography needs a `u` to keep `g` hard before a front vowel, which is the
      // whole of the difference between `Georgi` and `Gueorgui`.
      const next = s[i + 1]
      if (ch === 'г' && (next === 'е' || next === 'и')) options.push({ len: 1, out: 'gu' })
      return options
    },
    cap
  )
}

/** The plausible Cyrillic spellings of a Latin name, canonical first. */
export function cyrillicFormsOf(latin: string, cap = MAX_TRANSLITERATIONS): string[] {
  const s = fold(latin)
  return expandForms(
    s,
    (i) => {
      const options: Segment[] = []
      for (let len = 5; len >= 1; len--) {
        const key = s.slice(i, i + len)
        if (key.length < len) continue
        for (const alt of LATIN_SEGMENTS[key] ?? []) options.push({ len, out: alt })
      }
      if (!options.length) options.push({ len: 1, out: s[i] ?? '' })
      return options
    },
    cap
  )
}

/* ------------------------------------------------------------------ *
 * Tokenised text
 * ------------------------------------------------------------------ */

const TOKEN = /[\p{L}\p{N}]+/gu

/**
 * Only these characters may sit between two tokens of one name.
 *
 * Matching a multi-token name as a *token sequence* rather than as a literal substring is
 * what lets `Georgi Blimborgov` be found across a line break, or written
 * `Georgi  Blimborgov`. It is also how a name gets fabricated out of unrelated fields:
 * `"first":"Georgi","role":"Blimborgov"` would read as adjacent tokens if any separator
 * were allowed. So the gap must be short and must contain nothing but whitespace and the
 * punctuation that genuinely appears inside a written name — which excludes quotes,
 * brackets, colons and slashes, and therefore excludes every JSON field boundary.
 */
const THIN_GAP = /^[\s.,'’‐-―-]{0,3}$/

export interface TextToken {
  text: string
  at: number
  end: number
}

export interface PreparedText {
  original: string
  folded: string
  tokens: TextToken[]
  /** token text -> the indices in `tokens` where it appears. */
  index: Map<string, number[]>
  hasCyrillic: boolean
  hasLatin: boolean
}

/**
 * Tokenise once, match many times.
 *
 * A raw capture is up to half a megabyte and is searched for every seed the level holds.
 * Tokenising per seed would multiply that by the seed count for no gain, so the caller
 * prepares the text once and hands the same object to every seed.
 */
export function prepareText(text: string): PreparedText {
  const folded = fold(text)
  const tokens: TextToken[] = []
  const index = new Map<string, number[]>()
  TOKEN.lastIndex = 0
  for (;;) {
    const m = TOKEN.exec(folded)
    if (!m) break
    const t: TextToken = { text: m[0], at: m.index, end: m.index + m[0].length }
    const bucket = index.get(t.text)
    if (bucket) bucket.push(tokens.length)
    else index.set(t.text, [tokens.length])
    tokens.push(t)
  }
  return { original: text, folded, tokens, index, hasCyrillic: hasCyrillic(folded), hasLatin: hasLatin(folded) }
}

function asPrepared(text: string | PreparedText): PreparedText {
  return typeof text === 'string' ? prepareText(text) : text
}

/* ------------------------------------------------------------------ *
 * Name shapes
 * ------------------------------------------------------------------ */

interface NamePart {
  /** As typed, for the `why` phrase. */
  text: string
  folded: string
  /** A single letter, with or without a full stop: the `B.` of `Linus B. Torvalds`. */
  initial: boolean
}

/**
 * Split a seeded name into its parts, keeping a hyphenated surname whole.
 *
 * `Ivanova-Petrova` is one part here and two tokens later, which is exactly the
 * distinction the `compound` rule needs: the seed names one surname, and the sources drop
 * one half of it.
 */
function parseName(value: string): NamePart[] {
  const raw = value.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []
  return raw.map((text) => ({ text, folded: fold(text), initial: text.length === 1 }))
}

interface Shape {
  tokens: string[]
  rule: NameMatchRule
  /** How many transliterated spellings this shape is worth generating. */
  translitCap: number
  /**
   * The `<found> → <seeded>` half of the `why` phrase, for the rules where the seed's own
   * text is not the right thing to show. A diminutive must always read short-form first,
   * whichever direction the table was walked in.
   */
  phrase?: string
}

function splitTokens(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function shapesFor(parts: NamePart[]): Shape[] {
  const shapes: Shape[] = []
  const push = (s: Shape): void => {
    if (!s.tokens.length) return
    if (shapes.some((x) => x.rule === s.rule && x.tokens.join(' ') === s.tokens.join(' '))) return
    shapes.push(s)
  }

  const all = parts.flatMap((p) => splitTokens(p.folded))
  const named = parts.filter((p) => !p.initial)
  const namedTokens = named.flatMap((p) => splitTokens(p.folded))

  // The seed exactly as it was typed. `exact` here is provisional: whether the hit was
  // literal or only literal-after-folding is decided against the haystack, below.
  push({ tokens: all, rule: 'exact', translitCap: MAX_TRANSLITERATIONS })

  // The same name with any middle initials dropped. Both remaining tokens are still
  // literally present, so this stays `exact`.
  if (namedTokens.length >= 2 && namedTokens.length !== all.length) {
    push({ tokens: namedTokens, rule: 'exact', translitCap: 24 })
  }

  // "Family Given" rather than "Given Family". The parts are reversed, not the tokens: a
  // hyphenated surname keeps its own internal order when it moves to the front.
  if (named.length >= 2) {
    push({ tokens: [...named].reverse().flatMap((p) => splitTokens(p.folded)), rule: 'reversed', translitCap: 24 })
  }

  // Half of a compound surname, dropped the way registration forms drop it.
  for (const part of named) {
    const pieces = splitTokens(part.folded)
    if (pieces.length < 2) continue
    for (const piece of pieces) {
      const swapped = named.flatMap((p) => (p === part ? [piece] : splitTokens(p.folded)))
      if (swapped.length < 2) continue
      push({ tokens: swapped, rule: 'compound', translitCap: 12, phrase: part.text })
    }
  }

  // The given name on its own. A bare surname is deliberately not offered — see the
  // header: it is where the false positives live.
  const first = parts[0]
  if (named.length >= 2 && first && !first.initial) {
    push({ tokens: splitTokens(first.folded).slice(0, 1), rule: 'given-name', translitCap: 12 })
  }

  // `G. Blimborgov`.
  const lastNamed = named[named.length - 1]
  if (named.length >= 2 && first && !first.initial && lastNamed) {
    const initial = first.folded[0]
    const surname = splitTokens(lastNamed.folded)
    if (initial && surname.length) push({ tokens: [initial, ...surname], rule: 'initials', translitCap: 12 })
  }

  // Diminutives, in both directions, for every part the table knows. The phrase always
  // reads short form first, so the operator sees the nickname and the formal name in the
  // order that explains the inference rather than in the order the table was walked.
  for (let i = 0; i < named.length; i++) {
    const part = named[i]
    if (!part) continue
    const alternatives = [
      ...diminutivesOf(part.folded).map((alt) => ({ alt, phrase: `${displayName(alt)} → ${part.text}` })),
      ...formalNamesOf(part.folded).map((alt) => ({ alt, phrase: `${part.text} → ${displayName(alt)}` }))
    ]
    for (const { alt, phrase } of alternatives) {
      const swapped = named.flatMap((p, k) => (k === i ? [alt] : splitTokens(p.folded)))
      push({ tokens: swapped, rule: 'diminutive', translitCap: 12, phrase })
      // The short form on its own, which is how someone is addressed in a comment thread.
      if (swapped.length > 1) push({ tokens: [alt], rule: 'diminutive', translitCap: 8, phrase })
    }
  }

  return shapes
}

/* ------------------------------------------------------------------ *
 * Candidates
 * ------------------------------------------------------------------ */

interface Candidate {
  tokens: string[]
  rule: NameMatchRule
  strength: NameMatchStrength
  /** True when this spelling came out of the transliterator rather than the seed. */
  transliterated: boolean
  /** The shape's `<found> → <seeded>` phrase, where the rule needs one. */
  phrase?: string
}

/**
 * How much weight a rule deserves, given how much of a name it matched.
 *
 * Token count is doing the work here, and it is the honest discriminator available without
 * a name-frequency corpus: two tokens is a *name*, one token is a *name part*. A single
 * token can never reach `strong` under any rule, which is what stops `Chris` from
 * rendering beside `Linus Torvalds`.
 */
function strengthFor(rule: NameMatchRule, tokens: string[]): NameMatchStrength {
  const n = tokens.length
  const letters = tokens.join('').length
  switch (rule) {
    case 'exact':
    case 'diacritic':
      return n >= 2 ? 'strong' : letters >= 6 ? 'moderate' : 'weak'
    case 'reversed':
      return 'strong'
    case 'transliteration':
      return n >= 2 ? 'strong' : 'weak'
    case 'compound':
      return 'moderate'
    case 'diminutive':
      return n >= 2 ? 'moderate' : 'weak'
    case 'given-name':
    case 'initials':
      return 'weak'
  }
}

function meetsFloor(rule: NameMatchRule, tokens: string[]): boolean {
  return tokens.join('').length >= NAME_RULE_FLOOR[rule]
}

/** The fuzzier rule takes the label; the weaker strength takes the weight. */
function combine(a: NameMatchRule, b: NameMatchRule, tokens: string[]): Candidate {
  const rule = FUZZINESS[a] >= FUZZINESS[b] ? a : b
  return {
    tokens,
    rule,
    strength: weaker(strengthFor(a, tokens), strengthFor(b, tokens)),
    transliterated: true
  }
}

export interface MatchNameOptions {
  /**
   * Whether the diminutive table may fire. Off for anything that is not a person's name —
   * a city called `Мими` is not `Мария`.
   */
  diminutives?: boolean
}


/**
 * Candidate sets are rebuilt for every finding a seed is checked against, and building one
 * runs the transliterator. Two dozen seeds against several hundred claims is enough calls
 * for that to matter, and the answer depends only on the seed, the two script flags and
 * the one option — so it is memoised on exactly those. The cache is dropped whole rather
 * than aged, because a self-audit run is short and a stale entry is impossible.
 */
const CANDIDATE_CACHE = new Map<string, Candidate[]>()
const CANDIDATE_CACHE_LIMIT = 128

function candidatesFor(seedValue: string, hay: PreparedText, options: MatchNameOptions): Candidate[] {
  const allowDiminutives = options.diminutives !== false
  const seedCyrillic = hasCyrillic(seedValue)
  const seedLatin = hasLatin(seedValue)
  const needLatin = seedCyrillic && hay.hasLatin
  const needCyrillic = seedLatin && hay.hasCyrillic

  const key = `${allowDiminutives ? 'd' : '-'}${needLatin ? 'l' : '-'}${needCyrillic ? 'c' : '-'}|${seedValue}`
  const cached = CANDIDATE_CACHE.get(key)
  if (cached) return cached

  const parts = parseName(seedValue)
  const out: Candidate[] = []
  const seen = new Set<string>()

  const add = (c: Candidate): void => {
    if (out.length >= MAX_NAME_CANDIDATES) return
    if (!meetsFloor(c.rule, c.tokens)) return
    const dedupe = `${c.rule}:${c.tokens.join(' ')}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    out.push(c)
  }

  if (!parts.length) {
    if (CANDIDATE_CACHE.size >= CANDIDATE_CACHE_LIMIT) CANDIDATE_CACHE.clear()
    CANDIDATE_CACHE.set(key, out)
    return out
  }

  for (const shape of shapesFor(parts)) {
    if (shape.rule === 'diminutive' && !allowDiminutives) continue
    const literal: Candidate = {
      tokens: shape.tokens,
      rule: shape.rule,
      strength: strengthFor(shape.rule, shape.tokens),
      transliterated: false
    }
    add(shape.phrase ? { ...literal, phrase: shape.phrase } : literal)

    if (!needLatin && !needCyrillic) continue
    const joined = shape.tokens.join(' ')
    const spellings = needLatin
      ? latinFormsOf(joined, shape.translitCap)
      : cyrillicFormsOf(joined, shape.translitCap)

    // One token spelled unusually, the rest spelled the dull way.
    //
    // The breadth-first expansion above spends its departure budget across the whole
    // phrase at once, so for a two-token name it works outwards from the middle and never
    // reaches the spellings where one token is two departures from canonical and the other
    // is none. That is the common case rather than a corner: a surname is transliterated
    // the obvious way by whichever form generated it, and only the given name is spelled
    // `Gueorgui`. So each token is also expanded on its own against canonical spellings of
    // the rest — linear in the token count, and it carries the irregular table with it.
    const canonical = shape.tokens.map((t) =>
      needLatin ? (latinFormsOf(t, 1)[0] ?? t) : (cyrillicFormsOf(t, 1)[0] ?? t)
    )
    const perTokenCap = Math.max(4, Math.round(shape.translitCap / 2))
    const perToken: string[] = []
    shape.tokens.forEach((t, i) => {
      const forms = needLatin
        ? [...latinFormsOf(t, perTokenCap), ...(IRREGULAR_LATIN[t] ?? [])]
        : [...cyrillicFormsOf(t, perTokenCap), ...(IRREGULAR_CYRILLIC.get(t) ?? [])]
      for (const form of forms) {
        const copy = [...canonical]
        copy[i] = form
        perToken.push(copy.join(' '))
      }
    })

    for (const spelling of [...spellings, ...perToken]) {
      const tokens = splitTokens(spelling)
      if (tokens.length !== shape.tokens.length) continue
      if (tokens.join(' ') === joined) continue
      const c = combine(shape.rule, 'transliteration', tokens)
      add(shape.phrase ? { ...c, phrase: shape.phrase } : c)
    }
  }

  if (CANDIDATE_CACHE.size >= CANDIDATE_CACHE_LIMIT) CANDIDATE_CACHE.clear()
  CANDIDATE_CACHE.set(key, out)
  return out
}

/* ------------------------------------------------------------------ *
 * The matcher
 * ------------------------------------------------------------------ */

function spanAt(hay: PreparedText, start: number, tokens: string[]): TextToken[] | null {
  const first = hay.tokens[start]
  if (!first || first.text !== tokens[0]) return null
  const span: TextToken[] = [first]
  for (let k = 1; k < tokens.length; k++) {
    const previous = span[span.length - 1]
    const next = hay.tokens[start + k]
    if (!previous || !next || next.text !== tokens[k]) return null
    if (!THIN_GAP.test(hay.folded.slice(previous.end, next.at))) return null
    span.push(next)
  }
  return span
}

/** How many places one candidate spelling is allowed to fire, so one word cannot flood. */
const MAX_HITS_PER_CANDIDATE = 16

interface Hit {
  at: number
  end: number
  candidate: Candidate
}

/**
 * One phrase naming the mechanism, for the row the operator reads.
 *
 * House rule, from the adapter `doc` contract onwards: show the mechanism. An attribution
 * that says only "matched" is a claim; one that says "diminutive: Сашо → Александър" is a
 * claim the operator can overrule in a second. A spelling that came out of the
 * transliterator says so explicitly, because the found text will not look like the seed.
 */
function describe(seedValue: string, candidate: Candidate, matched: string, exactly: boolean): string {
  const seed = seedValue.trim().replace(/\s+/g, ' ')
  const spelled = candidate.transliterated ? `, spelled ${matched}` : ''
  switch (candidate.rule) {
    case 'exact':
      return exactly ? `exact match: ${matched}` : `diacritics folded: ${matched} → ${seed}`
    case 'diacritic':
      return `diacritics folded: ${matched} → ${seed}`
    case 'transliteration':
      return `transliteration: ${seed} → ${matched}`
    case 'reversed':
      return `family name first: ${matched} → ${seed}`
    case 'compound':
      return `half of a compound name: ${matched} → ${candidate.phrase ?? seed}`
    case 'given-name':
      return `given name only: ${matched}, of ${seed}`
    case 'initials':
      return `initial and surname: ${matched} → ${seed}`
    case 'diminutive':
      return `diminutive: ${candidate.phrase ?? `${matched} → ${seed}`}${spelled}`
  }
}

function toMatch(seedValue: string, hay: PreparedText, hit: Hit): NameMatch {
  const matched = hay.original.slice(hit.at, hit.end)
  // `exact` is provisional until the haystack is read: a hit is literal only when neither
  // side needed folding, which is the difference between "Ivanović" and "Ivanovic".
  const exactly =
    matched.toLowerCase().replace(/\s+/g, ' ') === seedValue.trim().toLowerCase().replace(/\s+/g, ' ')
  const rule: NameMatchRule = hit.candidate.rule === 'exact' && !exactly ? 'diacritic' : hit.candidate.rule
  return {
    rule,
    strength: hit.candidate.strength,
    matched,
    why: describe(seedValue, hit.candidate, matched, exactly),
    at: hit.at,
    length: hit.end - hit.at
  }
}

function collect(seedValue: string, text: string | PreparedText, limit: number, options: MatchNameOptions): NameMatch[] {
  const hay = asPrepared(text)
  if (!hay.tokens.length) return []

  const hits: Hit[] = []
  for (const candidate of candidatesFor(seedValue, hay, options)) {
    const starts = hay.index.get(candidate.tokens[0] ?? '')
    if (!starts) continue
    let fired = 0
    for (const start of starts) {
      const span = spanAt(hay, start, candidate.tokens)
      if (!span) continue
      const firstToken = span[0]
      const lastToken = span[span.length - 1]
      if (!firstToken || !lastToken) continue
      hits.push({ at: firstToken.at, end: lastToken.end, candidate })
      if (++fired >= MAX_HITS_PER_CANDIDATE) break
    }
  }
  if (!hits.length) return []

  // Strongest first, then longest, then in document order — so a caller that takes one
  // gets the best explanation of the match rather than the first one found.
  hits.sort(
    (a, b) =>
      STRENGTH_RANK[b.candidate.strength] - STRENGTH_RANK[a.candidate.strength] ||
      FUZZINESS[a.candidate.rule] - FUZZINESS[b.candidate.rule] ||
      b.end - b.at - (a.end - a.at) ||
      a.at - b.at
  )

  const out: NameMatch[] = []
  const takenOffsets = new Set<number>()
  for (const hit of hits) {
    if (takenOffsets.has(hit.at)) continue
    takenOffsets.add(hit.at)
    out.push(toMatch(seedValue, hay, hit))
    if (out.length >= limit) break
  }
  return out
}

/**
 * The strongest way `seedValue` appears in `haystack`, or `null`.
 *
 * Never the first rule that fires — every candidate spelling is tried and the strongest
 * surviving hit is returned, because the operator must see that a result was attributable
 * by a full literal name rather than by a nickname that happened to be checked first.
 */
export function matchName(
  seedValue: string,
  haystack: string | PreparedText,
  options: MatchNameOptions = {}
): NameMatch | null {
  return collect(seedValue, haystack, 1, options)[0] ?? null
}

/** Up to `limit` distinct places `seedValue` appears, strongest first. */
export function matchNameAll(
  seedValue: string,
  haystack: string | PreparedText,
  limit: number,
  options: MatchNameOptions = {}
): NameMatch[] {
  return limit > 0 ? collect(seedValue, haystack, limit, options) : []
}
