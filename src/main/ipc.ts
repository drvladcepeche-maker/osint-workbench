/**
 * IPC handlers. A thin, uniform mapping from channel name to service method.
 *
 * Every handler is wrapped so that a thrown error crosses the bridge as a readable
 * message rather than Electron's `Error invoking remote method` wrapper, and so that a
 * bug in one handler cannot take the main process down.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { app } from 'electron'
import {
  CH,
  type AddEntityRequest,
  type ExportRequest,
  type AuditRequest,
  type CandidateDecisionRequest,
  type CreateCaseRequest,
  type DeleteEntityRequest,
  type EditEntityRequest,
  type PromoteRequest,
  type RunJobRequest,
  type RunPlanRequest,
  type ScrubRunRequest
} from '../shared/ipc'
import type {
  GdprLetterRequest,
  RemoveSeedRequest,
  SeedFieldId,
  SelfAuditLevel,
  SelfAuditProfile,
  SelfAuditRunRequest,
  SelfAuditRunState
} from '../shared/selfaudit'
import type {
  InvestigationRequest,
  InvestigationRunState,
  PruneRequest
} from '../shared/engine'
import type { CandidateState, Job } from '../shared/types'
import { OPENABLE_SCHEMES } from '../shared/links'
import type { OsintService } from './service'
import { RangeStore, type RangeResources } from './range'
import { Scrubber } from './scrub'
import { SelfAudit, listContacts } from './selfaudit'
import { InvestigationEngine } from './engine'
import { galleryFor, previewExport, writeExport } from './export'

type Handler = (...args: never[]) => unknown

function handle(channel: string, fn: Handler): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Prefix so the renderer can tell a handler failure from a transport failure.
      throw new Error(`[${channel}] ${message}`)
    }
  })
}

/** The window a dialog should hang off, when there is one. */
function focused(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function registerIpc(service: OsintService, rangeFiles: RangeResources): void {
  const range = new RangeStore(rangeFiles)
  const scrubber = new Scrubber(service.loaded.paths.opsecKitRoot, service.config.pythonPath ?? null)

  handle(CH.casesList, () => service.listCases())
  handle(CH.casesCreate, (req: CreateCaseRequest) => service.createCase(req))
  handle(CH.casesGet, (caseId: string) => service.getCase(caseId))
  handle(CH.casesSetSubject, (caseId: string, subject: unknown) =>
    service.setCaseSubject(caseId, subject)
  )

  handle(CH.entitiesList, (caseId: string) => service.listEntities(caseId))
  handle(CH.entitiesAdd, (req: AddEntityRequest) => service.addEntity(req))
  handle(CH.entitiesUsage, (caseId: string, entityId: string) => service.entityUsage(caseId, entityId))
  handle(CH.entitiesEdit, (req: EditEntityRequest) => service.editEntity(req))
  handle(CH.entitiesDelete, (req: DeleteEntityRequest) => service.deleteEntity(req))
  handle(CH.entitiesRemoved, (caseId: string) => service.removedEntities(caseId))

  handle(CH.candidatesList, (caseId: string, state?: CandidateState | 'all') =>
    service.listCandidates(caseId, state ?? 'pending')
  )
  handle(CH.candidatesPromote, (req: CandidateDecisionRequest) => service.promoteCandidate(req))
  handle(CH.candidatesDismiss, (req: CandidateDecisionRequest) => service.dismissCandidate(req))
  handle(CH.candidatesPromoteConfirmed, (caseId: string) => service.promoteConfirmedCandidates(caseId))

  handle(CH.findingsList, (caseId: string) => service.listFindings(caseId))
  handle(CH.findingsSearch, (caseId: string, q: string) => service.searchFindings(caseId, q))
  handle(CH.findingsRaw, (caseId: string, findingId: string) => service.readRaw(caseId, findingId))
  handle(CH.findingsPromote, (req: PromoteRequest) => service.promoteFinding(req))
  handle(CH.findingsCorroborationCandidates, (caseId: string, findingId: string) =>
    service.corroborationCandidates(caseId, findingId)
  )

  handle(CH.evidenceList, (caseId: string) => service.listEvidence(caseId))
  handle(CH.confidenceLog, (caseId: string) => service.confidenceLog(caseId))

  handle(CH.adaptersList, () => service.registry.describe(service.config, service.loaded.paths.toolkitRoot))

  handle(CH.jobsRun, (req: RunJobRequest) => service.runJob(req))
  handle(CH.jobsPlan, (req: RunPlanRequest) => service.planRuns(req))
  handle(CH.jobsRunPlan, (req: RunPlanRequest) => service.runPlan(req))
  handle(CH.jobsCancel, (jobId: string) => service.orchestrator.cancel(jobId))
  handle(CH.jobsCancelCase, (caseId: string) => service.cancelCase(caseId))
  handle(CH.jobsList, (caseId?: string) => service.orchestrator.listJobs(caseId))

  handle(CH.indexRebuild, () => service.rebuildIndex())
  handle(CH.settingsGet, () => service.config)

  handle(CH.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    chrome: process.versions.chrome ?? '',
    paths: service.loaded.paths,
    configSource: service.loaded.source,
    configWarnings: service.loaded.warnings,
    adapterCount: service.registry.size()
  }))

  /* External links and Explorer. The renderer never receives a shell command — it names
     a URL or a path and the main process decides whether that is a thing to open. */
  handle(CH.appOpenExternal, async (url: string) => {
    const u = new URL(url)
    // `http` as well as `https`, because a real share of the sites a username sweep hits
    // are old, plain-HTTP forums and refusing those made the link on the row a link that
    // sometimes did nothing. Everything else is still refused here — the renderer checks
    // the same allowlist in `shared/links.ts`, and a check that lives only in the renderer
    // is a check that lives only until someone adds a second caller.
    if (!OPENABLE_SCHEMES.includes(u.protocol)) {
      throw new Error(`refusing to open a ${u.protocol} link — only http and https are opened`)
    }
    await shell.openExternal(u.toString())
  })
  handle(CH.appRevealInFolder, (target: string) => {
    shell.showItemInFolder(target)
  })

  /* The Range. */
  handle(CH.rangeData, () => range.load())
  handle(CH.rangeIndex, (region: 'bulgaria' | 'countries') =>
    range.index(region === 'bulgaria' ? 'bulgaria' : 'countries')
  )
  handle(CH.rangeLive, () => range.live())

  /* The Scrub view. Every path it acts on came from a native picker or a drop onto the
     window, so the operator chose it; nothing here is derived from renderer-supplied
     text that was never on disk. */
  handle(CH.scrubEnv, () => scrubber.env())
  handle(CH.scrubPick, async () => {
    const r = await dialog.showOpenDialog(focused() as BrowserWindow, {
      title: 'Choose files to inspect',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent']
    })
    return r.canceled ? [] : r.filePaths
  })
  handle(CH.scrubPickFolder, async (title?: string) => {
    const r = await dialog.showOpenDialog(focused() as BrowserWindow, {
      title: title ?? 'Choose a folder',
      properties: ['openDirectory', 'dontAddToRecent']
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
  handle(CH.scrubInspect, (paths: string[]) => scrubber.inspect(paths))
  handle(CH.scrubRun, (req: ScrubRunRequest) => scrubber.run(req))
  handle(CH.scrubAudit, (req: AuditRequest) => scrubber.audit(req))

  /* The avatar gallery and the shareable export. Both are pure readers over the case
     folder — neither makes a request to anybody — and only `write` touches the disk. */
  handle(CH.exportGallery, (caseId: string) => galleryFor(service.store, caseId))
  handle(CH.exportPreview, (req: ExportRequest) => previewExport(service.store, req))
  handle(CH.exportWrite, (req: ExportRequest) => writeExport(service.store, req))

  /* Self-Audit. The seed profile is real personal data, so it crosses the bridge only
     where the form has to render it — `state` — and the letter generator fills the
     operator's own details in on this side rather than making the page hold them. */
  const selfAudit = new SelfAudit(service)
  handle(CH.selfAuditState, () => selfAudit.state())
  handle(CH.selfAuditSaveProfile, (profile: SelfAuditProfile) => selfAudit.saveProfile(profile))
  handle(CH.selfAuditClearProfile, () => selfAudit.clearProfile())
  handle(CH.selfAuditSeedUsage, (field: SeedFieldId, value: string) => selfAudit.seedUsage(field, value))
  handle(CH.selfAuditRemoveSeed, (req: RemoveSeedRequest) => selfAudit.removeSeed(req))
  handle(CH.selfAuditPlan, (level: SelfAuditLevel) => selfAudit.plan(level))
  handle(CH.selfAuditRun, (req: SelfAuditRunRequest) => selfAudit.start(req).state)
  handle(CH.selfAuditCancel, () => selfAudit.cancel())
  handle(CH.selfAuditSnapshots, (level: SelfAuditLevel) => selfAudit.snapshots(level))
  handle(CH.selfAuditDelta, (level: SelfAuditLevel, from?: SelfAuditLevel) => selfAudit.delta(level, from))
  handle(CH.selfAuditReport, (level: SelfAuditLevel, snapshotId?: string) => selfAudit.report(level, snapshotId))
  handle(CH.selfAuditResetPaths, (level: SelfAuditLevel, snapshotId?: string) =>
    selfAudit.resetPaths(level, snapshotId)
  )
  handle(CH.selfAuditRescan, (req: SelfAuditRunRequest) => selfAudit.rescan(req))
  handle(CH.selfAuditLastRescan, (level: SelfAuditLevel) => selfAudit.lastRescan(level))
  handle(CH.selfAuditContacts, () => listContacts())
  handle(CH.selfAuditLetter, (req: GdprLetterRequest) => selfAudit.letter(req))
  handle(CH.selfAuditSaveLetter, (req: GdprLetterRequest) => selfAudit.saveLetter(req))

  /* The investigation engine.

     Held here rather than on the service for the same reason `SelfAudit` is: it owns a
     run, and a run belongs to the window's lifetime rather than to the store. The test
     suite constructs its own against the same service, which is what keeps the loop
     drivable in plain Node with no display. */
  // Constructing it is also what joins a removal to the provenance graph: the engine wires
  // `service.onEntityRemoved` to its own `prune` in its constructor, so an entity's cut
  // reaches the graph here and in the test suite alike. It used to be wired at this line
  // instead, which meant only the packaged app ever had it.
  const engine = new InvestigationEngine(service)

  handle(CH.enginePlan, (caseId: string, req?: Partial<InvestigationRequest>) => engine.plan(caseId, req))
  handle(CH.engineRun, (req: InvestigationRequest) => engine.start(req).state)
  handle(CH.engineCancel, () => engine.cancel())
  handle(CH.engineState, () => engine.state())
  handle(CH.engineBrief, (caseId: string) => engine.brief(caseId))
  handle(CH.engineChains, (caseId: string) => engine.chains(caseId))
  handle(CH.engineChain, (caseId: string, nodeId: string) => engine.chain(caseId, nodeId))
  // `human` is passed explicitly: a prune that arrives over the bridge is one the operator
  // asked for, and the record has to say so rather than crediting the engine with it.
  handle(CH.enginePrune, (req: PruneRequest) => engine.prune(req, 'human'))
  handle(CH.engineRestore, (caseId: string, nodeId: string) => engine.restore(caseId, nodeId))
  handle(CH.engineDecisions, (caseId: string, limit?: number) => engine.decisions(caseId, limit ?? 0))

  // Job progress is pushed, not polled: a sweep can emit hundreds of updates and
  // polling would either lag or hammer.
  service.orchestrator.on('job:update', (job: Job) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CH.eventJobUpdate, job)
    }
  })

  // The same contract for a self-audit sweep, which settles a dozen checks over several
  // minutes and would otherwise leave the view guessing.
  selfAudit.on('run:update', (state: SelfAuditRunState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CH.eventSelfAuditRun, state)
    }
  })

  // And for the engine, which settles a run every few seconds for minutes at a time.
  engine.on('run:update', (state: InvestigationRunState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CH.eventEngineRun, state)
    }
  })
}
