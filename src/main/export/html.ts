/**
 * The shareable report: one HTML file, no external anything.
 *
 * ## Constraints that shaped it
 *
 * - **Self-contained.** No stylesheet, no script, no font, no remote image. Every picture
 *   is inlined as a `data:` URI from bytes the case already holds. It opens from a
 *   Downloads folder with the wifi off, and opening it phones nobody — which matters,
 *   because the person opening it is the person the file is about.
 * - **Written to the subject.** Second person, no jargon that is not immediately explained,
 *   no tool names in the body. The reader agreed to be looked up by a friend; the document
 *   should read like being shown someone's working, not like being served papers.
 * - **Certainty is legible without reading anything.** The single most important thing this
 *   file conveys is the difference between "this is definitely you" and "this might be
 *   anyone with your username". That distinction is carried by a heading, a label in words,
 *   a glyph, and text weight — four separate channels, none of them colour alone, so it
 *   survives greyscale, colour blindness and a phone screen in sunlight.
 *
 * ## Why it does not look like the app
 *
 * The Darkroom's confidence ramp is a *luminance and weight* ramp — latent, developing,
 * developed — and that idea carries over unchanged here. What does not carry over is the
 * near-black canvas: this file is opened in a browser by somebody who is not sitting in a
 * dark room at four in the morning, so the ramp is inverted onto paper and the dark
 * variant is offered through `prefers-color-scheme` rather than assumed. Both are defined
 * as literal values because a standalone file has no token layer to inherit — which is
 * also why this module lives under `src/main/` and not under the renderer, where the design
 * lint would (correctly) refuse every colour in it.
 */

import type { AvatarGallery, ExportLang, GalleryImage } from '../../shared/ipc'
import { BAND_ORDER, type Band, type ExportAccount, type ExportBundle, type IdentityItem, type IdentityKind } from './bundle'

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

interface Strings {
  docTitle: (subject: string) => string
  forWhom: (subject: string) => string
  preparedBy: (who: string) => string
  generated: string
  howToRead: string
  howToReadBody: string
  keyHeading: string
  bandName: Record<Band, string>
  bandMeaning: Record<Band, string>
  bandGlyph: Record<Band, string>
  accountsHeading: string
  noAccounts: string
  vouched: string
  sources: (n: number) => string
  seenBy: string
  identityHeading: string
  identityBlurb: string
  identityKind: Record<IdentityKind, string>
  saidBy: (n: number) => string
  picturesHeading: string
  picturesBlurb: string
  sharedPicture: (n: number) => string
  onePicture: string
  defaultPictures: string
  defaultPicturesBlurb: string
  unreadablePictures: string
  unreadableBlurb: string
  notFetched: string
  notFetchedBlurb: string
  noPicture: string
  uncheckedHeading: string
  uncheckedBlurb: string
  uncheckedNone: string
  answeredNoneHeading: string
  answeredNoneBlurb: string
  notAskedHeading: string
  notAskedBlurb: string
  otherHeading: string
  otherBlurb: string
  otherCount: (findings: number, tools: number) => string
  orphanHeading: string
  orphanBlurb: string
  noiseWithheld: (n: number) => string
  pending: string
  adviceHeading: string
  adviceBlurb: string
  touches: (n: number) => string
  effort: Record<'minutes' | 'an evening' | 'weeks of waiting', string>
  noiseHeading: string
  noiseBlurb: string
  methodHeading: string
  methodBlurb: string
  toolsUsed: string
  claimsFrom: (n: number) => string
  seedsHeading: string
  seedsBlurb: string
  notPublishable: string
  profileName: string
  profileLocation: string
  profileWork: string
  profileJoined: string
  profileBio: string
  profileFollowers: string
  profileLinks: string
}

