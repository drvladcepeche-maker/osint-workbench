/**
 * GDPR letters — Article 17 (erasure) and Article 21 (objection, including AI training).
 *
 * Bulgarian and English, because the UI is English (DECISIONS.md #8) but the letters are
 * not UI: they are documents the operator sends to a controller, and a Bulgarian data
 * subject writing to a controller with an Irish or Luxembourg establishment may do either.
 * Bulgarian is offered because it is his first language and because a request in Bulgarian
 * to a controller operating in Bulgaria is answerable in Bulgarian; English is offered
 * because most of these controllers process EU requests centrally and reply faster in it.
 *
 * ## Two rules about the contact book below
 *
 *  1. **Nothing is invented.** Every address, form and postal line was transcribed from a
 *     platform's own published privacy documentation. Where a platform publishes no
 *     address and routes everything through an in-product form, that is what is recorded —
 *     a plausible-looking `privacy@` guess would be worse than no entry, because the
 *     operator would send a letter into a black hole and read the silence as refusal.
 *  2. **`verified` is `false` on every single one, permanently.** Privacy contacts move,
 *     establishments are re-domiciled, forms are renamed. The type makes the field a
 *     literal `false` so no future edit can quietly flip one to true, and the UI prints
 *     the reminder beside every letter. Check the address on the platform's own page
 *     before sending.
 *
 * The letters themselves cite the specific articles rather than gesturing at "GDPR",
 * because a request that names Art. 17(1), Art. 19 and Art. 12(3) gets a different class
 * of reply than one that does not — and because the operator's stated reason for building
 * any of this is to understand mechanisms, and the mechanism here is the article numbers.
 */

import type { GdprLang, GdprLetter, GdprLetterRequest, PlatformContact } from '../../shared/selfaudit'
import { siteOrigin } from '../adapters/support/sources'

/* ------------------------------------------------------------------ *
 * The contact book
 * ------------------------------------------------------------------ */

interface ContactSeed extends Omit<PlatformContact, 'verified'> {
  /** Hosts that should resolve to this entry: `instagram.com`, `m.facebook.com`, … */
  hosts: string[]
}

