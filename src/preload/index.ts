/**
 * The context bridge.
 *
 * This is the *entire* surface the renderer has. There is no `require`, no `fs`, no
 * `ipcRenderer` in the page — only the methods listed here. Adding a capability to the
 * UI means adding it to `shared/ipc.ts` and to this file, deliberately.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH, panoUrl, type OsintApi } from '../shared/ipc'

const api: OsintApi = {
  cases: {
    list: () => ipcRenderer.invoke(CH.casesList),
    create: (req) => ipcRenderer.invoke(CH.casesCreate, req),
    get: (caseId) => ipcRenderer.invoke(CH.casesGet, caseId),
    setSubject: (caseId, subject) => ipcRenderer.invoke(CH.casesSetSubject, caseId, subject)
  },
  entities: {
    list: (caseId) => ipcRenderer.invoke(CH.entitiesList, caseId),
    add: (req) => ipcRenderer.invoke(CH.entitiesAdd, req),
    usage: (caseId, entityId) => ipcRenderer.invoke(CH.entitiesUsage, caseId, entityId),
    edit: (req) => ipcRenderer.invoke(CH.entitiesEdit, req),
    delete: (req) => ipcRenderer.invoke(CH.entitiesDelete, req),
    removed: (caseId) => ipcRenderer.invoke(CH.entitiesRemoved, caseId)
  },
  candidates: {
    list: (caseId, state) => ipcRenderer.invoke(CH.candidatesList, caseId, state),
    promote: (req) => ipcRenderer.invoke(CH.candidatesPromote, req),
    dismiss: (req) => ipcRenderer.invoke(CH.candidatesDismiss, req),
    promoteConfirmed: (caseId) => ipcRenderer.invoke(CH.candidatesPromoteConfirmed, caseId)
  },
  findings: {
    list: (caseId) => ipcRenderer.invoke(CH.findingsList, caseId),
    search: (caseId, query) => ipcRenderer.invoke(CH.findingsSearch, caseId, query),
    raw: (caseId, findingId) => ipcRenderer.invoke(CH.findingsRaw, caseId, findingId),
    promote: (req) => ipcRenderer.invoke(CH.findingsPromote, req),
    corroborationCandidates: (caseId, findingId) =>
      ipcRenderer.invoke(CH.findingsCorroborationCandidates, caseId, findingId)
  },
  evidence: {
    list: (caseId) => ipcRenderer.invoke(CH.evidenceList, caseId)
  },
  confidence: {
    log: (caseId) => ipcRenderer.invoke(CH.confidenceLog, caseId)
  },
  adapters: {
    list: () => ipcRenderer.invoke(CH.adaptersList)
  },
  jobs: {
    run: (req) => ipcRenderer.invoke(CH.jobsRun, req),
    plan: (req) => ipcRenderer.invoke(CH.jobsPlan, req),
    runPlan: (req) => ipcRenderer.invoke(CH.jobsRunPlan, req),
    cancel: (jobId) => ipcRenderer.invoke(CH.jobsCancel, jobId),
    cancelCase: (caseId) => ipcRenderer.invoke(CH.jobsCancelCase, caseId),
    list: (caseId) => ipcRenderer.invoke(CH.jobsList, caseId),
    // Returns an unsubscribe function; React effects must be able to clean up, or a
    // remounting case view leaks a listener per mount.
    onUpdate: (cb) => {
      const listener = (_e: unknown, job: Parameters<typeof cb>[0]): void => cb(job)
      ipcRenderer.on(CH.eventJobUpdate, listener)
      return () => ipcRenderer.removeListener(CH.eventJobUpdate, listener)
    }
  },
  index: {
    rebuild: () => ipcRenderer.invoke(CH.indexRebuild)
  },
  range: {
    data: () => ipcRenderer.invoke(CH.rangeData),
    index: (region) => ipcRenderer.invoke(CH.rangeIndex, region),
    live: () => ipcRenderer.invoke(CH.rangeLive),
    // Pure string work, so it stays synchronous: an <img src> cannot await.
    imageUrl: (url) => panoUrl(url)
  },
  scrub: {
    // `File.path` was removed in Electron 32. `webUtils.getPathForFile` is the
    // replacement and it exists only here, which is why drag-and-drop has to cross the
    // bridge instead of being read off the drop event in the page.
    pathForFile: (file) => webUtils.getPathForFile(file),
    env: () => ipcRenderer.invoke(CH.scrubEnv),
    pick: () => ipcRenderer.invoke(CH.scrubPick),
    pickFolder: (title) => ipcRenderer.invoke(CH.scrubPickFolder, title),
    inspect: (paths) => ipcRenderer.invoke(CH.scrubInspect, paths),
    run: (req) => ipcRenderer.invoke(CH.scrubRun, req),
    audit: (req) => ipcRenderer.invoke(CH.scrubAudit, req)
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    getLaunchAtStartup: () => ipcRenderer.invoke(CH.settingsGetLaunchAtStartup),
    setLaunchAtStartup: (enabled) => ipcRenderer.invoke(CH.settingsSetLaunchAtStartup, enabled),
    getDataRoot: () => ipcRenderer.invoke(CH.settingsGetDataRoot),
    pickDataRoot: () => ipcRenderer.invoke(CH.settingsPickDataRoot),
    setDataRoot: (dir) => ipcRenderer.invoke(CH.settingsSetDataRoot, dir)
  },
  app: {
    info: () => ipcRenderer.invoke(CH.appInfo),
    openExternal: (url) => ipcRenderer.invoke(CH.appOpenExternal, url),
    revealInFolder: (target) => ipcRenderer.invoke(CH.appRevealInFolder, target),
    quit: () => ipcRenderer.invoke(CH.appQuit),
    restart: () => ipcRenderer.invoke(CH.appRestart),
    // Same unsubscribe contract as jobs.onUpdate: a remounting shell must be able to
    // clean up, or it leaks a listener per mount.
    onNavigate: (cb) => {
      const listener = (_e: unknown, section: Parameters<typeof cb>[0]): void => cb(section)
      ipcRenderer.on(CH.eventNavigate, listener)
      return () => ipcRenderer.removeListener(CH.eventNavigate, listener)
    }
  },
  exports: {
    gallery: (caseId) => ipcRenderer.invoke(CH.exportGallery, caseId),
    preview: (req) => ipcRenderer.invoke(CH.exportPreview, req),
    write: (req) => ipcRenderer.invoke(CH.exportWrite, req)
  },
  selfAudit: {
    state: () => ipcRenderer.invoke(CH.selfAuditState),
    saveProfile: (profile) => ipcRenderer.invoke(CH.selfAuditSaveProfile, profile),
    clearProfile: () => ipcRenderer.invoke(CH.selfAuditClearProfile),
    seedUsage: (field, value) => ipcRenderer.invoke(CH.selfAuditSeedUsage, field, value),
    removeSeed: (req) => ipcRenderer.invoke(CH.selfAuditRemoveSeed, req),
    plan: (level) => ipcRenderer.invoke(CH.selfAuditPlan, level),
    run: (req) => ipcRenderer.invoke(CH.selfAuditRun, req),
    cancel: () => ipcRenderer.invoke(CH.selfAuditCancel),
    snapshots: (level) => ipcRenderer.invoke(CH.selfAuditSnapshots, level),
    delta: (level, from) => ipcRenderer.invoke(CH.selfAuditDelta, level, from),
    report: (level, snapshotId) => ipcRenderer.invoke(CH.selfAuditReport, level, snapshotId),
    resetPaths: (level, snapshotId) => ipcRenderer.invoke(CH.selfAuditResetPaths, level, snapshotId),
    rescan: (req) => ipcRenderer.invoke(CH.selfAuditRescan, req),
    lastRescan: (level) => ipcRenderer.invoke(CH.selfAuditLastRescan, level),
    contacts: () => ipcRenderer.invoke(CH.selfAuditContacts),
    letter: (req) => ipcRenderer.invoke(CH.selfAuditLetter, req),
    saveLetter: (req) => ipcRenderer.invoke(CH.selfAuditSaveLetter, req),
    // A level's sweep runs for minutes and pushes a state object per settled check. Same
    // unsubscribe contract as jobs.onUpdate, for the same reason.
    onRun: (cb) => {
      const listener = (_e: unknown, state: Parameters<typeof cb>[0]): void => cb(state)
      ipcRenderer.on(CH.eventSelfAuditRun, listener)
      return () => ipcRenderer.removeListener(CH.eventSelfAuditRun, listener)
    }
  },
  engine: {
    plan: (caseId, req) => ipcRenderer.invoke(CH.enginePlan, caseId, req),
    run: (req) => ipcRenderer.invoke(CH.engineRun, req),
    cancel: () => ipcRenderer.invoke(CH.engineCancel),
    state: () => ipcRenderer.invoke(CH.engineState),
    brief: (caseId) => ipcRenderer.invoke(CH.engineBrief, caseId),
    chains: (caseId) => ipcRenderer.invoke(CH.engineChains, caseId),
    chain: (caseId, nodeId) => ipcRenderer.invoke(CH.engineChain, caseId, nodeId),
    prune: (req) => ipcRenderer.invoke(CH.enginePrune, req),
    restore: (caseId, nodeId) => ipcRenderer.invoke(CH.engineRestore, caseId, nodeId),
    decisions: (caseId, limit) => ipcRenderer.invoke(CH.engineDecisions, caseId, limit),
    // Same unsubscribe contract as jobs.onUpdate: a loop pushes a state object per settled
    // run for minutes, and a remounting view must be able to clean up after itself.
    onRun: (cb) => {
      const listener = (_e: unknown, state: Parameters<typeof cb>[0]): void => cb(state)
      ipcRenderer.on(CH.eventEngineRun, listener)
      return () => ipcRenderer.removeListener(CH.eventEngineRun, listener)
    }
  }
}

contextBridge.exposeInMainWorld('osint', api)
