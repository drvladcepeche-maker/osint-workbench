/**
 * The same report as plain Markdown, for the operator's own use.
 *
 * Deliberately not the HTML with the tags stripped. This one is read by the person who ran
 * the audit rather than by its subject, so it keeps the tool names, the source counts and
 * the raw claim strings — the things the shareable version leaves out because they are
 * jargon to a reader who has never heard of maigret.
 *
 * It carries no pictures at all. A Markdown file with 40 base64 data URIs in it is not a
 * text file any more; it is a megabyte of noise nothing will render. The gallery is
 * summarised in words and the HTML export is where the pictures live.
 *
 * **It is also the format that gets pasted into a chat window**, which is why the basis
 * statement is here and not only in the HTML: this is the copy most likely to leave the
 * machine, so it is the copy that most needs to say what it is.
 */

import type { ExportBundle, UncheckedItem } from './bundle'
import type { Band } from './bundle'
import type { ExportLang } from '../../shared/ipc'

const BAND_LABEL: Record<ExportLang, Record<Band, string>> = {
  en: {
    confirmed: 'Confirmed by hand',
    corroborated: 'Corroborated — two sites, no human',
    probable: 'Probable',
    unverified: 'Unverified',
    noise: 'Set aside as noise'
  },
  bg: {
    confirmed: 'Потвърдено на ръка',
    corroborated: 'Потвърдено от два сайта, без човек',
    probable: 'Вероятно',
    unverified: 'Непотвърдено',
    noise: 'Отделено като шум'
  }
}

const HEAD: Record<ExportLang, Record<string, string>> = {
  en: {
    accounts: 'Accounts',
    identity: 'What the profiles say',
    pictures: 'Pictures',
    unchecked: 'Could not be checked',
    answeredNone: 'Ran and found nothing',
    notAsked: 'Never asked',
    advice: 'What to do about it',
    method: 'How this was made',
    seeds: 'Seeds',
    tools: 'Tools that produced something',
    other: 'Everything else this case holds',
    orphans: 'About things no longer in the case',
    sources: 'independent sources',
    foundBy: 'found by',
    claims: 'Claims that attribute this account to the subject, verbatim',
    context: 'Recorded by runs pointed at this account — shown, never counted as corroboration',
    notPublishable:
      'This file is written for the person it is about. It is not a document to publish or pass on to anybody else.',
    noiseWithheld: 'set aside as noise and left out of this copy',
    pending: 'nobody has reviewed this row'
  },
  bg: {
    accounts: 'Акаунти',
    identity: 'Какво пише в профилите',
    pictures: 'Снимки',
    unchecked: 'Не можа да бъде проверено',
    answeredNone: 'Мина и не намери нищо',
    notAsked: 'Изобщо не беше питано',
    advice: 'Какво да се направи',
    method: 'Как е направено това',
    seeds: 'Начални данни',
    tools: 'Инструменти, които дадоха резултат',
    other: 'Какво друго съдържа случаят',
    orphans: 'За неща, които вече не са в случая',
    sources: 'независими източника',
    foundBy: 'намерено от',
    claims: 'Твърдения, че този акаунт е на субекта, дословно',
    context: 'Записано от проверки, насочени към този акаунт — показано, но не броено като потвърждение',
    notPublishable:
      'Този файл е написан за човека, за когото се отнася. Той не е документ за публикуване или предаване на друг.',
    noiseWithheld: 'отделени като шум и невключени в това копие',
    pending: 'никой не е преглеждал този ред'
  }
}

