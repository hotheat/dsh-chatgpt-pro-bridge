import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { createDriver, resolveBrowserExecutable, waitForComposer } from '../driver.js'

const TESTING_APP = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

test('the resolver prefers explicit, Playwright, installed and cached binaries in order', () => {
  const homeDir = '/home/test'
  const browsersPath = '/playwright'
  const playwrightExecutablePath = '/playwright/provided/Google Chrome for Testing'
  const older = join(browsersPath, 'chromium-999/chrome-mac-arm64', TESTING_APP)
  const newer = join(browsersPath, 'chromium-1254/chrome-mac', TESTING_APP)
  const arm = join(browsersPath, 'chromium-1254/chrome-mac-arm64', TESTING_APP)
  const macCache = join(homeDir, 'Library/Caches/ms-playwright')
  const dotCache = join(homeDir, '.cache/ms-playwright')
  const candidates = [
    playwrightExecutablePath, join('/Applications', TESTING_APP), join(homeDir, 'Applications', TESTING_APP),
    arm, newer, older,
    join(macCache, 'chromium-1254/chrome-mac-arm64', TESTING_APP),
    join(dotCache, 'chromium-1254/chrome-mac-arm64', TESTING_APP),
  ]
  const paths = new Set([...candidates, browsersPath, macCache, dotCache])
  const options = {
    homeDir, browsersPath, playwrightExecutablePath,
    exists: (path) => paths.has(path),
    readdir: () => ['chromium-999', 'chromium-1254'].map((name) => ({ name, isDirectory: () => true })),
  }
  assert.deepEqual(resolveBrowserExecutable({ ...options, executablePath: '/custom/browser' }),
    { path: '/custom/browser', kind: 'custom', label: 'browser' })
  for (const path of candidates) {
    assert.deepEqual(resolveBrowserExecutable(options), { path, kind: 'chrome-for-testing', label: 'Chrome for Testing' })
    paths.delete(path)
  }
  assert.deepEqual(resolveBrowserExecutable(options), { path: SYSTEM_CHROME, kind: 'chrome', label: 'Google Chrome' })

  const scanned = []
  resolveBrowserExecutable({ ...options, browsersPath: macCache, readdir: (dir) => {
    scanned.push(dir)
    return []
  } })
  assert.deepEqual(scanned, [macCache, dotCache])
})

test('idle status and stop leave the bridge browser unstarted', async () => {
  const driver = createDriver({
    profileDir: '/test/profile',
    fetchImpl: async () => ({ ok: false }),
    spawnImpl: () => assert.fail('idle status and stop must not spawn'),
    connectOverCDPImpl: () => assert.fail('idle status and stop must not connect'),
  })
  assert.deepEqual(await driver.status(), { running: false, loggedIn: false, url: '' })
  assert.equal(await driver.stop(), false)
})

test('status and stop do not relaunch when an existing browser disconnects during attach', async () => {
  const driver = createDriver({
    profileDir: '/test/profile',
    fetchImpl: async () => ({ ok: true }),
    connectOverCDPImpl: async () => { throw new Error('browser disconnected') },
    spawnImpl: () => assert.fail('status and stop must not relaunch'),
  })
  assert.equal((await driver.status()).error, 'browser disconnected')
  await assert.rejects(driver.stop(), /browser disconnected/)
})

function lifecycleDriver({ initiallyRunning = false, graceful = true, killMissing = false } = {}) {
  let running = initiallyRunning
  const events = []
  const executable = '/test/Google Chrome for Testing'
  const endpoint = 'http://127.0.0.1:9444'
  const page = {
    url: () => 'https://chatgpt.com/', isClosed: () => false,
    bringToFront: async () => {},
    evaluate: async () => ({ composer: true, loginText: false }),
  }
  const driver = createDriver({
    profileDir: '/test/profile', debugPort: 9444,
    resolveExecutableImpl: () => running
      ? { path: SYSTEM_CHROME, kind: 'chrome', label: 'Google Chrome' }
      : { path: executable, kind: 'chrome-for-testing', label: 'Chrome for Testing' },
    fetchImpl: async (url) => {
      assert.equal(url, endpoint + '/json/version')
      return { ok: running }
    },
    spawnImpl: (path, args) => {
      events.push('spawn')
      assert.equal(path, executable)
      assert.ok(args.includes('--remote-debugging-port=9444'))
      assert.ok(args.includes('--user-data-dir=/test/profile'))
      running = true
      return { pid: 42, unref() {} }
    },
    connectOverCDPImpl: async (url) => {
      events.push('connect')
      assert.equal(url, endpoint)
      return {
        isConnected: () => true,
        contexts: () => [{ pages: () => [page] }],
        newBrowserCDPSession: async () => ({
          send: async (command) => {
            events.push(command)
            if (graceful) running = false
          },
        }),
        close: async () => { events.push('disconnect') },
      }
    },
    killImpl: (pid, signal) => {
      events.push([pid, signal])
      if (killMissing) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      running = false
    },
    sleepImpl: async (ms) => { events.push(ms) },
  })
  return { driver, events, executable }
}

