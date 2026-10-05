/**
 * Narrow local contracts for the DSH host services this plugin consumes
 * (dsh-lark-channel precedent): keeping these structural copies lets the
 * package build self-contained while a composed DSH profile supplies the
 * real implementations at runtime. Field shapes mirror `@deepseek-ai/dsh-agent`,
 * `@deepseek-ai/dsh-tools`, and the webserver's route surface as of
 * dsh 0.1.5-rc.2.
 * @module dsh-timer-agent/host-contracts
 */

import type z from 'schemastery'

/**
 * Minimal JSON value face. dsh 0.1.2 stopped re-exporting `JsonValue` from
 * `@deepseek-ai/dsh-tools`; keeping a structural copy avoids a dependency on
 * the package that now owns it (`@deepseek-ai/dsh-util-values`).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** The live session a host agent drives; identity + log read. */
export interface HostSession {
  /** The session id shared by the agent registry and session log. */
  readonly id: string
}

/** One model-facing text content block. */
export interface HostTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** A user-role message accepted by {@link HostAgent.followup}. */
export interface HostUserMessage {
  /** Stable message identity; a fresh UUID per message. */
  readonly id: string
  readonly role: 'user'
  readonly content: readonly HostTextBlock[]
  /** Producer tag: a scheduled run is still a direct human-style prompt. */
  readonly source: {
    readonly kind: 'user'
  }
}

/**
 * Why an active agent is cancelled. dsh 0.1.5 replaced the free-text cause
 * string with this stable intent enum (`AgentCancelCause`); the runner's
 * timeout path speaks `{ kind: 'hook', reason }` (an automated component
 * cancelling with a reason, no user present).
 */
export type HostAgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook', readonly reason: string }
  | { readonly kind: 'disposed' }

/** Public live-agent handle (subset of the host `Agent` interface). */
export interface HostAgent {
  readonly id: string
  readonly session: HostSession
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: HostUserMessage): void
  /** Clear queued work and abort the active turn. */
  cancel(cause: HostAgentCancelCause): void
}

/** An owned agent plus its teardown capability, from `agents.create()`. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** The `agents` registry service (subset of the host `AgentRegistry`). */
export interface HostAgentRegistry {
  /**
   * The live agent already running under an id, if any (no ownership
   * transfer; the host owns its lifetime). Mirrors the api-proxy resolver's
   * live-first lookup — `resume` refuses to prepare a session while it is
   * live, so pinned targets must reuse the live agent instead.
   */
  get?(sessionId: string): HostAgent | undefined
  /** Reopen a persisted session as a live agent, replaying its history. */
  resume(options: {
    readonly resumeSessionId: string
    /** Per-agent overrides (provider, model, …); omit → keep the session's selection. */
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly reasoningEffort?: string
    }
    /** Pre-publication composition of the agent's scoped world (preset join). */
    readonly setup?: (agentCtx: object) => void | Promise<void>
  }): Promise<HostAgentHandle>
  create(options: {
    readonly sessionId: string
    readonly meta?: {
      readonly cwd?: string
      readonly agentPreset?: string
    }
    /** Per-agent options (provider, model, …) — omitting model starves `{{model}}`. */
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly reasoningEffort?: string
    }
    /** Pre-publication composition of the agent's scoped world (preset join). */
    readonly setup?: (agentCtx: object) => void | Promise<void>
  }): Promise<HostAgentHandle>
}

/**
 * The `agentPresets` service (subset of the host `AgentPresets`): the preset
 * roster whose standing mounts give an agent its tools, prompt sections, and
 * skills. `mount` must run inside the agent factory's `setup` hook, where a
 * failure rolls the whole creation back.
 */
export interface HostAgentPresets {
  /** Resolve one preset by id (undefined = the deployment default). */
  resolve(id?: string): Promise<{ readonly id: string }>
  /** Join one agent's scope to a preset's standing composition. */
  mount(agentCtx: object, id?: string): Promise<unknown>
  /** The preset id mounted when a caller names none (roster default). */
  readonly defaultId: string
  /** Every preset the configured roots currently supply (roster rows). */
  list(): Promise<ReadonlyArray<HostAgentPresetRow>>
}

