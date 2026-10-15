/**
 * Electron entry point.
 *
 * Window lifecycle, per DECISIONS.md #7:
 *  - **No global hotkey.** Explicitly not wanted.
 *  - The tray icon is the app. Double-click opens a normal window.
 *  - Closing the window does not quit — it hides to tray.
 *  - Hiding **destroys** the BrowserWindow rather than just hiding it, so an idle
 *    workbench costs one small main process and no renderer. A hidden-but-alive Chromium
 *    renderer is ~120 MB doing nothing; destroying it takes idle to roughly the main
 *    process alone, and the window rebuilds in well under a second.
 *
 * The consequence to keep in mind when adding features: **renderer state does not
 * survive a close.** Anything worth keeping belongs in the case files, which is the
 * right place for it anyway.
 *
 * Quitting is deliberately hard to do by accident: the close button hides, and the only
 * two ways out are the tray menu's Quit and File -> Quit. `quitting` is the flag that
 * separates "the user asked to leave" from "the user closed a window", and every path
 * that really means to exit sets it before calling `app.quit()`.
 */

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CH, type NavSection } from '../shared/ipc'
import { OsintService } from './service'
import { registerIpc } from './ipc'
import { registerPanoScheme, handlePanoProtocol, type RangeResources } from './range'
import { runSmokeTest } from './smoke'

let tray: Tray | null = null
let window: BrowserWindow | null = null
let service: OsintService | null = null
let quitting = false

/**
 * Runtime files that are read from disk rather than bundled — the tray icon, the example
 * config. `electron-builder.yml` copies `resources/` to `<install>/resources/assets`;
 * keep the two in step.
 *
 * These are not imported with `?asset` because that route lands them inside `app.asar`,
 * and `nativeImage.createFromPath` on an asar path returns an empty image — which shows
 * up as a tray icon that is simply missing in the packaged build and perfect in dev.
 */
function assetPath(file: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', file)
    : path.join(app.getAppPath(), 'resources', file)
}

/**
 * The Range's bundled reference data — atlas, the 20 reviewed rounds, the two
 * signal-filtered frame indexes and the world outline. Read from disk on first use
 * rather than bundled, for the same reason as the tray icon plus one more: the country
 * index is 4.4 MB and most sessions never open the Range at all.
 *
 * `extraResources` already copies the whole of `resources/`, so `geoint/` comes along
 * with no packaging change. Regenerate with `node scripts/build-range-resources.mjs`.
 */
function rangeResources(): RangeResources {
  return {
    atlas: assetPath('geoint/atlas.json'),
    curated: assetPath('geoint/curated.json'),
    basemap: assetPath('geoint/basemap.json'),
    indexBulgaria: assetPath('geoint/index.bulgaria.json'),
    indexCountries: assetPath('geoint/index.countries.json')
  }
}

/* ------------------------------------------------------------- data root *
 * Where `config/`, `cases/` and `data/` live in a packaged build.
 *
 * **It is not `userData`, and that is the whole point of this block.** On Windows
 * `app.getPath('userData')` is `%APPDATA%\OSINT Workbench` — on the system drive,
 * which is often the smallest one. Case folders are not small: raw tool
 * output is kept permanently and append-only, a single maigret sweep over 3,000 sites is
 * a large capture, and a self-audit run creates five case folders at a time and is meant
 * to be re-run. That grows without bound, so it lives wherever you point it.
 *
 * The chicken-and-egg problem: the location has to be known before any config inside it
 * can be read. So a **pointer** — a few hundred bytes of JSON naming the real directory —
 * lives at the OS userData path, and it is the only thing this app ever puts in the OS profile.
 * Everything else follows `app.setPath('userData', …)`, which has to happen before
 * `whenReady`, so that anything else reaching for userData lands in the data root too.
 * -------------------------------------------------------------------------- */

/** Nothing but the pointer is ever written here. */
const POINTER_FILE = 'data-location.json'

/** Where a packaged build keeps cases when nothing is configured. Change it in Settings. */
const defaultDataRoot = (): string => path.join(app.getPath('documents'), 'OSINT Workbench')

/** Chromium's scratch in a dev run. Off the repo so no file watcher sees it. */
const DEV_USER_DATA = process.env.OSINT_DEV_USER_DATA || path.join(os.tmpdir(), 'osint-workbench-dev-data')