test('login launches the selected browser lazily and CDP close shuts down its process', async () => {
  const { driver, events, executable } = lifecycleDriver()
  const info = { executable, kind: 'chrome-for-testing', label: 'Chrome for Testing' }
  assert.deepEqual(driver.info(), info)
  assert.deepEqual(events, [])
  assert.equal((await driver.login()).loggedIn, true)
  assert.deepEqual(driver.info(), info)
  assert.deepEqual(await driver.close(), { ok: true })
  assert.deepEqual(events, ['spawn', 'connect', 'Browser.close', 'disconnect'])
  assert.equal(await driver.connected(), false)
  await driver.login()
  assert.deepEqual(events.slice(4), ['spawn', 'connect'])
})

test('close reconnects to an existing browser without launching', async () => {
  const { driver, events } = lifecycleDriver({ initiallyRunning: true })
  assert.deepEqual(await driver.close(), { ok: true })
  assert.deepEqual(events, ['connect', 'Browser.close', 'disconnect'])
  assert.equal(await driver.connected(), false)
})

for (const killMissing of [false, true]) {
  test(`close falls back to SIGTERM after waiting for CDP shutdown (ESRCH=${killMissing})`, async () => {
    const { driver, events } = lifecycleDriver({ graceful: false, killMissing })
    await driver.ensure()
    assert.deepEqual(await driver.close(), { ok: true })
    assert.deepEqual(events, ['spawn', 'connect', 'Browser.close', 'disconnect', ...Array(12).fill(250), [42, 'SIGTERM']])
    if (!killMissing) assert.equal(await driver.connected(), false)
  })
}

function fakePage(states) {
  let poll = 0
  const clicked = []
  const state = () => states[Math.min(poll, states.length - 1)]
  return {
    clicked,
    url: () => state().url || 'https://chatgpt.com/',
    locator(selector) {
      assert.ok(['#prompt-textarea, div[contenteditable="true"]', '[data-testid="login-button"]'].includes(selector))
      let visibleOnly = false
      const matches = () => {
        const nodes = selector === '[data-testid="login-button"]'
          ? [{ visible: Boolean(state().login) }]
          : state().editors || []
        return visibleOnly ? nodes.filter((node) => node.visible) : nodes
      }
      const locator = {
        filter(options) {
          assert.deepEqual(options, { visible: true })
          visibleOnly = true
          return locator
        },
        first: () => locator,
        isVisible: async () => Boolean(matches()[0]?.visible),
        async click() {
          const node = matches()[0]
          assert.ok(node?.visible)
          clicked.push(node.id)
        },
      }
      return locator
    },
    async waitForTimeout(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms))
      poll += 1
    },
  }
}

const timing = { timeoutMs: 100, intervalMs: 5 }
const loginMessage = '还没登录 ChatGPT：先执行 chatgpt_bridge_browser(action="login") 在弹出的窗口里登录一次'

test('waits for a composer that appears after several polls', async () => {
  const page = fakePage([{}, {}, {}, { editors: [{ id: 'ready', visible: true }] }])
  const composer = await waitForComposer(page, timing)
  await composer.click()
  assert.deepEqual(page.clicked, ['ready'])
})

test('skips the hidden mirror and re-resolves the composer after replacement', async () => {
  const hidden = { id: 'mirror', visible: false }
  const page = fakePage([
    { editors: [hidden, { id: 'original', visible: true }] },
    { editors: [hidden, { id: 'replacement', visible: true }] },
  ])
  const composer = await waitForComposer(page, timing)
  await page.waitForTimeout(5)
  await composer.click()
  assert.deepEqual(page.clicked, ['replacement'])
})

for (const path of ['/auth/login', '/auth/0']) {
  test(`detects a client-side redirect to ${path} after the first poll`, async () => {
    const page = fakePage([{}, { url: `https://chatgpt.com${path}` }])
    await assert.rejects(waitForComposer(page, timing), { message: loginMessage })
  })
}

test('detects auth.openai.com as a login state', async () => {
  const page = fakePage([{ url: 'https://auth.openai.com/log-in' }])
  await assert.rejects(waitForComposer(page, timing), { message: loginMessage })
})

test('detects a visible login button when no composer is visible', async () => {
  const page = fakePage([{ login: true, editors: [{ id: 'mirror', visible: false }] }])
  await assert.rejects(waitForComposer(page, timing), { message: loginMessage })
})

test('a visible composer takes precedence over a login button', async () => {
  const page = fakePage([{ login: true, editors: [{ id: 'ready', visible: true }] }])
  const composer = await waitForComposer(page, timing)
  await composer.click()
  assert.deepEqual(page.clicked, ['ready'])
})

test('times out without claiming the account is not logged in', async () => {
  const page = fakePage([{}])
  await assert.rejects(waitForComposer(page, { timeoutMs: 15, intervalMs: 5 }), (error) => {
    assert.match(error.message, /页面没加载出输入框（等了 0\.015 秒）/)
    assert.match(error.message, /https:\/\/chatgpt\.com\//)
    assert.ok(error.message.includes('chatgpt_bridge_browser(action="probe")'))
    assert.doesNotMatch(error.message, /没登录/)
    return true
  })
})
