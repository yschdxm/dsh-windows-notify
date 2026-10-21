/**
 * Smoke test for dsh-windows-notify (host half + pure helpers).
 *
 * Runs outside the Harness with a fake Cordis context and a fake web server:
 * routes and listeners are exercised for real, and one actual Windows toast is
 * spawned (clickable, pointing at the fake port). Nothing is mocked inside the
 * plugin itself.
 *
 * Usage: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { describeTurnEnd, isSubagentSession } from '../format.js'

const BASE = '/plugins/dsh-windows-notify'
const listeners = new Map()
const services = new Map()
const routes = new Map()

const ctx = {
  on(name, listener) {
    listeners.set(name, listener)
    return () => listeners.delete(name)
  },
  get(name) {
    return services.get(name)
  },
  effect(setup) {
    const dispose = setup()
    return () => dispose?.()
  },
  logger: { warn() {} },
}

services.set('webServer', {
  port: 7094,
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
})

apply(ctx, { token: 'test-token', log: false })

assert.equal(routes.size, 4, 'four plugin routes register')

// --- pure helpers ---------------------------------------------------------
assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
assert.equal(isSubagentSession({ header: { delegationDepth: 2 } }), true)
assert.equal(isSubagentSession({ header: { parentSession: 'parent' } }), false, 'forked root stays root')
assert.equal(describeTurnEnd({ kind: 'completed' }), '会话任务已完成')
assert.equal(describeTurnEnd({ kind: 'completed' }, { phase: 'complete' }), '目标已完成')
assert.equal(
  describeTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }),
  '任务已被你停止',
)
assert.equal(
  describeTurnEnd({ kind: 'error', error: { message: '模型不可用' } }),
  '任务出错：模型不可用',
)

// --- HTTP routes ----------------------------------------------------------
const makeRes = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(name, value) { this.headers[name] = value },
  end(body = '') { this.body = String(body) },
})
const makeReq = (url) => ({ socket: { remoteAddress: '127.0.0.1' }, url, method: 'GET' })
const call = (url) => {
  const path = url.split('?')[0]
  const handler = routes.get(path)
  assert.ok(handler, `missing route ${path}`)
  const res = makeRes()
  handler(makeReq(url), res)
  return res
}

assert.equal(call(`${BASE}/focus?t=wrong&session=abc`).statusCode, 403, 'token is enforced')
assert.equal(call(`${BASE}/focus?t=test-token&session=abc`).statusCode, 200)
assert.deepEqual(JSON.parse(call(`${BASE}/pending`).body), { sessionId: 'abc' })
assert.deepEqual(JSON.parse(call(`${BASE}/pending`).body), {}, 'pending is consumed once')
assert.equal(JSON.parse(call(`${BASE}/ack?session=abc`).body).ok, true)

const health = JSON.parse(call(`${BASE}/health`).body)
assert.equal(health.channelOk, true, 'toast.ps1 + launcher.ps1 + powershell are present')
assert.equal(health.clickable, true)
assert.equal(health.port, 7094)
assert.equal(health.protocol, 'dshfocus')

// --- listeners ------------------------------------------------------------
const session = { id: 'session-root', header: { cwd: 'F:\\dev\\StoryForge' } }
services.set('sessions', { get: (id) => (id === 'session-root' ? session : undefined) })
services.set('agents', { get: () => undefined })
services.set('sessionTitle', { get: () => ({ title: '通知插件' }) })

const sessionEvent = listeners.get('session/event')
assert.ok(sessionEvent)

// Root completion: one real (clickable) toast.
sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

// Subagent completion: muted by default.
sessionEvent({ id: 'child', header: { origin: 'subagent', delegationDepth: 1 } }, {
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
})

// Armed goal rounds are quiet.
services.set('goals', { get: () => ({ phase: 'active', activation: 'armed' }) })
sessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
services.delete('goals')

// Waterfall listeners must keep delegating to next().
for (const [name, extra] of [
  ['approval/request', { agent: { id: 'session-root' }, toolName: 'write_text', reason: '写入文件' }],
  ['user-questions/request', { agent: { id: 'session-root' }, questions: [{ question: '选哪个？' }] }],
]) {
  let nextCalls = 0
  const result = listeners.get(name)(extra, () => {
    nextCalls += 1
    return Promise.resolve('delegated')
  })
  assert.equal(nextCalls, 1, `${name} calls next() once`)
  assert.ok(result instanceof Promise, `${name} returns the delegated promise`)
}

// Give the spawned toast process time to finish before this process exits.
await new Promise((resolve) => setTimeout(resolve, 3500))

console.log('smoke ok: routes, helpers, and listeners exercised')
console.log('expected real toasts: 3 (turn-end, approval, question)')
