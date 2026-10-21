/**
 * dsh-windows-notify — host half.
 *
 * Native Windows toasts (Windows PowerShell 5.1 + WinRT) for finished turns,
 * approvals, questions, sign-in prompts, and session-level failures.
 *
 * Clicking a toast focuses the desktop app AND jumps to the conversation:
 *   1. toast activation runs launcher.ps1 through a per-user protocol;
 *   2. launcher.ps1 GETs this plugin's `/focus` route and starts `dsh://open`;
 *   3. the client half (client.js) polls `/pending` and calls
 *      `uiWorkspace.openSession()` inside the app.
 *
 * Every notification is verified: toast.ps1 prints `toast shown` only after
 * `Show()` returns, and failures are logged to `%TEMP%\dsh-windows-notify`.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clamp,
  describeApproval,
  describeQuestions,
  describeTurnEnd,
  isSubagentSession,
  resolveConfig,
} from './format.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOAST_SCRIPT = join(HERE, 'toast.ps1')
const LAUNCHER_SCRIPT = join(HERE, 'launcher.ps1')
const POWERSHELL = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'
const SUPPORTED = process.platform === 'win32'
const ROUTE_BASE = '/plugins/dsh-windows-notify'
const LOG_DIR = join(tmpdir(), 'dsh-windows-notify')
const PENDING_TTL_MS = 5 * 60 * 1000
const MAX_PENDING = 8
const MAX_TITLE_CHARS = 90
const DEDUPE_MS = 2000
const VERSION = '2.0.0'

export const name = 'dsh-windows-notify'

/** Append one JSON line to %TEMP%\dsh-windows-notify\notify.log. */
function createLogger(config) {
  return (entry) => {
    if (!config.log) return
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      appendFileSync(join(LOG_DIR, 'notify.log'), `${JSON.stringify({ time: Date.now(), ...entry })}\n`)
    } catch {
      /* diagnostics must never break the notification path */
    }
  }
}

/** The bound web-server port, or undefined before the listener binds. */
function resolvePort(ctx) {
  try {
    const webServer = ctx.get('webServer')
    if (!webServer) return undefined
    if (Number.isInteger(webServer.port) && webServer.port > 0) return webServer.port
    const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined
    if (origin) {
      const parsed = new URL(origin)
      if (parsed.port) return Number(parsed.port)
    }
  } catch {
    /* optional service */
  }
  return undefined
}

/** Accept only connections that originated on this machine. */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function sendText(res, status, text) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(text)
}

/** Content-free focus URL handed to launcher.ps1 through the protocol. */
function focusUrl(port, token, sessionId) {
  const suffix = sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''
  return `http://127.0.0.1:${port}${ROUTE_BASE}/focus?t=${encodeURIComponent(token)}${suffix}`
}

/** Routes polled by the client half and called by launcher.ps1. */
function createRoutes(state) {
  const { config, log, pending, token } = state
  const trim = () => {
    const cutoff = Date.now() - PENDING_TTL_MS
    while (pending.length > 0 && pending[0].at < cutoff) pending.shift()
    while (pending.length > MAX_PENDING) pending.shift()
  }

  return [
    {
      path: `${ROUTE_BASE}/focus`,
      handler: (req, res) => {
        if (!isLoopback(req)) return sendText(res, 403, 'loopback only')
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.searchParams.get('t') !== token) return sendText(res, 403, 'bad token')
        const sessionId = url.searchParams.get('session') ?? ''
        if (sessionId && !/^[A-Za-z0-9._:-]{1,120}$/.test(sessionId)) return sendText(res, 400, 'bad session')
        log({ event: 'focus-request', sessionId: sessionId || null })
        if (sessionId) {
          pending.push({ sessionId, at: Date.now() })
          trim()
        }
        sendText(res, 200, 'ok')
      },
    },
    {
      path: `${ROUTE_BASE}/pending`,
      handler: (req, res) => {
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
        trim()
        const next = pending.shift()
        sendJson(res, 200, next ? { sessionId: next.sessionId } : {})
      },
    },
    {
      path: `${ROUTE_BASE}/ack`,
      handler: (req, res) => {
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        log({ event: 'focus-consumed', sessionId: url.searchParams.get('session') ?? null })
        sendJson(res, 200, { ok: true })
      },
    },
    {
      path: `${ROUTE_BASE}/health`,
      handler: (req, res) => {
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
        sendJson(res, 200, {
          version: VERSION,
          channelOk: state.channelOk,
          clickable: state.clickable,
          port: state.getPort() ?? null,
          pending: pending.length,
          powerShell: POWERSHELL,
          protocol: config.protocol,
        })
      },
    },
  ]
}

