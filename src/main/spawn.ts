/**
 * Child-process execution.
 *
 * Every OSINT CLI is somebody else's Python script talking to hostile endpoints. The
 * three things that actually happen in practice, and are handled here so no adapter has
 * to:
 *
 *  1. **It hangs.** A dead endpoint with no client-side timeout means the tool sits on a
 *     socket forever. We enforce our own deadline and kill.
 *  2. **Killing the parent is not enough.** `maigret` is a `.exe` shim that spawns
 *     `python.exe`; killing the shim leaves Python running and holding the port. On
 *     Windows we kill the whole tree with `taskkill /T /F`.
 *  3. **It exits non-zero with the useful part on stderr.** The exit code says nothing;
 *     the last few lines of stderr say "Cloudflare challenge" or "no such module". Those
 *     lines are captured, surfaced on the job, and persisted with the raw output.
 *
 * Output is capped. A username sweep that finds a pathological site can emit hundreds of
 * megabytes; past the cap we stop appending and set `truncated`.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions, SpawnResult } from './adapters/types'

/** How much of stderr is quoted into a job's error message. */
const STDERR_TAIL_LINES = 12

export interface RunProcessOptions extends SpawnOptions {
  maxOutputBytes: number
  signal?: AbortSignal
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    // /T = tree, /F = force. Failure is ignored: the process may already be gone, and a
    // failed kill must never take the orchestrator down with it.
    try {
      nodeSpawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on(
        'error',
        () => {}
      )
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}

/** The last few non-empty stderr lines — the part that actually explains a failure. */
export function stderrTail(stderr: string, lines = STDERR_TAIL_LINES): string {
  return stderr
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join('\n')
    .trim()
}

/**
 * Run a command to completion, or kill it.
 *
 * Never rejects. A process that cannot be spawned at all comes back with
 * `spawnError` set and `exitCode: null`, because a missing binary is a normal condition
 * in a toolbelt the user assembled by hand.
 */
export async function runProcess(file: string, opts: RunProcessOptions): Promise<SpawnResult> {
  const args = opts.args ?? []
  const timeoutMs = opts.timeoutMs ?? 120_000
  const started = Date.now()

  return new Promise<SpawnResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const child = nodeSpawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      // Detached on POSIX so the whole group can be signalled. On Windows detaching
      // would open a console window, and taskkill /T handles the tree anyway.
      detached: process.platform !== 'win32'
    })

    const finish = (extra: Partial<SpawnResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const merged: SpawnResult = {
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
        spawnError: null,
        ...extra
      }
      // A killed process usually emits 'close' before our post-kill settle timer, so the
      // close path wins the race and would otherwise report a plain non-zero exit with no
      // explanation. The reason has to survive whichever path settles first.
      if (merged.timedOut && !merged.spawnError) {
        merged.spawnError = `Timed out after ${timeoutMs} ms and was killed.`
      }
      if (opts.signal?.aborted && !merged.spawnError) merged.spawnError = 'Cancelled.'
      resolve(merged)
    }

    const append = (chunk: Buffer, into: 'out' | 'err'): void => {
      // The live handler sees everything the child wrote, including output past the cap.
      // The cap protects the *capture*, not the reader: a tool that has produced 8 MB is
      // exactly the tool whose progress is still worth showing.
      const observer = into === 'out' ? opts.onStdout : opts.onStderr
      if (observer) {
        try {
          observer(chunk.toString('utf8'))
        } catch {
          // A progress handler must never be able to kill a run that is otherwise fine.
        }
      }
      if (bytes >= opts.maxOutputBytes) {
        truncated = true
        return
      }
      const room = opts.maxOutputBytes - bytes
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (slice.length < chunk.length) truncated = true
      bytes += slice.length
      const text = slice.toString('utf8')
      if (into === 'out') stdout += text
      else stderr += text
    }

    child.stdout?.on('data', (c: Buffer) => append(c, 'out'))
    child.stderr?.on('data', (c: Buffer) => append(c, 'err'))

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      // Give the tree a moment to die, then settle regardless. Some Windows processes
      // hold handles long enough that 'close' never fires.
      // Not unref'd: this timer owns the pending promise. See the note in
      // orchestrator.pump().
      setTimeout(
        () =>
          finish({
            signal: 'SIGKILL',
            spawnError: `Timed out after ${timeoutMs} ms and was killed.`
          }),
        750
      )
    }, timeoutMs)

    const onAbort = (): void => {
      killTree(child.pid)
      setTimeout(() => finish({ signal: 'SIGKILL', spawnError: 'Cancelled.' }), 250)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      finish({ spawnError: `${(err as NodeJS.ErrnoException).code ?? 'ERROR'}: ${err.message}` })
    })

    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null })
    })

    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin)
    } else {
      // Close stdin so a tool that prompts gets EOF instead of blocking forever.
      child.stdin?.end()
    }
  })
}