const CONTACTS: ContactSeed[] = [
  {
    key: 'meta',
    name: 'Meta (Facebook, Instagram, Threads, Messenger)',
    controller: 'Meta Platforms Ireland Limited, Merrion Road, Dublin 4, D04 X2K5, Ireland',
    email: null,
    form: 'https://www.facebook.com/help/contact/540977946302970',
    postal: 'Meta Platforms Ireland Limited, Attn: Data Protection Officer, Merrion Road, Dublin 4, D04 X2K5, Ireland',
    note:
      'Meta routes rights requests through in-product forms and does not publish a working privacy mailbox; the DPO contact form above is the published route, and the postal address is the one to use if the form does not produce a reply. Meta\'s AI-training objection is a separate, named form inside the account settings — the Article 21 letter is what you send when that form refuses or does not apply to you.',
    hosts: ['facebook.com', 'instagram.com', 'threads.net', 'threads.com', 'messenger.com', 'meta.com']
  },
  {
    key: 'google',
    name: 'Google (Search, YouTube, Gmail, Maps)',
    controller: 'Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland',
    email: null,
    form: 'https://support.google.com/policies/contact/general_privacy_form',
    postal: 'Google Ireland Limited, Attn: Data Protection Officer, Gordon House, Barrow Street, Dublin 4, Ireland',
    note:
      'Google handles erasure of an account and de-listing from Search as two different requests with two different forms. If what you want is the search result gone rather than the account, say so explicitly — an Article 17 request to the account team will not de-list a third-party page.',
    hosts: ['google.com', 'youtube.com', 'gmail.com', 'blogger.com', 'googleusercontent.com']
  },
  {
    key: 'x',
    name: 'X (formerly Twitter)',
    controller: 'Twitter International Unlimited Company, One Cumberland Place, Fenian Street, Dublin 2, D02 AX07, Ireland',
    email: 'privacy@x.com',
    form: 'https://privacy.x.com/en/for-you',
    postal: 'Twitter International Unlimited Company, Attn: Data Protection Officer, One Cumberland Place, Fenian Street, Dublin 2, D02 AX07, Ireland',
    note: 'The mailbox has changed domain at least once since the rebrand. Send to the address and the form together.',
    hosts: ['x.com', 'twitter.com', 't.co']
  },
  {
    key: 'reddit',
    name: 'Reddit',
    controller: 'Reddit, Inc., with an EU representative designated under Art. 27 GDPR',
    email: 'privacy@reddit.com',
    form: 'https://www.reddit.com/settings/data-request',
    postal: null,
    note:
      'Deleting a Reddit account leaves the comments in place as [deleted]. If you want the content gone as well as the account, the letter has to say so — the default deletion is not erasure of the posts.',
    hosts: ['reddit.com', 'redd.it']
  },
  {
    key: 'linkedin',
    name: 'LinkedIn',
    controller: 'LinkedIn Ireland Unlimited Company, Wilton Plaza, Wilton Place, Dublin 2, Ireland',
    email: 'dpo@linkedin.com',
    form: 'https://www.linkedin.com/help/linkedin/ask/TSO-DPO',
    postal: 'LinkedIn Ireland Unlimited Company, Attn: Legal Dept (Privacy Policy and User Agreement), Wilton Plaza, Wilton Place, Dublin 2, Ireland',
    note: 'LinkedIn profiles are indexed by search engines by default, so an erasure here usually needs a de-listing request to Google alongside it.',
    hosts: ['linkedin.com']
  },
  {
    key: 'tiktok',
    name: 'TikTok',
    controller: 'TikTok Technology Limited, The Sorting Office, Ropemaker Place, 10 Hanover Quay, Dublin 2, Ireland',
    email: 'privacy@tiktok.com',
    form: 'https://www.tiktok.com/legal/report/privacy',
    postal: 'TikTok Technology Limited, Attn: Data Protection Officer, The Sorting Office, Ropemaker Place, 10 Hanover Quay, Dublin 2, Ireland',
    note: 'TikTok answers the web form considerably faster than the mailbox.',
    hosts: ['tiktok.com']
  },
  {
    key: 'discord',
    name: 'Discord',
    controller: 'Discord Netherlands B.V., Schiphol Boulevard 195, 1118 BG Schiphol, Netherlands',
    email: 'privacy@discord.com',
    form: 'https://support.discord.com/hc/en-us/requests/new',
    postal: null,
    note:
      'Discord messages live in other people\'s channels. Deleting the account anonymises the author but does not remove the messages, so an Article 17 request should name the servers if the content is what matters.',
    hosts: ['discord.com', 'discordapp.com', 'discord.gg']
  },
  {
    key: 'github',
    name: 'GitHub',
    controller: 'GitHub B.V., Vijzelstraat 68-72, 1017 HL Amsterdam, Netherlands (EU representative)',
    email: 'privacy@github.com',
    form: 'https://support.github.com/contact/privacy',
    postal: 'GitHub B.V., Vijzelstraat 68-72, 1017 HL Amsterdam, Netherlands',
    note:
      'Commits carry the author email in the git history of every fork and clone. Deleting the account does not rewrite anybody else\'s repository, and the letter should not imply that it will.',
    hosts: ['github.com', 'githubusercontent.com', 'gist.github.com']
  },
  {
    key: 'spotify',
    name: 'Spotify',
    controller: 'Spotify AB, Regeringsgatan 19, SE-111 53 Stockholm, Sweden',
    email: 'privacy@spotify.com',
    form: 'https://support.spotify.com/contact-spotify-privacy/',
    postal: 'Spotify AB, Attn: Data Protection Officer, Regeringsgatan 19, SE-111 53 Stockholm, Sweden',
    note: 'Public playlists stay reachable by URL after an account is closed unless they are deleted first.',
    hosts: ['spotify.com']
  },
  {
    key: 'snap',
    name: 'Snapchat',
    controller: 'Snap B.V., Keizersgracht 165, 1016 DP Amsterdam, Netherlands',
    email: 'dpo@snap.com',
    form: 'https://support.snapchat.com/i-need-help',
    postal: 'Snap B.V., Attn: Data Protection Officer, Keizersgracht 165, 1016 DP Amsterdam, Netherlands',
    note: 'Snap Map location history is a separate setting from the account and is worth naming explicitly.',
    hosts: ['snapchat.com', 'snap.com']
  },
  {
    key: 'pinterest',
    name: 'Pinterest',
    controller: 'Pinterest Europe Limited, Palmerston House, 2nd Floor, Fenian Street, Dublin 2, Ireland',
    email: 'privacy-support@pinterest.com',
    form: 'https://help.pinterest.com/en/contact',
    postal: 'Pinterest Europe Limited, Palmerston House, 2nd Floor, Fenian Street, Dublin 2, Ireland',
    note: '',
    hosts: ['pinterest.com', 'pinterest.co.uk']
  },
  {
    key: 'microsoft',
    name: 'Microsoft (Outlook, Xbox, LinkedIn account sign-in)',
    controller: 'Microsoft Ireland Operations Limited, One Microsoft Place, South County Business Park, Leopardstown, Dublin 18, Ireland',
    email: null,
    form: 'https://privacy.microsoft.com/en-us/privacy-questions',
    postal: 'Microsoft Ireland Operations Limited, Attn: Data Protection Officer, One Microsoft Place, South County Business Park, Leopardstown, Dublin 18, Ireland',
    note: 'Microsoft routes rights requests through the privacy dashboard first; the form above is the escalation when the dashboard cannot do what you are asking.',
    hosts: ['microsoft.com', 'outlook.com', 'hotmail.com', 'live.com', 'xbox.com', 'skype.com']
  },
  {
    key: 'telegram',
    name: 'Telegram',
    controller: 'Telegram Group Inc. / Telegram FZ-LLC, with an EU representative designated under Art. 27 GDPR',
    email: 'dpo@telegram.org',
    form: 'https://telegram.org/support',
    postal: null,
    note: 'Telegram publishes the DPO mailbox in its privacy policy and answers very little else.',
    hosts: ['telegram.org', 't.me', 'telegram.me']
  },
  {
    key: 'twitch',
    name: 'Twitch',
    controller: 'Twitch Interactive, Inc., with an EU representative designated under Art. 27 GDPR',
    email: 'privacy@twitch.tv',
    form: 'https://privacy.twitch.tv/',
    postal: null,
    note: 'VODs and clips outlive the account; name them if they are the point of the request.',
    hosts: ['twitch.tv']
  },
  {
    key: 'steam',
    name: 'Steam (Valve)',
    controller: 'Valve Corporation, with an EU representative designated under Art. 27 GDPR',
    email: null,
    form: 'https://help.steampowered.com/en/wizard/HelpWithDataPrivacy',
    postal: null,
    note:
      'Valve will delete a Steam account but that forfeits every game on it, and it says so. The useful request here is usually to make the profile private and to remove the real name and location fields rather than to erase the account.',
    hosts: ['steamcommunity.com', 'steampowered.com', 'valvesoftware.com']
  }
]

