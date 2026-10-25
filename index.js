/**
 * Isolated, disposable DSH sandboxes for plugin development.
 *
 * Boots a separate DSH (its own DSH_HOME, profile, port, and workspace) so an
 * unfinished plugin or a mocked component never runs against the live
 * environment. The tool also carries the model-facing reminder to use it.
 * @module @local/mock-dsh-sandbox
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'mock-dsh-sandbox'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

const MOCK_DIR = '.dsh-mock'
const PROFILE = 'mock'
const DEFAULT_INSTANCE = 'dev'
const DEFAULT_TEMPLATE = 'web'
const MAX_INSTANCES = 5
const START_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 300_000
const MAX_TAIL = 4000
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+[^\s]*/

/** Live child processes started by this Host, keyed by instance name. */
const children = new Map()
/** Instances whose start is in flight, so two calls cannot boot the same name. */
const starting = new Set()

const now = () => new Date().toISOString()

/**
 * Whether this Host runs inside a mock, whose profile is disposable by design.
 * @returns true for a mock-spawned DSH.
 */
function inMockEnvironment() {
  if (process.env.DSH_MOCK_INSTANCE) return true
  return /[\\/]\.dsh-mock[\\/]instances[\\/]/i.test(process.env.DSH_HOME ?? '')
}

const WARNING_MARK = '[LIVE-DSH-GUARD]'
const RISK_TTL_MS = 10 * 60_000
const PLUGIN_ACTION_RISKS = {
  install_bundle: ['installs a plugin bundle into the live DSH profile', '在真实 DSH 的 profile 中安装插件包'],
  remove_bundle: ['removes a plugin bundle from the live DSH profile', '从真实 DSH 的 profile 中移除插件包'],
  set_plugin: ['enables or disables a plugin in the live DSH profile', '在真实 DSH 的 profile 中启用或禁用插件'],
  set_bundle: ['enables or disables a bundle in the live DSH profile', '在真实 DSH 的 profile 中启用或禁用插件包'],
  set_version_exemption: ['grants a plugin version exemption in the live DSH profile', '在真实 DSH 的 profile 中授予插件版本豁免'],
}
/** Per-call risks recorded by pre-execute and consumed by the approval prompt. */
const pendingRisks = new Map()

/**
 * Watch live-profile mutations and gate them behind an explicit user approval.
 * @param ctx - plugin context with the tool, approval, and sandbox services.
 */
function registerProfileGuard(ctx) {
  try {
    ctx.on('tools/pre-execute', (exec, next) => {
      pruneRisks()
      let risk
      try {
        risk = assessLiveRisk(ctx, exec)
      } catch {
        risk = undefined
      }
      if (!risk) return next()
      pendingRisks.set(exec.callId, { ...risk, at: Date.now() })
      if (currentMode(ctx, exec) === 'danger-full-access') {
        return { kind: 'ask', reason: riskReason(risk), displayReason: riskDisplay(risk) }
      }
      return next()
    })
    ctx.on('tools/result', (exec) => {
      pendingRisks.delete(exec.callId)
    })
    ctx.on('approval/request', (req, next) => {
      return augmentApproval(ctx, req, next)
    }, true)
    const attach = (agent) => {
      try {
        ctx.effect(() => agent.ctx.on('approval/request', (req, next) => augmentApproval(ctx, req, next), true))
      } catch {
        /* the agent may already be disposed */
      }
    }
    ctx.on('agent/created', ({ agent }) => attach(agent))
    const agents = ctx.get('agents')
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) attach(agent)
    }
  } catch {
    /* the guard is best-effort; the mock tool and prompt stay available */
  }
}

/**
 * Add the live-profile warning to one pending approval prompt.
 * @param ctx - plugin context.
 * @param req - the approval request about to be forwarded.
 * @param next - the remaining waterfall.
 */