/** Read the configured data root, or seed the pointer with the default. */
function readDataRootPointer(osUserData: string): { root: string; source: 'pointer' | 'default' | 'fallback' } {
  const pointer = path.join(osUserData, POINTER_FILE)
  try {
    if (existsSync(pointer)) {
      const parsed = JSON.parse(readFileSync(pointer, 'utf8')) as { root?: unknown }
      if (typeof parsed.root === 'string' && parsed.root.trim()) {
        return { root: path.resolve(parsed.root.trim()), source: 'pointer' }
      }
    }
  } catch (err) {
    console.warn(`[main] ${pointer} unreadable, using the default root:`, (err as Error).message)
  }
  return { root: defaultDataRoot(), source: 'default' }
}

function writeDataRootPointer(osUserData: string, root: string): void {
  mkdirSync(osUserData, { recursive: true })
  writeFileSync(
    path.join(osUserData, POINTER_FILE),
    JSON.stringify(
      {
        // ASCII only. This file gets opened in whatever Notepad-shaped thing is to hand,
        // and a UTF-8 em dash read as ANSI renders as mojibake in the one sentence whose
        // job is to explain what the file is.
        $comment:
          'The only file this app keeps in the OS profile. It names the directory that holds cases, ' +
          'raw captures and the SQLite index - all of which live in the data root. ' +
          'Change it in Settings, or edit "root" here and restart.',
        root
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

/**
 * Resolves the data root and repoints `userData` at it. Must run before `whenReady`.
 * Returns what actually happened, for the startup log — the resolved path is printed
 * rather than assumed, because "the config says X" and "it wrote to X" are different
 * claims and only the second one matters.
 */
function applyDataRoot(): { root: string; osUserData: string; source: string } {
  const osUserData = app.getPath('userData')

  if (!app.isPackaged) {
    // Dev keeps cases and config in the repo, as it always has. But `userData` still has
    // to move: Chromium puts its caches, GPU cache, cookies and local storage there, and
    // in dev that is `%APPDATA%\osint-workbench` — a few MB per session, forever.
    // Not the repo, either: writes under a directory vite is watching are a reload loop
    // waiting to happen.
    try {
      mkdirSync(DEV_USER_DATA, { recursive: true })
      app.setPath('userData', DEV_USER_DATA)
    } catch (err) {
      console.warn('[main] dev userData stays in the OS profile:', (err as Error).message)
    }
    return { root: path.resolve(app.getAppPath()), osUserData, source: 'repo (dev)' }
  }

  const { root, source } = readDataRootPointer(osUserData)
  let resolved = root
  let how: string = source
  try {
    mkdirSync(resolved, { recursive: true })
  } catch (err) {
    // A missing or unwritable data root must not stop the app from starting; it must complain
    // loudly and land somewhere real instead.
    console.error(`[main] data root ${resolved} is not writable (${(err as Error).message}); falling back to ${osUserData}`)
    resolved = osUserData
    how = 'fallback'
  }
  app.setPath('userData', resolved)
  if (how !== 'fallback') writeDataRootPointer(osUserData, resolved)
  return { root: resolved, osUserData, source: how }
}

/** Where `config/`, `cases/` and `data/` live. In dev, the repo; packaged, the data root. */
function repoRoot(): string {
  if (!app.isPackaged) return path.resolve(app.getAppPath())
  const root = app.getPath('userData')
  const configDir = path.join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  // Seed the example so there is something to copy and edit. The *active* config is
  // never written by the app — a config it wrote is a config it can silently change.
  const example = path.join(configDir, 'example.config.json')
  const bundled = assetPath('example.config.json')
  if (!existsSync(example) && existsSync(bundled)) {
    try {
      copyFileSync(bundled, example)
    } catch {
      /* Not being able to seed an example is not a reason to fail to start. */
    }
  }
  return root
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    title: 'OSINT Workbench',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // The renderer is a UI, not a privileged process. Everything it can do goes
      // through the explicit IPC surface in shared/ipc.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // External links open in the real browser. A case view will eventually render URLs
  // from untrusted sources, and navigating the app's own window to one of them would be
  // a genuine hole.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    hideToTray()
  })

  win.on('closed', () => {
    if (window === win) window = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  console.log('[main] window created')
  return win
}

function showWindow(): void {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return
  }
  window = createWindow()
}

function hideToTray(): void {
  const win = window
  window = null
  if (win && !win.isDestroyed()) {
    // Destroy, do not hide. See the file header.
    win.destroy()
  }
  console.log('[main] window destroyed; resident in tray')
}

/** Opens the window and asks the renderer for a section once it can listen. */
function openAt(section: NavSection): void {
  showWindow()
  const win = window
  if (!win) return
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send(CH.eventNavigate, section)
  }
  // A window that was just created has not loaded yet; one that already existed has.
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

function quit(): void {
  quitting = true
  app.quit()
}

function createTray(): void {
  // .ico rather than .png: Windows then picks the right bitmap for the DPI instead of
  // resampling one, and 16px is where this icon has the least room to survive a resample.
  const image = nativeImage.createFromPath(assetPath('tray.ico'))
  if (image.isEmpty()) console.warn('[main] tray icon missing at', assetPath('tray.ico'))
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('OSINT Workbench')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => showWindow() },
      { label: 'Run self-audit', click: () => openAt('self-audit') },
      { type: 'separator' },
      { label: 'Quit', click: quit }
    ])
  )
  // Double-click, per the locked decision. Single click is left alone so the context
  // menu stays reachable without opening a window by accident.
  tray.on('double-click', () => showWindow())
  console.log('[main] tray created')
}

