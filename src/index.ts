/**
 * Host loader entry for the dsh-timer-agent plugin — the host-authoritative
 * engine (hermes-agent cron shape): a 60s in-process ticker that fires due
 * jobs through the real agent registry (GUI open or not), a file-backed
 * ledger at ~/.dsh/timer-agent/jobs.json, the `timer_agent` model tool so
 * any conversation can create/manage jobs, and /api/dsh-timer-agent routes
 * the web UI reads and writes through.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { HostPluginContext, HostWebServer } from './host/contracts.ts'
import { HostJobStore } from './host/store.ts'
import { TimerRunner } from './host/runner.ts'
import { registerTimerTool } from './host/tools.ts'
import { makeRoutes } from './host/routes.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 201

/** Plugin name: used for logs, diagnostics, and Fiber identity. */
export const name = 'dsh-timer-agent'

export const inject = ['tools', 'systemPrompt', 'agents', 'settings']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TIMER_AGENT_GUIDANCE = 'dsh-timer-agent is installed on this machine (a DSH scheduled-jobs engine, host-resident, in the shape of hermes-agent cron): a 60s ticker runs inside the host process and is live as soon as the plugin mounts — it keeps firing with the GUI closed, needs no `dsh web`, and works in bot and headless profiles too. Jobs live in ~/.dsh/timer-agent/jobs.json. Two job kinds: kind=agent (the default) fires a real agent session that executes the job prompt; kind=command runs command+args through the deployment\'s `ctx.shell` executor with no AI — inside the sandbox when the deployment mounts a confining executor — and consumes no API quota. Schedules are 5-field cron (e.g. 0 9 * * *). An agent job may pin a project workdir (its session runs in that directory and loads its AGENTS.md) or an existing session (every fire continues that conversation, so context carries over); with both blank each fire starts a new conversation in the default workspace. A command job needs only a title, command, args, and a timer (workdir becomes the process working directory, the timeout applies the same way, and a non-zero exit is recorded as a failure with the output tail kept). The `timer_agent` tool create/list/update/pause/resume/remove/run manages these jobs from any conversation (create/update also take kind/command/args), and the web GUI sidebar panel manages the same jobs. Scheduled runs are unattended, so an agent job\'s prompt must be self-contained and must not ask questions. When the user says "定时任务" (scheduled job), "定时器" (timer), or "cron", they mean this plugin — cooperate on that basis.'

/** Settings namespace of the plugin's capability (lowercase hyphenated id). */
export const TIMER_AGENT_SETTINGS_NAMESPACE = 'timer-agent'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (ticker + tool + routes). */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = true

/**
 * Mount the engine: ticker + runner, tool, routes, announcement.
 * @param ctx - host plugin context (tools/systemPrompt/agents/settings, plus an optional webServer).
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  const host = ctx as unknown as HostPluginContext
  let current: () => Config = () => config ?? {}
  let disposeEngine: (() => void) | undefined
  let disposeTool: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    for (const dispose of [disposeEngine, disposeTool, disposeSection]) dispose?.()
    disposeEngine = undefined
    disposeTool = undefined
    disposeSection = undefined
    if ((current().enabled ?? true) === false) return

    const store = new HostJobStore()
    const runner = new TimerRunner({ ctx: host, store })
    runner.start()

    disposeTool = ctx.effect(() => registerTimerTool(ctx.tools!, {
      store,
      runner,
      now: () => Date.now(),
    }), 'dsh-timer-agent: tool')

    const routes = makeRoutes({ store, runner, ctx: host, now: () => Date.now() })
    disposeEngine = () => {
      void runner.dispose()
      for (const route of routes) void route
    }
    // The HTTP routes exist for the web GUI. A profile without `dsh web` — a bot
    // profile, a headless one — has no `webServer`, and the ticker, the tool,
    // and the announcement work there regardless, so this is a soft lookup
    // rather than an injected dependency that holds the whole plugin pending.
    const webServer = ctx.get('webServer') as HostWebServer | undefined
    const disposeRoutes = ctx.effect(() => {
      if (webServer === undefined) return () => {}
      const disposers = routes.map(route => webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-timer-agent: routes')
    // Routes unregister with the engine (single teardown path).
    const engineTeardown = disposeEngine
    disposeEngine = () => {
      engineTeardown()
      disposeRoutes()
    }

    if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === true) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:timer-agent',
        order: SECTION_ORDER,
        text: TIMER_AGENT_GUIDANCE,
      })
    }
  }

  host.settings.installSection(ctx, TIMER_AGENT_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: sync,
  })

  sync()
}