function augmentApproval(ctx, req, next) {
  let risk
  try {
    risk = req.callId === undefined ? undefined : pendingRisks.get(req.callId)
  } catch {
    risk = undefined
  }
  if (risk && !String(req.reason ?? '').includes(WARNING_MARK)) {
    try {
      req.reason = `${riskReason(risk)}${req.reason ? `\n\n${req.reason}` : ''}`
      req.displayReason = mergeDisplay(req.displayReason, riskDisplay(risk))
    } catch {
      /* a frozen request keeps its original text */
    }
  }
  return next()
}

/**
 * Identify a tool call that would change the live profile.
 * @param ctx - plugin context.
 * @param exec - pending tool execution.
 * @returns the risk labels, or undefined for a safe call.
 */
function assessLiveRisk(ctx, exec) {
  if (exec.name === 'mock_dsh') return undefined
  const args = exec.arguments
  if (!args || typeof args !== 'object') return undefined
  if (exec.name === 'plugin_manager') {
    const action = args.action
    const labels = PLUGIN_ACTION_RISKS[action]
    if (!labels) return undefined
    const target = typeof args.target === 'string' && args.target.length > 0 ? args.target : ''
    return {
      en: `${labels[0]}${target ? ` (${target})` : ''}`,
      zh: `${labels[1]}${target ? `（${target}）` : ''}`,
    }
  }
  const cwd = sessionCwd(ctx, exec)
  if (exec.name === 'write' || exec.name === 'edit') {
    const path = callPath(args.file_path, cwd)
    if (!path || !isLiveProfilePath(path)) return undefined
    const shown = truncate(path, 220)
    return { en: `writes to the live DSH profile file ${shown}`, zh: `写入真实 DSH 的 profile 文件 ${shown}` }
  }
  if (exec.name === 'pwsh' || exec.name === 'bash') return shellRisk(args, cwd)
  return undefined
}

function shellRisk(args, cwd) {
  const command = typeof args.command === 'string' ? args.command : ''
  if (command.length === 0) return undefined
  if (/\.dsh-mock[\\/]/i.test(command)) return undefined
  const labels = ['runs a command that changes the live DSH profile', '运行会修改真实 DSH profile 的命令']
  if (/\bdsh(?:\.cmd)?\s+plugin\b/i.test(command) && !/--help\b/i.test(command)) {
    return { en: labels[0], zh: labels[1] }
  }
  if (/--from-default-profile\b/i.test(command)) return { en: labels[0], zh: labels[1] }
  const workdir = callPath(args.workdir, cwd)
  const targetsProfile = (workdir !== undefined && isLiveProfilePath(workdir)) || mentionsLiveProfile(command)
  if (!targetsProfile) return undefined
  const mutates = /(?:set-content|add-content|clear-content|set-item|new-item|remove-item|move-item|copy-item|rename-item|out-file|>\s*[^=])/i.test(command)
    || /\bpnpm\s+(?:add|remove|install|update|uninstall)\b/i.test(command)
  return mutates ? { en: labels[0], zh: labels[1] } : undefined
}

