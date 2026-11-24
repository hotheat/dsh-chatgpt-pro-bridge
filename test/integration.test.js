import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// Module mocks need a Node flag, so isolate the shipped entry point in a child.
test('plugin routes and tools enforce project lifetime and browser ownership', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    input: `
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const home = await mkdtemp(join(tmpdir(), 'dsh-integration-'))
process.env.DSH_HOME = home
const root = join(home, 'root')
const linkedRoot = join(home, 'linked-root')
await mkdir(root)
await symlink(root, linkedRoot, 'dir')
await writeFile(join(root, '.env'), 'private needle')
await writeFile(join(root, 'public.txt'), 'visible')
await symlink(join(root, '.env'), join(root, 'ordinary.txt'), 'file')
for (const [directory, name] of [['credentials', 'token.txt'], ['.env.backup', 'config.txt']]) {
  await mkdir(join(root, directory))
  await writeFile(join(root, directory, name), 'SECRET')
  await symlink(join(root, directory, name), join(root, name + '.link'), 'file')
}
await mkdir(join(root, 'normal'))
await writeFile(join(root, 'normal', 'notes.txt'), 'public note')
let resolveHandoff
let started
let connected = true
const calls = []
const executable = '/test/Google Chrome for Testing'
mock.module(new URL('./driver.js', import.meta.url).href, {
  namedExports: { createDriver: (options) => ({
    info: () => ({ executable: options.executablePath, label: 'Chrome for Testing', kind: 'chrome-for-testing' }),
    handoff: async (options) => {
      calls.push(['handoff', options])
      started?.()
      return new Promise((resolve) => { resolveHandoff = resolve })
    },
    login: async () => {
      calls.push(['login'])
      connected = true
      return { running: true }
    },
    close: async () => {
      calls.push(['close'])
      connected = false
      return { ok: true }
    },
    probe: async () => {
      calls.push(['probe'])
      return {}
    },
    debug: async () => {
      calls.push(['debug'])
      return {}
    },
    status: async () => {
      calls.push(['status'])
      return {}
    },
    connected: async () => connected,
  }) },
})
const { apply } = await import('./index.js')
const tools = new Map()
let handler
const webServer = { getOrigin: () => '', register: (route) => { handler = route.handler } }
const services = {
  webServer,
  sessions: { get: (id) => ['live', 'live-cached'].includes(id) ? { id } : undefined },
  sessionProjections: {
    stateOf: (session, key) => session?.id === 'live' && key === 'title' ? '  实时标题  ' : undefined,
    cachedSnapshot: (session) => session?.id === 'live-cached' ? { values: { title: '实时缓存标题' } } : undefined,
  },
  sessionQuery: { listSessions: async () => ['cold', 'predecessor', 'blank', 'unbound'].map((id) => ({ header: { id } })) },
  sessionProjectionCache: {
    cachedSnapshot: ({ id }) => id === 'predecessor' ? undefined : { values: { title: id === 'blank' ? ' ' : '  冷缓存标题  ' } },
    cachedPredecessorTitle: ({ id }) => id === 'predecessor' ? { values: { title: '  前序标题  ' } } : undefined,
  },
}
const ctx = {
  tools: { register: (tool) => tools.set(tool.name, tool) },
  get: (name) => services[name],
  effect: (fn) => fn(),
  inject: (names, fn) => { if (names.includes('webServer')) fn({ webServer, effect: (fn) => fn() }) },
}
apply(ctx, { project: 'one', roots: [{ alias: 'tmp', path: linkedRoot }], browser: { executablePath: executable } })
const request = async (path, body) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, {
    method: body === undefined ? 'GET' : 'POST',
    url: '/api/chatgpt-bridge' + path,
    headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' },
  })
  let status
  let text
  await handler(req, { writeHead: (code) => { status = code }, end: (value) => { text = value } })
  return { status, body: JSON.parse(text) }
}
const config = (body) => request('/config', body)
const mcp = async (name, args = {}) => {
  const response = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  return JSON.parse(response.body.result.content[0].text)
}
const handoff = tools.get('chatgpt_bridge_handoff')
const browser = tools.get('chatgpt_bridge_browser')
const status = async () => (await request('/status')).body
const start = async (task) => {
  const ready = new Promise((resolve) => { started = resolve })
  const result = handoff.execute({ task }, { agent: { id: 'session' } })
  await ready
  return { result }
}
try {
  for (const path of ['credentials/token.txt', '.env.backup/config.txt', 'token.txt.link', 'config.txt.link']) {
    assert.equal((await mcp('read_file', { path })).code, 'DENIED_SENSITIVE')
  }
  assert.equal((await mcp('search', { pattern: 'SECRET' })).count, 0)
  assert.equal((await mcp('read_file', { path: 'normal/notes.txt' })).text, '1\\tpublic note')
  assert.equal((await mcp('search', { pattern: 'public note' })).count, 1)
  assert.equal((await mcp('read_file', { path: 'ordinary.txt' })).code, 'DENIED_SENSITIVE')
  assert.equal((await mcp('search', { pattern: 'private needle' })).count, 0)
  assert.equal((await mcp('read_file', { path: 'public.txt' })).text, '1\\tvisible')
  assert.equal((await request('/bind', { session: 'session', project: 'one' })).status, 200)
  for (const session of ['live', 'live-cached', 'cold', 'predecessor', 'blank']) {
    assert.equal((await request('/bind', { session, project: 'one' })).status, 200)
  }
  const titles = { live: '实时标题', 'live-cached': '实时缓存标题', cold: '冷缓存标题', predecessor: '前序标题' }
  const statusTool = tools.get('chatgpt_bridge_status')
  assert.deepEqual((await status()).sessionTitles, titles)
  assert.deepEqual((await statusTool.execute()).sessionTitles, titles)
  const getService = ctx.get
  ctx.get = (name) => {
    if (['sessions', 'sessionProjections', 'sessionQuery', 'sessionProjectionCache'].includes(name)) throw new Error('unavailable')
    return getService(name)
  }
  assert.deepEqual((await status()).sessionTitles, {})
  assert.deepEqual((await statusTool.execute()).sessionTitles, {})
  ctx.get = getService
  assert.equal((await request('/bind', { session: 'bad', project: 'missing' })).status, 400)
  assert.equal((await config({ createProject: 'two' })).status, 200)
  assert.equal((await config({ switchTo: 'one' })).status, 200)
  const first = await start('first')
  const queued = handoff.execute({ task: 'second' }, { agent: { id: 'session' } })
  await new Promise((resolve) => setImmediate(resolve))
  const rename = await config({ renameProject: { from: 'one', to: 'renamed' } })
  assert.equal(rename.status, 400, 'running/queued project must reject rename')
  assert.match(rename.body.error, /委托/)
  assert.equal((await config({ deleteProject: 'one' })).status, 400)
  assert.equal((await browser.execute({ action: 'close' })).ok, false)
  const busyClose = await request('/browser/close', {})
  assert.equal(busyClose.status, 400)
  assert.match(busyClose.body.error, /占用/)
  assert.equal((await browser.execute({ action: 'login' })).ok, false)
  assert.equal((await request('/browser/login', {})).status, 400)
  assert.equal(calls.some(([action]) => action === 'close' || action === 'login'), false)
  assert.equal((await config({ switchTo: 'two' })).status, 200)
  assert.equal((await status()).exposedProject, 'one')
  assert.equal((await mcp('workspace_info')).project, 'one')
  assert.equal((await config({ resetConversation: 'one' })).status, 200)
  const secondStarted = new Promise((resolve) => { started = resolve })
  resolveHandoff({ answer: 'done', complete: true, streaming: false, url: 'https://chatgpt.com/c/first' })
  assert.equal((await first.result).ok, true)
  await secondStarted
  assert.equal((await status()).projects.find((p) => p.name === 'one').conversationUrl, null,
    'reset during a first conversation must survive completion')
  assert.equal(calls[1][1].conversationUrl, undefined)
  assert.equal((await config({ deleteProject: 'one' })).status, 400, 'second task still owns project')
  resolveHandoff({ answer: 'partial', complete: false, streaming: true, url: 'https://chatgpt.com/c/second' })
  const failed = await queued
  assert.equal(failed.ok, false)
  assert.equal(failed.answer, 'partial')
  assert.equal(failed.characters, 7)
  assert.match(handoff.output.render({}, failed)[0].text, /partial/)
  assert.match(failed.error, /超时/)
  const final = await status()
  assert.equal(final.delegations[0].ok, false)
  assert.equal(final.delegations[0].characters, 7)
  assert.ok(final.delegations[0].finishedAt)
  assert.equal(final.projects.find((p) => p.name === 'one').conversationUrl, null,
    'a timed-out delegation must not save its conversation URL')
  assert.equal(final.lastDelegatedProject, 'one')
  assert.equal(final.delegating, null)
  assert.ok(Number.isFinite(Date.parse(final.browser.idleCloseAt)))
  assert.deepEqual(final.browser, {
    connected: true, running: true, label: 'Chrome for Testing', kind: 'chrome-for-testing',
    executable, idleTimeoutMs: 600000, idleCloseAt: final.browser.idleCloseAt,
  })
  assert.deepEqual((await statusTool.execute()).browser, final.browser)
  assert.deepEqual(await request('/browser/close', {}), { status: 200, body: { ok: true, closed: true } })
  assert.deepEqual((await status()).browser, { ...final.browser, connected: false, running: false, idleCloseAt: null })
  const saved = JSON.parse(await readFile(join(home, 'chatgpt-pro-bridge', 'state.json'), 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.projects.one.conversationUrl, null)
  assert.deepEqual(Object.keys(saved.projects.one).sort(), ['conversationUrl', 'roots', 'workspace'])
  assert.equal((await config({ renameProject: { from: 'one', to: 'renamed' } })).status, 200)
  assert.equal((await status()).lastDelegatedProject, 'renamed')
  assert.equal((await browser.execute({ action: 'close' })).closed, true)
} finally {
  await rm(home, { recursive: true, force: true })
}
`,
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
})
