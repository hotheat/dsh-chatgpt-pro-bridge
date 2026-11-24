import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('../page/main.js', import.meta.url), 'utf8')

async function pageFixture(running, { stopped = true, sessions = [], sessionTitles = {}, browser = { connected: true } } = {}) {
  const record = { id: 1, project: 'test', title: '测试', startedAt: new Date().toISOString(), finishedAt: null }
  const state = {
    projects: [{ name: 'test', roots: [], sessions, workspace: null }],
    sessionTitles,
    exposedProject: 'test', calls: [], delegations: running ? [record] : [],
    delegation: running ? record : null, browser,
  }
  const listeners = new Map()
  const requests = []
  const app = { innerHTML: '', contains: () => false, querySelector: () => null, setAttribute() {} }
  const toast = { innerHTML: '', hidden: true }
  const dialog = { addEventListener() {} }
  const parent = {}
  const origin = 'http://127.0.0.1'
  const context = createContext({
    document: {
      hidden: true,
      activeElement: null,
      getElementById: (id) => ({ app, toast, dialog })[id] || null,
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    window: { parent, location: { origin }, addEventListener: (type, listener) => listeners.set(type, listener) },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
    async fetch(url, options) {
      requests.push({ url, options })
      let result = state
      if (url.endsWith('/delegation/stop')) {
        result = running ? { ok: true, cancelled: record.id } : { ok: true, cancelled: null, stopped }
        if (running) {
          Object.assign(record, { ok: false, cancelled: true, finishedAt: new Date().toISOString(), error: '已取消：在借阅台手动停止' })
          state.delegation = null
        }
      }
      if (url.endsWith('/browser/close')) {
        state.browser = { ...state.browser, connected: false, idleCloseAt: null }
        result = { ok: true, closed: true }
      }
      return { ok: true, json: async () => structuredClone(result) }
    },
  })
  await runInContext(`${source}\nrefresh();`, context)
  return {
    app, toast, requests,
    postContext: (data) => listeners.get('message')({ origin, source: parent, data: { type: 'cg:context', ...data } }),
    click: (act) => listeners.get('click')({ target: { closest: () => ({ dataset: { act } }) } }),
  }
}

test('bound sessions render titles above the short ID in context priority order', async () => {
  const page = await pageFixture(false, {
    sessions: ['map-session-long-id', 'workspace', 'status', 'untitled'],
    sessionTitles: { 'map-session-long-id': '旧状态标题', workspace: '旧工作区标题', status: '状态标题' },
  })
  assert.match(page.app.innerHTML, /class="s-title ell">状态标题<\/div>/)
  page.postContext({
    titles: { 'map-session-long-id': '全局标题' },
    workspaces: [{ path: '/test', sessions: [{ id: 'map-session-long-id', title: '旧列表标题' }, { id: 'workspace', title: '工作区标题' }] }],
  })
  for (const [id, title] of [['map-session-long-id', '全局标题'], ['workspace', '工作区标题'], ['status', '状态标题'], ['untitled', '会话']]) {
    assert.match(page.app.innerHTML, new RegExp(`class="s-title ell">${title}</div>\\s*<div class="s-sub"><span class="mono ell" title="${id}">${id.slice(0, 16)}</span>`))
  }
})

test('the client posts session snapshot titles and reposts when the session list changes', () => {
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const messages = []
  const effects = []
  const frame = { current: { contentWindow: { postMessage: (message) => messages.push(message) } } }
  let plugin, panel, updateSessions
  const react = {
    createElement() {}, useRef: () => frame, useSyncExternalStore: (_, getSnapshot) => getSnapshot(),
    useCallback: (callback) => callback, useEffect: (effect) => effects.push(effect),
  }
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => react) } },
    location: { origin: 'http://127.0.0.1' }, addEventListener() {},
  }
  runInContext(clientSource, createContext({ window }))
  let sessions = {
    byId: { live: { title: '  实时标题  ' }, blank: { title: '  ' } },
    projectionsBySession: { live: { values: { title: '旧标题' } }, cold: { values: { title: '  缓存标题  ' } } },
  }
  const services = {
    sessions: { list: { getSnapshot: () => sessions, subscribe: (callback) => { updateSessions = callback } } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws', path: '/test', sessionIds: ['live', 'blank'] }] }), subscribe() {} } },
  }
  plugin.apply({
    get: (name) => services[name],
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'live' }) } } },
    slots: { register: (slot, component) => { if (slot.name === 'main') panel = component } },
  })
  panel()
  effects.forEach((effect) => effect())
  assert.deepEqual(structuredClone(messages[0]), {
    type: 'cg:context', session: 'live', titles: { live: '实时标题', cold: '缓存标题' },
    workspaces: [{ workspaceId: 'ws', path: '/test', sessions: [{ id: 'live', title: '实时标题' }, { id: 'blank' }] }],
  })
  sessions = { byId: { live: { title: '新标题' } } }
  updateSessions()
  assert.equal(messages.length, 2)
  assert.equal(messages[1].titles.live, '新标题')
  assert.equal(messages[1].workspaces[0].sessions[0].title, '新标题')
})

