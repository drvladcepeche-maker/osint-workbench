import { seedField, type SeedAttribution, type SelfAuditDelta as Delta } from '../../../shared/selfaudit'
import type { NameMatchStrength } from '../../../shared/names'
import { Data, Tag } from './Data'
import { ConfidenceMark } from './Confidence'
import { EmptyState, Notice } from './Feedback'
import { Icon } from './Icon'
import { plural, stampMinute } from '../lib/format'

/**
 * What each strength means, in the tooltip, in the operator's terms.
 *
 * `unrecorded` is not a fourth level. It is what an attribution written by an older build
 * looks like when it is read back off disk, and saying so is better than inventing a
 * weight the snapshot never claimed.
 */
const STRENGTH_TITLE: Record<NameMatchStrength | 'unrecorded', string> = {
  strong:
    'The whole seeded value appears, literally or as a straight transliteration of it. About as good as this app’s evidence gets without a human opening the page.',
  moderate:
    'Most of the value appears, or a common one appears in full. Worth opening; not worth concluding from.',
  weak: 'A nickname, a given name on its own, or an initial and a surname. Plenty of strangers match this. Treat it as somewhere to look.',
  unrecorded:
    'This snapshot predates strength being recorded. The match was made by the older literal matcher; nothing here claims how strong it was.'
}

const STRENGTH_ORDER: Record<NameMatchStrength | 'unrecorded', number> = {
  strong: 3,
  moderate: 2,
  weak: 1,
  unrecorded: 0
}

/** Strongest first, stable within a strength, so truncation drops the least useful rows. */
function byStrength(attributions: SeedAttribution[]): SeedAttribution[] {
  return [...attributions].sort(
    (a, b) => STRENGTH_ORDER[b.strength ?? 'unrecorded'] - STRENGTH_ORDER[a.strength ?? 'unrecorded']
  )
}

/**
 * The delta between one level and the one below it.
 *
 * DECISIONS.md is explicit that this, and not the totals, is the point: *"which single
 * piece of seed data unlocks the biggest jump in what's findable."* So the page opens with
 * one sentence naming the seed and what it connected, then shows the rows that sentence
 * rests on, then says where the comparison is weaker than it looks.
 *
 * The caveats are not a disclaimer at the bottom. They sit directly under the headline,
 * because two levels ran at two different moments against sites that answer inconsistently
 * — and a causal claim built on that, presented without its qualifications, is exactly the
 * confident nonsense this app exists to be the opposite of.
 */