function liveProfileRoots() {
  const roots = []
  if (process.env.DSH_PROFILE_DIR) roots.push(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles'))
  return [...new Set(roots.filter(Boolean))]
}

function isLiveProfilePath(path) {
  return liveProfileRoots().some((root) => isInside(root, path))
}

function mentionsLiveProfile(command) {
  const normalized = command.replace(/\//g, '\\').toLowerCase()
  if (/\$env:dsh_profile_dir|%dsh_profile_dir%/.test(normalized)) return true
  if (/\$env:dsh_home/.test(normalized) && /profiles/.test(normalized)) return true
  if (/\.dsh[\\/]profiles[\\/]/.test(normalized)) return true
  return liveProfileRoots().some((root) => normalized.includes(root.replace(/\//g, '\\').toLowerCase()))
}

function currentMode(ctx, exec) {
  try {
    const policy = ctx.get('sandboxPolicy')
    if (!policy || typeof policy.resolve !== 'function') return 'danger-full-access'
    const session = exec.agent?.session
    return policy.resolve(session ? { session } : {}).mode ?? 'danger-full-access'
  } catch {
    return 'danger-full-access'
  }
}

function riskReason(risk) {
  return `${WARNING_MARK} This call ${risk.en}. This is the live DSH, not a mock, and the change persists across sessions. Use mock_dsh to test first and ask the user explicitly before changing the live profile.`
}

function riskDisplay(risk) {
  return {
    en: `⚠️ This is the LIVE DSH, not a mock. This call ${risk.en}. It changes the real profile and can break the running DSH. Use mock_dsh to test first; allow only if you intend to change the live environment.`,
    zh: `⚠️ 这是正在使用的真实 DSH，不是 mock。此操作会${risk.zh}，会修改真实 profile，可能损坏当前 DSH。请先用 mock_dsh 在隔离实例中验证；只有确认要修改真实环境时才允许。`,
  }
}

function mergeDisplay(existing, warning) {
  const base = existing && typeof existing === 'object' ? existing : undefined
  return {
    ...(base ?? {}),
    en: base?.en ? `${base.en}\n\n${warning.en}` : warning.en,
    zh: base?.zh ? `${base.zh}\n\n${warning.zh}` : warning.zh,
  }
}

function sessionCwd(ctx, exec) {
  try {
    const session = exec.agent?.session
    if (!session) return undefined
    return ctx.workingDirectory.get(session) ?? session.header?.cwd
  } catch {
    return undefined
  }
}

function callPath(value, cwd) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    return isAbsolute(value) ? resolve(value) : resolve(cwd ?? process.cwd(), value)
  } catch {
    return undefined
  }
}

function pruneRisks() {
  const cutoff = Date.now() - RISK_TTL_MS
  for (const [callId, risk] of pendingRisks) {
    if (risk.at < cutoff) pendingRisks.delete(callId)
  }
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

const REMINDER = `## Mock DSH before experimenting

This running DSH is the user's live environment. Do not test plugins or DSH components against it: do not install unfinished bundles into this profile, edit its config, or exercise half-working plugins here.

Develop and debug against a disposable mock instead. Use the \`mock_dsh\` tool before the first experiment:
- \`start\` creates an isolated DSH with its own home, profile, port, and workspace; open its URL to inspect the UI.
- \`install\` adds the bundle under test, \`restart\` reloads it, and \`run\` executes dsh CLI commands in the mock.
- Mock a component by passing \`patches\` that override its row, or by installing a stub bundle that provides the service.
- \`stop\` ends the mock; \`destroy\` deletes it.

A live-profile guard pauses plugin installs, bundle changes, and profile-file edits with a warning, then asks the user for explicit approval. Do not try to bypass it; deny such a request and use a mock instead.`

/**
 * Register the mock tool, its prompt reminder, and teardown of live mocks.
 * @param ctx - registrant context carrying the tool, prompt, and directory services.
 */
export function apply(ctx) {
  if (!inMockEnvironment()) registerProfileGuard(ctx)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'mock-dsh:development-safety',
    order: 9500,
    interpolate: false,
    text: REMINDER,
  }))

  ctx.effect(() => {
    return async () => {
      const live = [...children.values()]
      children.clear()
      await Promise.all(live.map((child) => killTree(child.pid)))
    }
  })

  ctx.effect(() => ctx.tools.register({
    name: 'mock_dsh',
    description: 'Create and operate an isolated, disposable DSH instance for developing, debugging, or reviewing a plugin or DSH component. The instance has its own DSH home, profile, port, and workspace, so installing or breaking it cannot affect the live DSH. Actions: start (boot and return its URL), restart (reload after a bundle or patch change), install (add a local bundle or package to the mock profile), run (execute a short-lived dsh CLI command inside the mock, for example --dump-config), logs, list, stop, destroy. Mock a component by passing patches that override or disable its row, or by installing a stub bundle that provides the service. Use this instead of experimenting against the live profile.',
    timeoutMs: 360_000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'restart', 'install', 'run', 'logs', 'list', 'stop', 'destroy'],
          description: 'Operation to perform. start boots the instance; restart stops and boots it again with its stored options; install adds a bundle to the mock profile; run executes the given dsh CLI arguments inside the mock; logs returns recent output; list shows instances; stop ends one; destroy stops it and deletes its files.',
        },
        name: {
          type: 'string',
          description: 'Instance name; default dev. Lowercase letters, digits, and hyphens.',
        },
        template: {
          type: 'string',
          description: 'Shipped profile template used when a new mock profile is created; default web.',
        },
        port: {
          type: 'integer',
          description: 'Listen port for a new mock; 0 (default) lets the OS choose one.',
        },
        patches: {
          type: 'array',
          items: { type: 'string' },
          description: 'Loader patch files (absolute or relative to the session workspace) applied to the mock when it starts. Use this to override or disable a component row for the mock.',
        },
        source: {
          type: 'string',
          description: 'install: local bundle directory (absolute or relative to the session workspace) or a package spec.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'run: dsh CLI arguments for a short-lived command, for example ["--profile", "mock", "--dump-config"]; use action "start" to serve a mock instead.',
        },
        lines: {
          type: 'integer',
          description: 'logs: number of trailing lines to return; default 40.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: {
          message: {
            type: 'string',
            description: 'Human-readable result, including paths and URLs the caller needs.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await sessionDirectory(ctx, exec)
      const result = await runAction(args, cwd)
      return { message: result }
    },
  }))
}