/** One roster row from `agentPresets.list()` (discovery shape, trimmed). */
export interface HostAgentPresetRow {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly name?: string
  readonly description?: string
  /** Why this preset cannot compose a session; absent when it can. */
  readonly broken?: string
}

/**
 * The `sessionQuery` service (subset of the host `SessionQueryEngine`, new in
 * the cold-read role dsh 0.1.5 carved out of `sessionPersistence`): the full
 * raw event log plus header of one session, cold.
 */
export interface HostSessionQuery {
  /** Read one session's header and complete raw event log. */
  readSession(sessionId: string): Promise<{
    readonly session: { readonly agentPreset?: string }
    readonly events: ReadonlyArray<{ readonly type: string, readonly data?: { readonly agentPreset?: string } }>
  }>
}

/**
 * The `sessionPersistence` service (subset): dsh 0.1.5 removed `inspect` —
 * header reads now go through `stat`, event-level cold reads through
 * `sessionQuery` (see {@link HostSessionQuery}).
 */
export interface HostSessionPersistence {
  /** Read one session's stored header without opening it (undefined = unknown). */
  stat(sessionId: string): Promise<{
    readonly header: { readonly agentPreset?: string }
  } | undefined>
}

/**
 * The `agentDefaultModel` service (subset of the host
 * `AgentDefaultModelConfig`): the deployment-wide default model selection a
 * session-less entry point uses when the target carries no selection.
 */
export interface HostAgentDefaultModel {
  /** Detached provider/model (plus optional reasoning effort) selection. */
  currentSelection(): {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }
}

/** One provider row from the `llm` service's route registry. */
export interface HostLlmProvider {
  /** Provider route key. */
  readonly id: string
  /** Provider display name. */
  readonly name: string
}

/** One model a provider advertises (subset of `LlmModelInfo`). */
export interface HostLlmModel {
  /** Provider-owned model id. */
  readonly id: string
  /** Human-readable model name. */
  readonly name: string
}

/**
 * The `llm` service (subset of the host LLM registry): the provider/model
 * catalog for selection surfaces.
 */
export interface HostLlm {
  /** Every registered provider route. */
  listProviders(): readonly HostLlmProvider[]
  /** One provider's advertised models (throws per-provider on failure). */
  listModels(provider: string): Promise<readonly HostLlmModel[]>
}

/** One workspace record (subset of the host `Workspace` entity). */
export interface HostWorkspace {
  readonly id: string
  /** The record's canonical (realpath) directory. */
  readonly path: string
  /** Account one session under this workspace (validates header cwd). */
  attachSession(id: string): Promise<unknown>
}

/** The `workspaceRegistry` service (subset of the host registry). */
export interface HostWorkspaceRegistry {
  /** The record for a canonical path, or undefined when none is registered. */
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  /** Register a workspace for a directory; at most one per canonical path. */
  create(path: string, title?: string): Promise<HostWorkspace>
  /** Every registered workspace (optional on older registries). */
  list?(): readonly HostWorkspace[]
}

/** One execution request for the `shell` service (subset of `ShellExecRequest`). */
export interface HostShellRequest {
  /** The command line to run. */
  readonly command: string
  /** Working directory in the executor's execution world; defaulted by the executor. */
  readonly workdir?: string
  /** Deadline in milliseconds; the executor caps and enforces it. */
  readonly timeoutMs?: number
  /** Foreground stdout capture budget in bytes. */
  readonly stdoutMaxBytes?: number
  /** Cancellation; the executor kills the command when it fires. */
  readonly signal?: AbortSignal
}

/** One captured stream (subset of `CollectedOutput`): the TAIL when truncated. */
export interface HostShellStream {
  readonly text: string
  readonly truncated: boolean
}

