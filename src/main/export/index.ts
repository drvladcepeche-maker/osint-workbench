/**
 * The export: assemble the bundle, render it, and put it somewhere the operator can find.
 *
 * Three calls, and only the last one writes anything:
 *
 *   gallery(caseId)   every picture the case holds, grouped
 *   preview(req)      the finished document as a string
 *   write(req)        the same string, on disk, with the path returned
 *
 * `preview` exists because this document is going to be handed to a person, and a thing
 * you are about to send somebody should be readable before you send it rather than after.
 *
 * The default destination is inside the case folder. Cases are already where everything
 * about a case lives, they are already under the data root, and an export that lands
 * in a folder the operator has open is one he can attach without hunting for it.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import type { ExportRequest, ExportResult, AvatarGallery } from '../../shared/ipc'
import type { CaseStore } from '../store/caseStore'
import { buildExportBundle, type ExportBundle } from './bundle'
import { buildGallery } from './gallery'
import { renderHtml } from './html'
import { renderMarkdown } from './markdown'

export * from './bundle'
export { buildGallery, groupAvatars, harvestAvatars, profilesFromHarvest, readProfiles } from './gallery'
export { renderHtml } from './html'
export { renderMarkdown } from './markdown'

/** Windows-safe, sortable, and obviously about this case. */
export function defaultExportName(bundle: ExportBundle, format: ExportRequest['format']): string {
  const stamp = bundle.generatedAt.slice(0, 10)
  const slug = bundle.case.id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
  return `report-${slug}-${stamp}.${format === 'html' ? 'html' : 'md'}`
}

export async function buildExport(
  store: CaseStore,
  req: ExportRequest
): Promise<{ bundle: ExportBundle; body: string }> {
  const bundle = await buildExportBundle({
    store,
    caseId: req.caseId,
    lang: req.lang,
    subjectName: req.subjectName,
    preparedBy: req.preparedBy
  })
  const options = { lang: req.lang, includeNoise: req.includeNoise !== false }
  const body = req.format === 'markdown' ? renderMarkdown(bundle, options) : renderHtml(bundle, options)
  return { bundle, body }
}

export async function previewExport(store: CaseStore, req: ExportRequest): Promise<string> {
  return (await buildExport(store, req)).body
}

export async function galleryFor(store: CaseStore, caseId: string): Promise<AvatarGallery> {
  return buildGallery(store.dir(caseId))
}

export class ExportPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportPathError'
  }
}

/**
 * Confine a caller-supplied destination to the data root.
 *
 * The comment that used to sit on `writeExport` said the path came from a native save
 * dialog the operator drove. **There is no save dialog.** `ipc.ts` hands the renderer's
 * `ExportRequest` straight through, so `outPath` is renderer-supplied text reaching
 * `path.resolve` + `mkdir -p` + `writeFile` — `caseId` is guarded by `store.dir()` and this
 * was not. A compromised or merely buggy renderer could write an attacker-controlled HTML
 * document anywhere the process can reach, including a startup folder.
 *
 * Until a real dialog exists, the destination has to live under `cases/`. That is where the
 * default lands anyway, and it keeps the honest half of the old promise: the operator picks
 * the name, not the volume. A rejected path says so instead of silently relocating, because
 * writing somewhere other than where you were asked is its own bug.
 */
export function resolveExportPath(store: CaseStore, caseId: string, outPath: string | undefined, fallback: string): string {
  const root = path.resolve(store.casesDir)
  const target =
    outPath !== undefined && outPath.trim()
      ? path.resolve(root, outPath)
      : path.join(store.dir(caseId), fallback)
  const relative = path.relative(root, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ExportPathError(
      `Refusing to write the export to ${target}: it is outside the case folder. ` +
        `Give a path under ${root}, or omit it and the file lands beside the case.`
    )
  }
  return target
}

/**
 * Write the document.
 *
 * `outPath` is honoured when it names somewhere under the data root, and is otherwise a
 * dated file in the case folder. See `resolveExportPath` for why it is confined.
 */
export async function writeExport(store: CaseStore, req: ExportRequest): Promise<ExportResult> {
  const { bundle, body } = await buildExport(store, req)
  const target = resolveExportPath(store, req.caseId, req.outPath, defaultExportName(bundle, req.format))

  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, body, 'utf8')

  // Counted from what was rendered rather than from what was available: the point of the
  // number is "this file works with the wifi off", and a picture that did not make it into
  // the bytes does not.
  const inlined = body.match(/data:image\/[a-z.+-]+;base64,/g)?.length ?? 0
  const imageBytes = [...body.matchAll(/data:image\/[a-z.+-]+;base64,([A-Za-z0-9+/=]+)/g)].reduce(
    (n, m) => n + m[1].length,
    0
  )

  return {
    path: target,
    bytes: Buffer.byteLength(body, 'utf8'),
    format: req.format,
    imagesInlined: inlined,
    imageBytes
  }
}
