# dsh-timer-agent — DSH 定时任务 × AI Agent 引擎

中文 | [English](./README.en.md)

一个 [DeepSeek Harness (DSH)](https://github.com/) 插件:调研 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 cron 系统后,按其「定时器 ↔ Agent 协同」思路实现的 **host 常驻定时任务引擎**——**宿主进程启动即生效**(任何挂了本插件的 profile:`dsh web`、bot(如 dsh-qqbot)、headless 都一样),**GUI 页面关闭也照常触发**;Web GUI 侧边栏面板只是三个入口之一,没挂 `webServer` 的 profile 里 ticker、`timer_agent` 工具、system-prompt 提示照常工作,只是没有面板和回环 API。

![新建任务弹窗:项目/会话树 + Agent 预设 + cron 定时(截图数据已脱敏)](docs/screenshot.png)

## 它做什么

到点(5 段 cron)通过**真实 agent 会话**执行你写好的 prompt:

- **指定已有会话** → 每次触发继续该对话,具备上下文连续性(hermes cron 的 continuity 形态)
- **指定项目 workdir** → 每次在该项目内新建会话运行(自动加载其 AGENTS.md)
- **两者都留空** → 每次触发在默认工作空间新建会话发起新对话

对话中可直接用 `timer_agent` 工具管理任务(create / list / update / pause / resume / remove / run);Web GUI 侧边栏「定时任务」面板管理同一批任务——**一个台账,三个入口**(工具 / WebUI / 文件)。

## 两种任务类型

- **AI Agent 任务**(默认):到点驱动真实 agent 会话执行 prompt,消耗 API 额度
- **普通任务(命令)**:到点经 harness 的**执行缝 `ctx.shell`** 运行你指定的 `命令 + 参数`(可选工作目录、超时),**不经过 AI、不消耗额度**;stdout/stderr 尾部(≤16k 字符)与退出码随执行记录入账。适合自包含的脚本(下载、导出、续期等)

  > 走 `ctx.shell` 而不是自己 spawn:部署挂了受限执行器(如 `dsh-bwrap-sandbox` 的 `bash-bwrap`,或自带的 `bash-sandbox`)时命令就被关在沙箱里,`workdir` 也按那个执行世界的拼写解析;本地执行器下就是普通进程。未挂载 `ctx.shell` 时任务以失败结算,不会退回无约束的 spawn。

> [!WARNING]
> **普通任务会以当前用户权限运行任意命令,是否受沙箱限制取决于部署的执行器。**在沙箱部署下它被限制在那个沙箱里(与 `bash` 工具同一套规则);在普通部署下它就是无约束的本地进程,没有白名单。任何能新建/编辑任务的人(你自己、能调用 `timer_agent` 工具的 agent 会话、能访问回环 API 的本机进程)都能让任意程序定时运行。请只填入你审查过的、无人值守安全的命令;不要把该插件暴露给不可信环境;任务台账 `jobs.json` 可被篡改即等价于本机任意代码执行。**谨慎使用。**

## 架构(hermes-agent cron 同构)

```
┌─ 宿主进程 (dsh web / bot / headless) ─────────────┐
│  60s ticker(常驻,GUI 关闭也运行)                  │
│   ├─ HostJobStore   ~/.dsh/timer-agent/jobs.json  │
│   │                 (原子写,损坏降级不崩溃)        │
│   ├─ TimerRunner    at-most-once:先顺延 nextRunAt │
│   │                 再触发;运行中跳过;错过即跳过   │
│   │   ├─ agents.resume(钉住会话)                  │
│   │   └─ agents.create + workspaceRegistry        │
│   │       (新会话挂到正确项目)                     │
│   ├─ timer_agent 工具(模型可调用)                 │
│   └─ /api/dsh-timer-agent/* 路由(仅回环)          │
└────────────────────────┬──────────────────────────┘
                         │ HTTP 轮询镜像(5s)
┌─ 浏览器半边(薄)────────┴──────────────────────────┐
│  侧边栏入口 + 任务面板(React)                      │
│  可折叠项目/会话树 · cron 预设 · 执行历史           │
└───────────────────────────────────────────────────┘
```

执行结算通过 `session/event`(`turn/end` 的 `reason.kind`)判定成功/失败,失败原因精确写入台账。

## 功能

- **定时执行**:5 段 cron(分 时 日 月 周,支持 `*` / `*/n` / `a-b` / 逗号列表)+ 预设下拉(每天 09:00 / 每小时 / 每 10 分钟 / 每周一 09:00,新建与编辑页均有)
- **三种执行模式**:新建页下拉选择 Cron / 固定间隔 / 一次性(紧跟「启用定时执行」,未勾选时禁用);固定间隔按上次触发时刻堆整周期,不随重启漂移
- **一次性任务**:只设一个执行时间(默认当前 +1 小时),触发一次即自动归档——无论成功、失败还是手动「立即执行」,都算消耗;适合"做完即走"的收尾脚本与提醒
- **下次执行时间可编辑**:固定间隔与一次性任务可在详情页手动改下次执行时间;Cron 模式严格遵守表达式(服务端拒绝手改)
- **暂停/恢复语义**:暂停保留下次执行时间;恢复基于真实上次执行时间重算,错过的执行不补跑,直接跳到下一个未来时间点
- **目标树选择器**:按项目分组的可折叠树,每组含「新增会话」+ 该项目已有会话(按最近活跃排序);选中会话即钉住该对话
- **任务面板**:列表(标题/状态/下次运行/执行次数)、搜索过滤、详情页(cron 编辑/执行历史/跳转会话 transcript/立即执行/重置/删除)
- **模型工具**:任何对话中 `timer_agent` 直接创建与管理定时任务
- **系统提示注入**:host 半边注册 `plugin:timer-agent` 播报段,agent 知晓本插件能力与协作方式
- **安全**:API 路由仅回环 + 同源可访问(与 dsh-ssh 同防线)

## v0.7.0 变更（兼容 dsh 0.1.5-rc.2）

**适配 dsh 0.1.5-rc.2**（自 v0.6.0 的 dsh 0.1.2-rc.1 跨四个 minor 升级，宿主插件面 API 几乎全部稳定，仅两处破坏性变化）：

- `agents` 的 `cancel(cause)`：宿主把自由文本 cause 换成了稳定意图枚举（`user`/`parent`/`hook`/`disposed`）。本插件的超时取消迁移为 `{ kind: 'hook', reason: … }`（无人到场的自动取消并携带原因）
- 冷读服务拆分：`sessionPersistence.inspect` 被移除。钉住会话恢复时的预设重建改走 `sessionQuery.readSession`（完整事件流，`agent-preset/selected` 仍生效）；宿主未挂 `sessionQuery` 时回退 `sessionPersistence.stat` 读 header
- 其余宿主面（五项服务注入名、webServer 路由、systemPrompt.section、tools.register、`session/event`/`turn/end`、agentDefaultModel/llm/agentPresets、followup 消息形状）经逐一核对全部不变；`dsh.compatibility.dshReleases` 声明更新为 `0.1.5-rc.2`
- peer/dev 依赖对齐 dsh 0.1.5-rc.2 配对版本（cordis ^4.0.2）；插件继续使用 `schemastery`（宿主运行时对 schema 仅做鸭子类型调用，分叉包无影响）

**向下兼容**：任务台账格式无变化，v0.6.0 及更早的 `~/.dsh/timer-agent/jobs.json` 升级即用；仅在 dsh ≥ 0.1.5 上验证，旧版 dsh 请用 v0.6.0。

## v0.5.0 变更与向下兼容

**变更**

- 执行模型改为**完全依赖持久化的下次执行时间**(`nextRunAt`):cron / 固定间隔只用于计算它,到期即触发
- 新增**一次性任务**(`runAt` 创建 / `timer_agent` 的 `run_at` 参数):触发一次即归档;手动执行同样消耗
- **暂停不再清空**下次执行时间;**恢复**改为基于真实上次执行时间(`executions` 最后一条的 `startedAt`,回退 `lastTriggeredAt`)重算,错过不补跑
- 固定间隔 / 一次性任务的下次执行时间支持手动修改(PATCH `nextRunAt` / 工具 `next_run_at`);Cron 严格按表达式,拒绝手改
- 一次性任务对「跳过一次」无意义(跳过即等于不执行),UI 隐藏该按钮、服务端拒绝

**向下兼容**

- **旧版本台账无需迁移,升级即用**:v0.4.0 及更早的 cron / 固定间隔 / 暂停态行全部原样保留;空白脏行仍被丢弃(与旧版一致),损坏台账依旧降级不崩溃
- 旧版代码路径不可能写出一次性任务的行形态(cron 与 interval 皆空且带时间),不存在旧任务被误判为一次性而自动归档的风险
- 唯一注意:升级后若**回滚**到 v0.4.0,一次性任务的排程会被旧版校验丢弃(任务变回未排程);cron / 固定间隔任务不受影响

## 安装

```sh
dsh plugin --profile web add link:<本目录绝对路径>
```

安装后**重启宿主进程**(`dsh web`、`dsh --profile <bot> …`、headless 同理)即生效:对话里 `timer_agent` 工具可用、到期任务照常触发。挂在 `dsh web` 时侧边栏另出现「定时任务」入口(浏览器侧改动强刷 `Ctrl+F5` 即可);挂在 bot / headless profile 时没有面板与回环 API,其余行为一致。

安装到非 web profile 用同一个命令换 profile 名即可(如 `dsh plugin --profile qqbot add link:<本目录绝对路径>`);台账 `~/.dsh/timer-agent/jobs.json` 是进程共享的,多个 profile 各自跑 ticker 会用同一份台账(建议只在一个常驻 profile 里挂本插件)。

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| enabled | boolean | true | Master switch: ticker + tool + routes. Set false to disable the engine without uninstalling. |
| announceToAgent | boolean | true | Inject a system-prompt section announcing the plugin's capabilities to the agent. |

## Tools

### `timer_agent`

Manage the scheduled jobs the host ticker owns (the same rows the web GUI「定时任务」panel renders).

**Parameters:**
- `action` (string, required): `create` / `list` / `update` / `pause` / `resume` / `archive` / `restart` / `remove` / `run`
- `job_id` (string): job id, required for all actions except `create`/`list` (get ids from `list`; never guess)
- `prompt` (string): for `create` — the full self-contained prompt the scheduled run executes; for `update` — replacement; for `run` — transient context for that single fire
- `schedule` (string): 5-field cron, e.g. `0 9 * * *`; required for `create`
- `name` (string): short human title
- `workdir` (string): absolute project directory the run's session works in (empty = default workspace)
- `session` (string): pin an existing session id — every run continues that conversation

**Returns:** `{ kind, job?, jobs?, error? }` — summarized job row(s) or a structured error message.

## 构建

```sh
pnpm install
pnpm run build      # lib/index.js(host) + lib/client.js(浏览器,CSS 已内联)
pnpm run typecheck
pnpm test           # 49 项行为级 E2E(fake host faces,无需 dsh 运行时)
pnpm run smoke-test # 静态结构冒烟(23 项)
```

E2E 覆盖:cron 解析与下次运行计算(本地时间语义)、台账原子写与损坏降级、at-most-once 调度触发、钉住会话 resume、`turn/end` 成功/失败结算(含失败原因入账)、运行中拒绝重复触发、禁用调度不触发、手动触发通道、workdir 传递、`timer_agent` 工具全动作(含非法参数拒绝)、HTTP 路由 CRUD + run + 回环/同源防线 + 非法输入 400。

## 与 hermes-agent cron 的对应关系

| hermes-agent | 本插件 |
|---|---|
| gateway 进程内 60s ticker | 宿主进程内 60s ticker(任何挂了本插件的 profile) |
| 触发即新 AIAgent(platform=cron) 会话 | `agents.create`/`resume` 真实 dsh 会话 |
| ~/.hermes/cron/jobs.json 台账 | ~/.dsh/timer-agent/jobs.json(原子写) |
| at-most-once(先推进 next_run_at) | 先顺延 nextRunAt 再触发 |
| claim 去重 + 心跳 | 运行中跳过 + 5s 手动触发快通道 |
| deliver 回投/指定平台续跑 | 钉住会话 / workdir 新会话 / 默认空间 |
| cron_hint → notepad → script 组装 prompt | 自包含 prompt(无人在场,不可提问) |
| turn/end reason.kind=error 结算 | 同款 session/event 结算 |

## 兼容性、依赖与权限声明

**兼容范围**（声明于 package.json）：

- DSH：`0.1.5-rc.2`（`dsh.compatibility.dshReleases` 精确声明 `compatible`；其他版本未验证，视为 `unknown`）
- Node.js：`>=22`（`engines.node`；仓库内测试依赖 Node 22+ 的 type-stripping 能力）
- 系统：开发验证环境为 Windows 10/11；macOS/Linux 未验证

**宿主面按代适配**：插件只把 `tools` / `systemPrompt` / `agents` 作为硬依赖，其余宿主面取到就用、取不到照样挂载：

- **设置缝两代都支持**：旧缝（dsh 0.1.5-rc.2 的 `SettingsProvider.installSection`）用它把本插件的 entry 注册成命名空间基底，并通过 hooks 接收实时配置；新缝（`SettingsForms`，`installSection` 已不存在）由 Loader 自动投影每个 entry 的 Config，配置改动会重新 apply 本插件，插件无需注册——检测到没有 `installSection` 就跳过，不会抛错
- **没有 `settings` 服务**（bot / headless profile）时插件照常挂载，`enabled` / `announceToAgent` 只能来自 `cordis.yml`，改配置需重启
- **没有 `webServer`**（非 `dsh web` profile）时没有侧边栏面板与回环 API，ticker、`timer_agent` 工具、system-prompt 提示照常工作

**依赖**：

- 运行时依赖仅 `schemastery`（配置 schema 校验），随包安装，无 install/postinstall/prepare 生命周期脚本
- `@deepseek-ai/*` 与 `react` 均为 peerDependencies,由 dsh 宿主提供,插件不禁用、不替换、不重复安装任何官方组件
- 不执行任何安装期构建、下载或远程安装;构建产物 `lib/` 直接随源码入库

**权限披露**（源码静态扫描可见的四类信号，均为插件功能所需）：

- **文件**：任务台账 `~/.dsh/timer-agent/jobs.json` 的原子读写（store）；不触碰 dsh 核心目录与其他 Profile 文件
- **命令**：`command` 型任务经 `ctx.shell` 执行任务作者填写的命令（cwd 可指定 workdir，按执行世界的拼写解析；环境继承宿主 `process.env`）；`prompt` 型任务通过 dsh session API 执行，不直接起 shell
- **网络**：挂了 `webServer` 时仅 localhost —— web GUI 调用同源 `/api/dsh-timer-agent/*` 路由 + 宿主经 dsh client 调用本地 dsh 服务；不连任何外部服务（未挂 `webServer` 的 profile 没有路由，也不再是硬依赖）
- **凭据**：子进程继承宿主 `process.env`（dsh 凭据经环境变量传递给 CLI）；插件自身不读取、不记录、不持久化任何凭据或密钥

**失败边界**：宿主进程停止即不触发（错过即跳过）；台账损坏时降级为空表并备份原文件；运行中到点跳过本次；手动触发与 ticker 触发经同一 at-most-once 通道，不会重复执行。

**源码版本锚**：v0.7.0 发布于 tag `v0.7.0`。

## 已知限制

- 定时执行依赖宿主进程存活(进程停了自然不触发;重启后只跑已顺延到期的任务,错过即跳过)
- 同一台账被多个进程共读时(例如同时在 `web` 和 bot profile 里挂了本插件)会各自触发,请只在一个常驻 profile 里挂载
- 任务运行中到点跳过本次,等下一个 cron 匹配点
- 执行消耗 API 额度;定时执行无人在场,prompt 必须自包含、不可提问

## 致谢

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — cron 架构范本
- [dsh-web-ui 全家桶](https://github.com/linxin666)(dsh-ssh / dsh-client-ui-task-board)— host 服务、路由注册、侧边栏注入与预设下拉的工程先例

## License

[MIT](./LICENSE)