/** A finished run (subset of `ShellRunResult`). */
export interface HostShellResult {
  /** Exit code, or null when preparation expired or a signal killed the process. */
  readonly exitCode: number | null
  /** Terminating signal, or null when none was reported. */
  readonly signal: string | null
  /** True when the executor's own deadline was the first cause to cut the run short. */
  readonly timedOut: boolean
  /** True when the caller's `AbortSignal` was the first cause to kill the run. */
  readonly aborted: boolean
  /** The effective timeout applied to this run (after the executor's defaulting and capping). */
  readonly timeoutMs: number
  readonly stdout: HostShellStream
  readonly stderr: HostShellStream
}

/**
 * A prepared execution handle (subset of `ShellExecution`).
 *
 * `result` is where the two seam generations differ: dsh 0.1.7-rc.2 converged
 * the shell seam on `execute()` and made it the method
 * `result(): Promise<ShellRunResult>`, while 0.1.5-rc.2's handle carried the
 * promise as the `result` property. {@link settleShellExecution} accepts either.
 */
export interface HostShellExecution {
  /** Settles at process close; rejects only for infrastructure failures. */
  readonly result: (() => Promise<HostShellResult>) | Promise<HostShellResult>
}

/**
 * The foreground result of one execution handle, whichever seam generation
 * produced it.
 * @param handle - the handle `ctx.shell.execute` resolved to.
 * @returns the settled result for that execution.
 */
export function settleShellExecution(handle: HostShellExecution): Promise<HostShellResult> {
  return typeof handle.result === 'function' ? handle.result() : handle.result
}

/**
 * The `shell` service (subset of the host `ShellExecutor`).
 *
 * Command jobs run through this seam rather than `node:child_process`, so the
 * deployment decides what a command is: a sandboxing executor (the stock
 * `bash-sandbox`, or dsh-bwrap-sandbox's replacement) confines it and resolves
 * its `workdir` in that execution world, while a plain local executor spawns
 * it directly.
 */
export interface HostShellExecutor {
  /** Apply the executor's defaults and caps to a request. */
  resolve(request: HostShellRequest): unknown
  /** Prepare and start one execution. */
  execute(spec: unknown): Promise<HostShellExecution>
}

/**
 * The `fs` service (subset): the execution world's spelling of a path.
 *
 * A job's workdir comes from the GUI's project tree, which names host
 * directories, while a session header cwd and a shell `workdir` are spelled the
 * way the execution world spells them. A local deployment maps a path onto
 * itself; a sandboxed one maps the bound project onto its virtual name.
 */
export interface HostFs {
  /** The execution-world path for a harness-host path, or undefined when it is unreachable there. */
  processPathFromHostPath(hostPath: string): string | undefined
}

/** One immutable entry in the host session log. */
export interface HostSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** The `turn/end` payload fields the runner settles on. */
export interface TurnEndData {
  readonly turn: number
  readonly reason: {
    readonly kind: string
    readonly error?: {
      readonly code?: string
      readonly message?: string
    }
  }
}

/** Narrow a session event to a closed turn boundary. */
export function isTurnEndEvent(event: HostSessionEvent): event is HostSessionEvent & { readonly data: TurnEndData } {
  if (event.type !== 'turn/end') return false
  const data = event.data as TurnEndData | undefined
  return typeof data === 'object' && data !== null && typeof data.reason?.kind === 'string'
}

/** Render a failed turn's reason as one operator-readable line. */
export function turnErrorDetail(data: TurnEndData): string {
  if (data.reason.kind !== 'error') return ''
  const error = data.reason.error
  if (error === undefined) return 'turn failed'
  return error.message ?? error.code ?? 'turn failed'
}

/** One webserver route registration (the dsh-ssh route surface). */
export interface HostRoute {
  /** 'exact' matches the full path; 'prefix' matches a path prefix. */
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  handler(req: NodeIncomingMessage, res: NodeServerResponse): Promise<void> | void
}