export function SelfAuditDelta({ delta }: { delta: Delta | null }): React.JSX.Element {
  if (!delta) {
    return (
      <div className="view__body--pad">
        <EmptyState
          title="Nothing to compare yet."
          body={[
            'A delta is the difference between one level and the one below it: what became findable, what became attributable, and which seed caused it. It needs a run to compare.',
            'Run the level above, and if you want the comparison rather than just the totals, run the one below it too. Each level is its own case folder, so they can be compared instead of blurred together.'
          ]}
          exampleLabel="What a delta says"
          example={
            'Adding your email made holehe runnable, and it reached 3 sites\nL0 could not: spotify.com, imgur.com, twitter.com.'
          }
        />
      </div>
    )
  }

  const { from, to } = delta

  return (
    <div>
      <section className="sa-section">
        {/* Above the headline, because it is a reason not to believe the headline. The
            lower level ran before the operator finished filling in the vault, so seeds
            that belong to *it* are new to this comparison — and a sentence naming a cause
            is worth nothing when the two runs did not start from where the ladder says
            they started. */}
        {from && delta.staleSeeds.length > 0 && (
          <Notice state="warning" label={`L${from.level} is out of date`}>
            L{from.level} ran before {plural(delta.staleSeeds.length, 'value')} you have since
            added — {delta.staleSeeds.map((s) => s.label).join(', ')}. Those belong to L
            {from.level}, so anything they produced is credited to the wrong rung here. Re-run L
            {from.level}, then read this again.
          </Notice>
        )}

        <p className="sa-headline">{delta.headline}</p>

        {delta.headlineBasis.length > 0 && (
          <ul className="sa-basis">
            {delta.headlineBasis.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}

        <div className="runbar" style={{ marginTop: 'var(--space-4)' }}>
          <span className="hint">
            {from
              ? `L${from.level} ${stampMinute(from.at)} · ${from.counts.claims} claims from ${from.counts.sources} sources`
              : 'No level below this one — this is the baseline.'}
          </span>
          {from && <Icon name="chevron-right" size={11} />}
          <span className="hint">
            L{to.level} {stampMinute(to.at)} · {to.counts.claims} claims from {to.counts.sources} sources
          </span>
        </div>
      </section>

      <section className="sa-section">
        <h3 className="sa-section__title">Where this is weaker than it looks</h3>
        <ul className="sa-caveats" style={{ marginTop: 'var(--space-3)' }}>
          {delta.caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </section>

      {delta.addedSeeds.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">What was added</h3>
          <p className="sa-section__lede">
            The candidate causes. Everything below this point is either something one of
            these made reachable, or something one of these made attributable.
          </p>
          <div className="entities" style={{ marginTop: 'var(--space-3)' }}>
            {delta.addedSeeds.map((s) => (
              <span className="entity" key={s.entityId} title={seedField(s.field).buys}>
                <span className="entity__kind">{seedField(s.field).label.toLowerCase()}</span>
                <span className="entity__value">{s.label}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {delta.newlyRunnable.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Tools the seed unlocked</h3>
          <p className="sa-section__lede">
            These accept nothing the level below held, so nothing there could have been
            pointed at them. Whether they answered is a separate question from whether they
            ran, and the second column is the one that decides what the report may claim.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {delta.newlyRunnable.map((c) => (
                <div
                  className={
                    c.outcome === 'answered' || c.outcome === 'answered-none'
                      ? 'sa-row'
                      : 'sa-row sa-row--silent'
                  }
                  key={`${c.adapterId}:${c.entityId ?? ''}`}
                >
                  <span className="sa-row__lead">{c.adapterTitle}</span>
                  <span className="sa-row__body">{c.detail}</span>
                  {c.coverage && (
                    <span className="sa-row__aside">
                      {c.coverage.answered}/{c.coverage.total} answered
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {delta.runnableForOtherReasons.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Tools that ran here and not below — for other reasons</h3>
          <p className="sa-section__lede">
            These accept a kind of seed the level below already had, so the new seed is not
            what made them runnable. Either you dropped them from that level&rsquo;s chain, or
            the tool was installed between the two runs. Worth reading, and never part of the
            sentence at the top: what they found is not something a seed unlocked.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {delta.runnableForOtherReasons.map((c) => (
                <div
                  className={
                    c.outcome === 'answered' || c.outcome === 'answered-none'
                      ? 'sa-row'
                      : 'sa-row sa-row--silent'
                  }
                  key={`${c.adapterId}:${c.entityId ?? ''}`}
                >
                  <span className="sa-row__lead">{c.adapterTitle}</span>
                  <span className="sa-row__body">{c.detail}</span>
                  {c.coverage && (
                    <span className="sa-row__aside">
                      {c.coverage.answered}/{c.coverage.total} answered
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {delta.newReach.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Newly findable</h3>
          <p className="sa-section__lede">
            Sites that answered here, were not represented at the level below, and whose tool
            was able to answer down there too — so the difference is the seed rather than the
            weather.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {delta.newReach.map((r) => (
                <div className="sa-row" key={r.sourceKey}>
                  <span className="sa-row__lead">
                    <Data>{r.sourceKey}</Data>
                  </span>
                  <span className="sa-row__body">{r.findings[0]?.claim}</span>
                  <span className="sa-row__aside">
                    {r.viaSeed ? `via ${r.viaSeed.label}` : plural(r.findings.length, 'claim')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {delta.incomparableReach.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Here, but not comparable</h3>
          <p className="sa-section__lede">
            Sites that answered here and are absent below — where the tool behind them could
            not get an answer at the level below either. Nobody asked those sites down there,
            so this is not the seed opening a door; it is the level below having been refused.
            Kept out of the count above rather than quietly added to it.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {delta.incomparableReach.map((r) => (
                <div className="sa-row sa-row--silent" key={r.sourceKey}>
                  <span className="sa-row__lead">
                    <Data>{r.sourceKey}</Data>
                  </span>
                  <span className="sa-row__body">{r.findings[0]?.claim}</span>
                  <span className="sa-row__aside">{plural(r.findings.length, 'claim')}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {delta.attributions.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Newly attributable</h3>
          <p className="sa-section__lede">
            Results the level below had already collected, in which a fact this level added
            now appears. Reach did not change; ownership did. Every one of these is a string
            match this app made, not a claim a tool asserted — read the excerpt before you
            believe the link.
          </p>
          <p className="sa-section__lede">
            Each row says <em>how</em> it matched, because the rules are not equally
            trustworthy. A full name written out is one thing; a nickname, an initial, or one
            of the several ways a Cyrillic name gets spelled in Latin is a lead worth
            checking, not a link worth believing. The strongest matches are listed first.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {/* A raw match names the tool, not a site. One capture covers every site the
                  tool touched, so crediting a hostname with a sentence from somewhere else
                  in that file would be a fabrication — see SeedAttribution.

                  Sorted by strength before it is truncated, so forty weak diminutive hits
                  cannot push the one literal full-name hit off the page. */}
              {byStrength(delta.attributions)
                .slice(0, 40)
                .map((a, i) => (
                  <div className="sa-row" key={`${a.findingId}:${a.field}:${i}`}>
                    <span className="sa-row__lead">
                      {a.sourceKey ? (
                        <Data>{a.sourceKey}</Data>
                      ) : (
                        <span title="Found inside this tool's capture. The capture covers every site the tool touched, so which one said it is not recoverable from here.">
                          <Data>{a.tool}</Data> capture
                        </span>
                      )}
                    </span>
                    <span className="sa-row__body">
                      {a.excerpt}
                      {a.why && (
                        <>
                          {' · '}
                          <span className="hint">{a.why}</span>
                        </>
                      )}
                    </span>
                    <span className="sa-row__aside">
                      <Tag
                        strong={a.strength === 'strong'}
                        title={STRENGTH_TITLE[a.strength ?? 'unrecorded']}
                      >
                        {a.strength ?? 'unrecorded'}
                      </Tag>{' '}
                      {seedField(a.field).label.toLowerCase()} ·{' '}
                      {a.where === 'raw' ? 'unattributed' : 'stated in the claim'}
                    </span>
                  </div>
                ))}
            </div>
          </div>
          {delta.attributions.length > 40 && (
            <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
              {delta.attributions.length - 40} more, in the snapshot on disk.
            </p>
          )}
        </section>
      )}

      {delta.newAccounts.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Accounts this level turned up</h3>
          <p className="sa-section__lede">
            Not in the graph. Each of these is a candidate a tool proposed and a human has
            not yet reviewed — the same queue a normal case uses, with no exception made
            because the subject is you.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {delta.newAccounts.map((a) => (
                <div className="sa-row" key={a.key}>
                  <span className="sa-row__lead">
                    <Data>{a.platform}</Data>
                  </span>
                  <span className="sa-row__body">
                    <Data>{a.handle}</Data> — {a.tools.join(', ')}
                    {a.independentSources > 1 ? ` · ${a.independentSources} independent sources` : ''}
                  </span>
                  <span className="sa-row__aside">
                    <ConfidenceMark confidence={a.confidence} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {(delta.lostReach.length > 0 || delta.goneAccounts.length > 0) && (
        <section className="sa-section">
          <h3 className="sa-section__title">Present below, absent here</h3>
          <p className="sa-section__lede">
            Almost always a rate limit rather than a removal. Check the run notes on the
            exposure page before reading any of this as progress.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {delta.lostReach.map((r) => (
                <div className="sa-row sa-row--silent" key={r.sourceKey}>
                  <span className="sa-row__lead">
                    <Data>{r.sourceKey}</Data>
                  </span>
                  <span className="sa-row__body">{r.findings[0]?.claim}</span>
                  <span className="sa-row__aside">{plural(r.findings.length, 'claim')}</span>
                </div>
              ))}
              {delta.goneAccounts.map((a) => (
                <div className="sa-row sa-row--silent" key={a.key}>
                  <span className="sa-row__lead">
                    <Data>{a.platform}</Data>
                  </span>
                  <span className="sa-row__body">
                    The account <Data>{a.handle}</Data> was proposed at the level below and was not
                    proposed here.
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {delta.promoted.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Promoted in confidence</h3>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {delta.promoted.map((p) => (
                <div className="sa-row" key={p.findingId}>
                  <span className="sa-row__lead">
                    <Data>{p.sourceKey}</Data>
                  </span>
                  <span className="sa-row__body">{p.claim}</span>
                  <span className="sa-row__aside">
                    <ConfidenceMark confidence={p.from} /> → <ConfidenceMark confidence={p.to} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="sa-foot" />
    </div>
  )
}