const EN: Strings = {
  docTitle: (s) => (s ? `What is publicly findable about ${s}` : 'What is publicly findable about you'),
  forWhom: (s) => (s ? `Written for ${s}.` : 'Written for you.'),
  preparedBy: (who) => `Put together by ${who}.`,
  generated: 'Generated',
  howToRead: 'How to read this',
  howToReadBody:
    'Everything below was found by looking at public pages — the same pages anybody can open without logging in. Nothing was hacked, guessed at, or bought. The important thing is that the sections are not equally reliable: the first one is things that were checked and hold up, and the last one is things a single automatic check reported that are very often simply wrong. Read the labels before you believe anything.',
  keyHeading: 'What the labels mean',
  bandName: {
    confirmed: 'Definitely you',
    corroborated: 'Two sites agree',
    probable: 'Probably you',
    unverified: 'Might be anyone',
    noise: 'Set aside'
  },
  bandMeaning: {
    confirmed:
      'Somebody opened this page, looked at it, and wrote down that it is yours. That is the only thing that reaches this label — no amount of automatic agreement does.',
    corroborated:
      'Two websites run by different people reported this independently. That is real agreement and much better than one, but it is still two machines agreeing: neither of them opened the page and checked it was you. Sites that block robots can both answer the same wrong way.',
    probable:
      'Something beyond the username matches — usually the same profile picture as another of your accounts, or a link you published yourself pointing at it. Worth checking, not yet proven.',
    unverified:
      'One automatic check said this account exists and nothing else backs it up. Most of these are wrong. Sites that block robots often answer a check in a way that reads as "yes, this exists", and a username can simply belong to a different person.',
    noise:
      'Excluded on purpose, and shown anyway so you can see what was excluded and why. Each one says which rule removed it.'
  },
  bandGlyph: { confirmed: '●', corroborated: '◕', probable: '◐', unverified: '○', noise: '×' },
  accountsHeading: 'Accounts',
  noAccounts: 'No accounts were found in this case.',
  vouched: 'added to the case by hand',
  sources: (n) => `${n} independent ${n === 1 ? 'source' : 'sources'}`,
  seenBy: 'Found by',
  identityHeading: 'What those pages say about you',
  identityBlurb:
    'Every line here is text somebody typed into a profile box and a website then published. None of it has been verified against anything — a location field is a claim, not a measurement, and it can be years out of date or deliberately false. Where two different sites say the same thing, that is noted, because two sites agreeing is much harder to arrange by accident than one.',
  identityKind: {
    name: 'Names shown on your profiles',
    place: 'Places named on your profiles',
    work: 'Work and school',
    contact: 'Contact details published in the open',
    link: 'Links you published between your own accounts',
    age: 'When these accounts were made'
  },
  saidBy: (n) => (n === 1 ? 'said by 1 site' : `said by ${n} different sites`),
  picturesHeading: 'Your pictures',
  picturesBlurb:
    'Profile pictures found on the accounts above. They are grouped by which of them are the same picture — not the same file, the same picture, so a photograph that two sites have resized and re-compressed differently still matches. Two accounts sharing a picture is the strongest single link in this whole document: usernames collide by accident, photographs do not.',
  sharedPicture: (n) => `The same picture on ${n} accounts`,
  onePicture: 'On one account only',
  defaultPictures: 'Accounts with no picture of their own',
  defaultPicturesBlurb:
    'These are showing the website’s stock avatar — the identical image every account there gets until someone uploads one. They are listed apart because matching one of these against another means nothing at all.',
  unreadablePictures: 'Pictures that could not be compared',
  unreadableBlurb:
    'These were downloaded but could not be turned into something comparable, so they are neither matched nor ruled out. They are unchecked, not clear.',
  notFetched: 'Pictures nobody has downloaded yet',
  notFetchedBlurb: 'A search noted these picture addresses but no picture has been fetched, so none of them has been compared.',
  noPicture: 'no picture kept',
  uncheckedHeading: 'What could not be checked',
  uncheckedBlurb:
    'This is separate from "nothing was found", and the difference matters more than anything else on this page. A website that refuses to answer has told us nothing about you. Reported as "nothing found", that would read as reassurance you have not earned. Everything in this section is a gap, not a clean bill of health.',
  uncheckedNone: 'Every check that ran either answered or is listed below as having found nothing.',
  answeredNoneHeading: 'Checks that ran and found nothing',
  answeredNoneBlurb:
    'These finished, reported no error, and came back empty. That is a result rather than a gap — it is the one part of this document that is mildly reassuring, and only about the sites each check actually reached.',
  notAskedHeading: 'What was never asked',
  notAskedBlurb: 'These checks exist and were not run in this case. They are not gaps in the results — they are questions nobody put.',
  otherHeading: 'Everything else this case holds',
  otherBlurb:
    'The counts above are only about what is printed on this page. This is the remainder: things noted while following something up, which belong to no account listed here. They are named rather than left out, so the numbers above can be checked.',
  otherCount: (findings, tools) =>
    `${findings} ${findings === 1 ? 'note' : 'notes'} from ${tools} ${tools === 1 ? 'check' : 'checks'}, not shown above.`,
  orphanHeading: 'Notes about things no longer in the case',
  orphanBlurb:
    'Something was looked up and then removed. What a check reported at the time is kept — taking the question out does not unobserve the answer — so it is listed here rather than deleted.',
  noiseWithheld: (n) =>
    `${n} ${n === 1 ? 'entry was' : 'entries were'} set aside as noise and left out of this copy. They exist in the case; this version of the file simply does not print them.`,
  pending: 'not reviewed yet',
  adviceHeading: 'What this means for you',
  adviceBlurb:
    'Ordered by how much each one actually disconnects, not by how alarming it sounds. Nothing here is urgent and nothing here is a disaster.',
  touches: (n) => `touches ${n} ${n === 1 ? 'thing' : 'things'}`,
  effort: { minutes: 'a few minutes', 'an evening': 'an evening', 'weeks of waiting': 'weeks of waiting' },
  noiseHeading: 'Set aside as noise',
  noiseBlurb:
    'These were found and then excluded, each for a stated reason. They are here so you can check the filter rather than trust it. If one of them is actually yours, the reason beside it will tell you why it was missed.',
  methodHeading: 'How this was made',
  methodBlurb:
    'Public pages only, opened without logging in to anything, at the speed a person would open them. No password was tried, no message was sent, and no account of yours was touched. Everything above is what a stranger with the same starting information could have found in an afternoon. Nothing in this file is proof of anything — it is a record of what a set of automatic checks reported, with the reliability of each one stated beside it.',
  toolsUsed: 'Checks that produced something',
  claimsFrom: (n) => `${n} ${n === 1 ? 'statement' : 'statements'}`,
  seedsHeading: 'What this started from',
  seedsBlurb: 'Everything above was reached from these, and nothing else was supplied.',
  notPublishable:
    'This file is written for the person it is about. It is not a document to publish or pass on to anybody else.',
  profileName: 'Name shown',
  profileLocation: 'Location shown',
  profileWork: 'Work',
  profileJoined: 'Account made',
  profileBio: 'Profile text',
  profileFollowers: 'Followers',
  profileLinks: 'Links on the page'
}

