/**
 * Host runner: the hermes-cron-shaped engine.
 *
 * - `tick()` (60s interval, the dsh web host process's lifetime): execution
 *   is driven ENTIRELY by the persisted `nextRunAt` (cron/interval only
 *   compute it). Due recurring jobs roll `nextRunAt` forward BEFORE the run
 *   is accepted (at-most-once, with a race guard against hand-pinned
 *   instants); due one-shot jobs consume `nextRunAt` inside requestRun's
 *   atomic mutate. All fires are skipped while the job is already running.
 * - Execution: pinned sessionId → `agents.resume` (context continuity);
 *   otherwise `agents.create` in the target workdir (default workspace when
 *   blank) — a fresh session per run, attached to the workspace record so
 *   the GUI groups it under the right project.
 * - Settlement: the queued user message id is correlated through
 *   `session/event` (`user/message` consumes it, `turn/end` settles the
 *   execution success/failed).
 */
import { randomUUID } from 'node:crypto'
import type {
  HostAgent, HostAgentHandle, HostAgentRegistry, HostFs, HostPluginContext,
  HostSession, HostSessionEvent, HostShellExecutor, HostShellResult, HostUserMessage, HostWorkspaceRegistry,
} from './contracts.ts'
import { isTurnEndEvent, settleShellExecution, turnErrorDetail } from './contracts.ts'
import type { HostJobStore } from './store.ts'
import { isIntervalRule, isOneShotRule, isSchedulable, nextRunAtMs, scheduleNextMs } from '../core/schedule.ts'
import { appendCapped, joinCommandArgs, splitCommandArgs, truncateOutputTail, OUTPUT_TAIL_BYTES } from '../core/command.ts'
import {
  settleExecution, startExecution, withSchedule, jobKind,
  type ExecutionRecord, type JobRecord,
} from '../core/jobs.ts'

/** Everything the runner needs from the host composition. */
export interface RunnerDeps {
  ctx: HostPluginContext
  store: HostJobStore
  /** Clock; injectable for tests. */
  now?: () => number
}

/** Slug a job title into a session-id-safe prefix (hermes names its cron sessions the same way). */
function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  return base === '' ? 'job' : base.slice(0, 32)
}

/** Safely read a selection off the default-model service (undefined on throw). */
function trySelection(defaults: { currentSelection(): { provider: string, model: string } }): { provider: string, model: string } | undefined {
  try {
    const selection = defaults.currentSelection()
    if (selection.provider === '' || selection.model === '') return undefined
    return selection
  } catch {
    return undefined
  }
}

/**
 * The live agent for a pinned id, wrapped as a non-owning handle (dispose is
 * a no-op — the host, e.g. the open GUI session, owns its lifetime). Returns
 * undefined when no live agent is registered under the id.
 */
function liveAgentHandle(agents: HostAgentRegistry, sessionId: string): HostAgentHandle | undefined {
  const live = agents.get?.(sessionId)
  if (live === undefined) return undefined
  return { agent: live, dispose: async () => undefined }
}

/** One in-flight execution the session-event watcher tracks. */
interface InFlight {
  jobId: string
  executionId: string
  sessionId: string
  messageId: string
  /** Whether the session log consumed our message yet. */
  consumed: boolean
  /** The live agent (for timeout cancellation). */
  agent: HostAgent | undefined
  /** Configured limit (ms) when the job carries a timeout; absent = unlimited. */
  timeoutMs: number | undefined
  /** Deadline (ms epoch) when the job carries a timeoutMs; absent = unlimited. */
  timeoutAt: number | undefined
}

/** One in-flight COMMAND execution (no session; kill() cancels the process). */
interface CommandFlight {
  jobId: string
  /** Configured limit (ms) when the job carries a timeout; absent = unlimited. */
  timeoutMs: number | undefined
  /** Deadline (ms epoch) when the job carries a timeoutMs; absent = unlimited. */
  timeoutAt: number | undefined
  /** Best-effort process cancellation (spawn failure tolerated). */
  kill(): void
}

/**
 * The scheduled-jobs engine. One instance per host plugin apply(); owns the
 * ticker interval, the in-flight map, and the session-event subscription.
 */