/** Escape the four characters that turn a claim string into Markdown structure. */
function md(s: unknown): string {
  return String(s ?? '').replace(/([\\`*_[\]#|])/g, '\\$1').replace(/\r?\n/g, ' ')
}

export function renderMarkdown(bundle: ExportBundle, options: { lang: ExportLang; includeNoise: boolean }): string {
  const t = HEAD[options.lang]
  const label = BAND_LABEL[options.lang]
  const out: string[] = []

  out.push(`# ${md(bundle.case.name)}`)
  out.push('')
  out.push(md(bundle.basisLine))
  if (!bundle.publishable) {
    out.push('')
    out.push(md(t.notPublishable))
  }
  out.push('')
  out.push(`Generated ${bundle.generatedAt} · case \`${bundle.case.id}\``)
  if (bundle.preparedBy) out.push(`Prepared by ${md(bundle.preparedBy)}`)
  out.push('')
  out.push(
    `${bundle.counts.confirmed} ${label.confirmed} · ${bundle.counts.corroborated} ${label.corroborated} · ${bundle.counts.probable} ${label.probable} · ${bundle.counts.unverified} ${label.unverified} · ${bundle.counts.noise} ${label.noise} · ${bundle.counts.sources} distinct sources behind the rows below · ${bundle.counts.pictures} pictures`
  )

  const bands: Band[] = options.includeNoise
    ? ['confirmed', 'corroborated', 'probable', 'unverified', 'noise']
    : ['confirmed', 'corroborated', 'probable', 'unverified']

  out.push('', `## ${t.accounts}`)
  for (const band of bands) {
    const rows = bundle.accounts.filter((a) => a.band === band)
    if (rows.length === 0) continue
    out.push('', `### ${label[band]} — ${rows.length}`)
    for (const a of rows) {
      out.push('')
      out.push(
        `- **${md(a.platform)}** \`${md(a.handle)}\`${a.promoted ? ' _(promoted)_' : ''}${a.reviewed ? '' : ` _(${md(t.pending)})_`}`
      )
      out.push(
        `  - ${a.independentSources} ${t.sources}${a.sources.length ? ` (${md(a.sources.join(', '))})` : ''}, ${t.foundBy} ${md(a.tools.join(', ')) || '—'}`
      )
      if (a.derivedSources.length) out.push(`  - derived, not counted: ${md(a.derivedSources.join(', '))}`)
      if (a.url) out.push(`  - ${md(a.url)}`)
      for (const w of a.why) out.push(`  - ${md(w)}`)
      const p = a.profile
      if (p) {
        if (p.displayName) out.push(`  - name: ${md(p.displayName)}`)
        if (p.realName) out.push(`  - real name field: ${md(p.realName)}`)
        if (p.location) out.push(`  - location: ${md(p.location)}`)
        if (p.company) out.push(`  - work: ${md(p.company)}`)
        if (p.joinedAt) out.push(`  - joined: ${md(p.joinedAt)}`)
        if (p.email) out.push(`  - email: ${md(p.email)}`)
        if (p.bio) out.push(`  - bio: ${md(p.bio)}`)
        for (const l of p.links) out.push(`  - link (${l.rel}): ${md(l.url)}`)
      }
      if (a.matcher) out.push(`  - probe quality: **${a.matcher.label}** — ${md(a.matcher.why)}`)
      // The header of this file promises the raw claim strings. They were carried in the
      // bundle and printed by neither renderer, which made the promise false.
      if (a.claims.length) {
        out.push(`  - ${t.claims}:`)
        for (const c of a.claims) out.push(`    - ${md(c)}`)
      }
      if (a.context.length) {
        out.push(`  - ${t.context}:`)
        for (const c of a.context) out.push(`    - ${md(c)}`)
      }
    }
  }

  if (bundle.identity.length) {
    out.push('', `## ${t.identity}`)
    for (const i of bundle.identity) {
      out.push(
        `- [${label[i.band]}] **${md(i.kind)}** ${md(i.value)} — ${md(i.sources.join(', '))} (read off ${md(i.accounts.join(', '))}; strongest backing row: ${label[i.backing]})`
      )
    }
  }

  out.push('', `## ${t.pictures}`)
  out.push(md(bundle.gallery.note))
  for (const g of bundle.gallery.groups) {
    out.push(`- **${g.accounts.length} accounts share one picture**: ${md(g.accounts.join(', '))} — ${md(g.note)}`)
  }
  if (bundle.gallery.singles.length) out.push(`- ${bundle.gallery.singles.length} pictures on one account only`)
  if (bundle.gallery.defaults.length) out.push(`- ${bundle.gallery.defaults.length} accounts showing the platform's stock avatar`)
  if (bundle.gallery.unreadable.length) out.push(`- ${bundle.gallery.unreadable.length} pictures fetched but not comparable`)
  if (bundle.gallery.notFetched.length) out.push(`- ${bundle.gallery.notFetched.length} avatar URLs nobody has fetched`)

  const run = (u: UncheckedItem): string =>
    `- **${md(u.tool)}**${u.target ? ` \`${md(u.target)}\`` : ''} (${u.outcome}) — ${md(u.detail)}${u.coverage ? ` _(${u.coverage.answered}/${u.coverage.total} answered, ${u.coverage.refused} refused)_` : ''}`

  out.push('', `## ${t.unchecked}`)
  if (bundle.unchecked.length === 0) out.push('_No run was refused, killed or left unread._')
  for (const u of bundle.unchecked) out.push(run(u))

  if (bundle.answeredNothing.length) {
    out.push('', `### ${t.answeredNone}`)
    for (const u of bundle.answeredNothing) out.push(run(u))
  }
  if (bundle.notAsked.length) {
    out.push('', `### ${t.notAsked}`)
    for (const n of bundle.notAsked) out.push(`- \`${md(n.tool)}\` — ${md(n.wouldCover)}`)
  }

  if (bundle.advice.length) {
    out.push('', `## ${t.advice}`)
    for (const a of bundle.advice) {
      out.push('')
      out.push(`- **${md(a.action)}**`)
      out.push(`  - ${md(a.because)}`)
      out.push(`  - touches ${a.reach} · ${a.effort}`)
    }
  }

  if (!options.includeNoise) {
    const noise = bundle.accounts.filter((a) => a.band === 'noise').length
    if (noise > 0) out.push('', `_${noise} ${md(t.noiseWithheld)}._`)
  }

  out.push('', `## ${t.method}`)
  if (bundle.seeds.length) {
    out.push('', `### ${t.seeds}`)
    for (const s of bundle.seeds) out.push(`- ${md(s.kind)}: \`${md(s.label)}\``)
  }
  if (bundle.toolsUsed.length) {
    out.push('', `### ${t.tools}`)
    for (const x of bundle.toolsUsed) out.push(`- \`${md(x.tool)}\` — ${x.claims} claims`)
  }
  if (bundle.other.findings > 0) {
    out.push('', `### ${t.other}`)
    out.push(
      `${bundle.other.findings} findings back no row above, from ${bundle.other.tools.length} checks and ${bundle.other.sources.length} sources.`
    )
    for (const x of bundle.other.tools) out.push(`- \`${md(x.tool)}\` — ${x.claims} claims`)
    if (bundle.other.orphans.length) {
      out.push('', `### ${t.orphans}`)
      for (const o of bundle.other.orphans) {
        out.push(`- **${md(o.label)}** (${md(o.kind)}) — ${o.findings} findings. ${md(o.why)}`)
      }
    }
  }
  out.push('')
  return out.join('\n')
}