const BG: Strings = {
  docTitle: (s) => (s ? `Какво може да се намери публично за ${s}` : 'Какво може да се намери публично за теб'),
  forWhom: (s) => (s ? `Написано за ${s}.` : 'Написано за теб.'),
  preparedBy: (who) => `Съставено от ${who}.`,
  generated: 'Създадено на',
  howToRead: 'Как да четеш това',
  howToReadBody:
    'Всичко по-долу е намерено от публични страници — същите, които всеки може да отвори без да влиза в акаунт. Нищо не е хакнато, налучкано или купено. Важното е, че разделите не са еднакво надеждни: първият е неща, които са проверени и се държат, а последният е неща, които една автоматична проверка е докладвала и които много често просто са грешни. Прочети етикетите, преди да повярваш на каквото и да е.',
  keyHeading: 'Какво значат етикетите',
  bandName: {
    confirmed: 'Определено ти',
    corroborated: 'Два сайта се съгласяват',
    probable: 'Вероятно ти',
    unverified: 'Може да е всеки',
    noise: 'Отделено настрани'
  },
  bandMeaning: {
    confirmed:
      'Някой е отворил тази страница, погледнал я е и е записал, че е твоя. Само това стига до този етикет — никакво количество автоматично съгласие не стига.',
    corroborated:
      'Два сайта, управлявани от различни хора, са докладвали това независимо един от друг. Това е истинско съгласие и е много по-добро от едно, но пак са две машини, които се съгласяват: никоя от тях не е отворила страницата, за да провери, че си ти. Сайтовете, които блокират ботове, могат да отговорят еднакво грешно.',
    probable:
      'Съвпада нещо повече от потребителското име — обикновено същата профилна снимка като на друг твой акаунт, или връзка, която ти самият си публикувал към него. Струва си да се провери, но още не е доказано.',
    unverified:
      'Една автоматична проверка е казала, че акаунтът съществува, и нищо друго не го потвърждава. Повечето от тези са грешни. Сайтовете, които блокират ботове, често отговарят така, че проверката чете „да, съществува“, а едно потребителско име може просто да е на друг човек.',
    noise:
      'Изключено нарочно и показано въпреки това, за да видиш какво е изключено и защо. При всяко пише кое правило го е махнало.'
  },
  bandGlyph: { confirmed: '●', corroborated: '◕', probable: '◐', unverified: '○', noise: '×' },
  accountsHeading: 'Акаунти',
  noAccounts: 'В този случай не са намерени акаунти.',
  vouched: 'добавено на ръка към случая',
  sources: (n) => `${n} независим${n === 1 ? ' източник' : 'и източника'}`,
  seenBy: 'Намерено от',
  identityHeading: 'Какво пише за теб на тези страници',
  identityBlurb:
    'Всеки ред тук е текст, който някой е написал в поле на профил, а сайтът го е публикувал. Нищо от това не е проверено срещу нищо — полето за местоположение е твърдение, не измерване, и може да е отпреди години или нарочно невярно. Където два различни сайта казват едно и също, това е отбелязано, защото две съвпадения са много по-трудни за случайност от едно.',
  identityKind: {
    name: 'Имена, показани в профилите ти',
    place: 'Места, посочени в профилите ти',
    work: 'Работа и училище',
    contact: 'Контакти, публикувани на открито',
    link: 'Връзки, които сам си публикувал между акаунтите си',
    age: 'Кога са направени тези акаунти'
  },
  saidBy: (n) => (n === 1 ? 'казано от 1 сайт' : `казано от ${n} различни сайта`),
  picturesHeading: 'Твоите снимки',
  picturesBlurb:
    'Профилни снимки, намерени по акаунтите по-горе. Групирани са по това кои от тях са една и съща снимка — не един и същ файл, а една и съща снимка, така че фотография, преоразмерена и прекодирана различно от два сайта, пак съвпада. Две акаунта с обща снимка са най-силната връзка в целия документ: потребителските имена се засичат случайно, снимките — не.',
  sharedPicture: (n) => `Една и съща снимка на ${n} акаунта`,
  onePicture: 'Само на един акаунт',
  defaultPictures: 'Акаунти без собствена снимка',
  defaultPicturesBlurb:
    'Тези показват стандартната картинка на сайта — същото изображение, което всеки акаунт там получава, докато някой не качи своя. Изброени са отделно, защото съвпадение между две такива не значи абсолютно нищо.',
  unreadablePictures: 'Снимки, които не можаха да бъдат сравнени',
  unreadableBlurb:
    'Тези са свалени, но не можаха да бъдат превърнати в нещо сравнимо, така че не са нито съпоставени, нито изключени. Те са непроверени, а не чисти.',
  notFetched: 'Снимки, които още не са свалени',
  notFetchedBlurb: 'Търсене е отбелязало тези адреси на снимки, но нито една не е свалена, така че нито една не е сравнена.',
  noPicture: 'снимката не е запазена',
  uncheckedHeading: 'Какво не можа да бъде проверено',
  uncheckedBlurb:
    'Това е различно от „не беше намерено нищо“ и разликата е по-важна от всичко друго на тази страница. Сайт, който откаже да отговори, не ни е казал нищо за теб. Ако това се отчете като „нищо не е намерено“, звучи като успокоение, което не е заслужено. Всичко в този раздел е празнина, не чисто досие.',
  uncheckedNone: 'Всяка проверка, която беше пусната, или отговори, или е изброена по-долу като намерила нищо.',
  answeredNoneHeading: 'Проверки, които минаха и не намериха нищо',
  answeredNoneBlurb:
    'Тези приключиха, не съобщиха грешка и се върнаха празни. Това е резултат, а не празнина — единствената леко успокоителна част от документа, и то само за сайтовете, до които всяка проверка наистина стигна.',
  notAskedHeading: 'Какво изобщо не беше питано',
  notAskedBlurb: 'Тези проверки съществуват и не бяха пуснати в този случай. Те не са празнини в резултатите — те са въпроси, които никой не зададе.',
  otherHeading: 'Какво друго съдържа случаят',
  otherBlurb:
    'Числата по-горе са само за това, което е отпечатано на тази страница. Това е остатъкът: неща, отбелязани докато е следвана друга следа, които не принадлежат на никой изброен тук акаунт. Назовани са, вместо да бъдат пропуснати, за да могат числата по-горе да бъдат проверени.',
  otherCount: (findings, tools) =>
    `${findings} ${findings === 1 ? 'бележка' : 'бележки'} от ${tools} ${tools === 1 ? 'проверка' : 'проверки'}, непоказани по-горе.`,
  orphanHeading: 'Бележки за неща, които вече не са в случая',
  orphanBlurb:
    'Нещо е било проверено и после премахнато. Каквото проверката е докладвала тогава, се пази — махането на въпроса не отменя отговора — затова е изброено тук, а не изтрито.',
  noiseWithheld: (n) =>
    `${n} ${n === 1 ? 'запис беше отделен' : 'записа бяха отделени'} като шум и не ${n === 1 ? 'е включен' : 'са включени'} в това копие. Съществуват в случая; просто този вариант на файла не ги отпечатва.`,
  pending: 'още непрегледано',
  adviceHeading: 'Какво значи това за теб',
  adviceBlurb:
    'Подредено по това колко всъщност разкача всяко едно, а не по това колко тревожно звучи. Нищо тук не е спешно и нищо тук не е катастрофа.',
  touches: (n) => `засяга ${n} ${n === 1 ? 'нещо' : 'неща'}`,
  effort: { minutes: 'няколко минути', 'an evening': 'една вечер', 'weeks of waiting': 'седмици чакане' },
  noiseHeading: 'Отделено като шум',
  noiseBlurb:
    'Тези бяха намерени и после изключени, всяко с посочена причина. Тук са, за да можеш да провериш филтъра, вместо да му вярваш. Ако някое от тях наистина е твое, причината до него ще ти каже защо е било пропуснато.',
  methodHeading: 'Как е направено това',
  methodBlurb:
    'Само публични страници, отваряни без влизане в какъвто и да е акаунт, със скоростта, с която човек би ги отворил. Не е пробвана парола, не е изпратено съобщение и не е пипнат нито един твой акаунт. Всичко по-горе е това, което непознат със същата начална информация би могъл да намери за един следобед. Нищо в този файл не е доказателство за нищо — той е запис на това какво са докладвали автоматични проверки, с надеждността на всяка от тях, посочена до нея.',
  toolsUsed: 'Проверки, които дадоха резултат',
  claimsFrom: (n) => `${n} ${n === 1 ? 'твърдение' : 'твърдения'}`,
  seedsHeading: 'От какво тръгна това',
  seedsBlurb: 'Всичко по-горе е достигнато от тези неща и нищо друго не е подавано.',
  notPublishable:
    'Този файл е написан за човека, за когото се отнася. Той не е документ за публикуване или предаване на друг.',
  profileName: 'Показано име',
  profileLocation: 'Показано местоположение',
  profileWork: 'Работа',
  profileJoined: 'Акаунтът е направен',
  profileBio: 'Текст в профила',
  profileFollowers: 'Последователи',
  profileLinks: 'Връзки на страницата'
}