/**
 * Resolve the calling Session's directory, which owns the mock tree.
 * @param ctx - plugin context.
 * @param exec - the running tool execution.
 * @returns the absolute session working directory.
 */
async function sessionDirectory(ctx, exec) {
  if (!exec.agent) throw new Error('mock_dsh requires an agent session')
  try {
    return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  } catch (error) {
    throw new Error(`cannot resolve the session working directory: ${error?.message ?? error}`)
  }
}

/**
 * Dispatch one tool action.
 * @param args - validated tool arguments.
 * @param cwd - session working directory.
 * @returns the model-facing result text.
 */
async function runAction(args, cwd) {
  switch (args.action) {
    case 'start':
      return startMock(args, cwd)
    case 'restart':
      return restartMock(args, cwd)
    case 'install':
      return installBundle(args, cwd)
    case 'run':
      return runCommand(args, cwd)
    case 'logs':
      return readLogs(args, cwd)
    case 'list':
      return listInstances(cwd)
    case 'stop':
      return stopMock(args.name ?? DEFAULT_INSTANCE, cwd)
    case 'destroy':
      return destroyMock(args.name ?? DEFAULT_INSTANCE, cwd)
    default:
      throw new Error(`unknown action ${JSON.stringify(args.action)}`)
  }
}

function mockBase(cwd) {
  return join(cwd, MOCK_DIR, 'instances')
}

function instanceRoot(cwd, name) {
  assertName(name)
  return join(mockBase(cwd), name)
}

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('instance name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (max 32 characters)')
  }
}

/**
 * Boot a mock instance and wait for its web URL.
 * @param args - tool arguments (name, template, port, patches).
 * @param cwd - session working directory.
 * @returns a message naming the URL, roots, and next steps.
 */
async function startMock(args, cwd) {
  const name = args.name ?? DEFAULT_INSTANCE
  const root = instanceRoot(cwd, name)
  if (starting.has(name)) throw new Error(`mock DSH "${name}" is already starting`)
  starting.add(name)
  try {
    const existing = await readRecord(root)
    if (existing && isAlive(existing.pid)) {
      return `Mock DSH "${name}" is already running at ${existing.url}. Root: ${existing.root}. Log: ${existing.log}.`
    }

    const records = await readAllRecords(cwd)
    if (!existing && records.length >= MAX_INSTANCES) {
      throw new Error(`refusing to create more than ${MAX_INSTANCES} mock DSH instances; destroy one first (${records.map((r) => r.name).join(', ')})`)
    }

    const template = args.template ?? existing?.template ?? DEFAULT_TEMPLATE
    const port = Number.isInteger(args.port) ? args.port : (existing?.port ?? 0)
    const patches = args.patches === undefined ? (existing?.patches ?? []) : resolvePatches(args.patches, cwd)
    const layout = await ensureLayout(root)
    await ensureProfile(root, layout, template)

    const log = join(layout.logs, 'dsh.log')
    const child = spawnDsh(
      [
        ...patches.flatMap((patch) => ['--patch', patch]),
        '--profile', PROFILE,
        '--port', String(port),
        '--no-open',
      ],
      layout.home,
      layout.workspace,
      log,
    )
    children.set(name, child)

    const url = await waitForUrl(child, log, name)
    const record = {
      name,
      template,
      profile: PROFILE,
      port,
      patches,
      root,
      home: layout.home,
      profileDir: layout.profileDir,
      workspace: layout.workspace,
      log,
      pid: child.pid,
      url,
      status: 'running',
      createdAt: existing?.createdAt ?? now(),
      startedAt: now(),
    }
    await writeRecord(root, record)
    child.once('close', () => {
      children.delete(name)
      markStopped(root).catch(() => {})
    })
    return `Mock DSH "${name}" is running at ${url}\nRoot: ${root}\nProfile: ${PROFILE} (isolated home: ${layout.home})\nInstall a bundle with action "install"; open the URL to inspect the UI.`
  } finally {
    starting.delete(name)
  }
}