export function findContact(platformOrHost: string): PlatformContact | null {
  const raw = platformOrHost.trim().toLowerCase()
  if (!raw) return null
  const host = siteOrigin(raw) || raw
  for (const c of CONTACTS) {
    if (c.key === raw) return toContact(c)
    if (c.hosts.some((h) => h === host || host.endsWith(`.${h}`))) return toContact(c)
  }
  return null
}

function toContact(c: ContactSeed): PlatformContact {
  const { hosts: _hosts, ...rest } = c
  return { ...rest, verified: false }
}

export function listContacts(): PlatformContact[] {
  return CONTACTS.map(toContact).sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ *
 * The supervisory authority
 * ------------------------------------------------------------------ */

const KZLD_EN =
  'If no substantive reply arrives within one month, or the reply refuses the request without the reasoning Art. 12(4) requires, ' +
  'the complaint goes to the Bulgarian supervisory authority:\n\n' +
  'Commission for Personal Data Protection (Комисия за защита на личните данни)\n' +
  '2 Prof. Tsvetan Lazarov Blvd., Sofia 1592, Bulgaria\n' +
  'kzld@cpdp.bg · +359 2 915 3518 · www.cpdp.bg\n\n' +
  'Under Art. 38(1) of the Bulgarian Personal Data Protection Act a complaint is filed within six months of becoming aware of the ' +
  'infringement and no later than two years after it occurred. Art. 77 GDPR also allows the complaint to be filed with the authority ' +
  'of the controller\'s main establishment — for a controller established in Ireland, the Irish Data Protection Commission — and the ' +
  'one-stop-shop mechanism means either route reaches the same lead authority.'

const KZLD_BG =
  'Ако в едномесечен срок не постъпи отговор по същество или отказът не е мотивиран съгласно чл. 12, § 4 от ОРЗД, жалбата се подава до надзорния орган:\n\n' +
  'Комисия за защита на личните данни\n' +
  'гр. София 1592, бул. „Проф. Цветан Лазаров“ № 2\n' +
  'kzld@cpdp.bg · +359 2 915 3518 · www.cpdp.bg\n\n' +
  'Съгласно чл. 38, ал. 1 от Закона за защита на личните данни жалбата се подава в 6-месечен срок от узнаване на нарушението и не по-късно ' +
  'от две години от извършването му. По чл. 77 от ОРЗД жалба може да се подаде и до надзорния орган по мястото на основното установяване ' +
  'на администратора — за администратор, установен в Ирландия, това е Data Protection Commission — като механизмът „едно гише“ води до един и същ водещ орган.'

/* ------------------------------------------------------------------ *
 * The letters
 * ------------------------------------------------------------------ */

interface LetterParts {
  platformName: string
  handle: string | null
  email: string | null
  fullName: string | null
  postalAddress: string | null
  minor: boolean
  ai: boolean
  extra: string | null
  today: string
}

function parts(req: GdprLetterRequest, contact: PlatformContact | null): LetterParts {
  return {
    platformName: contact?.name ?? req.platform,
    handle: req.handle?.trim() || null,
    email: req.email?.trim() || null,
    fullName: req.fullName?.trim() || null,
    postalAddress: req.postalAddress?.trim() || null,
    minor: req.minorWhenCreated === true,
    ai: req.includeAiTraining === true,
    extra: req.extra?.trim() || null,
    today: new Date().toISOString().slice(0, 10)
  }
}

/** The identification block. Every controller asks for this; supplying it up front removes a round trip. */
function identityEn(p: LetterParts): string {
  const lines = ['My account is identified by:']
  if (p.handle) lines.push(`  Username / profile:  ${p.handle}`)
  if (p.email) lines.push(`  Registered email:    ${p.email}`)
  if (p.fullName) lines.push(`  Name on the account: ${p.fullName}`)
  if (lines.length === 1) lines.push('  (identifiers to be supplied — see the note at the end of this letter)')
  return lines.join('\n')
}

function identityBg(p: LetterParts): string {
  const lines = ['Профилът ми се идентифицира със следните данни:']
  if (p.handle) lines.push(`  Потребителско име / профил: ${p.handle}`)
  if (p.email) lines.push(`  Регистриран имейл адрес:    ${p.email}`)
  if (p.fullName) lines.push(`  Име по профила:             ${p.fullName}`)
  if (lines.length === 1) lines.push('  (идентификаторите следва да бъдат допълнени — виж бележката в края)')
  return lines.join('\n')
}

function addressBlock(contact: PlatformContact | null, lang: GdprLang): string {
  if (!contact) {
    return lang === 'bg'
      ? 'До: (администраторът на лични данни — виж политиката за поверителност на платформата за актуален адрес)'
      : 'To: (the data controller — take the current address from the platform\'s own privacy policy)'
  }
  const lines = [lang === 'bg' ? `До: ${contact.name}` : `To: ${contact.name}`]
  if (contact.controller) lines.push(`    ${contact.controller}`)
  if (contact.email) lines.push(`    ${contact.email}`)
  if (contact.form) lines.push(`    ${contact.form}`)
  return lines.join('\n')
}

function erasureEn(p: LetterParts, contact: PlatformContact | null): string {
  const minorClause = p.minor
    ? '\nThis account was created while I was a child. Article 17(1)(f) applies: the personal data were collected in relation to the ' +
      'offer of information society services referred to in Article 8(1), and Recital 65 states expressly that the right to erasure is ' +
      'of particular relevance where consent was given as a child and the data subject later wishes to remove such data. I ask that ' +
      'this be taken into account in assessing any claimed overriding interest in retention.\n'
    : ''

  return [
    addressBlock(contact, 'en'),
    `Date: ${p.today}`,
    '',
    'Dear Sir or Madam,',
    '',
    'I am a data subject residing in the European Union and I am exercising my rights under Regulation (EU) 2016/679 (GDPR).',
    '',
    identityEn(p),
    '',
    `Under Article 17(1) GDPR I request the erasure, without undue delay, of all personal data concerning me that ${p.platformName} ` +
      'processes in connection with the account identified above. This includes the account record itself, the content posted from it, ' +
      'profile and contact details, device and location data, and any inferred or derived data such as interest, behavioural or ' +
      'advertising profiles built from my activity.',
    minorClause,
    'In addition, I request that you:',
    '',
    '  1. Confirm, under Article 12(3), within one month of receipt what has been erased and what has been retained;',
    '  2. State the specific legal ground under Article 17(3) for anything you retain, rather than a general reference to ' +
      'legal obligations — a categorical refusal without identifying the obligation is not a reasoned answer;',
    '  3. Communicate the erasure to each recipient to whom the data were disclosed, as Article 19 requires, and inform me of ' +
      'those recipients on request;',
    '  4. Cease any further processing of the data for training, fine-tuning or evaluating machine-learning or artificial ' +
      'intelligence models, and confirm whether my data have already been used for that purpose and what has been done about it;',
    '  5. Confirm whether backups have been excluded from the erasure and, if so, when the retention period on those backups expires.',
    '',
    'Under Article 12(6) you may request additional information necessary to confirm my identity. I ask that any such request be ' +
    'proportionate: I am not willing to supply a government identity document to a service that never held one, and Recital 64 ' +
    'does not require me to.',
    '',
    'This request is free of charge under Article 12(5).',
    p.extra ? `\n${p.extra}\n` : '',
    'Yours faithfully,',
    '',
    p.fullName ?? '(name)',
    p.postalAddress ?? '',
    p.email ? `Reply to: ${p.email}` : ''
  ]
    .filter((l) => l !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function erasureBg(p: LetterParts, contact: PlatformContact | null): string {
  const minorClause = p.minor
    ? '\nПрофилът е създаден, докато бях дете. Приложима е хипотезата на чл. 17, § 1, буква „е“ от ОРЗД: личните данни са събрани във ' +
      'връзка с предлагането на услуги на информационното общество по чл. 8, § 1. Съображение 65 от ОРЗД изрично посочва, че правото на ' +
      'изтриване е от особено значение, когато съгласието е дадено в детска възраст и субектът впоследствие желае данните да бъдат ' +
      'премахнати. Моля това да бъде взето предвид при преценката на всеки твърдян преимуществен интерес от запазване.\n'
    : ''

  return [
    addressBlock(contact, 'bg'),
    `Дата: ${p.today}`,
    '',
    'Уважаеми госпожи и господа,',
    '',
    'Аз съм субект на данни с местопребиваване в Европейския съюз и упражнявам правата си по Регламент (ЕС) 2016/679 (ОРЗД).',
    '',
    identityBg(p),
    '',
    `На основание чл. 17, § 1 от ОРЗД искам без ненужно забавяне да бъдат изтрити всички лични данни, които се отнасят до мен и които ` +
      `${p.platformName} обработва във връзка с посочения по-горе профил. Това включва самия запис за профила, публикуваното от него ` +
      'съдържание, данните от профила и за контакт, данните за устройство и местоположение, както и всички изведени или производни данни ' +
      '— интересни, поведенчески или рекламни профили, изградени въз основа на моята активност.',
    minorClause,
    'Наред с това моля:',
    '',
    '  1. Да потвърдите в едномесечен срок от получаването, съгласно чл. 12, § 3 от ОРЗД, какво е изтрито и какво е запазено;',
    '  2. Да посочите конкретното основание по чл. 17, § 3 от ОРЗД за всяко запазено обстоятелство, а не общо позоваване на ' +
      '„законови задължения“ — немотивиран отказ не представлява отговор по същество;',
    '  3. Да съобщите изтриването на всеки получател, на когото данните са били разкрити, съгласно чл. 19 от ОРЗД, и при поискване ' +
      'да ме уведомите за тези получатели;',
    '  4. Да преустановите всякакво по-нататъшно обработване на данните за обучение, дообучаване или оценяване на модели за машинно ' +
      'самообучение и изкуствен интелект, както и да потвърдите дали данните ми вече са били използвани за такава цел и какво е ' +
      'предприето във връзка с това;',
    '  5. Да потвърдите дали резервните копия са изключени от изтриването и ако да — кога изтича срокът на съхранение по тях.',
    '',
    'Съгласно чл. 12, § 6 от ОРЗД можете да поискате допълнителна информация за потвърждаване на самоличността ми. Моля искането да ' +
    'бъде пропорционално: не съм съгласен да предоставям документ за самоличност на услуга, която никога не е разполагала с такъв, ' +
    'а съображение 64 от ОРЗД не изисква това.',
    '',
    'Искането е безплатно съгласно чл. 12, § 5 от ОРЗД.',
    p.extra ? `\n${p.extra}\n` : '',
    'С уважение,',
    '',
    p.fullName ?? '(име)',
    p.postalAddress ?? '',
    p.email ? `Отговор на: ${p.email}` : ''
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function objectionEn(p: LetterParts, contact: PlatformContact | null): string {
  const aiClause = p.ai
    ? [
        '',
        'I object specifically and in the first place to the use of my personal data — including my posts, comments, images, ' +
          'profile information and the metadata attached to them — for training, fine-tuning, evaluating or otherwise developing ' +
          'artificial intelligence or machine-learning models, whether by you or by any third party to whom you make the data ' +
          'available.',
        '',
        'Where that processing is founded on legitimate interests under Article 6(1)(f), Article 21(1) gives me the right to object ' +
          'on grounds relating to my particular situation, and you must then stop unless you demonstrate compelling legitimate ' +
          'grounds that override my interests, rights and freedoms. I do not accept a general assertion that model development is ' +
          'in the public interest as such a demonstration. My particular situation is this: my data were published to be read by ' +
          'the people I addressed them to, not to be absorbed into a model that will reproduce my writing, my face and my ' +
          'associations to strangers, and once absorbed they cannot be withdrawn by any later erasure request — which makes the ' +
          'harm from this processing permanent in a way ordinary publication is not.',
        '',
        'I further ask you to confirm whether my data have already been used for this purpose and, if so, what measures you have ' +
          'taken in respect of models already trained on them.'
      ].join('\n')
    : ''

  return [
    addressBlock(contact, 'en'),
    `Date: ${p.today}`,
    '',
    'Dear Sir or Madam,',
    '',
    'I am a data subject residing in the European Union and I am exercising my right to object under Article 21 GDPR.',
    '',
    identityEn(p),
    '',
    'Under Article 21(1) GDPR I object, on grounds relating to my particular situation, to the processing of my personal data that ' +
      'you carry out on the basis of Article 6(1)(f) (legitimate interests) or Article 6(1)(e). You must cease that processing unless ' +
      'you demonstrate compelling legitimate grounds which override my interests, rights and freedoms, or the processing is for the ' +
      'establishment, exercise or defence of legal claims.',
    '',
    'Under Article 21(2) and (3) I object absolutely to the processing of my personal data for direct marketing purposes, including ' +
      'any profiling related to that marketing. This objection is not subject to a balancing test and takes effect immediately.',
    aiClause,
    '',
    'I request that you:',
    '',
    '  1. Confirm within one month, under Article 12(3), that the objected-to processing has ceased;',
    '  2. Identify each purpose you continue to process for and the legal basis for each, separately;',
    '  3. If you claim compelling legitimate grounds under Article 21(1), state them specifically and explain how they override ' +
      'my interests in my particular situation, as Article 12(4) requires a reasoned answer;',
    '  4. Restrict processing under Article 18(1)(d) for the period during which you are verifying that claim.',
    p.extra ? `\n${p.extra}\n` : '',
    '',
    'Yours faithfully,',
    '',
    p.fullName ?? '(name)',
    p.postalAddress ?? '',
    p.email ? `Reply to: ${p.email}` : ''
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function objectionBg(p: LetterParts, contact: PlatformContact | null): string {
  const aiClause = p.ai
    ? [
        '',
        'Възразявам изрично и на първо място срещу използването на моите лични данни — включително публикациите, коментарите, ' +
          'изображенията, информацията от профила и свързаните с тях метаданни — за обучение, дообучаване, оценяване или друга форма ' +
          'на разработване на модели с изкуствен интелект и машинно самообучение, независимо дали от Вас или от трето лице, на което ' +
          'предоставяте достъп до данните.',
        '',
        'Доколкото това обработване се основава на легитимен интерес по чл. 6, § 1, буква „е“ от ОРЗД, чл. 21, § 1 ми дава право да ' +
          'възразя по причини, свързани с моята конкретна ситуация, след което сте длъжни да преустановите обработването, освен ако ' +
          'докажете убедителни законови основания, които имат преимущество пред моите интереси, права и свободи. Общо твърдение, че ' +
          'разработването на модели е в обществен интерес, не представлява такова доказване. Конкретната ми ситуация е следната: ' +
          'данните ми са публикувани, за да бъдат четени от хората, към които са адресирани, а не за да бъдат погълнати от модел, ' +
          'който ще възпроизвежда моя изказ, моето лице и моите връзки пред непознати; веднъж погълнати, те не могат да бъдат ' +
          'оттеглени с последващо искане за изтриване, което прави вредата от това обработване необратима по начин, по който ' +
          'обикновената публикация не е.',
        '',
        'Моля също да потвърдите дали данните ми вече са били използвани за тази цел и ако да — какви мерки сте предприели по ' +
          'отношение на вече обучените върху тях модели.'
      ].join('\n')
    : ''

  return [
    addressBlock(contact, 'bg'),
    `Дата: ${p.today}`,
    '',
    'Уважаеми госпожи и господа,',
    '',
    'Аз съм субект на данни с местопребиваване в Европейския съюз и упражнявам правото си на възражение по чл. 21 от ОРЗД.',
    '',
    identityBg(p),
    '',
    'На основание чл. 21, § 1 от ОРЗД възразявам, по причини, свързани с моята конкретна ситуация, срещу обработването на личните ми ' +
      'данни, което извършвате на основание чл. 6, § 1, буква „е“ (легитимен интерес) или чл. 6, § 1, буква „д“. Длъжни сте да ' +
      'преустановите това обработване, освен ако докажете убедителни законови основания, които имат преимущество пред моите интереси, ' +
      'права и свободи, или обработването е за установяване, упражняване или защита на правни претенции.',
    '',
    'На основание чл. 21, § 2 и § 3 от ОРЗД възразявам безусловно срещу обработването на личните ми данни за целите на директния ' +
      'маркетинг, включително срещу всяко профилиране, свързано с този маркетинг. Това възражение не подлежи на претегляне на ' +
      'интереси и има незабавно действие.',
    aiClause,
    '',
    'Моля:',
    '',
    '  1. Да потвърдите в едномесечен срок, съгласно чл. 12, § 3 от ОРЗД, че оспореното обработване е преустановено;',
    '  2. Да посочите поотделно всяка цел, за която продължавате да обработвате, и правното основание за нея;',
    '  3. Ако се позовавате на убедителни законови основания по чл. 21, § 1, да ги изложите конкретно и да обосновете защо имат ' +
      'преимущество пред моите интереси в конкретната ми ситуация — чл. 12, § 4 от ОРЗД изисква мотивиран отговор;',
    '  4. Да ограничите обработването на основание чл. 18, § 1, буква „г“ от ОРЗД за периода, в който проверявате това твърдение.',
    p.extra ? `\n${p.extra}\n` : '',
    '',
    'С уважение,',
    '',
    p.fullName ?? '(име)',
    p.postalAddress ?? '',
    p.email ? `Отговор на: ${p.email}` : ''
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function buildLetter(req: GdprLetterRequest): GdprLetter {
  const contact = findContact(req.platform)
  const p = parts(req, contact)
  const bg = req.lang === 'bg'

  const subject = bg
    ? req.article === 'erasure'
      ? `Искане за изтриване на лични данни — чл. 17 от Регламент (ЕС) 2016/679${p.handle ? ` — ${p.handle}` : ''}`
      : `Възражение срещу обработване на лични данни — чл. 21 от Регламент (ЕС) 2016/679${p.handle ? ` — ${p.handle}` : ''}`
    : req.article === 'erasure'
      ? `Request for erasure of personal data — Article 17 GDPR${p.handle ? ` — ${p.handle}` : ''}`
      : `Objection to processing of personal data — Article 21 GDPR${p.handle ? ` — ${p.handle}` : ''}`

  const body =
    req.article === 'erasure'
      ? bg
        ? erasureBg(p, contact)
        : erasureEn(p, contact)
      : bg
        ? objectionBg(p, contact)
        : objectionEn(p, contact)

  return {
    subject,
    body,
    contact,
    escalation: bg ? KZLD_BG : KZLD_EN,
    warnings: warningsFor(req, p, contact)
  }
}

/**
 * What is missing, and what will make the letter fail.
 *
 * These sit above the letter in the UI and are deliberately not inside it: a letter with
 * a bracketed placeholder in the middle of a legal request reads as a template someone
 * forgot to finish, and a controller answering one has an easy reason to ask for
 * clarification instead of complying.
 */
function warningsFor(req: GdprLetterRequest, p: LetterParts, contact: PlatformContact | null): string[] {
  const out: string[] = []

  if (!contact) {
    out.push(
      `No contact is recorded for ${req.platform}. Find the controller on the platform's own privacy policy — look for "Data Protection Officer", ` +
        `"EU representative" or an Article 27 designation — and put it at the top before sending.`
    )
  } else {
    out.push(
      `The contact below was transcribed from ${contact.name}'s published privacy documentation and is not verified. Privacy addresses move. ` +
        `Confirm it on the platform's own page before you send.`
    )
    if (contact.note) out.push(contact.note)
  }

  if (!p.handle && !p.email) {
    out.push(
      'Neither a username nor a registered email address is filled in. A controller cannot identify the account from this letter and will ' +
        'answer by asking for one, which costs a month.'
    )
  }
  if (!p.fullName) {
    out.push('No name is filled in. The letter ends with a placeholder; fill in the name field or edit it before sending.')
  }
  if (req.article === 'objection' && !req.includeAiTraining) {
    out.push(
      'The AI-training clause is off, so this is a general Article 21 objection. If model training is what you are objecting to, turn it on — ' +
        'a general objection lets a controller answer about advertising and say nothing about training.'
    )
  }
  if (req.article === 'erasure' && !p.minor) {
    out.push(
      'The Article 17(1)(f) clause for data collected from a child is off. If the account was created before you turned 18, turning it on adds a ' +
        'ground that is harder to refuse than the general one.'
    )
  }

  out.push('Send it in a way that produces a timestamp you keep. The one-month clock in Article 12(3) runs from receipt, and you have to be able to show when that was.')
  return out
}
