import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'

import * as driver from '../driver.js'

function fakePage({ stopVisible = true, clickError = false, onComposer, onKey, onSendLookup, onSend } = {}) {
  const events = []
  const timers = new Set()
  const polling = Promise.withResolvers()
  const page = {
    events,
    polling: polling.promise,
    cleanup() { for (const timer of timers) clearTimeout(timer) },
    url: () => 'https://chatgpt.com/c/existing',
    async goto() { events.push('navigate') },
    locator(selector) {
      const stop = selector.includes('stop-button')
      const composer = selector.includes('prompt-textarea')
      const locator = {
        filter(options) {
          assert.deepEqual(options, { visible: true })
          return locator
        },
        first: () => locator,
        async isVisible() {
          if (composer) onComposer?.()
          return stop ? (typeof stopVisible === 'function' ? stopVisible() : stopVisible) : composer
        },
        async click() {
          events.push(stop ? 'stop' : 'composer')
          if (stop && clickError) throw new Error('button disappeared')
        },
      }
      return locator
    },
    keyboard: {
      async press(key) { events.push(key); onKey?.(key) },
      async insertText(text) { events.push(['insert', text]) },
    },
    async $$(selector) { return [] },
    async $(selector) {
      if (selector.includes('send-button')) {
        onSendLookup?.()
        return { async click() { events.push('send'); onSend?.() } }
      }
      return null
    },
    async waitForTimeout(ms) {
      if (ms === 500) return
      polling.resolve()
      await new Promise((resolve) => {
        const timer = setTimeout(() => { timers.delete(timer); resolve() }, ms)
        timers.add(timer)
      })
    },
  }
  return page
}

const cancelled = (message = '已取消') => (error) => {
  assert.equal(error.name, 'AbortError')
  assert.equal(error.cancelled, true)
  assert.equal(error.message, message)
  return true
}

test('stopGeneration clicks a visible stop button', async () => {
  const page = fakePage()
  assert.equal(await driver.stopGeneration(page), true)
  assert.deepEqual(page.events, ['stop'])
})

test('stopGeneration returns false when no stop button is visible', async () => {
  const page = fakePage({ stopVisible: false })
  assert.equal(await driver.stopGeneration(page), false)
  assert.deepEqual(page.events, [])
})

test('stopGeneration swallows click errors', async () => {
  assert.equal(await driver.stopGeneration(fakePage({ clickError: true })), false)
})

test('stopGeneration waits for a stop button that appears after several polls', async (t) => {
  let polls = 0
  const page = fakePage({ stopVisible: () => polls >= 3 })
  t.after(() => page.cleanup())
  const wait = page.waitForTimeout
  page.waitForTimeout = async (ms) => { await wait(ms); polls += 1 }
  assert.equal(await driver.stopGeneration(page, { waitMs: 100, intervalMs: 2 }), true)
  assert.equal(polls, 3)
  assert.deepEqual(page.events, ['stop'])
})

test('stopGeneration returns false after waitMs when the button never appears', async (t) => {
  const page = fakePage({ stopVisible: false })
  t.after(() => page.cleanup())
  const started = performance.now()
  assert.equal(await driver.stopGeneration(page, { waitMs: 20, intervalMs: 5 }), false)
  const elapsed = performance.now() - started
  assert.ok(elapsed >= 18 && elapsed < 220, `expected roughly 20ms, got ${elapsed}ms`)
  assert.deepEqual(page.events, [])
})

test('cancelling immediately after send waits for a late stop button', async () => {
  const controller = new AbortController()
  let polls = 0
  const page = fakePage({ stopVisible: () => polls >= 3, onSend: () => controller.abort() })
  page.waitForTimeout = async (ms) => {
    if (ms === 500) return
    assert.equal(ms, 250)
    await new Promise((resolve) => setTimeout(resolve, 2))
    polls += 1
  }
  await assert.rejects(driver.runHandoff(page, { brief: '任务', signal: controller.signal }), cancelled())
  assert.equal(polls, 3)
  assert.ok(page.events.indexOf('stop') > page.events.indexOf('send'))
})