/**
 * The application menu. It exists for exactly one reason DESIGN.md cares about — File ->
 * Quit is the second of the two ways out — and is otherwise the standard set. The menu
 * bar is auto-hidden on the window, so this is Alt-to-reveal rather than always-on chrome.
 */
function createAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '&File',
        submenu: [
          { label: 'Open Window', accelerator: 'CmdOrCtrl+N', click: () => showWindow() },
          { label: 'Run Self-Audit', click: () => openAt('self-audit') },
          { type: 'separator' },
          { label: 'Close to Tray', accelerator: 'CmdOrCtrl+W', click: () => hideToTray() },
          { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quit }
        ]
      },
      { label: '&Edit', role: 'editMenu' },
      {
        label: '&View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: '&Help',
        submenu: [
          {
            label: 'Case files on disk',
            click: () => {
              const dir = service?.loaded.paths.casesDir
              if (dir) void shell.openPath(dir)
            }
          }
        ]
      }
    ])
  )
}

/* ------------------------------------------------------------------ startup *
 * `app.setLoginItemSettings` rather than writing Run keys by hand: Electron already
 * owns the per-platform detail, and a registry write is a thing that outlives an
 * uninstall. Off unless he turns it on.
 *
 * The path is passed explicitly. Under `npm run dev` `process.execPath` is
 * `node_modules/electron/dist/electron.exe`, and registering *that* would put a bare
 * Electron in his startup list — so dev is refused outright rather than half-working.
 * -------------------------------------------------------------------------- */

function getLaunchAtStartup(): boolean {
  if (!app.isPackaged) return false
  return app.getLoginItemSettings({ path: process.execPath }).openAtLogin
}

function setLaunchAtStartup(enabled: boolean): boolean {
  if (!app.isPackaged) {
    console.warn('[main] launch-at-startup is a packaged-build setting; ignored in dev')
    return false
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    // Start into the tray, not into a window. Something that opens a window on every
    // boot gets uninstalled.
    args: ['--hidden']
  })
  return getLaunchAtStartup()
}

/**
 * Window and lifecycle IPC.
 *
 * Registered here rather than in `ipc.ts` on purpose: `ipc.ts` is a flat mapping from
 * channel to `OsintService` method, and none of these are service calls — they are the
 * tray, the login item and the quit path, all of which are this file's business.
 */