/**
 * Stop then boot an instance with its stored options.
 * @param args - tool arguments; only name is required.
 * @param cwd - session working directory.
 */
async function restartMock(args, cwd) {
  const name = args.name ?? DEFAULT_INSTANCE
  const root = instanceRoot(cwd, name)
  const record = await readRecord(root)
  if (!record) throw new Error(`mock DSH "${name}" does not exist; use action "start" first`)
  await stopMock(name, cwd)
  return startMock({
    name,
    template: args.template ?? record.template,
    port: args.port ?? record.port,
    patches: args.patches ?? record.patches,
  }, cwd)
}

/**
 * Install a bundle into the mock profile with the mock's own home.
 * @param args - tool arguments (name, source).
 * @param cwd - session working directory.
 */
async function installBundle(args, cwd) {
  const name = args.name ?? DEFAULT_INSTANCE
  const root = instanceRoot(cwd, name)
  const record = await readRecord(root)
  if (!record) throw new Error(`mock DSH "${name}" does not exist; use action "start" first`)
  if (typeof args.source !== 'string' || args.source.length === 0) {
    throw new Error('install requires "source": a local bundle directory or a package spec')
  }
  const layout = await ensureLayout(root)
  await ensureProfile(root, layout, record.template ?? DEFAULT_TEMPLATE)
  const source = resolveSource(args.source, cwd)
  const log = join(layout.logs, `install-${Date.now()}.log`)
  const result = await runDsh(['plugin', '--profile', PROFILE, 'add', source], {
    home: layout.home,
    cwd: layout.workspace,
    logFile: log,
    timeoutMs: COMMAND_TIMEOUT_MS,
  })
  const running = isAlive(record.pid)
  const status = result.timedOut
    ? `timed out after ${COMMAND_TIMEOUT_MS / 1000}s`
    : result.error
      ? `failed: ${result.error}`
      : `exit ${result.code}`
  const tail = result.output ? `\n--- output tail ---\n${result.output}` : ''
  return `Installed ${source} into mock DSH "${name}" profile "${PROFILE}" (${status}). Log: ${log}${running ? '\nThe mock is running; use action "restart" to load the new bundle.' : ''}${tail}`
}

/**
 * Run a dsh CLI command with the mock's own DSH_HOME.
 * @param args - tool arguments (name, args).
 * @param cwd - session working directory.
 */
async function runCommand(args, cwd) {
  const name = args.name ?? DEFAULT_INSTANCE
  const root = instanceRoot(cwd, name)
  const record = await readRecord(root)
  if (!record) throw new Error(`mock DSH "${name}" does not exist; use action "start" first`)
  if (!Array.isArray(args.args) || args.args.length === 0 || args.args.some((value) => typeof value !== 'string')) {
    throw new Error('run requires "args": a non-empty array of dsh CLI arguments')
  }
  const layout = await ensureLayout(root)
  const log = join(layout.logs, `run-${Date.now()}.log`)
  const result = await runDsh(args.args, {
    home: layout.home,
    cwd: layout.workspace,
    logFile: log,
    timeoutMs: COMMAND_TIMEOUT_MS,
  })
  const status = result.timedOut
    ? `timed out after ${COMMAND_TIMEOUT_MS / 1000}s`
    : result.error
      ? `failed: ${result.error}`
      : `exit ${result.code}`
  const tail = result.output ? `\n--- output tail ---\n${result.output}` : ''
  return `dsh ${args.args.join(' ')}\nMock: ${name} (isolated home: ${layout.home})\nResult: ${status}. Log: ${log}${tail}`
}

