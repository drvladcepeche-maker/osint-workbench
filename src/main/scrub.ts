/**
 * The Scrub view's back end: a thin, careful driver for the opsec-kit checkout.
 *
 * **Nothing here decides anything.** The Python owns which fields are sensitive, what
 * each one means in plain English, whether a scrub verified, and how a file is written.
 * This module's whole job is to spawn it correctly, read its JSON without tripping over
 * its known rough edges, and turn a failure into a sentence rather than a stack trace.
 *
 * Four rough edges are load-bearing and all four are handled below:
 *
 *  1. **stdout is not always JSON.** `scrub.py` prints `Nothing to do.` and `audit.py`
 *     prints `No supported files found.` to *stdout* even under `--json`. Both exit 1.
 *     So the exit code is checked first and the payload is only parsed when it actually
 *     starts like JSON.
 *  2. **Exit 0 does not mean clean.** A `skipped` file leaves the exit code at 0, and a
 *     PDF whose values are still recoverable from the raw bytes comes back `ok: true`,
 *     `action: "copy"`, `verification.status: "RECOVERABLE"`. The UI has to read the
 *     per-file record, so this module returns it untouched.
 *  3. **Encoding.** opsec-kit reconfigures its own streams to UTF-8 because stdout
 *     defaults to cp1252 here, and it passes filenames to ExifTool through a UTF-8
 *     argfile so Cyrillic names survive. The child is therefore spawned with
 *     `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` and read as UTF-8, matching the path its
 *     own test suite exercises.
 *  4. **`--in-place --no-backup` does not prompt a child process.** opsec-kit's
 *     confirmation returns true when stdin is not a tty. This module therefore never
 *     passes `--no-backup`: an in-place scrub from this UI always keeps a `.bak`.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AuditEntry, AuditRequest, ScrubEnv, ScrubResult, ScrubRunRequest } from '../shared/ipc'
import { findPython, type PythonResolution } from './python'

/** opsec-kit's own tool paths, which it resolves from this file and we only report. */
interface KitConfig {
  exiftool?: string | null
  ffmpeg?: string | null
  ffprobe?: string | null
}

const MAX_OUTPUT = 32 * 1024 * 1024
/** A folder audit over a large tree is genuinely slow; ExifTool batches 200 at a time. */
const TIMEOUT_MS = 15 * 60 * 1000

export class Scrubber {
  private python: PythonResolution | null = null

  constructor(
    /** the opsec-kit checkout — the checkout holding scrub.py, audit.py and opsec/. */
    readonly kitRoot: string,
    private readonly configuredPython: string | null
  ) {}

  /** Resolved once and cached: probing four interpreters costs ~1 s. */
  private resolvePython(): PythonResolution {
    if (!this.python) this.python = findPython(this.configuredPython)
    return this.python
  }

  private kitConfig(): KitConfig {
    try {
      return JSON.parse(readFileSync(path.join(this.kitRoot, 'config.json'), 'utf8')) as KitConfig
    } catch {
      return {}
    }
  }

  /**
   * Everything the Scrub view needs to decide whether it may run, and exactly what to
   * tell the operator when it may not.
   *
   * ExifTool and ffmpeg are reported, not passed: `scrub.py` has no flag for either and
   * resolves them from opsec-kit's own `config.json`. Checking them here means a missing
   * binary is named in the UI before a run instead of surfacing as a per-file failure
   * halfway through one.
   */
  env(): ScrubEnv {
    const py = this.resolvePython()
    const kitPresent = existsSync(path.join(this.kitRoot, 'scrub.py'))
    const cfg = this.kitConfig()

    const exiftoolPath = cfg.exiftool ?? null
    const ffmpegPath = cfg.ffmpeg ?? null
    const ffprobePath = cfg.ffprobe ?? null
    const exiftoolPresent = !!exiftoolPath && existsSync(exiftoolPath)

    const problems: string[] = []
    if (py.error) problems.push(py.error)
    if (!kitPresent) {
      problems.push(
        `The scrubber was not found at ${this.kitRoot}. It is a separate checkout — set "opsecKitRoot" in config/local.config.json to wherever scrub.py lives.`
      )
    }
    if (kitPresent && !exiftoolPath) {
      problems.push(
        `${path.join(this.kitRoot, 'config.json')} does not name an ExifTool binary. Metadata cannot be read or stripped without it.`
      )
    } else if (exiftoolPath && !exiftoolPresent) {
      problems.push(
        `ExifTool is configured as ${exiftoolPath} and there is no file there. Correct "exiftool" in ${path.join(this.kitRoot, 'config.json')}.`
      )
    }
    if (ffmpegPath && !existsSync(ffmpegPath)) {
      problems.push(
        `ffmpeg is configured as ${ffmpegPath} and there is no file there. Images, PDFs and Office files still work; video and audio will fail.`
      )
    }

    return {
      // ffmpeg is not required — it only gates video and audio, and its absence is a
      // warning about scope rather than a reason to refuse to start.
      ok: !py.error && kitPresent && exiftoolPresent,
      python: { path: py.command, version: py.version, how: py.how, error: py.error },
      kitRoot: { path: this.kitRoot, present: kitPresent },
      exiftool: { path: exiftoolPath, version: null, present: exiftoolPresent },
      ffmpeg: { path: ffmpegPath, present: !!ffmpegPath && existsSync(ffmpegPath) },
      ffprobe: { path: ffprobePath, present: !!ffprobePath && existsSync(ffprobePath) },
      problems
    }
  }