function registerWindowIpc(): void {
  ipcMain.removeHandler(CH.settingsGetLaunchAtStartup)
  ipcMain.handle(CH.settingsGetLaunchAtStartup, () => getLaunchAtStartup())
  ipcMain.removeHandler(CH.settingsSetLaunchAtStartup)
  ipcMain.handle(CH.settingsSetLaunchAtStartup, (_e, enabled: boolean) => setLaunchAtStartup(!!enabled))

  ipcMain.removeHandler(CH.settingsGetDataRoot)
  ipcMain.handle(CH.settingsGetDataRoot, () => describeDataRoot())

  // A directory picker rather than a text field: a typo in a path typed by hand is an
  // app that starts with an empty case list and no explanation.
  ipcMain.removeHandler(CH.settingsPickDataRoot)
  ipcMain.handle(CH.settingsPickDataRoot, async () => {
    const parent = window && !window.isDestroyed() ? window : undefined
    const opts = {
      title: 'Where should cases, raw captures and the index live?',
      defaultPath: dataRoot.root,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.removeHandler(CH.settingsSetDataRoot)
  ipcMain.handle(CH.settingsSetDataRoot, (_e, dir: string) => setDataRoot(dir))

  ipcMain.removeHandler(CH.appRestart)
  ipcMain.handle(CH.appRestart, () => {
    app.relaunch()
    quit()
  })

  ipcMain.removeHandler(CH.appQuit)
  ipcMain.handle(CH.appQuit, () => quit())
}

function describeDataRoot(): { root: string; effective: string; pointerFile: string; requiresRestart: boolean } {
  const pointerFile = path.join(dataRoot.osUserData, POINTER_FILE)
  const configured = app.isPackaged ? readDataRootPointer(dataRoot.osUserData).root : dataRoot.root
  return {
    root: configured,
    effective: dataRoot.root,
    pointerFile,
    // Moving the root cannot take effect live: SQLite is open on the old one and every
    // case path in memory points into it. Writing the pointer and restarting is honest;
    // re-homing a running service is a much bigger promise than this needs to make.
    requiresRestart: path.resolve(configured) !== path.resolve(dataRoot.root)
  }
}

/**
 * Points the data root somewhere else. Writes the pointer only — **existing cases are
 * not moved.** Copying an investigation between drives behind the operator's back is not
 * something a settings toggle gets to do; the new directory starts empty and the old one
 * is left exactly where it was.
 */
function setDataRoot(dir: string): ReturnType<typeof describeDataRoot> {
  if (!app.isPackaged) throw new Error('the data root is the repo in a dev build; nothing to set')
  const target = path.resolve(String(dir ?? '').trim())
  if (!target || !path.parse(target).root) throw new Error('a data root must be an absolute path')
  mkdirSync(target, { recursive: true }) // throws with a real message if it is not writable
  writeDataRootPointer(dataRoot.osUserData, target)
  console.log('[main] data root set to', target, '— takes effect on restart')
  return describeDataRoot()
}

/**
 * Resolved before anything else, and before `whenReady`, because `app.setPath` has to
 * land before any Electron subsystem caches the old userData path.
 */
const dataRoot = applyDataRoot()

// One instance only: a second launch should surface the existing window, not start a
// second process holding the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  /* Must happen before `whenReady`. The Range's imagery is fetched by the main process
     and handed to the page over this scheme, so the renderer keeps its "no remote loads"
     CSP and a Panoramax instance that sends no CORS headers stops being a dead spinner.
     See main/range.ts. */
  registerPanoScheme()

  // The second process has already exited by the time this fires; all that is left is
  // to put the existing window in front of him, which is what he meant by launching it.
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(async () => {
    try {
      service = await OsintService.create(repoRoot())
    } catch (err) {
      // Most likely cause: an adapter with an incomplete doc. Fail loudly.
      console.error('[main] startup failed:', err)
      app.exit(1)
      return
    }

    // Printed, not assumed. "The config says X" and "it writes to X" are different
    // claims, and only the second one is checkable from a log.
    console.log(
      [
        '[main] data root:',
        `  root      ${service.loaded.paths.root}   (${dataRoot.source})`,
        `  cases     ${service.loaded.paths.casesDir}`,
        `  index db  ${service.loaded.paths.dbFile}`,
        `  config    ${service.loaded.paths.configFile}`,
        `  pointer   ${path.join(dataRoot.osUserData, POINTER_FILE)}  (the only file in the OS profile)`
      ].join('\n')
    )
    console.log(
      `[main] service ready — ${service.registry.size()} adapter(s), cases at ${service.loaded.paths.casesDir}`
    )
    if (service.startupRebuild) {
      console.log('[main] index schema changed; rebuilt from case files:', service.startupRebuild)
    }
    for (const w of service.loaded.warnings) console.warn('[main] config:', w)

    handlePanoProtocol()
    registerIpc(service, rangeResources())
    registerWindowIpc()
    createAppMenu()
    createTray()

    // `--hidden` is what the login item passes; a boot that opens a window is a boot
    // that gets the app uninstalled.
    const hidden = process.argv.includes('--hidden') || service.config.ui.startHiddenInTray
    if (!hidden) showWindow()

    // Opt-in end-to-end self test, used to verify `npm run dev` without a human clicking.
    if (process.env.OSINT_SMOKE === '1') {
      await runSmokeTest(service)
      quitting = true
      app.quit()
    }
  })

  // Do NOT quit when the last window closes — that is the normal state for this app.
  app.on('window-all-closed', () => {
    /* stay resident in the tray */
  })

  app.on('activate', () => showWindow())

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    void service?.dispose()
    tray?.destroy()
    tray = null
  })
}
