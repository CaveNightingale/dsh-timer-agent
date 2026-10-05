/**
 * Command-execution helpers for 'command' jobs (普通任务): quote-aware
 * argument splitting and output tail truncation. Framework-free so both the
 * host runner and the tests import it directly.
 *
 * @module dsh-timer-agent/command
 */

/**
 * Split an argument string the way a shell roughly would:
 * - whitespace separates arguments (repeated whitespace collapses)
 * - double quotes group (backslash escapes `\` and `"` inside)
 * - single quotes group literally (no escapes inside)
 *
 * Unlike a full shell there is no variable expansion or redirection — the
 * string is pure argv for the spawned executable.
 */
export function splitCommandArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let hasCurrent = false
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasCurrent) {
        args.push(current)
        current = ''
        hasCurrent = false
      }
      index += 1
      continue
    }
    if (char === '"') {
      hasCurrent = true
      index += 1
      let closed = false
      while (index < input.length) {
        const inner = input[index]
        if (inner === '\\' && index + 1 < input.length && (input[index + 1] === '"' || input[index + 1] === '\\')) {
          current += input[index + 1]
          index += 2
          continue
        }
        if (inner === '"') {
          closed = true
          index += 1
          break
        }
        current += inner
        index += 1
      }
      if (!closed) throw new Error(`unterminated double quote in args: ${input}`)
      continue
    }
    if (char === "'") {
      hasCurrent = true
      index += 1
      const close = input.indexOf("'", index)
      if (close === -1) throw new Error(`unterminated single quote in args: ${input}`)
      current += input.slice(index, close)
      index = close + 1
      continue
    }
    hasCurrent = true
    current += char
    index += 1
  }
  if (hasCurrent) args.push(current)
  return args
}

/** Hard cap on captured output kept in memory per stream (bytes-ish). */
const CAPTURE_CAP = 128 * 1024

/** Shell-special-free characters that need no quoting. */
const BARE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/

/** One argv entry as a single-quoted POSIX word (nothing expands inside). */
function quoteArg(arg: string): string {
  if (arg === '') return "''"
  if (BARE_ARG.test(arg)) return arg
  return `'${arg.replaceAll("'", "'\\''")}'`
}

/**
 * Render argv as one POSIX shell command line.
 *
 * The execution seams that confine a command (`ctx.shell`, and therefore a
 * sandboxing executor such as dsh-bwrap-sandbox's) take a command STRING, not
 * argv. Each entry is quoted so the shell hands it to the program byte for
 * byte — `splitCommandArgs` turns the string back into the same argv.
 *
 * @param argv - the executable followed by its arguments.
 * @returns a command line that runs exactly that argv.
 */
export function joinCommandArgs(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}

/** What a settled command execution keeps in the ledger. */
export const OUTPUT_TAIL_CHARS = 16_000

/**
 * Bytes the shell seam may capture for one job's stdout.
 *
 * The seam's capture budget is BYTES while the ledger's tail is CHARACTERS, so
 * four bytes per kept character — the UTF-8 worst case — keeps the seam from
 * cutting a multi-byte tail short before `truncateOutputTail` sees it.
 */
export const OUTPUT_TAIL_BYTES = OUTPUT_TAIL_CHARS * 4

/**
 * Keep the tail of a captured output blob (the interesting part of a long
 * script log is almost always the end), with an elision marker when trimmed.
 */
export function truncateOutputTail(text: string, maxChars = OUTPUT_TAIL_CHARS): string {
  if (text.length <= maxChars) return text
  const elided = text.length - maxChars
  return `…（前 ${elided} 字符已省略）\n${text.slice(-maxChars)}`
}

/** Append a chunk to a capped capture buffer (keeps head + tail marker). */
export function appendCapped(buffer: string, chunk: string): string {
  if (buffer.length >= CAPTURE_CAP) {
    // Already capped: keep sliding the tail so recent output stays visible.
    return buffer.slice(chunk.length) + chunk
  }
  const next = buffer + chunk
  if (next.length <= CAPTURE_CAP) return next
  return `…（输出超长，仅保留末尾）\n${next.slice(-CAPTURE_CAP)}`
}