/** The `webServer` service (subset of the host webserver). */
export interface HostWebServer {
  register(route: HostRoute): () => void
}

/** Hooks a consumer hands to {@link HostSettings.installSection} (subset). */
export interface HostSettingsSectionHooks<T> {
  /** Receive the active configuration source (attach, detach, and change). */
  setSource(current: () => T): void
  /** Re-judge anything derived from the source after a source change. */
  onChange(): void
}

/**
 * The `settings` service, when it offers namespace registration: the shape dsh
 * 0.1.5-rc.2 exposed as `SettingsProvider.installSection` (five params, as dsh
 * 0.1.2 introduced them; the hooks' `validate?` member stays optional and unused
 * here). The later `SettingsForms` seam has no such method — its descriptor list
 * comes from the Loader entries themselves — so the member is optional and the
 * plugin works with either generation.
 */
export interface HostSettings {
  /**
   * Register this plugin's composition entry as the namespace's base layer.
   * @param owner - the consuming plugin's context (registration is an effect
   *   on its fiber: unloading removes the namespace).
   * @param ns - consumer-owned namespace (lowercase hyphenated identifier).
   * @param schema - schemastery schema resolving the namespace.
   * @param entry - composition entry used as the base and fallback value.
   * @param hooks - source sink and change notification.
   */
  installSection?<T>(
    owner: object,
    ns: string,
    schema: z<T>,
    entry: T,
    hooks: HostSettingsSectionHooks<T>,
  ): void
}

// Node http types spelled structurally so the package needs no @types/node
// at the type level beyond these interfaces.
export interface NodeIncomingMessage {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly socket: { readonly remoteAddress?: string }
  on(event: 'data', listener: (chunk: Uint8Array) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>
}

export interface NodeServerResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(chunk?: string | Uint8Array): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host agent registry; required via `inject`. */
    agents: HostAgentRegistry
    /**
     * The host webserver route surface. NOT injected: only the web GUI needs the
     * routes, and a bot or headless profile has no webserver at all.
     */
    webServer?: HostWebServer
    /**
     * The host settings service, when mounted. NOT injected, and not required at
     * runtime: `installSection` is a member of the older seam only, and a dsh
     * without it carries the plugin's Config through the profile entry instead
     * (dsh 0.1.7-rc.2 replaced `installSection` with `SettingsForms`, which
     * projects every entry's Config and needs no consumer registration).
     */
    settings?: HostSettings
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    'session/event'(session: HostSession, event: HostSessionEvent): void
  }
}

/**
 * Structural face the host apply() uses (keeps the entry thin). Not a Context
 * extension — cordis generics over event keys make a narrowed `on` incompatible;
 * the real context satisfies this shape structurally.
 */
export interface HostPluginContext {
  agents: HostAgentRegistry
  /** The host webserver, when mounted ('webServer'); the routes serve the web GUI only. */
  webServer?: HostWebServer
  /** The host settings service, when mounted ('settings'); see {@link HostSettings}. */
  settings?: HostSettings
  /** The host default-model service, when mounted ('agentDefaultModel'). */
  get(service: 'agentDefaultModel'): HostAgentDefaultModel | undefined
  /** The host LLM registry, when mounted ('llm'). */
  get(service: 'llm'): HostLlm | undefined
  /** The preset roster, when mounted ('agentPresets'). */
  get(service: 'agentPresets'): HostAgentPresets | undefined
  /** The session persistence service, when mounted ('sessionPersistence'). */
  get(service: 'sessionPersistence'): HostSessionPersistence | undefined
  /** The cold session-read service, when mounted ('sessionQuery', dsh 0.1.5+). */
  get(service: 'sessionQuery'): HostSessionQuery | undefined
  get(service: string): unknown
  on(event: 'session/event', listener: (session: HostSession, event: HostSessionEvent) => void): () => void
  effect(setup: () => () => void, label?: string): void
  tools?: { register(def: unknown): () => void }
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void
  }
}
