import { useCallback, useEffect, useState } from 'react'
import { useAutoFold } from './lib/hooks'
import type { AdapterInfo, Finding } from '../../shared/types'
import type { FindingSelection } from './components/CaseView'
import type { AppInfo, CaseSummary } from '../../shared/ipc'
import { CaseView } from './components/CaseView'
import { CasesView } from './components/CasesView'
import { ContextPanel, CONTEXT_MIN } from './components/ContextPanel'
import { FindingDetail } from './components/FindingDetail'
import { HowThisWorks } from './components/HowThisWorks'
import { Icon, type IconName } from './components/Icon'
import { Notice } from './components/Feedback'
import { RangeView } from './components/range/RangeView'
import { ScrubView } from './components/scrub/ScrubView'
import { SelfAuditView } from './components/SelfAuditView'
import { SettingsView } from './components/SettingsView'
import { Data } from './components/Data'

type Section = 'cases' | 'self-audit' | 'range' | 'scrub' | 'settings'

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'cases', label: 'Cases', icon: 'cases' },
  { id: 'self-audit', label: 'Self-Audit', icon: 'self-audit' },
  { id: 'range', label: 'Range', icon: 'range' },
  { id: 'scrub', label: 'Scrub', icon: 'scrub' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

/**
 * The three-zone shell: collapsible left nav, main content, right context panel.
 *
 * The context panel is the piece that matters. DESIGN.md calls it a persistent margin
 * annotation rather than a modal, and it is on screen from the first frame because the
 * product's premise is understanding mechanisms — an explanation you have to summon is
 * an explanation you stop summoning by the third session.
 *
 * Whatever is selected fills it: a finding shows its own detail followed by the doc for
 * the tool that produced it; an adapter row in Settings shows the same doc in the same
 * place. When nothing is selected it explains the view instead of going blank.
 */
export default function App(): React.JSX.Element {
  const [section, setSection] = useState<Section>('cases')
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [activeCase, setActiveCase] = useState<string | null>(null)
  /**
   * The finding the margin is annotating, with its relevance beside it.
   *
   * The assessment travels with the selection rather than being recomputed here: it is a
   * function of the case's seeds, and the case view is the thing that holds those. Two
   * places deriving the same score independently is two places that can disagree by a
   * render.
   */
  const [finding, setFinding] = useState<FindingSelection | null>(null)
  const [adapterId, setAdapterId] = useState<string | null>(null)
  /**
   * Bumped every time a finding's confidence changes, from either of the two places that
   * can change it.
   *
   * The shell holds it because the two places are on opposite sides of the tree: the
   * table lives in `CaseView`, the margin panel lives here, and neither is an ancestor of
   * the other. Without a shared counter, verifying from the panel would leave the table
   * showing the old level until the next run settled — the row and the margin annotating
   * that row disagreeing about the one fact they both exist to state.
   */
  const [verifyEpoch, setVerifyEpoch] = useState(0)

  /**
   * One handler for both paths.
   *
   * The updated finding comes from the main process rather than being reconstructed here:
   * `promote()` also stamps `lastVerified`, and a locally patched copy would be subtly
   * wrong in a field the panel displays.
   */
  const onVerified = useCallback((updated: Finding) => {
    setFinding((prev) =>
      prev && prev.finding.id === updated.id ? { ...prev, finding: updated } : prev
    )
    setVerifyEpoch((n) => n + 1)
  }, [])

  /* Both zones fold on their own in a narrow window and stop doing so the moment the
     operator touches either toggle. 1180 is where the nav's 200px starts costing the
     claim column more than the labels are worth; 980 is where the context panel does. */
  const [navOpen, toggleNav] = useAutoFold(1180)
  const [contextOpen, toggleContext] = useAutoFold(980)
  const [contextWidth, setContextWidth] = useState(CONTEXT_MIN)
  const [dragging, setDragging] = useState(false)
  const navCollapsed = !navOpen

  const reload = useCallback(async () => {
    try {
      const [c, a, i] = await Promise.all([
        window.osint.cases.list(),
        window.osint.adapters.list(),
        window.osint.app.info()
      ])
      setCases(c)
      setAdapters(a)
      setInfo(i)
      setAdapterId((prev) => prev ?? a[0]?.id ?? null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const goto = (next: Section): void => {
    setSection(next)
    if (next !== 'cases') {
      setActiveCase(null)
      setFinding(null)
    }
  }

  const current = cases.find((c) => c.id === activeCase) ?? null
  const findingAdapter = finding ? adapters.find((a) => a.id === finding.finding.tool) : undefined
  const shownAdapter = adapters.find((a) => a.id === adapterId)

  /* What the margin is annotating right now. */
  const context = ((): { title: string; body: React.ReactNode } => {
    if (finding && current) {
      return {
        title: 'Finding',
        body: (
          <FindingDetail
            finding={finding.finding}
            relevance={finding.relevance}
            scored={finding.scored}
            adapter={findingAdapter}
            caseId={current.id}
            onVerified={onVerified}
          />
        )
      }
    }
    if (section === 'settings' && shownAdapter) {
      return {
        title: 'How this works',
        body: (
          <HowThisWorks
            doc={shownAdapter.doc}
            toolId={shownAdapter.id}
            version={shownAdapter.version}
          />
        )
      }
    }
    return { title: 'Context', body: <ContextDefault section={section} inCase={!!current} /> }
  })()

  return (
    <div
      className="shell"
      data-dragging={dragging ? 'true' : undefined}
      data-context={contextOpen ? 'open' : 'closed'}
      style={
        {
          '--shell-nav': navCollapsed ? 'var(--nav-width-collapsed)' : 'var(--nav-width)',
          '--shell-context': `${contextWidth}px`
        } as React.CSSProperties
      }
    >
      <nav className="nav" data-collapsed={navCollapsed ? 'true' : undefined} aria-label="Sections">
        <div className="nav__head">
          {!navCollapsed && <span className="nav__wordmark">OSINT Workbench</span>}
          <button
            type="button"
            className="btn btn--quiet btn--icon"
            onClick={toggleNav}
            aria-expanded={!navCollapsed}
            title={navCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-label={navCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          >
            <Icon name={navCollapsed ? 'chevron-right' : 'chevron-left'} />
          </button>
        </div>

        <ul className="nav__items">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="nav__item"
                aria-current={section === s.id ? 'page' : undefined}
                onClick={() => goto(s.id)}
                title={navCollapsed ? s.label : undefined}
              >
                <Icon name={s.icon} />
                {navCollapsed ? (
                  <span className="sr-only">{s.label}</span>
                ) : (
                  <span className="nav__item-label">{s.label}</span>
                )}
                {!navCollapsed && s.id === 'cases' && cases.length > 0 && (
                  <span className="nav__item-count">{cases.length}</span>
                )}
              </button>
            </li>
          ))}
        </ul>

        {info && !navCollapsed && (
          <div className="nav__foot">
            v{info.version} · Electron {info.electron}
            <br />
            {info.adapterCount} adapter{info.adapterCount === 1 ? '' : 's'} registered
          </div>
        )}
      </nav>

      <main className="main">
        {error && (
          <Notice state="danger" label="Failed" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}

        {section === 'cases' && current && (
          <CaseView
            key={current.id}
            summary={current}
            adapters={adapters}
            selectedFindingId={finding?.finding.id ?? null}
            onSelectFinding={setFinding}
            onChanged={() => void reload()}
            onVerified={onVerified}
            verifyEpoch={verifyEpoch}
            onBack={() => {
              setActiveCase(null)
              setFinding(null)
            }}
          />
        )}

        {section === 'cases' && !current && (
          <CasesView
            cases={cases}
            loading={loading}
            onOpen={(id) => {
              setActiveCase(id)
              setFinding(null)
            }}
            onCreated={() => void reload()}
          />
        )}

        {section === 'self-audit' && <SelfAuditView />}
        {section === 'range' && <RangeView />}
        {section === 'scrub' && <ScrubView />}
        {section === 'settings' && (
          <SettingsView
            info={info}
            adapters={adapters}
            selectedAdapterId={adapterId}
            onSelectAdapter={setAdapterId}
          />
        )}
      </main>

      <ContextPanel
        title={context.title}
        width={contextWidth}
        open={contextOpen}
        onWidth={setContextWidth}
        onToggle={toggleContext}
        onDragging={setDragging}
      >
        {context.body}
      </ContextPanel>
    </div>
  )
}

/**
 * The panel when nothing is selected. Not blank, and not a shrug — the margin is where
 * the app explains itself, so an unselected margin explains the view you are in.
 */
function ContextDefault({
  section,
  inCase
}: {
  section: Section
  inCase: boolean
}): React.JSX.Element {
  if (section === 'cases' && inCase) {
    return (
      <div className="doc">
        <p className="doc__text">
          Select a finding to read what produced it: the source, the tool, the unparsed
          bytes it returned, and the six things its adapter must declare about itself —
          including how it lies to you.
        </p>
        <section className="doc__field">
          <h3 className="doc__label">Why almost everything says unverified</h3>
          <p className="doc__text">
            One tool saying something is one source, and a single source is never better
            than unverified — the code enforces it, so an adapter cannot emit anything
            else. Two sources with different hosts make a claim corroborated. Only you,
            with a written note, can make one confirmed.
          </p>
        </section>
        <section className="doc__field">
          <h3 className="doc__label">Independence is keyed on the source</h3>
          <p className="doc__text">
            Sherlock and Maigret both probing <Data>github.com</Data> is one source, not
            two. Keying on the tool instead would let two wrappers around the same site
            list corroborate every false positive in it — which is exactly the
            unresolved bug class those tools have.
          </p>
        </section>
      </div>
    )
  }

  const TEXT: Record<Section, { title: string; body: string }> = {
    cases: {
      title: 'Cases',
      body: 'A case is a folder on disk and a declared reason you are allowed to look. Open one to see its findings; the margin then explains whichever one you select.'
    },
    'self-audit': {
      title: 'Self-Audit',
      body: 'Five cases at escalating adversary knowledge, each its own folder, compared against each other. The interesting output is the delta between two levels — which single added fact unlocked the most — and not the totals. A tool that was refused is reported as unchecked, never as nothing found.'
    },
    range: {
      title: 'Range',
      body: 'Geolocation drills scored on distance and on calibration together. The tier picker is the difficulty ramp: country first, coordinates last, and the first twenty rounds were reviewed by hand.'
    },
    scrub: {
      title: 'Scrub',
      body: 'What a file says about you beyond the picture, and how to remove it. Nothing is written until you have read the field list; a scrub is always verified afterwards, because a written file is not automatically a clean one.'
    },
    settings: {
      title: 'Settings',
      body: 'Select an adapter to read its mechanism here: what it does, how it works, why that reveals anything, what it is better and worse at, and how it lies to you.'
    }
  }

  const t = TEXT[section]
  return (
    <div className="doc">
      <div className="doc__tool">
        <span className="doc__tool-name">{t.title}</span>
      </div>
      <p className="doc__text">{t.body}</p>
    </div>
  )
}