/**
 * Return the tail of an instance's boot log.
 * @param args - tool arguments (name, lines).
 * @param cwd - session working directory.
 */
async function readLogs(args, cwd) {
  const name = args.name ?? DEFAULT_INSTANCE
  const root = instanceRoot(cwd, name)
  const record = await readRecord(root)
  if (!record) throw new Error(`mock DSH "${name}" does not exist`)
  const count = Number.isInteger(args.lines) ? Math.min(Math.max(args.lines, 1), 400) : 40
  const text = await readFile(record.log, 'utf8').catch(() => '')
  if (text.length === 0) return `Mock DSH "${name}" has no log output yet (${record.log}).`
  const all = text.split(/\r?\n/)
  while (all.length > 0 && all[all.length - 1] === '') all.pop()
  const tail = all.slice(-count).join('\n')
  return `Mock DSH "${name}" log (${record.log}), last ${Math.min(count, all.length)} lines:\n${tail}`
}

/**
 * List every recorded instance with its current liveness.
 * @param cwd - session working directory.
 */
async function listInstances(cwd) {
  const records = await readAllRecords(cwd)
  if (records.length === 0) return `No mock DSH instances under ${mockBase(cwd)}.`
  const lines = records.map((record) => {
    const running = isAlive(record.pid)
    const state = record.status === 'running' && !running ? 'stopped (process gone)' : record.status
    const where = running ? `pid ${record.pid}, ${record.url}` : record.root
    return `- ${record.name}: ${state}; ${where}`
  })
  return `Mock DSH instances under ${mockBase(cwd)}:\n${lines.join('\n')}`
}

/**
 * Stop one instance if it is live.
 * @param name - instance name.
 * @param cwd - session working directory.
 */
async function stopMock(name, cwd) {
  const root = instanceRoot(cwd, name)
  const record = await readRecord(root)
  const child = children.get(name)
  let pid
  if (child && isAlive(child.pid)) {
    pid = child.pid
    await killTree(pid)
    children.delete(name)
  } else if (record && isAlive(record.pid)) {
    pid = record.pid
    if (!(await looksLikeMock(pid))) {
      throw new Error(`refusing to stop PID ${pid}: it no longer looks like the mock DSH process; check it manually`)
    }
    await killTree(pid)
  }
  if (pid && !(await waitForExit(pid))) {
    throw new Error(`mock DSH "${name}" is still running as PID ${pid}; stop it manually`)
  }
  await markStopped(root)
  if (!record) return `No mock DSH named "${name}" exists.`
  return `Stopped mock DSH "${name}". Its files remain under ${root}; use action "destroy" to delete them.`
}

/**
 * Stop an instance and delete its isolated tree.
 * @param name - instance name.
 * @param cwd - session working directory.
 */
async function destroyMock(name, cwd) {
  const root = instanceRoot(cwd, name)
  const base = mockBase(cwd)
  const record = await readRecord(root)
  if (!record) return `No mock DSH named "${name}" exists.`
  await stopMock(name, cwd)
  if (!isInside(base, root) || resolve(root) === resolve(base)) {
    throw new Error(`refusing to delete ${root}: it is not an instance directory`)
  }
  await rm(root, { recursive: true, force: true })
  return `Destroyed mock DSH "${name}" and deleted ${root}.`
}

/**
 * Create the isolated home, workspace, and log directories.
 * @param root - instance directory.
 */