  /** Spawn one opsec-kit script and hand back its streams. Never throws on exit code. */
  private exec(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const py = this.resolvePython()
    if (!py.command) throw new Error(py.error ?? 'No Python interpreter was found.')
    if (!existsSync(path.join(this.kitRoot, script))) {
      throw new Error(
        `${script} was not found in ${this.kitRoot}. Set "opsecKitRoot" in config/local.config.json to the folder holding scrub.py and audit.py.`
      )
    }

    return new Promise((resolve, reject) => {
      const child = spawn(py.command as string, [...py.args, script, ...args], {
        cwd: this.kitRoot,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      })

      let stdout = ''
      let stderr = ''
      let killed = false
      const timer = setTimeout(() => {
        killed = true
        child.kill()
      }, TIMEOUT_MS)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += d
      })
      child.stderr.on('data', (d: string) => {
        if (stderr.length < MAX_OUTPUT) stderr += d
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`could not start ${py.command}: ${err.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (killed) {
          reject(new Error(`${script} was still running after 15 minutes and was stopped.`))
          return
        }
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  /**
   * Read a `--json` payload, accounting for the two places opsec-kit writes prose to
   * stdout in JSON mode. The exit code is authoritative; the payload is only trusted
   * when it looks like the array it is documented to be.
   */
  private parseArray<T>(script: string, r: { code: number; stdout: string; stderr: string }): T[] {
    const body = r.stdout.trimStart()
    if (body.startsWith('[')) {
      try {
        return JSON.parse(body) as T[]
      } catch (err) {
        throw new Error(`${script} produced output that is not valid JSON: ${(err as Error).message}`)
      }
    }
    // Exit 1 with prose on stdout is "nothing to do", which is a fact, not a failure.
    if (r.code === 1) return []
    const said = (r.stderr.trim() || body.trim() || '(no output)').split('\n').slice(0, 4).join(' ')
    if (r.code === 3) {
      throw new Error(
        `${script} could not find ExifTool. Check the "exiftool" path in ${path.join(this.kitRoot, 'config.json')}. It said: ${said}`
      )
    }
    if (r.code === 2) throw new Error(`${script} rejected its arguments: ${said}`)
    throw new Error(`${script} exited ${r.code}: ${said}`)
  }

  /** `--report-only`: reads and classifies, writes nothing, opens nothing for write. */
  async inspect(paths: string[]): Promise<ScrubResult[]> {
    if (!paths.length) return []
    const r = await this.exec('scrub.py', ['--json', '--report-only', '--recursive', ...paths])
    return this.parseArray<ScrubResult>('scrub.py', r)
  }

  /**
   * Strip, then verify.
   *
   * `--no-backup` is never passed. opsec-kit skips its own confirmation when stdin is
   * not a tty — which is always true of a spawned child — so the only safe way to offer
   * "scrub in place" from a GUI is to make the backup non-optional.
   */
  async run(req: ScrubRunRequest): Promise<ScrubResult[]> {
    if (!req.paths.length) return []
    const args = ['--json', '--recursive']
    if (req.mode === 'in-place') args.push('--in-place', '--yes')
    else if (req.outDir) args.push('--out', req.outDir)
    const r = await this.exec('scrub.py', [...args, ...req.paths])
    return this.parseArray<ScrubResult>('scrub.py', r)
  }

  /** A folder, ranked worst-first. `audit.py` sorts it; nothing here re-sorts. */
  async audit(req: AuditRequest): Promise<AuditEntry[]> {
    const args = ['--json', req.recursive ? '--recursive' : '--no-recursive']
    if (req.gpsOnly) args.push('--gps-only')
    const r = await this.exec('audit.py', [...args, req.path])
    return this.parseArray<AuditEntry>('audit.py', r)
  }
}
