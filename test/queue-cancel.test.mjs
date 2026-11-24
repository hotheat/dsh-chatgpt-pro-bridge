import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cancellationError } from '../driver.js'

const sessionReason = '已取消：DSH 会话已停止'
const manualReason = '已取消：在借阅台手动停止'
const tick = () => new Promise(setImmediate)

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cancel-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const calls = []
  let stopCalls = 0
  let stopError
  const fakeDriver = {
    connected: async () => false,
    async stop() { stopCalls += 1; if (stopError) throw stopError; return true },
    handoff(options) {
      const result = Promise.withResolvers()
      calls.push({ ...options, ...result })
      options.signal.addEventListener('abort', () => result.reject(cancellationError(options.signal)), { once: true })
      return result.promise
    },
  }
  // Replace only this index module's driver import; all queue and persistence code is real.
  const indexUrl = new URL(`../index.js?fixture=${dir}`, import.meta.url).href
  const driverUrl = new URL('../driver.js', import.meta.url).href
  const key = `bridge-driver-${dir}`
  globalThis[key] = fakeDriver
  const source = `export { cancellationError } from ${JSON.stringify(driverUrl)}; export const createDriver = () => globalThis[${JSON.stringify(key)}]`
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './driver.js' && context.parentURL === indexUrl) {
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
  t.after(async () => {
    for (const call of calls) call.reject(new Error('test cleanup'))
    await tick()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    delete globalThis[key]
    rmSync(dir, { recursive: true, force: true })
  })
  let apply
  try { ({ apply } = await import(indexUrl)) } finally { hooks.deregister() }
  const tools = new Map()
  let route
  const ctx = {
    effect: (run) => run(),
    get: () => undefined,
    tools: { register: (tool) => tools.set(tool.name, tool) },
    inject(deps, run) {
      if (deps.includes('webServer')) run({
        effect: (effect) => effect(),
        webServer: { register: (entry) => { route = entry.handler } },
      })
    },
  }
  apply(ctx, { project: 'test', roots: [] })
  delete globalThis[key]
  return {
    calls,
    get stopCalls() { return stopCalls },
    failStop() { stopError = new Error('停止失败') },
    handoff: (signal) => tools.get('chatgpt_bridge_handoff').execute({ task: '测试' }, { signal }),
    render: (value) => tools.get('chatgpt_bridge_handoff').output.render({}, value)[0].text,
    stop: () => tools.get('chatgpt_bridge_browser').execute({ action: 'stop' }),
    status: () => tools.get('chatgpt_bridge_status').execute(),
    saved: () => JSON.parse(readFileSync(join(dir, 'chatgpt-pro-bridge/state.json'), 'utf8')),
    async postStop() {
      let code, body
      await route({ method: 'POST', url: '/api/chatgpt-bridge/delegation/stop', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {
        writeHead(status) { code = status },
        end(value) { body = JSON.parse(value) },
      })
      return { code, body }
    },
  }
}

test('an already aborted handoff rejects without waiting for the active queue', async (t) => {
  const f = await fixture(t)
  const running = f.handoff()
  await tick()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await f.handoff(AbortSignal.abort('upstream reason')), { ok: false, error: sessionReason, cancelled: true })
  assert.equal(f.saved().delegations.length, 1)
  assert.equal(f.calls.length, 1)
  await f.stop()
  await running
})

test('an aborted queued turn creates no record and never touches the driver', async (t) => {
  const f = await fixture(t)
  const running = f.handoff()
  await tick()
  const controller = new AbortController()
  const queued = f.handoff(controller.signal)
  await tick()
  controller.abort()
  f.calls[0].resolve({ answer: '完成', url: '', characters: 2, complete: true })
  assert.equal((await running).ok, true)
  assert.deepEqual(await queued, { ok: false, error: sessionReason, cancelled: true })
  assert.equal(f.calls.length, 1)
  assert.equal(f.saved().delegations.length, 1)
  assert.equal(f.saved().nextDelegation, 2)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('DSH cancellation finishes the record, removes its listener and releases the queue', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const running = f.handoff(controller.signal)
  await tick()
  const queued = f.handoff()
  controller.abort(new Error('host abort'))
  const result = await running
  assert.deepEqual(result, { ok: false, error: sessionReason, cancelled: true })
  assert.match(f.render(result), /ChatGPT Pro · 已取消/)
  assert.doesNotMatch(f.render(result), /失败/)
  await tick()
  assert.equal(f.calls.length, 2)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const record = f.saved().delegations.find((entry) => entry.id === 1)
  assert.equal(record.ok, false)
  assert.equal(record.cancelled, true)
  assert.equal(record.error, sessionReason)
  assert.ok(record.finishedAt)
  assert.equal(f.saved().lastDelegatedProject, 'test')
  f.calls[1].resolve({ answer: '完成', url: '', characters: 2, complete: true })
  assert.equal((await queued).ok, true)
  const status = await f.status()
  assert.equal(status.delegating, null)
  assert.equal(status.delegation, null)
})

for (const entry of ['route', 'tool']) {
  test(`${entry} manually cancels the active delegation and stops stray generation while idle`, async (t) => {
    const f = await fixture(t)
    const stop = async () => {
      if (entry === 'tool') return f.stop()
      const response = await f.postStop()
      assert.equal(response.code, 200)
      return response.body
    }
    const running = f.handoff()
    await tick()
    assert.deepEqual(await stop(), { ok: true, cancelled: 1 })
    assert.deepEqual(await running, { ok: false, error: manualReason, cancelled: true })
    assert.equal(f.calls[0].signal.reason, manualReason)
    assert.equal(f.stopCalls, 0)
    assert.equal(f.saved().delegations[0].cancelled, true)
    assert.deepEqual(await stop(), { ok: true, cancelled: null, stopped: true })
    assert.equal(f.stopCalls, 1)
    f.failStop()
    if (entry === 'tool') assert.deepEqual(await stop(), { ok: false, error: '停止失败' })
    else assert.deepEqual(await f.postStop(), { code: 500, body: { error: '停止失败' } })
  })
}