async function ensureLayout(root) {
  const layout = {
    home: join(root, 'home'),
    workspace: join(root, 'workspace'),
    logs: join(root, 'logs'),
    profileDir: join(root, 'home', 'profiles', PROFILE),
  }
  await Promise.all([
    mkdir(layout.home, { recursive: true }),
    mkdir(layout.workspace, { recursive: true }),
    mkdir(layout.logs, { recursive: true }),
  ])
  return layout
}

/**
 * Create the mock profile from a shipped template the first time it is needed.
 * @param root - instance directory.
 * @param layout - instance layout.
 * @param template - shipped profile template name.
 */
async function ensureProfile(root, layout, template) {
  if (existsSync(join(layout.profileDir, 'package.json'))) return
  const log = join(layout.logs, 'profile-init.log')
  const result = await runDsh(
    ['--profile', PROFILE, '--from-default-profile', template, '--dump-config'],
    { home: layout.home, cwd: layout.workspace, logFile: log, timeoutMs: START_TIMEOUT_MS },
  )
  if (result.timedOut || result.error || result.code !== 0) {
    const reason = result.timedOut
      ? `timed out after ${START_TIMEOUT_MS / 1000}s`
      : result.error ?? `exit ${result.code}`
    throw new Error(`cannot create the mock profile from template "${template}" (${reason}). Log: ${log}\n${result.output}`)
  }
}

/**
 * Resolve and validate patch files supplied for the mock.
 * @param patches - absolute or workspace-relative file paths.
 * @param cwd - session working directory.
 */
function resolvePatches(patches, cwd) {
  if (!Array.isArray(patches) || patches.some((value) => typeof value !== 'string')) {
    throw new Error('patches must be an array of file paths')
  }
  return patches.map((patch) => {
    const path = isAbsolute(patch) ? patch : resolve(cwd, patch)
    if (!existsSync(path)) throw new Error(`patch file not found: ${path}`)
    return path
  })
}

/**
 * Resolve an install source to a local path or pass a package spec through.
 * @param source - tool argument.
 * @param cwd - session working directory.
 */
function resolveSource(source, cwd) {
  const path = isAbsolute(source) ? source : resolve(cwd, source)
  if (isAbsolute(source) || source.startsWith('.')) {
    if (!existsSync(path)) throw new Error(`bundle directory not found: ${path}`)
    return path
  }
  if (existsSync(path)) return path
  return source
}

/**
 * Read one instance record.
 * @param root - instance directory.
 */
async function readRecord(root) {
  try {
    return JSON.parse(await readFile(join(root, 'record.json'), 'utf8'))
  } catch {
    return undefined
  }
}