export class TimerRunner {
  private readonly ctx: HostPluginContext
  private readonly store: HostJobStore
  private readonly now: () => number
  private readonly inFlight = new Map<string, InFlight>() // by messageId
  private readonly commandFlights = new Map<string, CommandFlight>() // by executionId
  private timer: ReturnType<typeof setInterval> | undefined
  private requestTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  /** Agent handles for pinned sessions, kept alive across runs (lark precedent). */
  private readonly pinnedHandles = new Map<string, HostAgentHandle>()

  constructor(deps: RunnerDeps) {
    this.ctx = deps.ctx
    this.store = deps.store
    this.now = deps.now ?? (() => Date.now())
  }

  /** Start the ticker + the session-event watcher. */
  start(): void {
    if (this.disposed) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, 60_000)
    // Manual-run requests (tool / web UI) deserve a snappier response than
    // the schedule tick: a cheap 5s poll that only reads the request field.
    this.requestTimer = setInterval(() => { void this.pollRequests() }, 5_000)
    this.ctx.effect(() => () => { this.stop() }, 'dsh-timer-agent: runner')
    this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
  }

  /** Stop the ticker (idempotent; pinned handles disposed with the plugin). */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.requestTimer !== undefined) clearInterval(this.requestTimer)
    this.timer = undefined
    this.requestTimer = undefined
  }

  /** Fire pending manual-run requests only (the 5s fast path). */
  private async pollRequests(): Promise<void> {
    if (this.disposed) return
    await this.checkTimeouts()
    const jobs = await this.store.load()
    if (!jobs.some(job => job.runRequestedAt !== undefined)) return
    await this.tick()
  }

  /**
   * Enforce per-job run timeouts (n8n / cron-job.org parity, and the
   * stuck-run risk hermes #121953-class issues describe): an execution
   * still in flight past its deadline is cancelled and settled failed.
   * At-most-once: the flight is removed BEFORE settle, so a late turn/end
   * cannot double-settle.
   */
  private async checkTimeouts(): Promise<void> {
    for (const flight of [...this.inFlight.values()]) {
      if (flight.timeoutAt === undefined || this.now() < flight.timeoutAt) continue
      this.inFlight.delete(flight.messageId)
      try {
        // dsh 0.1.5 cancel cause is an intent enum, not free text: a scheduled
        // run's timeout is an automated component cancelling with a reason.
        flight.agent?.cancel({ kind: 'hook', reason: 'dsh-timer-agent: run timed out' })
      } catch (error) {
        console.warn('[dsh-timer-agent] timeout cancel failed:', error)
      }
      const seconds = flight.timeoutMs === undefined ? 0 : Math.max(1, Math.round(flight.timeoutMs / 1000))
      void this.settle(flight.jobId, flight.executionId, 'failed', `run timed out after ${seconds}s (deadline reached)`)
    }
    for (const [executionId, flight] of [...this.commandFlights.entries()]) {
      if (flight.timeoutAt === undefined || this.now() < flight.timeoutAt) continue
      this.commandFlights.delete(executionId)
      try {
        flight.kill()
      } catch (error) {
        console.warn('[dsh-timer-agent] command timeout kill failed:', error)
      }
      const seconds = flight.timeoutMs === undefined ? 0 : Math.max(1, Math.round(flight.timeoutMs / 1000))
      void this.settle(flight.jobId, executionId, 'failed', `command timed out after ${seconds}s (killed)`)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stop()
    for (const flight of this.commandFlights.values()) {
      try { flight.kill() } catch { /* best effort */ }
    }
    this.commandFlights.clear()
    for (const handle of this.pinnedHandles.values()) {
      await handle.dispose().catch(() => undefined)
    }
    this.pinnedHandles.clear()
  }

  /**
   * One scheduler pass: fire due schedules, then manual run requests.
   * Recurring jobs roll `nextRunAt` forward before the run is accepted
   * (at-most-once); one-shot jobs consume it inside requestRun's atomic
   * mutate instead (see {@link requestRun}).
   */
  async tick(): Promise<number> {
    if (this.disposed) return 0
    await this.checkTimeouts()
    const jobs = await this.store.load()
    let fired = 0
    for (const job of jobs) {
      // 1. due schedule (archived jobs never fire; cron, interval, or one-shot)
      const schedule = job.schedule
      if (job.status !== 'archived'
        && schedule !== undefined && schedule.enabled && isSchedulable(schedule)
        && schedule.nextRunAt !== undefined && schedule.nextRunAt <= this.now()) {
        const firedAt = schedule.nextRunAt
        if (isOneShotRule(schedule)) {
          // One-shot: there is no "next" instant to compute — the fire IS the
          // consumption. requestRun clears nextRunAt in its atomic mutate, so
          // a skipped (already running) fire leaves the shot armed and the
          // next tick retries — same skip-while-running semantics as recurring.
          if (await this.requestRun(job.id)) fired += 1
        } else {
          // Interval grids advance from the just-fired instant; cron follows
          // its own grid (max(firedAt, nextRunAt) base keeps a skipped-running
          // occurrence from rolling the grid backwards).
          const next = isIntervalRule(schedule)
            ? scheduleNextMs(schedule, firedAt)
            : nextRunAtMs(schedule.cron, firedAt)
          if (await this.requestRun(job.id)) {
            fired += 1
            await this.store.mutate(current => {
              const row = current.find(candidate => candidate.id === job.id)
              if (row === undefined || row.schedule === undefined) return undefined
              // Race guard: the user may have hand-pinned nextRunAt between
              // the snapshot above and this mutate — only roll the grid when
              // the row still carries a pipeline-owned instant, i.e. the one
              // that fired, or the interval re-anchor requestRun just wrote
              // (identifiable as `latest execution startedAt + N`, immune to
              // real-clock drift between the two mutates). Anything else is a
              // user pin: keep it, stamp only the trigger.
              const schedule = row.schedule
              const lastStartedAt = row.executions[row.executions.length - 1]?.startedAt
              const reanchored = isIntervalRule(schedule)
                && schedule.nextRunAt !== undefined && lastStartedAt !== undefined
                && schedule.nextRunAt === lastStartedAt + schedule.intervalMinutes! * 60_000
              const rolled = schedule.nextRunAt === firedAt || reanchored
              return {
                jobs: current.map(candidate =>
                  candidate.id === job.id
                    ? withSchedule(
                        candidate,
                        { ...(rolled ? { nextRunAt: next } : {}), lastTriggeredAt: this.now() },
                        this.now(),
                      )
                    : candidate),
                result: true,
              }
            })
          }
        }
      }
      // 2. manual run request (from the tool or the web UI)
      if (job.runRequestedAt !== undefined) {
        await this.store.mutate(current => {
          const row = current.find(candidate => candidate.id === job.id)
          if (row === undefined || row.runRequestedAt === undefined) return undefined
          return {
            jobs: current.map(candidate =>
              candidate.id === job.id ? { ...candidate, runRequestedAt: undefined } : candidate),
            result: true,
          }
        })
        if (await this.requestRun(job.id)) fired += 1
      }
    }
    return fired
  }

  /**
   * Fire one job now (used by the tool's action='run' and the web UI's Run
   * button). Rejects while the job is already running (skip-while-running).
   */
  async requestRun(jobId: string, extraPrompt?: string): Promise<boolean> {
    if (this.disposed) return false
    const outcome = await this.store.mutate(current => {
      const job = current.find(candidate => candidate.id === jobId)
      if (job === undefined || job.status === 'running' || job.status === 'archived') return undefined
      const kind = jobKind(job)
      const targeting: ExecutionRecord['targeting'] = kind === 'command'
        ? 'command'
        : job.target.sessionId !== '' ? 'specified-session' : 'new-session'
      const { job: openedJob, execution } = startExecution(job, this.now(), randomUUID(), targeting)
      let next = openedJob
      if (kind === 'agent' && extraPrompt !== undefined && extraPrompt.trim() !== '') {
        execution.error = undefined
        next.prompt = `${next.prompt}\n\n## Run Context\n${extraPrompt}`.trim()
      }
      // One-shot consumption, in the SAME atomic mutate that opens the run
      // (at-most-once): scheduled fires, manual runs, success, and failure all
      // spend the single shot (settleExecution archives the job afterwards),
      // while a rejected run (already running) leaves it armed for a retry.
      if (next.schedule !== undefined && isOneShotRule(next.schedule) && next.schedule.nextRunAt !== undefined) {
        next = withSchedule(next, { nextRunAt: undefined, lastTriggeredAt: this.now() }, this.now())
      }
      // A manual run counts as the last execution: an armed interval grid
      // re-anchors on it (下次 = 手动时刻 + N). Scheduled fires re-roll the
      // grid right after (tick branch 1), so this never shifts cron/interval
      // grids that fire on their own.
      if (next.schedule?.enabled === true && isIntervalRule(next.schedule)) {
        next = withSchedule(
          next,
          { nextRunAt: this.now() + next.schedule.intervalMinutes! * 60_000, lastTriggeredAt: this.now() },
          this.now(),
        )
      }
      return {
        jobs: current.map(candidate => (candidate.id === jobId ? next : candidate)),
        result: { job: next, execution },
      }
    })
    if (outcome === undefined) return false
    void this.execute(outcome.job, outcome.execution)
    return true
  }

  /** The real execution: command jobs run through `ctx.shell`; agent jobs connect/create the agent and send the prompt. */
  private async execute(job: JobRecord, execution: ExecutionRecord): Promise<void> {
    if (jobKind(job) === 'command') {
      this.executeCommand(job, execution)
      return
    }
    try {
      const handle = await this.connectAgent(job)
      const agent: HostAgent = handle.agent
      await this.recordSessionId(job.id, execution.id, agent.session.id)
      const message: HostUserMessage = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: job.prompt.trim() !== '' ? job.prompt : job.title }],
        source: { kind: 'user' },
      }
      this.inFlight.set(message.id, {
        jobId: job.id,
        executionId: execution.id,
        sessionId: agent.session.id,
        messageId: message.id,
        consumed: false,
        agent,
        timeoutMs: job.timeoutMs,
        timeoutAt: job.timeoutMs !== undefined && job.timeoutMs > 0
          ? this.now() + job.timeoutMs
          : undefined,
      })
      agent.followup(message)
    } catch (error) {
      await this.settle(job.id, execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Command execution (普通任务): run the job's command + args through the
   * harness shell seam (`ctx.shell`) — no AI, no session, no API quota.
   *
   * The seam is what makes a run follow its deployment: a sandboxing executor
   * (the stock `bash-sandbox`, or dsh-bwrap-sandbox's replacement for it)
   * confines the process and resolves `workdir` in that execution world, while
   * a local executor spawns it directly. A `node:child_process` spawn here
   * would bypass both, so an absent shell service fails the execution instead
   * of running the command unconfined.
   *
   * Exit 0 settles succeeded; anything else (nonzero exit, deadline kill,
   * runner failure) settles failed with the captured stdout/stderr tail.
   */
  private executeCommand(job: JobRecord, execution: ExecutionRecord): void {
    const command = (job.command ?? '').trim()
    if (command === '') {
      void this.settle(job.id, execution.id, 'failed', 'command is empty (edit the job and set a command)')
      return
    }
    const shell = this.ctx.get('shell') as HostShellExecutor | undefined
    if (shell === undefined) {
      void this.settle(job.id, execution.id, 'failed', 'shell service unavailable (no ctx.shell mounted); the command was not executed')
      return
    }
    let argv: string[]
    try {
      argv = [command, ...splitCommandArgs(job.args ?? '')]
    } catch (error) {
      void this.settle(job.id, execution.id, 'failed', error instanceof Error ? error.message : String(error))
      return
    }
    const workdir = job.target.workdir.trim()
    const worldWorkdir = workdir === '' ? undefined : this.worldPath(workdir)
    if (workdir !== '' && worldWorkdir === undefined) {
      void this.settle(job.id, execution.id, 'failed', this.unreachableWorkdir(workdir).message)
      return
    }
    const timeoutMs = job.timeoutMs !== undefined && job.timeoutMs > 0 ? job.timeoutMs : undefined
    // The controller is the flight's kill switch: the executor treats an
    // already-aborted signal as fired, so registering it before preparation
    // keeps dispose() able to stop a command that has not started yet.
    const controller = new AbortController()
    this.commandFlights.set(execution.id, {
      jobId: job.id,
      timeoutMs,
      timeoutAt: timeoutMs !== undefined ? this.now() + timeoutMs : undefined,
      kill: () => controller.abort(),
    })
    try {
      const spec = shell.resolve({
        command: joinCommandArgs(argv),
        ...(worldWorkdir !== undefined ? { workdir: worldWorkdir } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        stdoutMaxBytes: OUTPUT_TAIL_BYTES,
        signal: controller.signal,
      })
      void this.settleCommandFlight(job, execution, command, spec, shell)
    } catch (error) {
      this.failCommandStart(job, execution, command, error)
    }
  }

  /** Await one started flight, then settle the job from the executor's result. */
  private async settleCommandFlight(
    job: JobRecord,
    execution: ExecutionRecord,
    command: string,
    spec: unknown,
    shell: HostShellExecutor,
  ): Promise<void> {
    try {
      const result = await settleShellExecution(await shell.execute(spec))
      this.commandFlights.delete(execution.id)
      this.settleCommand(job, execution, command, result)
    } catch (error) {
      this.failCommandStart(job, execution, command, error)
    }
  }

  /** Settle a command flight the executor never started. */
  private failCommandStart(job: JobRecord, execution: ExecutionRecord, command: string, error: unknown): void {
    this.commandFlights.delete(execution.id)
    void this.settle(job.id, execution.id, 'failed', `failed to start command '${command}': ${error instanceof Error ? error.message : String(error)}`)
  }

  /** Settle one finished command run from the executor's own result facts. */
  private settleCommand(job: JobRecord, execution: ExecutionRecord, command: string, result: HostShellResult): void {
    const streams = result.stdout.text === '' && result.stderr.text === ''
      ? ''
      : `${result.stdout.text}${result.stderr.text === '' ? '' : `\n[stderr]\n${result.stderr.text}`}`
    const output = truncateOutputTail(streams)
    if (result.timedOut) {
      // The applied deadline, not the job's request: the executor defaults and
      // caps it, so a job that configured none can still be cut short by the
      // deployment's own limit.
      const applied = result.timeoutMs
      const reason = applied > 0
        ? `command timed out after ${Math.max(1, Math.round(applied / 1000))}s (killed)`
        : 'command timed out (killed)'
      void this.settle(job.id, execution.id, 'failed', reason, { output })
      return
    }
    if (result.aborted) {
      void this.settle(job.id, execution.id, 'failed', `command cancelled before it finished`, { output })
      return
    }
    if (result.signal !== null) {
      void this.settle(job.id, execution.id, 'failed', `command killed by signal ${result.signal}`, { output })
      return
    }
    if (result.exitCode === 0) {
      void this.settle(job.id, execution.id, 'succeeded', undefined, { exitCode: 0, output })
      return
    }
    void this.settle(job.id, execution.id, 'failed',
      result.exitCode === null ? 'command exited without an exit code' : `command exited with code ${result.exitCode}`,
      { exitCode: result.exitCode ?? undefined, output })
  }

  /**
   * The execution-world spelling of a host path, or `undefined` when that path
   * is unreachable there.
   *
   * A job's workdir comes from the GUI's project tree, which names host
   * directories; a session header cwd and a shell `workdir` are spelled the way
   * the execution world spells them (a sandboxed deployment binds the project at
   * `/workspace`). A local deployment maps a path onto itself. With no fs
   * service mounted there is no mapping layer and the host spelling is all there
   * is; with one, `undefined` means the deployment's execution world cannot
   * reach that directory, which is reported rather than papered over.
   */
  private worldPath(hostPath: string): string | undefined {
    const fs = this.ctx.get('fs') as HostFs | undefined
    return fs === undefined ? hostPath : fs.processPathFromHostPath(hostPath)
  }

  /** The message a workdir no execution world can reach gets. */
  private unreachableWorkdir(hostPath: string): Error {
    return new Error(`workdir "${hostPath}" is not reachable in this deployment's execution world`)
  }

  /**
   * Pinned session → live agent if one is running, else resume (cached);
   * otherwise a new session in the workdir.
   */
  private async connectAgent(job: JobRecord): Promise<HostAgentHandle> {
    const pinnedId = job.target.sessionId
    if (pinnedId !== '') {
      // Live-first (api-proxy resolver precedent): persistence refuses to
      // prepare a session that is already live, so reuse the running agent
      // (e.g. the GUI session the user pinned is open right now).
      const agents: HostAgentRegistry = this.ctx.agents
      const live = liveAgentHandle(agents, pinnedId)
      if (live !== undefined) return live
      const cached = this.pinnedHandles.get(pinnedId)
      if (cached !== undefined) return cached
      // Rebuild the session's recorded preset composition for the resume
      // (api-proxy agentFor precedent): a cold resume without the join runs
      // the session on host-plane tools instead of the composition its
      // history was produced under. Failure to compose degrades to a bare
      // resume rather than abandoning the pinned conversation.
      let resumeSetup: ((agentCtx: object) => Promise<void>) | undefined
      try {
        resumeSetup = await this.presetSetupFor(pinnedId)
      } catch (error) {
        console.warn('[dsh-timer-agent] preset composition for pinned session failed; resuming bare:', error)
      }
      try {
        // An explicit per-job model selection overrides the session's own;
        // without one the resume keeps the session's persisted selection.
        const handle = await agents.resume({
          resumeSessionId: pinnedId,
          ...job.modelSelection === undefined ? {} : { agentOptions: { ...job.modelSelection } },
          ...resumeSetup === undefined ? {} : { setup: resumeSetup },
        })
        this.pinnedHandles.set(pinnedId, handle)
        return handle
      } catch (error) {
        // Resume can lose the race against the session going live; re-check
        // before giving up so we never fork a live pinned session.
        const raced = liveAgentHandle(agents, pinnedId)
        if (raced !== undefined) return raced
        // The pinned session may have been deleted; fall through to a new
        // session rather than failing the job forever.
        console.warn('[dsh-timer-agent] resume of pinned session failed; creating a new one:', error)
      }
    }
    const agents: HostAgentRegistry = this.ctx.agents
    const sessionId = `timer-${slug(job.title)}-${new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
    // A fresh session has no persisted model selection, and the deployment
    // persona template references `{{model}}` strictly: creating without
    // agentOptions starves that variable and the first turn fails before any
    // work starts. Resolution order: the job's own model selection, else the
    // deployment agentDefaultModel (mirroring the GUI/headless entry points).
    const defaults = this.ctx.get('agentDefaultModel')
    let agentOptions: { provider?: string, model?: string, reasoningEffort?: string } | undefined
    const seed = job.modelSelection ?? (defaults === undefined ? undefined : trySelection(defaults))
    if (seed !== undefined) {
      agentOptions = { provider: seed.provider, model: seed.model }
    }
    // Join the deployment's agent preset: without it the new session runs
    // on the empty global layer — no tool packages, no preset prompt
    // sections. The job's own preset id (agent jobs targeting new sessions)
    // wins; otherwise the roster default. A broken default preset fails the
    // run loudly (creation rolls back with the resolver's error), matching
    // the GUI's behavior; a job-pinned id the roster no longer supplies
    // degrades to the default with a warning instead of failing forever.
    let presetMeta: { agentPreset: string } | undefined
    let presetSetup: ((agentCtx: object) => Promise<void>) | undefined
    ;({ presetMeta, presetSetup } = await this.composePreset(job.preset))
    let cwd: string | undefined
    if (job.target.workdir !== '') {
      cwd = this.worldPath(job.target.workdir)
      if (cwd === undefined) throw this.unreachableWorkdir(job.target.workdir)
    }
    const handle = await agents.create({
      sessionId,
      ...(agentOptions !== undefined ? { agentOptions } : {}),
      ...(cwd !== undefined
        ? { meta: { cwd, ...presetMeta } }
        : presetMeta === undefined ? {} : { meta: presetMeta }),
      ...(presetSetup === undefined ? {} : { setup: presetSetup }),
    })
    await this.attachWorkspace(sessionId, job.target.workdir).catch(() => undefined)
    return handle
  }

  /**
   * Compose a NEW session's preset: resolve the wanted id (or the roster
   * default when blank), record it on the session header, and join the
   * agent's scope to its standing mount inside the factory setup hook
   * (api-proxy composeAgent precedent — the join decides the agent's tools,
   * prompt sections, and skills, so a session created bare resolves them
   * against the empty global layer). Undefined parts when no roster is
   * composed; a broken preset rejects so creation rolls back with the
   * resolver's error — except a job-pinned id the roster no longer knows,
   * which degrades to the default (warned) rather than failing every run.
   */
  private async composePreset(wanted?: string): Promise<{
    presetMeta: { agentPreset: string } | undefined
    presetSetup: ((agentCtx: object) => Promise<void>) | undefined
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { presetMeta: undefined, presetSetup: undefined }
    let resolvedId: string
    if (wanted !== undefined && wanted.trim() !== '') {
      try {
        resolvedId = (await presets.resolve(wanted)).id
      } catch (error) {
        console.warn(`[dsh-timer-agent] job preset "${wanted}" is not on the roster; falling back to the default:`, error)
        resolvedId = (await presets.resolve()).id
      }
    } else {
      resolvedId = (await presets.resolve()).id
    }
    return {
      presetMeta: { agentPreset: resolvedId },
      presetSetup: async agentCtx => { await presets.mount(agentCtx, resolvedId) },
    }
  }

  /**
   * Compose a RESUMED session's recorded preset: the last
   * `agent-preset/selected` event wins over the creation header
   * (`resolveSessionPreset` semantics), read through the cold-read services —
   * dsh 0.1.5 split them: `sessionQuery.readSession` carries the raw event
   * log, `sessionPersistence.stat` the header. A session that recorded none
   * falls back to the roster default. Rejection means "compose nothing" — the
   * caller resumes bare rather than abandoning the pinned conversation.
   */
  private async presetSetupFor(sessionId: string): Promise<((agentCtx: object) => Promise<void>) | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    let recorded: string | undefined
    try {
      const query = this.ctx.get('sessionQuery')
      if (query !== undefined) {
        const snapshot = await query.readSession(sessionId)
        for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
          const event = snapshot.events[index]
          if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            recorded = event.data.agentPreset
            break
          }
        }
        recorded = recorded ?? snapshot.session.agentPreset
      } else {
        const persistence = this.ctx.get('sessionPersistence')
        const snapshot = persistence === undefined ? undefined : await persistence.stat(sessionId)
        recorded = snapshot?.header.agentPreset
      }
    } catch {
      recorded = undefined
    }
    const resolvedId = (await presets.resolve(recorded)).id
    return async agentCtx => { await presets.mount(agentCtx, resolvedId) }
  }

  /** Best-effort workspace grouping so the run lands under the right project in the GUI. */
  private async attachWorkspace(sessionId: string, workdir: string): Promise<void> {
    if (workdir === '') return
    const registry = this.ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
    if (registry === undefined) return
    const workspace = await registry.resolveByPath(workdir) ?? await registry.create(workdir).catch(() => undefined)
    try {
      await workspace?.attachSession(sessionId)
    } catch (error) {
      // A deployment whose filesystem spells the project differently (a sandbox
      // binding it at /workspace) records that spelling in the session header,
      // while workspace records are keyed by the host path, so the registry's
      // cwd check rejects the attach. The run is unaffected; grouping is not.
      console.warn('[dsh-timer-agent] session/workspace attach failed:', error)
    }
  }

  /** Fold the session-event stream into execution settlement. */
  private onSessionEvent(session: HostSession, event: HostSessionEvent): void {
    for (const flight of this.inFlight.values()) {
      if (flight.sessionId !== session.id) continue
      if (event.type === 'user/message') {
        const id = (event.data as { id?: string } | null)?.id
        if (id === flight.messageId) flight.consumed = true
        continue
      }
      if (isTurnEndEvent(event) && flight.consumed) {
        const detail = turnErrorDetail(event.data)
        void this.settle(flight.jobId, flight.executionId, detail === '' ? 'succeeded' : 'failed', detail === '' ? undefined : detail)
        this.inFlight.delete(flight.messageId)
      }
    }
  }

  /** Persist a settled (or failed-to-start) execution and job status. */
  private async settle(jobId: string, executionId: string, outcome: 'succeeded' | 'failed' | 'cancelled', error?: string, extra?: { exitCode?: number, output?: string }): Promise<void> {
    await this.store.mutate(current => {
      const job = current.find(candidate => candidate.id === jobId)
      if (job === undefined) return undefined
      return {
        jobs: current.map(candidate =>
          candidate.id === jobId ? settleExecution(candidate, executionId, outcome, this.now(), error, extra) : candidate),
        result: true,
      }
    })
  }

  /** Record which session an execution landed in (the 'started' event). */
  private async recordSessionId(jobId: string, executionId: string, sessionId: string): Promise<void> {
    await this.store.mutate(current => {
      const job = current.find(candidate => candidate.id === jobId)
      if (job === undefined) return undefined
      return {
        jobs: current.map(candidate => candidate.id === jobId
          ? {
              ...candidate,
              updatedAt: this.now(),
              executions: candidate.executions.map(execution =>
                execution.id === executionId ? { ...execution, sessionId } : execution),
            }
          : candidate),
        result: true,
      }
    })
  }
}
