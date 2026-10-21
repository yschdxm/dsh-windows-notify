/**
 * Pure formatting helpers for dsh-windows-notify.
 *
 * Everything here is side-effect free so `test/smoke.mjs` can exercise it
 * without a Host: config resolution, subagent classification, and the Chinese
 * toast copy for every terminal turn reason and interactive request.
 */

export const DEFAULTS = {
  /** AppUserModelID of the installed desktop app; keeps the app's own icon and name. */
  appId: 'com.deepseek.dsh',
  /** Mute the toast sound. */
  silent: false,
  /** Notify when a user-visible conversation turn ends. */
  notifyTurnEnd: true,
  /** Notify when a subagent/teammate session turn ends. */
  notifySubagentTurns: false,
  /** Notify on turn errors and session-level failures. */
  notifyErrors: true,
  /** Notify when an approval waits for the user. */
  notifyApproval: true,
  /** Notify when a session asks the user a structured question. */
  notifyQuestions: true,
  /** Notify when the account needs a sign-in. */
  notifySignIn: true,
  /** Upper bound for the toast body. */
  maxBodyChars: 260,
  /** Make toasts clickable: focus the desktop app and jump to the session. */
  openOnClick: true,
  /** CSIDL protocol registered for toast clicks. */
  protocol: 'dshfocus',
  /** Append JSON diagnostics under %TEMP%\dsh-windows-notify. */
  log: true,
  /** Log every observed session event. */
  debug: false,
}

const ABORT_TEXT = {
  user: '任务已被你停止',
  parent: '任务已随父会话停止',
  disposed: '会话已关闭',
  legacy: '任务已中止',
}

/** Collapse whitespace and cut a string to `max` characters. */
export function clamp(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Read one boolean toggle, treating a non-boolean value as the default. */
export function toggle(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Merge the row config over the defaults, ignoring unknown or invalid values. */
export function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const resolved = { ...DEFAULTS }
  if (typeof config.appId === 'string' && config.appId.trim()) {
    resolved.appId = config.appId.trim()
  }
  if (typeof config.protocol === 'string' && /^[a-z][a-z0-9+.-]*$/.test(config.protocol)) {
    resolved.protocol = config.protocol
  }
  resolved.silent = toggle(config.silent, DEFAULTS.silent)
  for (const key of [
    'notifyTurnEnd',
    'notifySubagentTurns',
    'notifyErrors',
    'notifyApproval',
    'notifyQuestions',
    'notifySignIn',
    'openOnClick',
    'log',
    'debug',
  ]) {
    resolved[key] = toggle(config[key], DEFAULTS[key])
  }
  const maxBody = Number(config.maxBodyChars)
  if (Number.isFinite(maxBody) && maxBody >= 40) {
    resolved.maxBodyChars = Math.min(500, Math.floor(maxBody))
  }
  return resolved
}

/**
 * True for subagent/teammate sessions.
 *
 * `parentSession` alone is not a subagent marker: a forked top-level
 * conversation also carries it while `origin` stays empty. The Harness marks
 * real child sessions with `origin: 'subagent'` and/or a non-zero
 * `delegationDepth`; restored main sessions carry `delegationDepth: 0`.
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  return (header.delegationDepth ?? 0) > 0
}

/** User-facing sentence for one durable `turn/end` reason. */
export function describeTurnEnd(reason, goal) {
  switch (reason?.kind) {
    case 'completed':
      return goal?.phase === 'complete' ? '目标已完成' : '会话任务已完成'
    case 'error':
      return `任务出错：${clamp(reason?.error?.message ?? '未知错误', 160)}`
    case 'aborted': {
      const cause = reason?.reason
      if (cause?.kind === 'hook' && cause.reason) {
        return `任务被中止：${clamp(cause.reason, 120)}`
      }
      return ABORT_TEXT[cause?.kind] ?? '任务已中止'
    }
    case 'blocked':
      return goal?.blockedReason?.message
        ? `任务受阻：${clamp(goal.blockedReason.message, 160)}`
        : '任务已阻断，等待处理'
    case 'max-tokens':
      return '达到输出上限，任务暂停'
    case 'interrupted':
      return '任务被打断'
    case 'forked':
      return undefined
    default:
      return '会话任务已结束'
  }
}

/** Title and body for one approval request. */
export function describeApproval(request, sessionTitle) {
  const reason = request?.displayReason?.zh
    ?? request?.displayReason?.en
    ?? request?.reason
  const detail = reason
    ? clamp(reason, 200)
    : request?.toolName
      ? `工具 ${clamp(request.toolName, 60)} 需要你的批准`
      : '有操作等待你的确认'
  return {
    title: '需要你确认',
    body: sessionTitle ? `${sessionTitle} · ${detail}` : detail,
  }
}

/** Title and body for one structured question request. */
export function describeQuestions(request, sessionTitle) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions[0]
  const text = clamp(first?.question || first?.header || '', 200)
  const suffix = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
  const detail = text ? `${text}${suffix}` : '有一个问题等待你的回答'
  const planReview = first?.intent?.kind === 'plan-review'
  return {
    title: planReview ? '计划待确认' : '需要你回答',
    body: sessionTitle ? `${sessionTitle} · ${detail}` : detail,
  }
}