const STRINGS: Record<ExportLang, Strings> = { en: EN, bg: BG }

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

/**
 * Every string in this document came from a website. All of them go through here.
 *
 * A bio is attacker-controlled text by construction, and this file is opened in a browser
 * by the person it is about. `&` first, or the other replacements get double-escaped.
 */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A `data:` URI is safe to inline; anything else becomes text, never an `src`. */
function safeImageSrc(image: GalleryImage): string | null {
  return image.dataUri !== null && image.dataUri.startsWith('data:image/') ? image.dataUri : null
}

/* ------------------------------------------------------------------ *
 * Style
 * ------------------------------------------------------------------ */

/**
 * The whole stylesheet, inline.
 *
 * The confidence ramp is the only part with a rule behind it: certainty is carried by
 * **text weight and ink darkness**, exactly as in the app, plus a glyph and a word. Colour
 * is used for the band rules and nothing semantic, so the document reads identically in
 * greyscale, printed, or to someone who cannot distinguish red from green.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --paper: #fbfaf8;
  --panel: #ffffff;
  --rule: #e2ded7;
  --rule-strong: #c9c3b8;
  --ink: #1b1917;
  --ink-strong: #000000;
  --ink-muted: #55504a;
  --ink-faint: #6d6760;
  --mark: #8c2f2f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14100f;
    --panel: #1b1717;
    --rule: #332c2c;
    --rule-strong: #4a4040;
    --ink: #ece7e2;
    --ink-strong: #ffffff;
    --ink-muted: #b3aba4;
    --ink-faint: #948c85;
    --mark: #d98d7a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 20px 96px;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.65rem; line-height: 1.25; margin: 0 0 8px; letter-spacing: -0.01em; }
h2 { font-size: 1.2rem; margin: 48px 0 4px; padding-top: 20px; border-top: 1px solid var(--rule-strong); }
h3 { font-size: 0.95rem; margin: 28px 0 8px; color: var(--ink-muted); font-weight: 600; }
p { margin: 10px 0; }
.lede { color: var(--ink-muted); }
.meta { color: var(--ink-faint); font-size: 0.85rem; margin: 2px 0; }
.blurb { color: var(--ink-muted); font-size: 0.92rem; max-width: 40rem; }
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.85em; }
.card {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 5px;
  padding: 14px 16px;
  margin: 12px 0;
}
.key { display: grid; gap: 10px; margin: 16px 0 8px; }
.key .card { margin: 0; }
.row { display: flex; gap: 14px; align-items: flex-start; }
.avatar {
  width: 56px; height: 56px; flex: 0 0 56px;
  border-radius: 4px; border: 1px solid var(--rule-strong);
  object-fit: cover; background: var(--paper);
}
.avatar--empty {
  display: flex; align-items: center; justify-content: center;
  font-size: 0.6rem; color: var(--ink-faint); text-align: center; padding: 4px; line-height: 1.2;
}
.grow { min-width: 0; flex: 1 1 auto; }
.title { margin: 0 0 2px; font-size: 1rem; word-break: break-word; }
.handle { color: var(--ink-muted); }
.tag {
  display: inline-block; font-size: 0.72rem; line-height: 1.5;
  border: 1px solid var(--rule-strong); border-radius: 3px;
  padding: 0 6px; margin: 2px 6px 2px 0; color: var(--ink-muted);
  white-space: nowrap;
}
.why { margin: 8px 0 0; padding: 0 0 0 18px; color: var(--ink-muted); font-size: 0.9rem; }
.why li { margin: 2px 0; }
.fields { margin: 10px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; font-size: 0.9rem; }
.fields dt { color: var(--ink-faint); }
.fields dd { margin: 0; word-break: break-word; }
a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }

/*
 * The ramp. Weight and ink, never hue — the same rule the app itself follows, and the
 * reason it survives greyscale, printing and every form of colour blindness.
 *
 * Carried by a full hairline and a background tint rather than a stripe down one edge:
 * DESIGN.md bans side-stripe accents outright, and it is right to. A 3px bar on the left
 * of a card is the most recognisable tell of a generated interface, and this file is meant
 * to read as somebody's working rather than as a template.
 */