test('aborting the reply wait wakes promptly and stops generation', async (t) => {
  const controller = new AbortController()
  const page = fakePage()
  t.after(() => page.cleanup())
  const result = driver.runHandoff(page, { brief: '任务', signal: controller.signal, timeoutMs: 100 })
  const rejected = assert.rejects(result, cancelled('已取消：测试停止'))
  await page.polling
  const started = performance.now()
  controller.abort('已取消：测试停止')
  await rejected
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.ok(performance.now() - started < 700, 'abort must wake the 1200ms poll sleep')
  assert.ok(page.events.indexOf('stop') > page.events.indexOf('send'))
})

for (const stage of ['before navigation', 'after composer', 'before inserting']) {
  test(`aborting ${stage} never inserts or sends text`, async (t) => {
    const controller = new AbortController()
    const page = fakePage({
      onComposer: () => { if (stage === 'after composer') controller.abort() },
      onKey: (key) => { if (stage === 'before inserting' && key === 'Backspace') controller.abort() },
    })
    t.after(() => page.cleanup())
    if (stage === 'before navigation') controller.abort()
    await assert.rejects(driver.runHandoff(page, { brief: '任务', signal: controller.signal, timeoutMs: 100 }), cancelled())
    assert.ok(!page.events.some((event) => Array.isArray(event)))
    assert.ok(!page.events.includes('send'))
    assert.ok(!page.events.includes('stop'))
    if (stage === 'before navigation') assert.deepEqual(page.events, [])
  })
}

test('aborting just before send does not click send', async (t) => {
  const controller = new AbortController()
  const page = fakePage({ onSendLookup: () => controller.abort('已取消：发送前停止') })
  t.after(() => page.cleanup())
  await assert.rejects(driver.runHandoff(page, { brief: '任务', signal: controller.signal, timeoutMs: 100 }), cancelled('已取消：发送前停止'))
  assert.ok(!page.events.includes('send'))
  assert.ok(!page.events.includes('stop'))
})

for (const complete of [true, false]) {
  test(`runHandoff preserves main's reply result with complete=${complete}`, async (t) => {
    let time = 0
    let samples = 0
    t.mock.method(Date, 'now', () => time)
    const page = fakePage()
    page.waitForTimeout = async (ms) => { time += ms }
    page.$$ = async () => ++samples === 1 ? [] : [{ innerText: async () => '回复' }]
    const lookup = page.$
    page.$ = async (selector) => selector.includes('stop-button') ? (complete ? null : {}) : lookup(selector)
    page.evaluate = async () => 'GPT-5.2'
    // Exercise the signal-aware wait even when this handoff is not cancelled.
    const controller = new AbortController()
    const result = await driver.runHandoff(page, { brief: '任务', timeoutMs: 16000, signal: controller.signal })
    assert.equal(result.complete, complete)
    assert.equal(result.streaming, !complete)
    assert.equal(result.answer, '回复')
    assert.equal(result.text, '回复')
    assert.equal(result.characters, 2)
    assert.equal(result.model, 'GPT-5.2')
    assert.equal(result.url, page.url())
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(page.events.filter((event) => event === 'send').length, 1)
    assert.ok(!page.events.includes('stop'))
    if (!complete) assert.equal(time, 16500, 'streaming must wait for the full reply timeout')
  })
}

test('aborting during a reply sample stops generation instead of completing the reply', async (t) => {
  const controller = new AbortController()
  const page = fakePage()
  let reads = 0
  page.waitForTimeout = async () => {}
  page.$$ = async () => {
    if (++reads > 1) controller.abort('已取消：读取时停止')
    return []
  }
  t.after(() => page.cleanup())
  await assert.rejects(driver.runHandoff(page, { brief: '任务', signal: controller.signal }), cancelled('已取消：读取时停止'))
  assert.ok(page.events.indexOf('stop') > page.events.indexOf('send'))
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