async function writeRecord(root, record) {
  await writeFile(join(root, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

async function markStopped(root) {
  const record = await readRecord(root)
  if (!record || record.status === 'stopped') return
  record.status = 'stopped'
  record.pid = null
  record.url = undefined
  record.stoppedAt = now()
  await writeRecord(root, record).catch(() => {})
}

async function readAllRecords(cwd) {
  const base = mockBase(cwd)
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const records = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const record = await readRecord(join(base, entry.name))
    if (record) records.push(record)
  }
  return records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

/**
 * Locate the packaged dsh CLI launcher, falling back to ``dsh`` on PATH.
 * @returns spawn command, leading arguments, and whether a shell is required.
 */
function launchSpec() {
  const executable = process.execPath
  const resources = process.resourcesPath ?? join(dirname(executable), 'resources')
  const cli = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  if (existsSync(cli)) return { command: executable, prefix: ['--expose-internals', cli], shell: false }
  const override = process.env.DSH_CLI
  if (override && existsSync(override)) return { command: executable, prefix: ['--expose-internals', override], shell: false }
  return { command: 'dsh', prefix: [], shell: true }
}

/**
 * Build the environment that pins a child to the mock home and profile.
 * @param home - mock DSH_HOME.
 */
function mockEnv(home) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  delete env.DSH_WEB_URL
  delete env.DSH_SHELL
  delete env.DSH_PROFILE
  delete env.DSH_PROFILE_DIR
  env.DSH_HOME = home
  env.DSH_PROFILE = PROFILE
  env.DSH_PROFILE_DIR = join(home, 'profiles', PROFILE)
  const instance = /[\\/]\.dsh-mock[\\/]instances[\\/]([^\\/]+)[\\/]home$/i.exec(home)
  if (instance) env.DSH_MOCK_INSTANCE = instance[1]
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function spawnDsh(args, home, cwd, logFile) {
  const spec = launchSpec()
  const child = spawn(spec.command, [...spec.prefix, ...args], {
    cwd,
    env: mockEnv(home),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: spec.shell,
  })
  const stream = createWriteStream(logFile, { flags: 'a' })
  stream.on('error', () => {})
  const write = (chunk) => stream.write(chunk)
  child.stdout?.on('data', write)
  child.stderr?.on('data', write)
  child.once('error', () => stream.end())
  child.once('close', () => stream.end())
  return child
}

/**
 * Wait until the mock web server prints its URL.
 * @param child - spawned mock process.
 * @param logFile - where its output is appended.
 * @param label - instance name for messages.
 */
function waitForUrl(child, logFile, label) {
  return new Promise((resolveUrl, rejectUrl) => {
    let buffer = ''
    let settled = false
    let timer
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const inspect = (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-65_536)
      const match = buffer.match(URL_RE)
      if (match) settle(resolveUrl, match[0])
    }
    child.stdout?.on('data', inspect)
    child.stderr?.on('data', inspect)
    timer = setTimeout(() => {
      killTree(child.pid)
        .catch(() => {})
        .finally(() => settle(rejectUrl, new Error(`mock DSH "${label}" did not become ready within ${START_TIMEOUT_MS / 1000}s. Log: ${logFile}\n${tail(buffer)}`)))
    }, START_TIMEOUT_MS)
    child.once('exit', (code, signal) => {
      settle(rejectUrl, new Error(`mock DSH "${label}" exited before it was ready (${signal ?? `code ${code}`}). Log: ${logFile}\n${tail(buffer)}`))
    })
    child.once('error', (error) => {
      settle(rejectUrl, new Error(`cannot start mock DSH "${label}": ${error.message}. Log: ${logFile}`))
    })
  })
}

/**
 * Run a short-lived dsh command pinned to the mock home.
 * @param args - CLI arguments.
 * @param options - home, cwd, log, and timeout.
 */
async function runDsh(args, options) {
  const child = spawnDsh(args, options.home, options.cwd, options.logFile)
  let buffer = ''
  const append = (chunk) => {
    buffer = (buffer + chunk.toString()).slice(-200_000)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return new Promise((resolveRun) => {
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ ...result, output: tail(buffer) })
    }
    timer = setTimeout(() => {
      killTree(child.pid)
        .catch(() => {})
        .finally(() => finish({ code: null, signal: null, timedOut: true }))
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    child.once('error', (error) => finish({ code: null, signal: null, timedOut: false, error: error.message }))
    child.once('close', (code, signal) => finish({ code, signal, timedOut: false }))
  })
}

/**
 * Terminate a process and its children.
 * @param pid - process id.
 */
async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('close', () => resolveKill())
      killer.once('error', () => resolveKill())
    })
    if (!isAlive(pid)) return
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
  if (!isAlive(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Confirm a recorded PID still refers to a DSH mock process before killing it.
 * @param pid - process id.
 */
async function looksLikeMock(pid) {
  if (process.platform !== 'win32') return true
  return new Promise((resolveCheck) => {
    let output = ''
    const lister = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    lister.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    const done = () => resolveCheck(/DeepSeek Harness\.exe|node\.exe|cmd\.exe/i.test(output))
    lister.once('close', done)
    lister.once('error', () => resolveCheck(false))
  })
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Wait briefly for a terminated process to disappear.
 * @param pid - process id.
 * @param timeoutMs - maximum wait.
 * @returns whether the process is gone.
 */
async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  return !isAlive(pid)
}

function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

function tail(text, max = MAX_TAIL) {
  if (!text) return ''
  return text.length <= max ? text : `…${text.slice(-max)}`
}