.band { }
.band--confirmed    .title { font-weight: 700; color: var(--ink-strong); }
.band--corroborated .title { font-weight: 700; color: var(--ink); }
.band--probable     .title { font-weight: 600; color: var(--ink); }
.band--unverified   .title { font-weight: 400; color: var(--ink-muted); }
.band--noise        .title { font-weight: 400; color: var(--ink-faint); }
.card.band--confirmed    { border-color: var(--rule-strong); background: var(--panel); }
.card.band--corroborated { border-color: var(--rule-strong); }
.card.band--probable     { border-color: var(--rule); }
.card.band--unverified   { border-color: var(--rule); background: transparent; }
.card.band--noise        { border-color: var(--rule); background: transparent; }
.glyph { font-size: 0.8em; margin-right: 6px; color: var(--ink-faint); }
.bandline { font-size: 0.78rem; letter-spacing: 0.02em; color: var(--ink-faint); margin: 0 0 6px; }

.gallery { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; }
.shot { width: 108px; }
.shot img, .shot .avatar--empty { width: 108px; height: 108px; flex-basis: auto; }
.shot .cap { font-size: 0.72rem; color: var(--ink-muted); margin-top: 4px; word-break: break-word; }
details { margin: 12px 0; }
summary { cursor: pointer; font-weight: 600; }
ul.plain { list-style: none; padding: 0; margin: 8px 0; }
ul.plain li { padding: 6px 0; border-bottom: 1px solid var(--rule); }
ul.plain li:last-child { border-bottom: 0; }
footer { margin-top: 56px; padding-top: 16px; border-top: 1px solid var(--rule-strong); color: var(--ink-faint); font-size: 0.85rem; }
@media print {
  body { background: #ffffff; color: #000000; padding: 0; }
  h2 { page-break-after: avoid; }
  .card { page-break-inside: avoid; }
}
`

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

function accountCard(a: ExportAccount, t: Strings): string {
  const image = a.avatar
  const src = image === null ? null : safeImageSrc(image)
  const picture =
    src !== null
      ? `<img class="avatar" alt="" src="${esc(src)}">`
      : `<div class="avatar avatar--empty">${esc(t.noPicture)}</div>`

  const fields: string[] = []
  const p = a.profile
  if (p !== null) {
    const add = (label: string, value: string | null): void => {
      if (value === null) return
      fields.push(`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`)
    }
    add(t.profileName, p.displayName ?? p.realName)
    add(t.profileLocation, p.location)
    add(t.profileWork, p.company)
    add(t.profileJoined, p.joinedAt)
    add(t.profileFollowers, p.followers === null ? null : String(p.followers))
    add(t.profileBio, p.bio)
    if (p.links.length > 0) {
      fields.push(
        `<dt>${esc(t.profileLinks)}</dt><dd>${p.links
          .map((l) => `<a href="${esc(l.url)}" rel="noopener noreferrer nofollow">${esc(l.url)}</a>`)
          .join('<br>')}</dd>`
      )
    }
  }

  const tags = [
    a.promoted ? `<span class="tag">${esc(t.vouched)}</span>` : '',
    // A positive marker, not merely the absence of one. "Nobody has looked at this" is a
    // fact about the row and reads very differently from an unlabelled row.
    !a.reviewed && a.band !== 'noise' ? `<span class="tag">${esc(t.pending)}</span>` : '',
    a.independentSources >= 2 ? `<span class="tag">${esc(t.sources(a.independentSources))}</span>` : '',
    a.tools.length ? `<span class="tag">${esc(t.seenBy)} ${esc(a.tools.join(', '))}</span>` : ''
  ].join('')

  const heading = a.url
    ? `<a href="${esc(a.url)}" rel="noopener noreferrer nofollow">${esc(a.platform)}</a>`
    : esc(a.platform)

  return `<article class="card band band--${a.band}">
  <div class="row">
    ${picture}
    <div class="grow">
      <p class="title"><span class="glyph">${esc(t.bandGlyph[a.band])}</span>${heading} <span class="handle mono">${esc(a.handle)}</span></p>
      <div>${tags}</div>
      <ul class="why">${a.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      ${fields.length ? `<dl class="fields">${fields.join('')}</dl>` : ''}
    </div>
  </div>
</article>`
}

function bandSection(band: Band, accounts: readonly ExportAccount[], t: Strings): string {
  const rows = accounts.filter((a) => a.band === band)
  if (rows.length === 0) return ''
  return `<h3>${esc(t.bandGlyph[band])} ${esc(t.bandName[band])} — ${rows.length}</h3>
<p class="blurb">${esc(t.bandMeaning[band])}</p>
${rows.map((a) => accountCard(a, t)).join('\n')}`
}

function identitySection(items: readonly IdentityItem[], t: Strings): string {
  if (items.length === 0) return ''
  const kinds: IdentityKind[] = ['name', 'place', 'work', 'contact', 'link', 'age']
  const blocks: string[] = []
  for (const kind of kinds) {
    const rows = items.filter((i) => i.kind === kind)
    if (rows.length === 0) continue
    blocks.push(`<h3>${esc(t.identityKind[kind])}</h3>
<p class="blurb">${esc(rows[0].note)}</p>
<ul class="plain">${rows
      .map(
        (i) =>
          `<li class="band band--${i.band}"><span class="glyph">${esc(t.bandGlyph[i.band])}</span><span class="title">${esc(i.value)}</span><br><span class="meta">${esc(t.saidBy(i.sources.length))} — ${esc(i.sources.join(', '))}</span></li>`
      )
      .join('')}</ul>`)
  }
  return blocks.join('\n')
}

/**
 * One picture, captioned with the confidence of the account it came off.
 *
 * Without the band a gallery is a page of photographs under the heading "Your pictures",
 * every one of them presented as the subject's, with the avatar of a row they dismissed
 * sitting beside a confirmed one and looking identical.
 */
function shot(image: GalleryImage, t: Strings, bandOf: Record<string, Band>): string {
  const band = bandOf[image.accountKey] ?? 'unverified'
  const src = safeImageSrc(image)
  const body =
    src !== null
      ? `<img class="avatar" alt="" src="${esc(src)}">`
      : `<div class="avatar avatar--empty">${esc(image.reason ?? t.noPicture)}</div>`
  return `<figure class="shot band band--${band}" style="margin:0">${body}<figcaption class="cap mono">${esc(image.platform)}/${esc(image.handle)}</figcaption><figcaption class="cap">${esc(t.bandGlyph[band])} ${esc(t.bandName[band])}</figcaption></figure>`
}

/** A group is only as good as its weakest member: unverified pictures make an unverified group. */
function groupBand(accounts: readonly string[], bandOf: Record<string, Band>): Band {
  let band: Band = 'confirmed'
  for (const key of accounts) {
    const member = bandOf[key] ?? 'unverified'
    if (BAND_ORDER[member] > BAND_ORDER[band]) band = member
  }
  return band
}

function gallerySection(g: AvatarGallery, t: Strings, bandOf: Record<string, Band>): string {
  // `note` says whether anything was ever fetched at all. Markdown printed it and this did
  // not, so an empty gallery read here as "no pictures exist" when it means "nobody looked".
  const parts: string[] = [`<p class="blurb">${esc(t.picturesBlurb)}</p>`, `<p class="blurb">${esc(g.note)}</p>`]

  for (const group of g.groups) {
    const band = groupBand(group.accounts, bandOf)
    parts.push(`<div class="card band band--${band}">
  <p class="bandline">${esc(t.bandGlyph[band])} ${esc(t.sharedPicture(group.accounts.length))} — ${esc(t.bandName[band])}</p>
  <div class="gallery">${group.images.map((i) => shot(i, t, bandOf)).join('')}</div>
  <p class="blurb">${esc(group.note)}</p>
</div>`)
  }

  if (g.singles.length > 0) {
    parts.push(
      `<h3>${esc(t.onePicture)}</h3><div class="gallery">${g.singles.map((i) => shot(i, t, bandOf)).join('')}</div>`
    )
  }
  if (g.defaults.length > 0) {
    parts.push(
      `<h3>${esc(t.defaultPictures)}</h3><p class="blurb">${esc(t.defaultPicturesBlurb)}</p><div class="gallery">${g.defaults
        .map((i) => shot(i, t, bandOf))
        .join('')}</div>`
    )
  }
  if (g.unreadable.length > 0) {
    parts.push(
      `<h3>${esc(t.unreadablePictures)}</h3><p class="blurb">${esc(t.unreadableBlurb)}</p><div class="gallery">${g.unreadable
        .map((i) => shot(i, t, bandOf))
        .join('')}</div>`
    )
  }
  if (g.notFetched.length > 0) {
    parts.push(
      `<h3>${esc(t.notFetched)}</h3><p class="blurb">${esc(t.notFetchedBlurb)}</p><ul class="plain">${g.notFetched
        .map((n) => `<li class="mono">${esc(n.platform)}/${esc(n.handle)}</li>`)
        .join('')}</ul>`
    )
  }
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

export interface HtmlOptions {
  lang: ExportLang
  /** Include the collapsed "set aside as noise" section. */
  includeNoise: boolean
}

export function renderHtml(bundle: ExportBundle, options: HtmlOptions): string {
  const t = STRINGS[options.lang]
  const title = t.docTitle(bundle.subjectName)
  const real = bundle.accounts.filter((a) => a.band !== 'noise')
  const noise = bundle.accounts.filter((a) => a.band === 'noise')

  const shown: Band[] = ['confirmed', 'corroborated', 'probable', 'unverified']

  const key = shown
    .map(
      (b) =>
        `<div class="card band band--${b}"><p class="title"><span class="glyph">${esc(t.bandGlyph[b])}</span>${esc(t.bandName[b])}</p><p class="blurb">${esc(t.bandMeaning[b])}</p></div>`
    )
    .join('')

  const accountsBody =
    real.length === 0
      ? `<p class="blurb">${esc(t.noAccounts)}</p>`
      : shown.map((b) => bandSection(b, real, t)).join('\n')

  const runList = (items: readonly ExportBundle['unchecked'][number][]): string =>
    `<ul class="plain">${items
      .map(
        (u) =>
          `<li><span class="title">${esc(u.tool)}</span>${u.target ? ` <span class="mono">${esc(u.target)}</span>` : ''}<br><span class="blurb">${esc(u.detail)}</span>${
            u.coverage === null
              ? ''
              : `<br><span class="meta mono">${u.coverage.answered}/${u.coverage.total} answered · ${u.coverage.refused} refused</span>`
          }</li>`
      )
      .join('')}</ul>`

  // The heading used to print over an empty list. A section captioned "everything here is a
  // gap" with nothing under it is a question the reader is left to answer themselves.
  const unchecked = bundle.unchecked.length === 0 ? `<p class="blurb">${esc(t.uncheckedNone)}</p>` : runList(bundle.unchecked)

  const answeredNothing =
    bundle.answeredNothing.length === 0
      ? ''
      : `<h3>${esc(t.answeredNoneHeading)}</h3><p class="blurb">${esc(t.answeredNoneBlurb)}</p>${runList(bundle.answeredNothing)}`

  const notAsked =
    bundle.notAsked.length === 0
      ? ''
      : `<h3>${esc(t.notAskedHeading)}</h3><p class="blurb">${esc(t.notAskedBlurb)}</p><ul class="plain">${bundle.notAsked
          .map((n) => `<li><span class="mono">${esc(n.tool)}</span> — ${esc(n.wouldCover)}</li>`)
          .join('')}</ul>`

  const advice =
    bundle.advice.length === 0
      ? ''
      : `<ul class="plain">${bundle.advice
          .map(
            (a) =>
              `<li><p class="title">${esc(a.action)}</p><p class="blurb">${esc(a.because)}</p><p class="meta">${esc(t.touches(a.reach))} · ${esc(t.effort[a.effort])}</p></li>`
          )
          .join('')}</ul>`

  // Turning the section off must still leave a trace. A document that silently drops what
  // it discarded is asking the reader to trust a filter they cannot see was applied — which
  // is the one thing this file exists not to do.
  const noiseSection =
    noise.length === 0
      ? ''
      : options.includeNoise
        ? `<h2>${esc(t.noiseHeading)}</h2>
<p class="blurb">${esc(t.noiseBlurb)}</p>
<details><summary>${esc(t.bandName.noise)} — ${noise.length}</summary>
${noise.map((a) => accountCard(a, t)).join('\n')}
</details>`
        : `<h2>${esc(t.noiseHeading)}</h2>
<p class="blurb">${esc(t.noiseWithheld(noise.length))}</p>`

  const other =
    bundle.other.findings === 0
      ? ''
      : `<h3>${esc(t.otherHeading)}</h3><p class="blurb">${esc(t.otherBlurb)}</p>
<p class="meta">${esc(t.otherCount(bundle.other.findings, bundle.other.tools.length))}</p>
${
  bundle.other.tools.length === 0
    ? ''
    : `<ul class="plain">${bundle.other.tools
        .map((x) => `<li><span class="mono">${esc(x.tool)}</span> — ${esc(t.claimsFrom(x.claims))}</li>`)
        .join('')}</ul>`
}${
  bundle.other.orphans.length === 0
    ? ''
    : `<h3>${esc(t.orphanHeading)}</h3><p class="blurb">${esc(t.orphanBlurb)}</p><ul class="plain">${bundle.other.orphans
        .map(
          (o) =>
            `<li><span class="title">${esc(o.label)}</span> <span class="meta">${esc(o.kind)}</span><br><span class="blurb">${esc(o.why)}</span><br><span class="meta">${esc(t.claimsFrom(o.findings))}</span></li>`
        )
        .join('')}</ul>`
}`

  const seeds =
    bundle.seeds.length === 0
      ? ''
      : `<h3>${esc(t.seedsHeading)}</h3><p class="blurb">${esc(t.seedsBlurb)}</p><ul class="plain">${bundle.seeds
          .map((s) => `<li><span class="meta">${esc(s.kind)}</span> <span class="mono">${esc(s.label)}</span></li>`)
          .join('')}</ul>`

  const tools =
    bundle.toolsUsed.length === 0
      ? ''
      : `<h3>${esc(t.toolsUsed)}</h3><ul class="plain">${bundle.toolsUsed
          .map((x) => `<li><span class="mono">${esc(x.tool)}</span> — ${esc(t.claimsFrom(x.claims))}</li>`)
          .join('')}</ul>`

  return `<!doctype html>
<html lang="${options.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="lede">${esc(t.forWhom(bundle.subjectName))}${bundle.preparedBy ? ` ${esc(t.preparedBy(bundle.preparedBy))}` : ''}</p>
<p class="meta">${esc(bundle.basisLine)}</p>
<p class="meta">${esc(t.generated)} ${esc(bundle.generatedAt.slice(0, 16).replace('T', ' '))} · ${esc(bundle.case.name)}</p>
${bundle.publishable ? '' : `<p class="meta">${esc(t.notPublishable)}</p>`}

<h2>${esc(t.howToRead)}</h2>
<p class="blurb">${esc(t.howToReadBody)}</p>
<h3>${esc(t.keyHeading)}</h3>
<div class="key">${key}</div>

<h2>${esc(t.accountsHeading)}</h2>
${accountsBody}

${bundle.identity.length ? `<h2>${esc(t.identityHeading)}</h2><p class="blurb">${esc(t.identityBlurb)}</p>${identitySection(bundle.identity, t)}` : ''}

<h2>${esc(t.picturesHeading)}</h2>
${gallerySection(bundle.gallery, t, bundle.bandOf)}

<h2>${esc(t.uncheckedHeading)}</h2>
<p class="blurb">${esc(t.uncheckedBlurb)}</p>
${unchecked}
${answeredNothing}
${notAsked}

${advice ? `<h2>${esc(t.adviceHeading)}</h2><p class="blurb">${esc(t.adviceBlurb)}</p>${advice}` : ''}

${noiseSection}

<h2>${esc(t.methodHeading)}</h2>
<p class="blurb">${esc(t.methodBlurb)}</p>
${seeds}
${tools}
${other}

<footer>${esc(bundle.case.name)} · ${esc(bundle.case.id)}</footer>
</main>
</body>
</html>
`
}
