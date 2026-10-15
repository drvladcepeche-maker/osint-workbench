import { useState } from 'react'
import type { AdapterInfo, IndexStats } from '../../../shared/types'
import type { AppInfo } from '../../../shared/ipc'
import { group } from '../lib/format'
import { CopyValue, Data } from './Data'
import { Loading, Notice } from './Feedback'
import { Icon } from './Icon'

const PATH_LABEL: Record<string, string> = {
  root: 'Repository',
  casesDir: 'Cases',
  dataDir: 'Index data',
  dbFile: 'Index database',
  toolkitRoot: 'Toolkit',
  configFile: 'Config'
}

/**
 * Settings.
 *
 * Three panels: where things are on disk, the index that can be thrown away, and the
 * adapters that are registered. Selecting an adapter puts its `doc` in the context panel
 * — the same panel, the same six fields, in the same place as when a finding is
 * selected, so "how does this work" is always answered in one location.
 */
export function SettingsView({
  info,
  adapters,
  selectedAdapterId,
  onSelectAdapter
}: {
  info: AppInfo | null
  adapters: AdapterInfo[]
  selectedAdapterId: string | null
  onSelectAdapter: (id: string) => void
}): React.JSX.Element {
  const [rebuild, setRebuild] = useState<IndexStats | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doRebuild = async (): Promise<void> => {
    setRebuilding(true)
    setError(null)
    try {
      setRebuild(await window.osint.index.rebuild())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRebuilding(false)
    }
  }

  if (!info) {
    return (
      <div className="view">
        <header className="view__head">
          <h1 className="view__title">Settings</h1>
        </header>

        <div className="view__scroll">
          <div className="view__body">
            <Loading what="settings" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="view">
      <header className="view__head">
        <h1 className="view__title">Settings</h1>
        <span className="view__subtitle">
          v{info.version} · Electron {info.electron} · Chromium {info.chrome}
        </span>
      </header>

      <div className="view__scroll">
        {error && (
          <Notice state="danger" label="Failed" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}

        {info.configWarnings.map((w) => (
          <Notice key={w} state="warning" label="Config">
            {w} The app started on defaults rather than refusing to open — you would
            otherwise have no interface in which to fix it.
          </Notice>
        ))}

        <div className="view__body">
          <section className="panel">
            <div className="panel__head">
              <span className="panel__title">Paths</span>
            </div>
            <div className="panel__body">
              <div className="detail" style={{ padding: 0 }}>
                {Object.entries(info.paths).map(([k, v]) => (
                  <div className="detail__row" key={k} style={{ gridTemplateColumns: '120px minmax(0,1fr)' }}>
                    <span className="detail__key">{PATH_LABEL[k] ?? k}</span>
                    <span className="detail__value">
                      <CopyValue value={v} title={`Copy ${v}`} />
                    </span>
                  </div>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
                Configuration came from{' '}
                {info.configSource === 'file' ? (
                  <Data>config/local.config.json</Data>
                ) : (
                  'the built-in defaults'
                )}
                . There is no <Data>.env</Data> file in this project, by design: keys live in{' '}
                <Data>config.adapters[id].options</Data>, and that file is gitignored.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <span className="panel__title">Search index</span>
            </div>
            <div className="panel__body">
              <p className="prose" style={{ marginBottom: 'var(--space-3)' }}>
                The SQLite index is derived from the case folders and holds nothing of its
                own. Deleting it loses nothing; a schema change is a rebuild rather than a
                migration. The rebuild reads every case first and writes in one transaction,
                so a failure leaves the old index intact rather than half-populated.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => void doRebuild()}
                disabled={rebuilding}
                data-loading={rebuilding ? 'true' : undefined}
              >
                {rebuilding ? 'Rebuilding from case files…' : 'Rebuild index from case files'}
              </button>
              {rebuild && (
                <p className="run__line" style={{ marginTop: 'var(--space-3)' }}>
                  {group(rebuild.cases)} cases · {group(rebuild.entities)} entities ·{' '}
                  {group(rebuild.findings)} findings · {group(rebuild.evidence)} evidence ·{' '}
                  {group(rebuild.confidenceChanges)} confidence changes · {rebuild.durationMs} ms
                  {rebuild.skipped.length > 0 && ` · ${rebuild.skipped.length} skipped`}
                </p>
              )}
              {rebuild && rebuild.skipped.length > 0 && (
                <Notice state="warning" label="Skipped">
                  {rebuild.skipped.map((s) => `${s.caseId}: ${s.reason}`).join(' · ')} — a
                  corrupt case folder is skipped, not fatal. One bad case.json must not take
                  the other twelve down with it.
                </Notice>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <span className="panel__title">Adapters</span>
              <span>{adapters.length}</span>
            </div>
            <div className="table-wrap">
              <table className="table" aria-label="Registered adapters">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 180 }}>
                      Tool
                    </th>
                    <th scope="col">Accepts → produces</th>
                    <th scope="col" style={{ width: 126 }}>
                      Needs
                    </th>
                    <th scope="col" className="col--seen" style={{ width: 214 }}>
                      Limits
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {adapters.map((a) => (
                    <tr
                      key={a.id}
                      tabIndex={0}
                      aria-selected={a.id === selectedAdapterId}
                      onClick={() => onSelectAdapter(a.id)}
                      onFocus={() => onSelectAdapter(a.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        {a.title} <Data>v{a.version}</Data>
                      </td>
                      <td
                        className="data"
                        title={
                          `${a.accepts.join(', ')} → ${a.produces.join(', ') || 'nothing new'}. ` +
                          (a.proposes
                            ? 'It proposes what it discovers as candidate entities; you decide whether any of them enter the case.'
                            : 'It declares no discoveries, so it only ever annotates the entity it was pointed at.')
                        }
                      >
                        {a.accepts.join(', ')} → {a.produces.join(', ') || 'nothing new'}
                        {a.proposes && <span className="hint"> · proposes</span>}
                      </td>
                      {/* One line, always: the icons are the row's only variable-height
                          content, and a 36px row here would break the 30px rhythm the
                          whole table is built on. */}
                      <td>
                        <span className="inline-marks">
                          {a.requiresNetwork && (
                            <span className="inline-marks" title="Touches the network">
                              <Icon name="network" size={11} />
                              <span className="sr-only">needs the network</span>
                            </span>
                          )}
                          {a.requiresKey && (
                            <span
                              className="inline-marks"
                              title="Needs an API key in config.adapters[id].options"
                            >
                              <Icon name="key" size={11} />
                              <span className="sr-only">needs a key</span>
                            </span>
                          )}
                          {!a.available && (
                            <span
                              className="inline-marks state-warning"
                              title={a.unavailableReason ?? ''}
                            >
                              <Icon name="warning" size={11} />
                              unavailable
                            </span>
                          )}
                          {a.available && !a.requiresNetwork && !a.requiresKey && (
                            <span className="hint">local only</span>
                          )}
                        </span>
                      </td>
                      <td className="data col--seen">
                        {a.concurrency}× · {a.minIntervalMs} ms · {a.defaultTimeoutMs} ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel__body">
              <p className="hint">
                An adapter whose <Data>doc</Data> block is incomplete cannot register — the
                registry throws at startup with the field name. Select a row to read the
                mechanism in the panel on the right.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
