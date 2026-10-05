import z from "schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/** Plugin name: used for logs, diagnostics, and Fiber identity. */
declare const name = "dsh-timer-agent";
declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
declare const TIMER_AGENT_GUIDANCE = "dsh-timer-agent is installed on this machine (a DSH scheduled-jobs engine, host-resident, in the shape of hermes-agent cron): a 60s ticker runs inside the host process and is live as soon as the plugin mounts \u2014 it keeps firing with the GUI closed, needs no `dsh web`, and works in bot and headless profiles too. Jobs live in ~/.dsh/timer-agent/jobs.json. Two job kinds: kind=agent (the default) fires a real agent session that executes the job prompt; kind=command runs command+args through the deployment's `ctx.shell` executor with no AI \u2014 inside the sandbox when the deployment mounts a confining executor \u2014 and consumes no API quota. Schedules are 5-field cron (e.g. 0 9 * * *). An agent job may pin a project workdir (its session runs in that directory and loads its AGENTS.md) or an existing session (every fire continues that conversation, so context carries over); with both blank each fire starts a new conversation in the default workspace. A command job needs only a title, command, args, and a timer (workdir becomes the process working directory, the timeout applies the same way, and a non-zero exit is recorded as a failure with the output tail kept). The `timer_agent` tool create/list/update/pause/resume/remove/run manages these jobs from any conversation (create/update also take kind/command/args), and the web GUI sidebar panel manages the same jobs. Scheduled runs are unattended, so an agent job's prompt must be self-contained and must not ask questions. When the user says \"\u5B9A\u65F6\u4EFB\u52A1\" (scheduled job), \"\u5B9A\u65F6\u5668\" (timer), or \"cron\", they mean this plugin \u2014 cooperate on that basis.";
/** Settings namespace of the plugin's capability (lowercase hyphenated id). */
declare const TIMER_AGENT_SETTINGS_NAMESPACE = "timer-agent";
/** Plugin config, validated by the same-named schemastery schema. */
interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean;
  /** Master switch for the plugin (ticker + tool + routes). */
  enabled?: boolean;
}
declare const Config: z<Config>;
/**
 * Mount the engine: ticker + runner, tool, routes, announcement.
 * @param ctx - host plugin context (tools/systemPrompt/agents, plus optional settings and webServer).
 * @param config - resolved plugin config.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, TIMER_AGENT_GUIDANCE, TIMER_AGENT_SETTINGS_NAMESPACE, apply, inject, name };