/** Raise one toast and verify that it was actually shown. */
function spawnToast(config, log, payload) {
  const port = payload.port
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', TOAST_SCRIPT,
    '-AppId', config.appId,
    '-Protocol', config.protocol,
    '-Title', clamp(payload.title, MAX_TITLE_CHARS),
    '-Body', clamp(payload.body, config.maxBodyChars),
  ]
  const clickable = config.openOnClick && Number.isInteger(port) && port > 0
  if (clickable) args.push('-Url', focusUrl(port, payload.token, payload.sessionId))
  if (config.silent) args.push('-Silent')

  let stdout = ''
  let stderr = ''
  try {
    const child = spawn(POWERSHELL, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // NOT `detached`: a DETACHED_PROCESS console host turns WinRT
      // ToastNotificationManager.Show() into a silent no-op (verified on
      // Windows 11 26100).
      detached: false,
    })
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      log({ event: 'spawn-error', message: String(error?.message ?? error) })
      console.error('[windows-notify] toast process failed:', error?.message ?? error)
    })
    child.on('exit', (code) => {
      const shown = /toast shown/.test(stdout)
      if (shown && code === 0) {
        if (config.debug) log({ event: 'toast-shown', title: clamp(payload.title, 40), sessionId: payload.sessionId ?? null })
        return
      }
      log({
        event: 'toast-failed',
        code,
        shown,
        title: clamp(payload.title, 40),
        sessionId: payload.sessionId ?? null,
        stderr: stderr.slice(0, 400),
      })
      console.error(`[windows-notify] toast not shown (exit ${code}): ${stderr.slice(0, 300)}`)
    })
  } catch (error) {
    log({ event: 'toast-failed', message: String(error?.message ?? error) })
    console.error('[windows-notify] toast spawn failed:', error?.message ?? error)
  }
}

function sessionOf(ctx, sessionId) {
  try {
    return ctx.get('sessions')?.get(sessionId)
  } catch {
    return undefined
  }
}

function agentOf(ctx, sessionId) {
  try {
    return ctx.get('agents')?.get(sessionId)
  } catch {
    return undefined
  }
}

function sessionTitleOf(ctx, session) {
  try {
    const title = ctx.get('sessionTitle')?.get(session)?.title
    if (typeof title === 'string' && title.trim()) return title.trim()
  } catch {
    /* optional service */
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string') {
    const name = cwd.split(/[\\/]+/).filter(Boolean).pop()
    if (name) return name
  }
  return 'DeepSeek Harness'
}

function goalOf(ctx, session) {
  const agent = agentOf(ctx, session?.id)
  if (!agent) return undefined
  try {
    return ctx.get('goals')?.get(agent)
  } catch {
    return undefined
  }
}

/** Wire `session/event` turn ends. */
function handleTurnEnd(ctx, config, session, event, notify) {
  const reason = event?.data?.reason
  const isRoot = !isSubagentSession(session)
  if (!isRoot && !config.notifySubagentTurns) return
  const goal = goalOf(ctx, session)
  const continuing = goal?.phase === 'active' && goal?.activation === 'armed'
  if (isRoot && reason?.kind !== 'error' && continuing) return
  if (reason?.kind === 'error' && !config.notifyErrors) return
  if (reason?.kind !== 'error' && isRoot && !config.notifyTurnEnd) return
  const body = describeTurnEnd(reason, goal)
  if (!body) return
  notify({
    title: sessionTitleOf(ctx, session),
    body,
    sessionId: session?.id,
    key: `${session?.id}:${reason?.kind}`,
  })
}

