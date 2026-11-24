/**
 * Browser driver for chatgpt.com.
 *
 * Owns one Chrome instance launched against a dedicated profile, then talks to
 * it over CDP. Because the browser is a separate process, reloading the plugin
 * does not lose the login: the driver reconnects to the same Chrome.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { cancellationError, waitForReply } from './delegation.js'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_FOR_TESTING = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const DEBUG_PORT = 9333
const COMPOSER = '#prompt-textarea, div[contenteditable="true"]'
const SEND = '[data-testid="send-button"], button[aria-label="Send prompt"]'
const ASSISTANT = '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]'
const STOP = '[data-testid="stop-button"], button[aria-label="Stop streaming"]'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export { cancellationError }

export function resolveBrowserExecutable({
  executablePath, playwrightExecutablePath, homeDir = homedir(),
  browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH, exists = existsSync, readdir = readdirSync,
} = {}) {
  const describe = (path) => {
    if (path.includes('Chrome for Testing')) return { path, kind: 'chrome-for-testing', label: 'Chrome for Testing' }
    if (path.includes('Google Chrome')) return { path, kind: 'chrome', label: 'Google Chrome' }
    return { path, kind: 'custom', label: basename(path) || 'Custom Browser' }
  }
  if (typeof executablePath === 'string' && executablePath.length) return describe(executablePath)

  const candidates = [
    playwrightExecutablePath,
    join('/Applications', CHROME_FOR_TESTING),
    join(homeDir, 'Applications', CHROME_FOR_TESTING),
  ]
  const installed = candidates.find((path) => path && exists(path))
  if (installed) return describe(installed)

  const caches = new Set([browsersPath, join(homeDir, 'Library', 'Caches', 'ms-playwright'), join(homeDir, '.cache', 'ms-playwright')])
  for (const cache of caches) {
    if (!cache || !exists(cache)) continue
    let entries
    try {
      entries = readdir(cache, { withFileTypes: true })
    } catch {
      continue
    }
    const revisions = entries
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .sort((a, b) => Number(b.name.slice(9)) - Number(a.name.slice(9)))
    for (const { name } of revisions) {
      for (const layout of ['chrome-mac-arm64', 'chrome-mac']) {
        const path = join(cache, name, layout, CHROME_FOR_TESTING)
        if (exists(path)) return describe(path)
      }
    }
  }
  return describe(CHROME)
}

function checkAborted(signal) {
  if (signal?.aborted) throw cancellationError(signal)
}

export async function stopGeneration(page, { waitMs = 0, intervalMs = 250 } = {}) {
  try {
    const button = page.locator(STOP).filter({ visible: true }).first()
    const started = Date.now()
    while (true) {
      if (await button.isVisible()) {
        await button.click()
        return true
      }
      const remaining = waitMs - (Date.now() - started)
      if (remaining <= 0) return false
      await page.waitForTimeout(Math.min(intervalMs, remaining))
    }
  } catch {
    return false
  }
}

async function waitForReplyPoll(page, ms, signal) {
  checkAborted(signal)
  if (!signal) return page.waitForTimeout(ms)
  let onAbort
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(cancellationError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([page.waitForTimeout(ms), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function waitForComposer(page, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const composer = page.locator(COMPOSER).filter({ visible: true }).first()
  const loginButton = page.locator('[data-testid="login-button"]').filter({ visible: true }).first()
  const started = Date.now()
  while (true) {
    const url = new URL(page.url())
    if (url.hostname === 'auth.openai.com' || (url.hostname === 'chatgpt.com' && /\/auth\/login|\/auth\/0/.test(url.pathname))) {
      throw new Error('还没登录 ChatGPT：先执行 chatgpt_bridge_browser(action="login") 在弹出的窗口里登录一次')
    }
    if (await composer.isVisible()) return composer
    if (await loginButton.isVisible()) {
      throw new Error('还没登录 ChatGPT：先执行 chatgpt_bridge_browser(action="login") 在弹出的窗口里登录一次')
    }
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) {
      throw new Error(`页面没加载出输入框（等了 ${timeoutMs / 1000} 秒）：${page.url()}。可以先 chatgpt_bridge_browser(action="probe") 看看页面状态`)
    }
    await page.waitForTimeout(Math.min(intervalMs, remaining))
  }
}

const detectModel = async (page) => {
  const text = await page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => '')
  const match = text.match(/GPT-[\w.\s-]{2,18}|o\d[\w.-]{0,8}/)
  return match ? match[0].trim() : ''
}

export const runHandoff = async (page, { brief, conversationUrl, timeoutMs = 240000, composerTimeoutMs = 20000, signal }) => {
  checkAborted(signal)
  const target = conversationUrl || 'https://chatgpt.com/'
  if (!page.url().startsWith('https://chatgpt.com')) {
    await page.goto(target, { waitUntil: 'domcontentloaded' })
  } else if (conversationUrl && page.url() !== conversationUrl) {
    await page.goto(conversationUrl, { waitUntil: 'domcontentloaded' })
  } else if (!conversationUrl && /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\//.test(page.url())) {
    await page.goto(target, { waitUntil: 'domcontentloaded' })
  }
  const composer = await waitForComposer(page, { timeoutMs: composerTimeoutMs })
  checkAborted(signal)
  const before = (await page.$$(ASSISTANT)).length

  checkAborted(signal)
  await composer.click()
  await page.keyboard.press('Meta+A').catch(() => {})
  await page.keyboard.press('Backspace').catch(() => {})
  checkAborted(signal)
  await page.keyboard.insertText(brief)
  await page.waitForTimeout(500)

  const sendButton = await page.$(SEND)
  checkAborted(signal)
  if (sendButton) await sendButton.click()
  else await page.keyboard.press('Enter')

  try {
    const reply = await readReply(page, before, timeoutMs, Date.now, signal)
    const model = await detectModel(page)
    checkAborted(signal)
    return {
      ...reply,
      answer: reply.text,
      url: page.url(),
      characters: reply.text.length,
      model,
    }
  } catch (error) {
    if (signal?.aborted) {
      await stopGeneration(page, { waitMs: 5000 })
      throw cancellationError(signal)
    }
    throw error
  }
}

export function createDriver({
  profileDir, executablePath, debugPort = DEBUG_PORT, log = () => {},
  fetchImpl = fetch, spawnImpl = spawn, killImpl = process.kill, connectOverCDPImpl,
  resolveExecutableImpl = resolveBrowserExecutable, sleepImpl = sleep,
}) {
  const endpoint = `http://127.0.0.1:${debugPort}`
  let browser
  let child
  let lastPage
  let launched = null

  const debugReady = async () => {
    try {
      return (await fetchImpl(`${endpoint}/json/version`)).ok
    } catch {
      return false
    }
  }

  const launchChrome = async (chromium) => {
    const executable = resolveExecutableImpl({ executablePath, playwrightExecutablePath: chromium?.executablePath?.() })
    child = spawnImpl(executable.path, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=HttpsUpgrades',
    ], { detached: true, stdio: 'ignore' })
    let launchError
    child.once?.('error', (error) => { launchError = error })
    child.unref()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await debugReady()) {
        launched = executable
        return
      }
      if (launchError) throw launchError
      await sleepImpl(250)
    }
    throw new Error('Chrome 的调试端口一直没起来')
  }

  const loadChromium = async () => {
    if (connectOverCDPImpl) return undefined
    try {
      return (await import('playwright-core')).chromium
    } catch {
      throw new Error('缺少 playwright-core：在插件目录执行 npm i playwright-core@1.65.0 后重载 bundle')
    }
  }

  const connect = (chromium) => connectOverCDPImpl
    ? connectOverCDPImpl(endpoint)
    : chromium.connectOverCDP(endpoint)

  const ensure = async (allowLaunch = true) => {
    if (browser?.isConnected?.()) return browser
    const chromium = await loadChromium()
    if (allowLaunch && !(await debugReady())) await launchChrome(chromium)
    lastPage = undefined
    browser = await connect(chromium)
    log('attached to chrome')
    return browser
  }

  const currentPage = async (allowLaunch) => {
    const instance = await ensure(allowLaunch)
    if (lastPage && !lastPage.isClosed()) return lastPage
    const context = instance.contexts()[0]
    const pages = context.pages()
    lastPage = pages.find((page) => page.url().startsWith('https://chatgpt.com')) || pages[0] || (await context.newPage())
    return lastPage
  }

  const inspectPage = (page) => {
    return page.evaluate(() => {
      const text = document.body.innerText || ''
      const has = (selector) => Boolean(document.querySelector(selector))
      return {
        url: location.href,
        title: document.title,
        composer: has('#prompt-textarea, div[contenteditable="true"]'),
        sendButton: has('[data-testid="send-button"], button[aria-label="Send prompt"]'),
        accountButton: has('[data-testid="profile-button"]'),
        loginText: /log in|sign in|登录/i.test(text.slice(0, 800)),
        messages: document.querySelectorAll('[data-markdown-text-style="assistant-message"], [data-message-author-role]').length,
        roles: [...document.querySelectorAll('[data-message-author-role]')].map((el) => el.getAttribute('data-message-author-role')),
        articles: document.querySelectorAll('article').length,
        lastTurns: [...document.querySelectorAll('[data-message-author-role]')].slice(-2).map((el) => (el.innerText || '').slice(0, 160)),
        iframes: document.querySelectorAll('iframe').length,
        mainTurns: document.querySelectorAll('[data-testid^="conversation-turn"]').length,
        testIds: [...document.querySelectorAll('[data-testid]')].slice(0, 25).map((el) => el.getAttribute('data-testid')),
        textLength: text.length,
        textTail: text.slice(-400),
        htmlSample: document.body.innerHTML.slice(0, 400),
      }
    })
  }

  const probe = async () => inspectPage(await currentPage())

  const status = async () => {
    if (!(await debugReady())) return { running: false, loggedIn: false, url: '' }
    try {
      const page = await currentPage(false)
      const url = page.url()
      const facts = await inspectPage(page)
      return {
        running: true,
        loggedIn: Boolean(facts.composer) && !facts.loginText,
        url,
        title: facts.title,
        composer: facts.composer,
      }
    } catch (error) {
      return { running: false, loggedIn: false, url: '', error: error.message }
    }
  }

  const debug = async () => {
    const page = await currentPage()
    return page.evaluate(() => {
      const nodes = [...document.querySelectorAll('*')].filter(
        (el) => el.children.length === 0 && /ChatGPT 说：/.test(el.textContent || ''),
      )
      const node = nodes[0]
      if (!node) return { found: false }
      const chain = []
      let current = node
      for (let depth = 0; depth < 8 && current; depth += 1) {
        chain.push({
          tag: current.tagName.toLowerCase(),
          cls: String(current.className || '').slice(0, 60),
          testid: current.getAttribute?.('data-testid') || '',
          role: current.getAttribute?.('data-message-author-role') || '',
        })
        current = current.parentElement
      }
      const editors = [...document.querySelectorAll('[contenteditable]')].map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: String(el.className || '').slice(0, 40),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          y: Math.round(rect.y),
        }
      })
      const turn = node.closest('[data-testid], article, [data-message-author-role]')
      return {
        found: true,
        chain,
        editors,
        hasPromptTextarea: Boolean(document.querySelector('#prompt-textarea')),
        turnHtml: (turn?.outerHTML || node.parentElement?.parentElement?.outerHTML || '').slice(0, 1200),
      }
    })
  }

  const login = async () => {
    const page = await currentPage()
    if (!page.url().startsWith('https://chatgpt.com')) await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
    await page.bringToFront().catch(() => {})
    return status()
  }

  const handoff = async (options) => {
    checkAborted(options.signal)
    return runHandoff(await currentPage(), options)
  }

  const stop = async () => {
    if (!(await debugReady())) return false
    return stopGeneration(await currentPage(false))
  }

  const info = () => {
    const { path, kind, label } = launched ?? resolveExecutableImpl({ executablePath })
    return { executable: path, label, kind }
  }

  const close = async () => {
    try {
      let instance = browser
      try {
        if (!instance?.isConnected?.() && await debugReady()) {
          instance = await connect(await loadChromium())
        }
        if (instance?.isConnected?.()) {
          const session = await instance.newBrowserCDPSession()
          await session.send('Browser.close')
        }
      } catch {
        // Chrome can disconnect while handling Browser.close.
      } finally {
        await instance?.close().catch(() => {})
      }

      for (let attempt = 0; attempt < 12 && await debugReady(); attempt += 1) {
        await sleepImpl(250)
      }
      if (child?.pid && await debugReady()) {
        try {
          killImpl(child.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    } finally {
      browser = undefined
      lastPage = undefined
      child = undefined
      launched = null
    }
    return { ok: true }
  }

  return { status, probe, debug, login, handoff, stop, close, ensure, connected: debugReady, info }
}

export function readReply(page, previousCount, timeoutMs, now = Date.now, signal) {
  return waitForReply({
    timeoutMs,
    now,
    signal,
    wait: (ms) => waitForReplyPoll(page, ms, signal),
    sample: async () => {
      const messages = await page.$$(ASSISTANT)
      const text = messages.length > previousCount
        ? (await messages[messages.length - 1].innerText().catch(() => '')).trim()
        : ''
      const streaming = Boolean(await page.$(STOP).catch(() => null))
      return { text, streaming }
    },
  })
}
