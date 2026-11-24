import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelegation } from '../delegation.js'
import { readReply } from '../driver.js'

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}

function replyPage(stateAt) {
  let time = 0
  return {
    now: () => time,
    async waitForTimeout(ms) { time += ms },
    async $$() {
      const state = stateAt(time)
      return state.text === undefined ? [] : [{ innerText: async () => state.text }]
    },
    async $() { return stateAt(time).streaming ? {} : null },
  }
}

const identity = (name) => ({ name, project: { roots: [], conversationUrl: null } })
const run = (owner, name, options = {}) => owner.enqueue(identity(name), (ticket, perform) => perform(options))

const idleTimeoutMs = 600000
const idleStart = Date.parse('2026-11-21T00:00:00Z')

function idleFixture(driver) {
  const timers = new Set()
  const owner = createDelegation(driver, {
    idleTimeoutMs,
    now: () => idleStart,
    setTimer(callback, delay) {
      const timer = { callback, delay }
      timers.add(timer)
      return timer
    },
    clearTimer: (timer) => timers.delete(timer),
  })
  return {
    owner,
    timers,
    expire() {
      assert.equal(timers.size, 1)
      const [timer] = timers
      timers.delete(timer)
      return timer.callback()
    },
  }
}

test('reply completes only after text is stable and streaming has stopped', async () => {
  const page = replyPage((time) => ({ text: time < 3600 ? 'part' : 'done', streaming: time < 4800 }))
  const reply = await readReply(page, 0, 20000, page.now)
  assert.deepEqual(reply, { text: 'done', complete: true, streaming: false })
  assert.equal(page.now(), 7200)
  const owner = createDelegation({ handoff: async () => ({ ...reply, answer: reply.text }) })
  assert.deepEqual(await run(owner, 'one'), { ...reply, answer: 'done', ok: true, characters: 4 })
})

test('12 seconds of stable text while streaming cannot complete a delegation', async () => {
  const page = replyPage((time) => ({ text: 'partial', streaming: time < 18000 }))
  const reply = await readReply(page, 0, 24000, page.now)
  assert.equal(page.now(), 18000)
  assert.deepEqual(reply, { text: 'partial', complete: true, streaming: false })
})

test('total timeout preserves partial text and reports failure with its character count', async () => {
  const page = replyPage(() => ({ text: 'partial', streaming: true }))
  const reply = await readReply(page, 0, 20000, page.now)
  assert.equal(page.now(), 20000)
  assert.deepEqual(reply, { text: 'partial', complete: false, streaming: true })
  const owner = createDelegation({ handoff: async () => ({ ...reply, answer: reply.text, url: 'https://chatgpt.com/c/partial' }) })
  const result = await run(owner, 'one')
  assert.equal(result.ok, false)
  assert.equal(result.characters, 7)
  assert.equal(result.answer, 'partial')
  assert.match(result.error, /超时.*仍在生成/)
  assert.equal(owner.pending.size, 0)
})

test('timeout without a new assistant message cannot reuse an older answer', async () => {
  const page = replyPage(() => ({ text: 'old answer', streaming: false }))
  const reply = await readReply(page, 1, 2500, page.now)
  assert.deepEqual(reply, { text: '', complete: false, streaming: false })
  const owner = createDelegation({ handoff: async () => ({ ...reply, answer: '' }) })
  const result = await run(owner, 'one')
  assert.equal(result.ok, false)
  assert.equal(result.characters, 0)
  assert.match(result.error, /超时/)
})

test('queued projects register immediately and release only when their task really ends', async () => {
  const gates = [deferred(), deferred()]
  const finishing = deferred()
  const firstStarted = deferred()
  const secondStarted = deferred()
  let calls = 0
  const owner = createDelegation({ handoff: async () => {
    const index = calls++
    const signal = [firstStarted, secondStarted][index]
    signal.resolve()
    return gates[index].promise
  } })
  const first = owner.enqueue(identity('one'), async (ticket, perform) => {
    const result = await perform({})
    await finishing.promise
    return result
  })
  const second = run(owner, 'two')
  assert.deepEqual([...owner.pending].map((ticket) => ticket.name), ['one', 'two'])
  await firstStarted.promise
  assert.equal(owner.active.name, 'one')
  assert.equal(calls, 1)
  gates[0].resolve({ answer: 'first', complete: true })
  await Promise.resolve()
  assert.equal(owner.pending.size, 2)
  finishing.resolve()
  await first
  await secondStarted.promise
  assert.deepEqual([...owner.pending].map((ticket) => ticket.name), ['two'])
  assert.equal(owner.active.name, 'two')
  gates[1].resolve({ answer: 'second', complete: true })
  await second
  assert.equal(owner.pending.size, 0)
  assert.equal(owner.active, null)
})

test('browser operations including close and login are rejected during queued or running delegation', async () => {
  const gate = deferred()
  const invoked = []
  const driver = {
    handoff: () => gate.promise,
    connected: async () => true,
  }
  for (const action of ['close', 'login', 'probe', 'debug', 'status']) {
    driver[action] = async () => {
      invoked.push(action)
      return { ok: true }
    }
  }
  const owner = createDelegation(driver)
  const result = run(owner, 'one')
  await assert.rejects(owner.browser('close'), /占用/)
  await Promise.resolve()
  for (const action of ['close', 'login', 'probe', 'debug', 'status']) await assert.rejects(owner.browser(action), /占用/)
  assert.equal(await owner.connected(), true)
  assert.deepEqual(invoked, [])
  gate.resolve({ answer: 'done', complete: true })
  await result
  assert.deepEqual(await owner.browser('close'), { ok: true })
  assert.deepEqual(invoked, ['close'])
})

