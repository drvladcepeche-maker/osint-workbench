import type { ExposureReport, RemediationItem, ResetPathMap } from '../../../shared/selfaudit'
import { CHECK_OUTCOME_LABEL } from '../../../shared/selfaudit'
import { ConfidenceMark } from './Confidence'
import { CopyValue, Data, Tag } from './Data'
import { EmptyState } from './Feedback'
import { Icon } from './Icon'
import { plural, stampMinute } from '../lib/format'

/**
 * The exposure report.
 *
 * Order is the argument. **What could not be checked comes first**, before a single
 * finding, because a report that leads with what it found and buries what it could not ask
 * reads as complete — and a self-audit that reads as complete when it is not converts
 * ignorance into confidence, which is worse than producing nothing.
 *
 * After that: what to do, ranked by how much each action actually disconnects; then the
 * reset-path map; then where he appears; then the tools' own run notes verbatim.
 *
 * PRODUCT.md rules out everything a security product would normally put here. No threat
 * score. No red total. No meter. The one quantity on the page is reach — the number of
 * things an action touches — and it is shown as the fact it is.
 */
export function SelfAuditReport({ report }: { report: ExposureReport | null }): React.JSX.Element {
  if (!report) {
    return (
      <div className="view__body--pad">
        <EmptyState
          title="No run to report on yet."
          body={[
            'The exposure report is built from a snapshot: where you appear, what recovers what, what could not be checked, and what to do about it in the order that disconnects the most.',
            'Run a level first. The report reads the snapshot that run wrote, so it stays available afterwards and can be compared against the next one.'
          ]}
          exampleLabel="What it leads with"
          example={'120 of 122 sites refused to answer.\nThat is unchecked, not clear.'}
        />
      </div>
    )
  }

  const claims = report.appearances.length

  return (
    <div>
      <section className="sa-section">
        <h3 className="sa-section__title">What could not be checked</h3>
        <p className="sa-section__lede">
          This is first on the page on purpose. Everything below is a floor, not a total —
          and a floor built mostly out of refusals is close to meaningless. A rate limit and
          a bot wall are refusals aimed at us; neither is evidence that there is nothing
          there.
        </p>
        {report.unchecked.length === 0 ? (
          <div className="sa-section__panel">
            <div className="sa-rows">
              <div className="sa-row">
                <span className="sa-row__lead">Nothing</span>
                <span className="sa-row__body">
                  Every check in this run reached a verdict. That is unusual and worth not
                  taking for granted — these tools are refused far more often than they are
                  answered.
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="sa-section__panel">
            <div className="sa-rows">
              {report.unchecked.map((c) => (
                <div className="sa-row sa-row--silent" key={`${c.adapterId}:${c.entityId ?? c.jobId ?? ''}`}>
                  <span className="sa-row__lead">
                    <span className="sa-silent">
                      <Icon name="warning" size={11} />
                      {CHECK_OUTCOME_LABEL[c.outcome]}
                    </span>
                  </span>
                  <span className="sa-row__body">
                    <strong>{c.adapterTitle}</strong>
                    {c.entityLabel ? (
                      <>
                        {' '}
                        on <Data>{c.entityLabel}</Data>
                      </>
                    ) : null}{' '}
                    — {c.detail}
                  </span>
                  {c.coverage && (
                    <span className="sa-row__aside">
                      {c.coverage.answered}/{c.coverage.total}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="sa-section">
        <h3 className="sa-section__title">What to do, in order</h3>
        <p className="sa-section__lede">
          Ordered by how many things each action disconnects, then by how long it takes.
          Not by severity — there is no severity here, only reach and effort, and both are
          observable rather than assigned.
        </p>
        <div className="sa-section__panel">
          {report.remediation.length === 0 ? (
            <div className="sa-rows">
              <div className="sa-row">
                <span className="sa-row__body">
                  Nothing to recommend from this run. That is a statement about the run, not
                  about your exposure — read the section above before taking it as good news.
                </span>
              </div>
            </div>
          ) : (
            report.remediation.map((item, i) => <Fix key={item.id} item={item} n={i + 1} />)
          )}
        </div>
      </section>

      <ResetPaths map={report.resetPaths} />

      <section className="sa-section">
        <h3 className="sa-section__title">Where you appear</h3>
        <p className="sa-section__lede">
          {claims === 0
            ? 'Nothing this run could attribute to you. Read that against the unchecked list above rather than on its own.'
            : `${plural(claims, 'site')} produced at least one claim about the seeds this level holds. Attributed rows come first: those are the ones where a fact you seeded turned up in the result, rather than only a handle that anyone could share.`}
        </p>
        {claims > 0 && (
          <div className="sa-section__panel">
            <div className="sa-rows">
              {report.appearances.map((a) => (
                <div className="sa-row" key={a.sourceKey}>
                  <span className="sa-row__lead">
                    <Data>{a.sourceKey}</Data>
                  </span>
                  <span className="sa-row__body">
                    {a.handles.length ? (
                      <>
                        as <Data>{a.handles.join(', ')}</Data> —{' '}
                      </>
                    ) : null}
                    {a.tools.join(', ')}
                    {a.attributed && (
                      <>
                        {' '}
                        <Tag strong title="A value you seeded appears in this result, so it is about you rather than about anyone holding the same handle.">
                          attributed
                        </Tag>
                      </>
                    )}
                  </span>
                  <span className="sa-row__aside">
                    <ConfidenceMark confidence={a.confidence} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {report.orphaned.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">Left behind by a seed you removed</h3>
          <p className="sa-section__lede">
            You purged a seed out of this level&rsquo;s case, and these are the claims it
            produced before you did. The observation happened and its capture is permanent, so
            they are not deleted — but nothing in this snapshot still names what caused them,
            so they are counted nowhere above and they do not order the list of things to do.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {report.orphaned.map((f) => (
                <div className="sa-row sa-row--silent" key={f.id}>
                  <span className="sa-row__lead">
                    <Data>{f.sourceKey || f.tool}</Data>
                  </span>
                  <span className="sa-row__body">{f.claim}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {report.telemetry.length > 0 && (
        <section className="sa-section">
          <h3 className="sa-section__title">The run, in the tools’ own words</h3>
          <p className="sa-section__lede">
            Every adapter writes a summary of its own run as a <Data>local:</Data> finding.
            These are never counted alongside claims about you, and they can never
            corroborate anything — analysis must not be able to promote itself. They are
            here verbatim because they are the most honest account of what this report is
            built on.
          </p>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {report.telemetry.map((t) => (
                <div className="sa-row" key={t.id}>
                  <span className="sa-row__lead">
                    <Data>{t.tool}</Data>
                  </span>
                  <span className="sa-row__body">{t.claim}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="sa-section">
        <p className="hint">
          Snapshot <Data>{report.snapshotId}</Data> · L{report.level} · {stampMinute(report.at)} ·{' '}
          <CopyValue value={report.caseId} title="Copy the case id — it is also the folder name on disk" />
        </p>
      </section>

      <div className="sa-foot" />
    </div>
  )
}

function Fix({ item, n }: { item: RemediationItem; n: number }): React.JSX.Element {
  return (
    <div className="sa-fix">
      <div className="sa-fix__head">
        <span className="sa-fix__n">{n}</span>
        <span className="sa-fix__action">{item.action}</span>
      </div>
      <p className="sa-fix__body">{item.effect}</p>
      {item.caveat && (
        <p className="sa-fix__body">
          <strong>Before you act on it: </strong>
          {item.caveat}
        </p>
      )}
      <div className="sa-fix__meta">
        {/* `reach` counts only what a human promoted or two independent sources agreed on,
            and it is the ordering key. The unverified remainder is never folded into it: a
            username sweep over a common handle returns tens of anti-bot pages that answer
            200 and look exactly like real accounts in the row, and if those counted, the
            tool's own noise would order the page the operator acts on.

            When nothing is verified there is no "touches 0" to show — a zero would read as
            a measurement of the action rather than of the evidence, and the item's own
            sentence already says what it rests on. */}
        {item.reach > 0 && (
          <Tag title="How many distinct things this action disconnects, counting only what a human promoted or two independent sources agreed on. This is the ordering key, and it is a count rather than a score.">
            touches {item.reach}
          </Tag>
        )}
        {item.unverifiedReach > 0 && (
          <Tag title="Hits from a single tool that nobody has opened and confirmed. Real leads, and not yet facts — they are counted apart so they cannot order this page.">
            {item.reach > 0 ? `+${item.unverifiedReach} unverified` : `${item.unverifiedReach} unverified`}
          </Tag>
        )}
        <Tag title="Rough time to do it, not a priority.">{item.effort}</Tag>
        <ConfidenceMark confidence={item.confidence} />
        {item.targets.slice(0, 6).map((t) => (
          <Data key={t}>{t}</Data>
        ))}
        {item.targets.length > 6 && <span className="hint">+{item.targets.length - 6} more</span>}
      </div>
    </div>
  )
}

function ResetPaths({ map }: { map: ResetPathMap }): React.JSX.Element {
  return (
    <section className="sa-section">
      <h3 className="sa-section__title">Reset paths</h3>
      <p className="sa-section__lede">
        Which accounts can be recovered through which address or number. Every edge here is
        something a site actually said when asked through its own password-reset,
        registration or login form — where the data does not support a link, none is drawn.
      </p>

      {map.degraded && map.degradedNote && (
        <div className="sa-section__panel">
          <div className="sa-rows">
            <div className="sa-row sa-row--silent">
              <span className="sa-row__lead">
                <span className="sa-silent">
                  <Icon name="warning" size={11} />
                  degraded
                </span>
              </span>
              <span className="sa-row__body">{map.degradedNote}</span>
            </div>
          </div>
        </div>
      )}

      {map.hubs.length > 0 && (
        <div className="sa-section__panel">
          {map.hubs.map((hub) => (
            <div className="sa-hub" key={`${hub.kind}:${hub.value}`}>
              <div className="sa-hub__head">
                <Data>{hub.value}</Data>
                <span className="sa-hub__reach">
                  reaches {plural(hub.platforms.length, 'site')}
                  {hub.inferred > 0 &&
                    ` · ${hub.inferred} of them inferred from a masked hint rather than stated`}
                </span>
              </div>
              <div className="sa-edges">
                {hub.platforms.map((p) => (
                  <Data key={p}>{p}</Data>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {map.chains.length > 0 && (
        <div className="sa-section__panel">
          {map.chains.map((chain, i) => (
            <div className="sa-chain" key={i}>
              <ol>
                {chain.steps.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ol>
              <p className="sa-chain__note">{chain.note}</p>
            </div>
          ))}
        </div>
      )}

      {map.edges.length > 0 && (
        <div className="sa-section__panel">
          <div className="sa-rows">
            {map.edges.map((e, i) => (
              <div className="sa-row" key={`${e.fromValue}:${e.platform}:${i}`}>
                <span className="sa-row__lead">
                  <Data>{e.platform}</Data>
                </span>
                <span className="sa-row__body">{e.note}</span>
                <span className="sa-row__aside">
                  {e.status === 'observed' ? 'the site said so' : 'consistent, not proved'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {map.unchecked.length > 0 && (
        <>
          <div className="sa-section__panel">
            <div className="sa-rows">
              {/* A refused holehe run puts every one of its 120 sites here. All of them are
                  true and none of them is worth scrolling past, so the list is capped and
                  the remainder is counted rather than drawn. */}
              {map.unchecked.slice(0, 30).map((u) => (
                <div className="sa-row sa-row--silent" key={u.platform}>
                  <span className="sa-row__lead">
                    <Data>{u.platform}</Data>
                  </span>
                  <span className="sa-row__body">{u.reason}</span>
                </div>
              ))}
            </div>
          </div>
          {map.unchecked.length > 30 && (
            <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
              {map.unchecked.length - 30} more sites are unchecked for the same reasons. The
              full list is in the snapshot in the case folder.
            </p>
          )}
        </>
      )}

      {map.edges.length === 0 && map.unchecked.length === 0 && !map.degraded && (
        <div className="sa-section__panel">
          <div className="sa-rows">
            <div className="sa-row">
              <span className="sa-row__body">
                No recovery oracle produced a verdict for this level. Add an email address to
                the vault and run L1 or above — this map is built from what those sites say
                when asked about an address, and there is nothing to ask about below L1.
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
