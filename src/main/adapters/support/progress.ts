/**
 * Reading progress out of a tool while it is still running.
 *
 * `JobProgress` used to be `{ pct?, note? }`, and the UI recovered the count and the
 * current site by running regexes over whatever sentence an adapter happened to write.
 * The fields are structured now, which moves the parsing to where the knowledge is: the
 * adapter watching its own tool's stdout.
 *
 * These tools do not make that easy, and the two shapes they use are both handled here:
 *
 *  - **A redrawn progress bar.** Maigret prints `Searching |███ | 12/38 [32%]` over and
 *    over, separated by carriage returns rather than newlines, interleaved with result
 *    lines. A line-buffered reader waiting for `\n` can sit for a whole minute without
 *    firing.
 *  - **One line per site.** Sherlock with `--print-all` prints `[+] GitHub: <url>` and
 *    `[-] Facebook: Not Found!`, which is a count you can only get by tallying.
 *
 * So the scanner works on a rolling buffer cut at the last carriage return or newline:
 * no token ever spans a cut, which is what makes tallying safe against double counting.
 * Everything here degrades to reporting *less* rather than reporting something wrong —
 * an unrecognised line contributes nothing, and a scanner that never matches leaves the
 * job with an indeterminate bar, which is the honest rendering of "no idea".
 */

/** How much unterminated text is kept while waiting for a boundary. */
const MAX_CARRY = 4096

export interface ScannerHandlers {
  /** A `done / total` pair the tool printed. Only the most recent one per chunk fires. */
  onCount?(done: number, total: number): void
  /** One unit finished, with whatever the tool called it. */
  onUnit?(label: string, hit: boolean): void
  /** A denominator stated on its own, before any counting starts. */
  onTotal?(total: number): void
}

export type Scanner = (chunk: string) => void

/**
 * `12/38 [32%]` — alive_progress's counter, as maigret prints it. The percentage is
 * required so an unrelated `1/2` inside a URL or a date cannot be read as progress.
 */
const BAR_COUNT = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*\[\s*\d+%\s*\]/g

/**
 * `[+] GitHub: https://github.com/torvalds` and `[-] Facebook: Not Found!`.
 *
 * Deliberately **not** anchored to a line start. Maigret writes its result lines directly
 * after a progress-bar frame with no newline between them, so an anchored pattern misses
 * every one of them. The cost is that a banner line of the same shape (`[+] Using sites
 * database: ...`) also matches; the caller filters those, because only the caller knows
 * what its own tool's chatter looks like.
 */
const RESULT_LINE = /\[([+-])\]\s+([^:\r\n]{1,80}):/g

/** `[-] Starting a search on top 38 sites from the Maigret database...` */
const STATED_TOTAL = /\bon\s+(?:top\s+)?(\d[\d,]*)\s+sites\b/i

const num = (s: string): number => Number(s.replace(/,/g, ''))

/**
 * Build a scanner to hand to `ctx.spawn`'s `onStdout`.
 *
 * The returned function must be cheap: it runs on every chunk the child writes, which for
 * a redrawn progress bar is several times a second.
 */
export function createScanner(handlers: ScannerHandlers): Scanner {
  let carry = ''
  let sawTotal = false

  return (chunk: string): void => {
    let buffer = carry + chunk
    // Cut at the last boundary so no token straddles two passes and gets counted twice.
    // With no boundary at all, a bar that never breaks would grow the buffer without
    // limit, so past the cap the text is processed as-is and the carry is dropped.
    const cut = Math.max(buffer.lastIndexOf('\n'), buffer.lastIndexOf('\r'))
    if (cut >= 0) {
      carry = buffer.slice(cut + 1)
      buffer = buffer.slice(0, cut + 1)
    } else if (buffer.length > MAX_CARRY) {
      carry = ''
    } else {
      carry = buffer
      return
    }
    if (carry.length > MAX_CARRY) carry = carry.slice(-MAX_CARRY)
    if (!buffer) return

    if (!sawTotal && handlers.onTotal) {
      const m = STATED_TOTAL.exec(buffer)
      if (m?.[1]) {
        sawTotal = true
        handlers.onTotal(num(m[1]))
      }
    }

    if (handlers.onCount) {
      // Only the newest counter matters; the ones before it are frames of the same bar.
      let last: RegExpExecArray | null = null
      BAR_COUNT.lastIndex = 0
      for (let m: RegExpExecArray | null; (m = BAR_COUNT.exec(buffer)); ) last = m
      if (last?.[1] && last[2]) {
        const done = num(last[1])
        const total = num(last[2])
        if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done <= total) {
          handlers.onCount(done, total)
        }
      }
    }

    if (handlers.onUnit) {
      RESULT_LINE.lastIndex = 0
      for (let m: RegExpExecArray | null; (m = RESULT_LINE.exec(buffer)); ) {
        const label = (m[2] ?? '').trim()
        // `[*] Checking username x on` and `[!] You can run ...` are chatter, not results;
        // the character class above already excludes them, and an empty label is dropped.
        if (label) handlers.onUnit(label, m[1] === '+')
      }
    }
  }
}