test('delegation waits for an existing browser operation and errors do not poison the queue', async () => {
  const gate = deferred()
  const invoked = []
  const owner = createDelegation({
    login: async () => {
      invoked.push('login')
      await gate.promise
    },
    close: async () => {
      invoked.push('close')
      throw new Error('close failed')
    },
    handoff: async () => {
      invoked.push('handoff')
      return { answer: 'done', complete: true }
    },
  })
  const login = owner.browser('login')
  await assert.rejects(owner.browser('close'), /占用/)
  const result = run(owner, 'one')
  await Promise.resolve()
  assert.deepEqual(invoked, ['login'])
  gate.resolve()
  await login
  assert.equal((await result).ok, true)
  await assert.rejects(owner.browser('close'), /close failed/)
  await assert.rejects(owner.enqueue(identity('one'), async () => { throw new Error('preflight failed') }), /preflight failed/)
  assert.equal(owner.pending.size, 0)
  assert.equal(owner.active, null)
  assert.equal((await run(owner, 'two')).ok, true)
})

test('a throwing driver releases the task and the next delegation can run', async () => {
  let calls = 0
  const owner = createDelegation({ handoff: async () => {
    if (++calls === 1) throw new Error('disconnected')
    return { answer: 'retry', complete: true }
  } })
  const first = run(owner, 'one')
  const second = run(owner, 'one')
  await assert.rejects(first, /disconnected/)
  assert.equal((await second).answer, 'retry')
  assert.equal(owner.pending.size, 0)
})

for (const [operation, start] of [['enqueue', (owner) => run(owner, 'one')], ['login', (owner) => owner.browser('login')]]) {
  test(`idle close is armed after ${operation} and closes a connected browser at expiry`, async () => {
    let closes = 0
    const { owner, timers, expire } = idleFixture({
      handoff: async () => ({ answer: 'done', complete: true }),
      login: async () => ({ running: true }),
      connected: async () => true,
      close: async () => { closes++ },
    })
    assert.equal(owner.idleTimeoutMs, idleTimeoutMs)
    assert.equal(owner.idleCloseAt, null)

    await start(owner)
    assert.equal(owner.idleCloseAt, new Date(idleStart + idleTimeoutMs).toISOString())
    assert.deepEqual([...timers].map((timer) => timer.delay), [idleTimeoutMs])
    assert.equal(closes, 0)

    await expire()
    assert.equal(closes, 1)
    assert.equal(owner.idleCloseAt, null)
    assert.equal(timers.size, 0)
  })
}

test('enqueue cancels the pending idle close and rearms it after the delegation finishes', async () => {
  const started = deferred()
  const reply = deferred()
  const { owner, timers } = idleFixture({
    login: async () => ({ running: true }),
    handoff: () => {
      started.resolve()
      return reply.promise
    },
  })
  await owner.browser('login')
  const [previous] = timers
  assert.ok(previous)

  const result = run(owner, 'one')
  assert.equal(timers.size, 0)
  assert.equal(owner.idleCloseAt, null)
  await started.promise
  assert.equal(owner.active.name, 'one')
  assert.equal(timers.size, 0)

  reply.resolve({ answer: 'done', complete: true })
  await result
  assert.equal(timers.size, 1)
  assert.equal(timers.has(previous), false)
})

test('starting a browser operation cancels the pending idle close before it completes', async () => {
  const status = deferred()
  const { owner, timers } = idleFixture({
    login: async () => ({ running: true }),
    status: () => status.promise,
  })
  await owner.browser('login')
  const [previous] = timers
  assert.ok(previous)

  const result = owner.browser('status')
  assert.equal(timers.size, 0)
  assert.equal(owner.idleCloseAt, null)

  status.resolve({ running: true })
  await result
  assert.equal(timers.size, 1)
  assert.equal(timers.has(previous), false)
})

test('idle expiry skips close if a delegation starts during the connection check', async () => {
  const connection = deferred()
  const started = deferred()
  const reply = deferred()
  let closes = 0
  const { owner, expire } = idleFixture({
    login: async () => ({ running: true }),
    connected: () => connection.promise,
    close: async () => { closes++ },
    handoff: () => {
      started.resolve()
      return reply.promise
    },
  })
  await owner.browser('login')
  const closing = expire()
  const result = run(owner, 'one')
  await started.promise
  assert.equal(owner.active.name, 'one')

  connection.resolve(true)
  reply.resolve({ answer: 'done', complete: true })
  await result
  await closing
  assert.equal(closes, 0)
})

test('idle expiry skips close when the browser is disconnected', async () => {
  let closes = 0
  const { owner, timers, expire } = idleFixture({
    login: async () => ({ running: true }),
    connected: async () => false,
    close: async () => { closes++ },
  })
  await owner.browser('login')
  await expire()
  assert.equal(closes, 0)
  assert.equal(owner.idleCloseAt, null)
  assert.equal(timers.size, 0)
})

test('status for a stopped browser leaves an unarmed idle timer unset', async () => {
  const { owner, timers } = idleFixture({ status: async () => ({ running: false }) })
  assert.deepEqual(await owner.browser('status'), { running: false })
  assert.equal(owner.idleCloseAt, null)
  assert.equal(timers.size, 0)
})

test('manual close and disposal each cancel the idle timer', async () => {
  let closes = 0
  const { owner, timers } = idleFixture({
    login: async () => ({ running: true }),
    close: async () => { closes++ },
  })
  await owner.browser('login')
  assert.equal(timers.size, 1)
  await owner.browser('close')
  assert.equal(closes, 1)
  assert.equal(owner.idleCloseAt, null)
  assert.equal(timers.size, 0)

  await owner.browser('login')
  assert.equal(timers.size, 1)
  owner.dispose()
  assert.equal(closes, 1)
  assert.equal(owner.idleCloseAt, null)
  assert.equal(timers.size, 0)
})