test('the live stop control refreshes the ledger to 已取消 and shows the idle action', async () => {
  const page = await pageFixture(true)
  assert.match(page.app.innerHTML, /class="lock-band"[^]*data-act="stop">停止<\/button>/)
  assert.doesNotMatch(page.app.innerHTML, /停止网页生成/)
  await page.click('stop')
  assert.match(page.app.innerHTML, /已取消 · 已取消：在借阅台手动停止/)
  assert.doesNotMatch(page.app.innerHTML, /失败 ·/)
  assert.match(page.app.innerHTML, /data-act="stop">停止网页生成<\/button>/)
  assert.match(page.toast.innerHTML, /已请求停止委托 #1/)
  assert.equal(page.requests[1].url, '/api/chatgpt-bridge/delegation/stop')
  assert.equal(page.requests[1].options.method, 'POST')
  assert.equal(page.requests[1].options.body, '{}')
  assert.equal(page.requests[2].url, '/api/chatgpt-bridge/status')
})

for (const stopped of [true, false]) {
  test(`the idle stop action reports stopped=${stopped}`, async () => {
    const page = await pageFixture(false, { stopped })
    assert.match(page.app.innerHTML, /data-act="stop">停止网页生成<\/button>/)
    await page.click('stop')
    assert.match(page.toast.innerHTML, stopped ? /已停止网页生成/ : /网页当前没有生成内容/)
  })
}

const runningBrowser = {
  connected: true, label: 'Chrome for Testing', idleTimeoutMs: 600000, idleCloseAt: '2026-11-21T00:10:00.000Z',
}

test('the browser pill disables close during a running delegation', async () => {
  const page = await pageFixture(true, { browser: runningBrowser })
  assert.match(page.app.innerHTML, /桥接浏览器 <b>运行中<\/b>/)
  assert.match(page.app.innerHTML, /data-act="close-browser" disabled[^>]*>关闭浏览器<\/button>/)
})

test('closing the idle browser posts, refreshes status, and shows the confirmation toast', async () => {
  const page = await pageFixture(false, { browser: runningBrowser })
  assert.match(page.app.innerHTML, /桥接浏览器 <b>运行中<\/b><span[^>]*>· Chrome for Testing<\/span>/)
  assert.match(page.app.innerHTML, /空闲将于 .+ 自动退出/)
  assert.match(page.app.innerHTML, /data-act="close-browser">关闭浏览器<\/button>/)

  await page.click('close-browser')

  assert.deepEqual(page.requests.map(({ url }) => url), [
    '/api/chatgpt-bridge/status',
    '/api/chatgpt-bridge/browser/close',
    '/api/chatgpt-bridge/status',
  ])
  assert.equal(page.requests[1].options.method, 'POST')
  assert.equal(page.requests[1].options.body, '{}')
  assert.equal(page.requests[2].options.method, undefined)
  assert.match(page.app.innerHTML, /桥接浏览器 <b>未启动<\/b>/)
  assert.equal(page.toast.hidden, false)
  assert.match(page.toast.innerHTML, /已关闭桥接浏览器/)
})

test('the stopped browser pill offers login and hides close and stop', async () => {
  const page = await pageFixture(false, { browser: { ...runningBrowser, connected: false, idleCloseAt: null } })
  assert.match(page.app.innerHTML, /桥接浏览器 <b>未启动<\/b><button data-act="login">打开登录窗口<\/button>/)
  assert.doesNotMatch(page.app.innerHTML, /关闭浏览器|停止网页生成/)
})