/** Register every listener and route on the plugin fiber. */
export function apply(ctx, rawConfig) {
  if (!SUPPORTED) {
    console.error('[windows-notify] inactive: Windows toast notifications need win32')
    return
  }
  const config = resolveConfig(rawConfig)
  const token = typeof rawConfig?.token === 'string' && rawConfig.token ? rawConfig.token : randomUUID()
  const log = createLogger(config)
  const pending = []
  const recent = new Map()
  const state = {
    config,
    token,
    pending,
    log,
    channelOk: false,
    clickable: false,
    getPort: () => resolvePort(ctx),
  }

  const webServer = ctx.get('webServer')
  if (webServer?.register) {
    for (const route of createRoutes(state)) {
      const dispose = webServer.register({ kind: 'exact', path: route.path, handler: route.handler })
      ctx.effect(() => dispose)
    }
    state.clickable = true
  } else {
    log({ event: 'routes-unavailable' })
  }

  state.channelOk = existsSync(TOAST_SCRIPT)
    && existsSync(LAUNCHER_SCRIPT)
    && (POWERSHELL === 'powershell.exe' || existsSync(POWERSHELL))
  let clientBundle = null
  let graphKeys = null
  try {
    const clientModules = ctx.get('clientModules')
    clientBundle = clientModules?.clientPath?.('@yschdxm/dsh-windows-notify') ?? null
    const graph = clientModules?.graph?.()
    graphKeys = graph && typeof graph === 'object' ? Object.keys(graph) : null
  } catch (error) {
    clientBundle = `error: ${error?.message ?? error}`
  }
  log({
    event: 'start',
    version: VERSION,
    channelOk: state.channelOk,
    clickable: state.clickable,
    port: state.getPort() ?? null,
    powerShell: POWERSHELL,
    protocol: config.protocol,
    clientBundle,
    graphKeys,
  })
  if (!state.channelOk) {
    console.error('[windows-notify] notification channel unavailable: toast.ps1, launcher.ps1, or powershell.exe is missing')
    ctx.logger?.warn?.('[windows-notify] notification channel unavailable; desktop toasts will not be sent')
  }

  const notify = ({ title, body, sessionId, key }) => {
    const now = Date.now()
    if (key) {
      const last = recent.get(key) ?? 0
      if (now - last < DEDUPE_MS) return
      recent.set(key, now)
      for (const [staleKey, at] of recent) {
        if (now - at > 120000) recent.delete(staleKey)
      }
    }
    spawnToast(config, log, { title, body, sessionId, token, port: state.getPort() })
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (config.debug) log({ event: 'session-event', type: event?.type, sessionId: session?.id })
      if (event?.type !== 'turn/end') return
      handleTurnEnd(ctx, config, session, event, notify)
    } catch (error) {
      log({ event: 'turn-end-error', message: String(error?.message ?? error) })
      console.error('[windows-notify] turn-end notification failed:', error?.message ?? error)
    }
  })

  ctx.on('approval/request', (request, next) => {
    try {
      if (config.notifyApproval) {
        const session = sessionOf(ctx, request?.agent?.id)
        const { title, body } = describeApproval(request, session ? sessionTitleOf(ctx, session) : undefined)
        notify({ title, body, sessionId: request?.agent?.id, key: `approval:${request?.agent?.id ?? 'unknown'}` })
      }
    } catch (error) {
      console.error('[windows-notify] approval notification failed:', error?.message ?? error)
    }
    return next()
  })

  ctx.on('user-questions/request', (request, next) => {
    try {
      if (config.notifyQuestions) {
        const session = sessionOf(ctx, request?.agent?.id)
        const { title, body } = describeQuestions(request, session ? sessionTitleOf(ctx, session) : undefined)
        notify({ title, body, sessionId: request?.agent?.id, key: `question:${request?.agent?.id ?? 'unknown'}` })
      }
    } catch (error) {
      console.error('[windows-notify] question notification failed:', error?.message ?? error)
    }
    return next()
  })

  ctx.on('deepseek-account/model-sign-in-required', () => {
    if (!config.notifySignIn) return
    notify({ title: '需要登录', body: '账号模型请求需要你先登录', key: 'sign-in' })
  })

  ctx.on('deepseek-account/session-expired', () => {
    if (!config.notifySignIn) return
    notify({ title: '登录已过期', body: '账号登录已失效，请重新登录', key: 'session-expired' })
  })

  ctx.on('api-session/error', (sessionId, message) => {
    if (!config.notifyErrors) return
    const session = sessionOf(ctx, sessionId)
    notify({
      title: session ? sessionTitleOf(ctx, session) : 'DeepSeek Harness',
      body: `会话出错：${clamp(message ?? '未知错误', 200)}`,
      sessionId,
      key: `${sessionId}:agent-error`,
    })
  })
}
