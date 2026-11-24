/** Project-scoped read-only MCP, shared delegation queue, and management page. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { startGateway } from './gateway.js'
import { createDriver } from './driver.js'
import * as files from './files.js'
import * as projects from './projects.js'
import { BrowserBusyError, cancellationError, createDelegation } from './delegation.js'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

export const name = 'dsh-chatgpt-pro-bridge'
export const inject = ['tools']

const ROUTE = '/api/chatgpt-bridge'
const DEFAULT_BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const PAGE_DIR = fileURLToPath(new URL('./page/', import.meta.url))
const PAGE_ASSETS = { 'page.css': 'text/css', 'main.js': 'text/javascript' }
const STATE_VERSION = 2
const MCP_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'chatgpt-pro-bridge', version: '0.1.0' }
const SESSION_CANCEL_REASON = '已取消：DSH 会话已停止'
const MANUAL_CANCEL_REASON = '已取消：在借阅台手动停止'

export function tunnelPreflightError({ publicUrl, changed }) {
  if (publicUrl && changed) return `连接器地址已失效。请将 ChatGPT 连接器更新为 ${publicUrl}，然后在借阅台页面点击「已更新连接器」后重试。`
}

export function delegationMcpResult(calls, id) {
  const mcpCalls = calls.filter((call) => call.delegation === id).length
  return {
    mcpCalls,
    ...(mcpCalls === 0 ? { warning: '本次委托中 ChatGPT 未通过桥接读取任何文件（MCP 工具调用为 0）。如果回答提到 MCP 错误，连接器地址可能已失效，或当前对话未启用连接器。' } : {}),
  }
}


function createUserMessage(text) {
  // Equivalent to @deepseek-ai/dsh-llm/message createUserMessage for this text-only message.
  const message = structuredClone({ role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source: { kind: 'user' } })
  Object.freeze(message.content[0])
  Object.freeze(message.content)
  Object.freeze(message.source)
  return Object.freeze(message)
}

const runGit = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? '' : stdout))
  })

function buildBrief(state, project, cwd, task, diff, status, testOutput) {
  const roots = describeRoots(state, project)
    .filter((root) => root.exists)
    .map((root) => `- ${root.alias} → ${root.path}`)
    .join('\n')
  return [
    `项目：${project}${cwd ? `（当前目录 ${cwd}）` : ''}`,
    '你是外脑：只做规划和审查，不要写代码文件，也不要假装执行过任何命令。',
    roots ? `通过只读 MCP 可查这些根目录：\n${roots}` : '',
    `任务：${task}`,
    status ? `工作区状态：\n\u0060\u0060\u0060\n${String(status).slice(0, 8000)}\n\u0060\u0060\u0060` : '',
    diff ? `改动：\n\u0060\u0060\u0060diff\n${String(diff).slice(0, 60000)}\n\u0060\u0060\u0060` : '',
    testOutput ? `测试输出：\n\u0060\u0060\u0060\n${String(testOutput).slice(0, 20000)}\n\u0060\u0060\u0060` : '',
    '输出要求：结论先行；按风险排序列出问题，每条给出文件:行号与改法；不确定处明确说“需要确认”。',
  ].filter(Boolean).join('\n\n')
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'chatgpt-pro-bridge')
}

function stateFile() {
  return join(stateDir(), 'state.json')
}

function seedState(config) {
  const project = config?.project || 'default'
  const roots = Array.isArray(config?.roots) && config.roots.length
    ? config.roots
    : [{ alias: 'workspace', path: process.cwd() }]
  return {
    version: STATE_VERSION,
    activeProject: project,
    projects: {
      [project]: {
        workspace: null,
        conversationUrl: null,
        roots: files.normalizeRoots(roots.map((root, index) => ({
          alias: String(root.alias || `root${index + 1}`),
          path: String(root.path),
          readonly: true,
        }))),
      },
    },
    bindings: {},
    lastDelegatedProject: null,
    counters: { total: 0, tools: {} },
    calls: [],
    delegations: [],
    nextDelegation: 1,
  }
}

function loadState(config) {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (raw?.version === STATE_VERSION) {
      for (const project of Object.values(raw.projects)) {
        project.roots = files.normalizeRoots(project.roots)
        project.workspace ??= null
        project.conversationUrl ??= null
      }
      raw.delegations ??= []
      raw.nextDelegation ??= 1
      return raw
    }
    if (raw?.version === 1) {
      const migrated = {
        version: STATE_VERSION,
        activeProject: raw.project,
        projects: { [raw.project]: { roots: files.normalizeRoots(raw.roots), workspace: null, conversationUrl: null } },
        bindings: {},
        lastDelegatedProject: null,
        counters: raw.counters,
        calls: raw.calls,
        delegations: [],
        nextDelegation: 1,
      }
      saveState(migrated)
      return migrated
    }
  } catch {
    // first run, or an unreadable state file: reseed below
  }
  const seeded = seedState(config)
  saveState(seeded)
  return seeded
}

function saveState(state) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(stateFile(), JSON.stringify(state, null, 2))
}

const projectNames = (state) => Object.keys(state.projects)
const projectOf = projects.projectOf
const rootsOf = (state, name) => projectOf(state, name)?.roots || []
const describeRoots = (state, name) => files.describeRoots(rootsOf(state, name))
const describeProjects = (state) => projectNames(state).map((name) => ({
  name,
  active: name === state.activeProject,
  roots: describeRoots(state, name),
  workspace: projectOf(state, name).workspace ?? null,
  conversationUrl: projectOf(state, name).conversationUrl ?? null,
  sessions: Object.keys(state.bindings).filter((session) => state.bindings[session] === name),
}))

function projectForSession(state, sessionId, cwd) {
  const bound = sessionId ? state.bindings[sessionId] : undefined
  if (bound && projectOf(state, bound)) return bound
  if (cwd) {
    cwd = files.normalizePath(cwd)
    let best
    let bestLength = -1
    for (const [name, project] of Object.entries(state.projects)) {
      const bases = project.roots.map((root) => root.path)
      if (project.workspace) bases.push(project.workspace)
      for (const path of bases) {
        const base = files.normalizePath(path).replace(/[/\\]$/, '')
        if ((cwd === base || cwd.startsWith(base + '/') || cwd.startsWith(base + '\\')) && base.length > bestLength) {
          best = name
          bestLength = base.length
        }
      }
    }
    if (best) return best
  }
  return state.activeProject
}

function workspaceError(workspace) {
  if (workspace === null) return
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) return '工作区必须是绝对路径'
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return `不是已存在的目录：${workspace}`
}

/* ------------------------------------------------------------------ */
/* MCP tool implementations                                            */
/* ------------------------------------------------------------------ */

const TOOL_SPECS = [
  {
    name: 'workspace_info',
    description: 'List the project this bridge exposes and the folders ChatGPT may read. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(state, args, project) {
      return {
        project,
        readonly: true,
        roots: describeRoots(state, project).map((root) => ({ alias: root.alias, path: root.path, exists: root.exists })),
        note: 'Paths are relative to each root alias. Read files with read_file(root, path).',
      }
    },
  },
  {
    name: 'resolve_root',
    description: 'Map a path to the root alias that owns it, longest match first.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or root-relative path.' } },
      required: ['path'],
      additionalProperties: false,
    },
    run(state, args, project) {
      return files.resolveRoot(rootsOf(state, project), args)
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside a root. Returns numbered lines and the total line count.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Root alias; omit for the default root.' },
        path: { type: 'string', description: 'Path relative to the root.' },
        start: { type: 'integer', description: '1-based first line, default 1.' },
        end: { type: 'integer', description: 'Last line, inclusive; at most 400 lines per call.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run(state, args, project) {
      return files.readFile(rootsOf(state, project), args)
    },
  },
  {
    name: 'search',
    description: 'Regex search across the roots. Skips build output and dependency folders.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression, case-sensitive.' },
        root: { type: 'string', description: 'Root alias; omit to search every root.' },
        maxResults: { type: 'integer', description: 'Default 40, cap 100.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    run(state, args, project) {
      return files.search(rootsOf(state, project), args)
    },
  },
]

const TOOLS = TOOL_SPECS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))

/* ------------------------------------------------------------------ */
/* JSON-RPC over HTTP                                                  */
/* ------------------------------------------------------------------ */

function recordCall(state, tool, startedAt, project, args, value, delegation) {
  state.counters.total += 1
  state.counters.tools[tool] = (state.counters.tools[tool] || 0) + 1
  const display = (input) => typeof input === 'string' ? input : JSON.stringify(input ?? '')
  const root = display(args.root || rootsOf(state, project)[0]?.alias || '')
  const target = tool === 'read_file' ? `${root}/${display(args.path || '')}`
    : tool === 'search' ? `"${display(args.pattern || '')}" · ${args.root ? display(args.root) : rootsOf(state, project).map((r) => r.alias).join(', ')}`
      : tool === 'resolve_root' ? display(args.path || '') : ''
  const note = value.error || (tool === 'read_file' ? `${value.start}-${value.end}`
    : tool === 'search' ? `${value.count} 处`
      : tool === 'workspace_info' ? `${value.roots.length} 个根` : value.found ? value.root : '未找到')
  state.calls.unshift({ tool, project, at: new Date().toISOString(), ms: Date.now() - startedAt,
    delegation: delegation?.id ?? null, target, note, refused: value.code === 'DENIED_SENSITIVE' })
  state.calls = state.calls.slice(0, 200)
  saveState(state)
}

async function dispatch(state, message, project, delegation) {
  const { id, method, params } = message || {}
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Read-only bridge over local project folders. Call workspace_info first.',
      },
    }
  }
  if (method === 'notifications/initialized' || isNotification) return undefined
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } }
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } }
  if (method === 'tools/call') {
    const tool = TOOL_SPECS.find((candidate) => candidate.name === params?.name)
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具 ${params?.name}` } }
    const startedAt = Date.now()
    let value, failure
    try {
      value = tool.run(state, params?.arguments || {}, project)
    } catch (error) {
      failure = `执行失败：${error.message}`
      value = { error: failure }
    }
    recordCall(state, tool.name, startedAt, project, params?.arguments || {}, value, delegation)
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: failure || JSON.stringify(value, null, 2) }], isError: Boolean(value?.error) },
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法 ${method}` } }
}

async function resolveSessionTitles(ctx, state) {
  const unresolved = new Set(Object.keys(state.bindings))
  const titles = new Map()
  const saveTitle = (id, title) => {
    if (typeof title !== 'string' || !title.trim()) return
    titles.set(id, title.trim())
    unresolved.delete(id)
  }

  for (const id of unresolved) {
    try {
      const live = ctx.get?.('sessions')?.get?.(id)
      if (!live) continue
      const projections = ctx.get?.('sessionProjections')
      saveTitle(id, projections?.stateOf?.(live, 'title') ?? projections?.cachedSnapshot?.(live)?.values?.title)
    } catch {}
  }

  if (unresolved.size) {
    try {
      const query = ctx.get?.('sessionQuery')
      const cache = ctx.get?.('sessionProjectionCache')
      if (query?.listSessions && cache) {
        for (const { header } of await query.listSessions()) {
          if (!unresolved.has(header?.id)) continue
          try {
            saveTitle(header.id, (cache.cachedSnapshot?.(header) ?? cache.cachedPredecessorTitle?.(header))?.values?.title)
          } catch {}
        }
      }
    } catch {}
  }

  return Object.fromEntries(titles)
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    ...headers,
  })
  res.end(body)
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const state = loadState(config)
  // The queue is fresh at startup, so no handoff from this instance can be in flight.
  const unfinished = state.delegations.filter((record) => record.finishedAt == null)
  if (unfinished.length) {
    const finishedAt = new Date().toISOString()
    for (const record of unfinished) {
      Object.assign(record, { ok: false, error: '已中断：委托进行中 DSH 退出或重启', finishedAt, interrupted: true })
    }
    saveState(state)
  }
  let gateway
  const idleTimeoutMs = config?.browser?.idleTimeoutMs === undefined
    ? DEFAULT_BROWSER_IDLE_TIMEOUT_MS
    : Math.max(0, Number(config.browser.idleTimeoutMs) || 0)
  const executablePath = config?.browser?.executablePath || process.env.DSH_CHATGPT_BRIDGE_BROWSER || undefined
  const driver = createDriver({ profileDir: join(stateDir(), 'chrome-profile'), executablePath })
  const owner = createDelegation(driver, { idleTimeoutMs })
  ctx.effect(() => () => owner.dispose())

  const browserStatus = async () => {
    const connected = await owner.connected()
    const info = owner.browserInfo()
    return {
      connected,
      running: connected,
      label: info.label ?? null,
      kind: info.kind ?? null,
      executable: info.executable ?? null,
      idleTimeoutMs: owner.idleTimeoutMs,
      idleCloseAt: connected ? owner.idleCloseAt : null,
    }
  }
  let delegation = null
  let delegationController = null
  const tunnelStatus = () => {
    const publicUrl = gateway?.status().publicUrl || ''
    if (publicUrl && !state.ackedPublicUrl) {
      state.ackedPublicUrl = publicUrl
      saveState(state)
    }
    return { publicUrl, changed: Boolean(publicUrl) && publicUrl !== state.ackedPublicUrl }
  }
  const exposedProject = (state) => projects.exposedProject(state, owner.active)

  const handoff = async (project, options, meta) => {
    if (options.signal?.aborted) throw cancellationError(AbortSignal.abort(SESSION_CANCEL_REASON))
    return owner.enqueue(projects.delegationIdentity(state, project), async (identity, perform) => {
      if (options.signal?.aborted) throw cancellationError(AbortSignal.abort(SESSION_CANCEL_REASON))
      const error = tunnelPreflightError(tunnelStatus())
      if (error) throw new Error(error)
      const manualController = new AbortController()
      const sessionController = new AbortController()
      const cancelSession = () => sessionController.abort(SESSION_CANCEL_REASON)
      options.signal?.addEventListener('abort', cancelSession, { once: true })
      const signal = AbortSignal.any([sessionController.signal, manualController.signal])
      delegationController = manualController
      // A queued delegation starts from the latest conversation, including resets.
      Object.assign(identity, projects.delegationIdentity(state, identity.name))
      const record = { id: state.nextDelegation++, project: identity.name, title: meta.title.split(/\r?\n/)[0].slice(0, 40),
        session: meta.session ?? null, kind: meta.kind, startedAt: new Date().toISOString(),
        finishedAt: null, ok: null, characters: null, url: null, error: null }
      delegation = record
      state.delegations.unshift(record)
      state.delegations = state.delegations.slice(0, 30)
      let result
      try {
        saveState(state)
        result = await perform({
          ...options,
          signal,
          conversationUrl: options.conversationUrl || identity.conversationUrl || undefined,
        })
        if (signal.aborted) throw cancellationError(signal)
        const mcp = delegationMcpResult(state.calls, record.id)
        Object.assign(record, { ok: result.ok, characters: result.characters, url: result.url ?? null, error: result.error ?? null }, mcp)
        return { ...result, ...mcp }
      } catch (error) {
        Object.assign(record, { ok: false, error: error.message, ...(error.cancelled ? { cancelled: true } : {}) })
        throw error
      } finally {
        record.finishedAt = new Date().toISOString()
        options.signal?.removeEventListener('abort', cancelSession)
        delegationController = null
        delegation = null
        Object.assign(state, projects.finishDelegation(state, identity, { url: result?.url, ok: record.ok === true }))
        saveState(state)
      }
    })
  }

  const stopDelegation = async () => {
    if (delegation) {
      delegationController.abort(MANUAL_CANCEL_REASON)
      return { ok: true, cancelled: delegation.id }
    }
    return { ok: true, cancelled: null, stopped: await owner.browser('stop') }
  }

  const cwdForTool = async (exec) => {
    try {
      return await ctx.get('workingDirectory')?.ensure?.(exec?.agent)
    } catch {
      return undefined
    }
  }

  ctx.inject(['webServer'], (web) => {
    const gatewayPort = Number(config?.gateway?.port || 0)
    if (gatewayPort > 0) {
      const instance = startGateway({
        port: gatewayPort,
        dataDir: stateDir(),
        innerBase: web.webServer.getOrigin(),
        tunnel: { ...config?.gateway?.tunnel, provider: config?.gateway?.tunnel?.provider ?? 'ngrok' },
      })
      gateway = instance
      instance.listen().catch(() => { gateway = null })
      web.effect(() => () => {
        gateway = null
        instance.close()
      })
    }

    web.effect(() =>
      web.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        async handler(req, res) {
          const peer = req.socket?.remoteAddress || ''
          const loopback = peer === '127.0.0.1' || peer === '::1' || peer.startsWith('::ffff:127.')
          if (!loopback) return send(res, 403, { error: 'bridge 只接受本机请求；对外暴露需要先接隧道与 OAuth' })
          const origin = `http://${req.headers.host || '127.0.0.1'}`
          const url = new URL(req.url || ROUTE, origin)
          try {
            if (req.method === 'GET' && (url.pathname === `${ROUTE}/page/` || url.pathname.startsWith(`${ROUTE}/page/assets/`))) {
              const name = url.pathname === `${ROUTE}/page/` ? 'index.html' : url.pathname.slice(`${ROUTE}/page/assets/`.length)
              const type = name === 'index.html' && url.pathname === `${ROUTE}/page/` ? 'text/html' : Object.hasOwn(PAGE_ASSETS, name) ? PAGE_ASSETS[name] : null
              if (!type) return send(res, 404, { error: 'not found' })
              const contents = readFileSync(join(PAGE_DIR, name))
              res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
              return res.end(contents)
            }
            if (req.method === 'POST' && url.pathname === `${ROUTE}/tunnel/ack`) {
              state.ackedPublicUrl = tunnelStatus().publicUrl
              saveState(state)
              return send(res, 200, { ok: true, tunnel: tunnelStatus() })
            }
            if (req.method === 'POST' && [`${ROUTE}/browser/login`, `${ROUTE}/browser/close`].includes(url.pathname)) {
              try {
                if (url.pathname.endsWith('/close')) {
                  await owner.browser('close')
                  return send(res, 200, { ok: true, closed: true })
                }
                return send(res, 200, await owner.browser('login'))
              } catch (error) {
                if (!(error instanceof BrowserBusyError)) throw error
                return send(res, 400, { error: error.message })
              }
            }
            if (req.method === 'POST' && url.pathname === `${ROUTE}/delegation/stop`) {
              return send(res, 200, await stopDelegation())
            }
            if (req.method === 'OPTIONS') return send(res, 204, undefined)
            if (req.method === 'GET' && url.pathname === `${ROUTE}/status`) {
              return send(res, 200, {
                project: state.activeProject,
                exposedProject: exposedProject(state),
                delegating: owner.active?.name ?? null,
                delegation,
                delegations: state.delegations,
                lastDelegatedProject: state.lastDelegatedProject,
                tunnel: tunnelStatus(),
                endpoint: `${origin}${ROUTE}/mcp`,
                roots: describeRoots(state),
                projects: describeProjects(state),
                bindings: state.bindings,
                sessionTitles: await resolveSessionTitles(ctx, state),
                counters: state.counters,
                calls: state.calls,
                gateway: gateway ? gateway.status() : null,
                browser: await browserStatus(),
                capabilities: { readonly: true, tools: TOOLS.map((tool) => tool.name) },
              })
            }
            if (req.method === 'POST' && url.pathname === `${ROUTE}/pairing/rotate`) {
              if (!gateway) return send(res, 400, { error: 'gateway 未启动' })
              return send(res, 200, { pairingCode: gateway.rotate() })
            }
            if (req.method === 'POST' && url.pathname === `${ROUTE}/config`) {
              const body = JSON.parse((await readBody(req)) || '{}')
              const prepared = {}
              if (typeof body.createProject === 'string') {
                const workspace = body.workspace ?? null
                const issue = workspaceError(workspace)
                if (issue) return send(res, 400, { error: issue })
                const next = files.registerRoots(body.seedRoot === true && workspace
                  ? [{ alias: basename(workspace) || 'root', path: workspace }]
                  : [])
                if (next.error) return send(res, 400, next)
                prepared.createdRoots = next.roots
              }
              if (body.setWorkspace) {
                const issue = workspaceError(body.setWorkspace.workspace)
                if (issue) return send(res, 400, { error: issue })
              }
              if (Array.isArray(body.roots)) {
                const next = files.registerRoots(body.roots)
                if (next.error) return send(res, 400, next)
                prepared.roots = next.roots
              }
              const next = projects.configure(state, body, owner.pending, prepared)
              if (next.error) return send(res, 400, { error: next.error })
              Object.assign(state, next.state)
              saveState(state)
              return send(res, 200, { project: state.activeProject, roots: describeRoots(state) })
            }
            if (req.method === 'POST' && url.pathname === `${ROUTE}/bind`) {
              const { session, project } = JSON.parse((await readBody(req)) || '{}')
              const next = projects.bindSession(state, session, project)
              if (next.error) return send(res, 400, { error: next.error })
              Object.assign(state, next.state)
              saveState(state)
              return send(res, 200, { session, project })
            }
            if (req.method === 'POST' && url.pathname === `${ROUTE}/roots`) {
              const body = JSON.parse((await readBody(req)) || '{}')
              const project = body.project === undefined ? state.activeProject : body.project
              if (!Object.hasOwn(state.projects, project)) return send(res, 400, { error: `未知项目：${project}` })
              const next = Object.hasOwn(body, 'remove')
                ? files.removeRoot(rootsOf(state, project), body.remove)
                : files.addRoot(rootsOf(state, project), body)
              if (next.error) return send(res, 400, next)
              projectOf(state, project).roots = next.roots
              saveState(state)
              return send(res, 200, { project, roots: describeRoots(state, project) })
            }
            if (url.pathname === `${ROUTE}/mcp` || url.pathname.startsWith(`${ROUTE}/mcp/`)) {
              if (req.method === 'GET') return send(res, 405, { error: '仅支持 POST（Streamable HTTP JSON 模式）' })
              if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
              const raw = await readBody(req)
              const session = req.headers['mcp-session-id']
              let message
              try {
                message = JSON.parse(raw)
              } catch {
                return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
              }
              let project = exposedProject(state)
              if (url.pathname !== `${ROUTE}/mcp`) {
                try {
                  project = decodeURIComponent(url.pathname.slice(`${ROUTE}/mcp/`.length))
                } catch {
                  return send(res, 400, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32602, message: '项目名编码无效' } })
                }
                if (!Object.hasOwn(state.projects, project)) {
                  return send(res, 404, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32602, message: `未知项目：${project}` } })
                }
              }
              const responses = []
              for (const item of Array.isArray(message) ? message : [message]) {
                const response = await dispatch(state, item, project, delegation)
                if (response) responses.push(response)
              }
              if (!responses.length) return send(res, 202, undefined)
              return send(res, 200, Array.isArray(message) ? responses : responses[0], session ? { 'mcp-session-id': session } : {})
            }
            return send(res, 404, { error: 'not found' })
          } catch (error) {
            return send(res, 500, { error: error.message })
          }
        },
      }),
    )
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_status',
      description:
        'Inspect the local ChatGPT Pro bridge: project name, registered folders, MCP endpoint, and recent calls. ' +
        'Use it before handing work to ChatGPT web.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        const origin = ctx.get('webServer')?.getOrigin?.() || 'http://127.0.0.1'
        const gatewayStatus = gateway?.status()
        return {
          project: state.activeProject,
          activeProject: state.activeProject,
          exposedProject: exposedProject(state),
          delegating: owner.active?.name ?? null,
          delegation,
          delegations: state.delegations,
          lastDelegatedProject: state.lastDelegatedProject,
          tunnel: tunnelStatus(),
          browser: await browserStatus(),
          projects: describeProjects(state),
          bindings: state.bindings,
          sessionTitles: await resolveSessionTitles(ctx, state),
          endpoint: `${origin}${ROUTE}/mcp`,
          roots: describeRoots(state),
          counters: state.counters,
          calls: state.calls,
          gateway: gatewayStatus || null,
          tunnelState: gatewayStatus?.tunnelState || 'off',
          tunnelError: gatewayStatus?.tunnelError || '',
          configured: describeRoots(state).filter((root) => root.exists).length,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_use',
      description: 'Inspect or set the project binding for the current DSH session.',
      parameters: {
        type: 'object',
        properties: { project: { type: 'string', description: 'Project name to bind to this session.' } },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        const project = args?.project
        if (project === undefined) {
          return {
            binding: state.bindings[sessionId] || null,
            derived: projectForSession(state, sessionId, undefined),
            projects: projectNames(state),
            activeProject: state.activeProject,
          }
        }
        const next = projects.bindSession(state, sessionId, project)
        if (next.error) return { ok: false, error: next.error }
        Object.assign(state, next.state)
        saveState(state)
        return { ok: true, binding: project, roots: describeRoots(state, project) }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_probe',
      description:
        'Call the bridge MCP endpoint the way ChatGPT would: initialize, list tools, then read one file. ' +
        'Use it after changing folders or routes to prove the endpoint still works.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional file path to read as part of the probe.' } },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const origin = ctx.get('webServer')?.getOrigin?.()
        if (!origin) return { ok: false, error: 'webServer 未激活' }
        const endpoint = `${origin}${ROUTE}/mcp`
        const call = async (payload) => {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          })
          return response.json()
        }
        const started = Date.now()
        await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'dsh-probe', version: '0.1.0' } } })
        const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        const tools = (listed?.result?.tools || []).map((tool) => tool.name)
        let sample
        if (args?.path) {
          const read = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: args.path } } })
          sample = read?.result?.content?.[0]?.text?.slice(0, 400)
        }
        return { ok: true, endpoint, tools, sample, ms: Date.now() - started }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_pairing',
      description:
        'Show the ChatGPT connector URL and the one-time pairing code for this bridge. ' +
        'Use it when the user needs to add or re-pair the connector in ChatGPT.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        if (!gateway) return { ok: false, error: 'gateway 未启动（config.gateway.port）' }
        const status = gateway.status()
        return {
          ok: true,
          url: status.publicUrl,
          provider: status.provider,
          tunnelState: status.tunnelState,
          tunnelError: status.tunnelError,
          pairingCode: status.pairingCode,
          expiresAt: status.pairingExpiresAt,
          steps: [
            'ChatGPT → 设置 → 连接器 → 新建',
            `填 ${status.publicUrl || status.localUrl}`,
            '浏览器打开授权页，输入上面的配对码',
          ],
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_rotate_pairing',
      description: 'Invalidate the current pairing code and issue a new one.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        if (!gateway) return { ok: false, error: 'gateway 未启动' }
        return { ok: true, pairingCode: gateway.rotate() }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_browser',
      description:
        'Control the plugin-owned Chrome window used to drive chatgpt.com: check status, probe or debug the page, open the login page, stop the current delegation or page generation, or close it.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['status', 'probe', 'debug', 'login', 'stop', 'close'], description: 'Default status.' } },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const action = args?.action || 'status'
        try {
          if (action === 'stop') return await stopDelegation()
          const result = await owner.browser(['probe', 'debug', 'login', 'close'].includes(action) ? action : 'status')
          return action === 'close' ? { ok: true, closed: true } : result
        } catch (error) {
          return { ok: false, error: error.message }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_handoff',
      description:
        'Send a planning or review brief to ChatGPT web through the plugin Chrome window and return its answer. ' +
        'The brief may include a diff and test output; ChatGPT can also read files itself over the bridge MCP.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What ChatGPT should decide or review.' },
          includeChanges: { type: 'boolean', description: 'Collect git diff and status from the session cwd for review.' },
          diff: { type: 'string', description: 'Optional unified diff or file excerpts; ignored when includeChanges is true.' },
          testOutput: { type: 'string', description: 'Optional test or build output.' },
          conversationUrl: { type: 'string', description: 'Optional existing conversation URL to continue.' },
          timeoutMs: { type: 'integer', description: 'Default 240000.' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value && value.ok) {
            const head = `◍ ChatGPT Pro · ${value.characters} 字`
            return [{ type: 'text', text: `${value.warning ? `${value.warning}\n\n` : ''}${head}\n\n${value.answer}\n\n${value.url ? `对话：${value.url}` : ''}` }]
          }
          return [{ type: 'text', text: `◍ ChatGPT Pro · ${value?.cancelled ? '已取消' : '失败'}\n\n${value?.error || '未知错误'}${value?.answer ? `\n\n已读取 ${value.characters} 字：\n\n${value.answer}` : ''}` }]
        },
      },
      async execute(args, exec) {
        const cwd = await cwdForTool(exec)
        const project = projectForSession(state, exec?.agent?.id, cwd)
        try {
          let diff = args?.diff
          let status = ''
          if (args?.includeChanges) {
            if (!cwd) throw new Error('无法取得当前会话的工作目录')
            ;[diff, status] = await Promise.all([
              runGit(cwd, ['diff', '--no-color', '--unified=3']),
              runGit(cwd, ['status', '--porcelain', '-uall']),
            ])
          }
          const brief = buildBrief(state, project, cwd, args?.task || '', diff, status, args?.testOutput)
          const result = await handoff(project, {
            brief,
            conversationUrl: args?.conversationUrl,
            timeoutMs: Number(args?.timeoutMs) || 240000,
            signal: exec?.signal,
          }, { title: String(args?.task || ''), session: exec?.agent?.id, kind: args?.includeChanges ? 'review' : 'tool' })
          return { ...result, chars: result.answer.length }
        } catch (error) {
          return { ok: false, error: error.message, ...(error.cancelled ? { cancelled: true } : {}) }
        }
      },
    }),
  )

  ctx.inject(['commands', 'workingDirectory'], (sub) => {
    sub.effect(() =>
      sub.commands.register({
        name: 'cg-use',
        description: '查看或设置当前会话绑定的项目',
        input: { hint: '项目名' },
        handler: async (invocation) => {
          const project = invocation.rawInput.trim()
          const sessionId = invocation.agent.id
          if (!project) {
            return {
              kind: 'success',
              text: `本会话绑定：${state.bindings[sessionId] || '未绑定'}\n可用项目：${projectNames(state).join('、')}`,
            }
          }
          const next = projects.bindSession(state, sessionId, project)
          if (next.error) return { kind: 'error', text: next.error }
          Object.assign(state, next.state)
          saveState(state)
          return { kind: 'success', text: `本会话绑定：${project}` }
        },
      }),
    )

    sub.effect(() =>
      sub.commands.register({
        name: 'cg-review',
        description: '把当前目录的未提交改动交给 ChatGPT 网页版审查',
        handler: async (invocation) => {
          try {
            const cwd = await sub.workingDirectory.ensure(invocation.agent)
            const [diff, status] = await Promise.all([
              runGit(cwd, ['diff', '--no-color', '--unified=3']),
              runGit(cwd, ['status', '--porcelain', '-uall']),
            ])
            if (!diff.trim() && !status.trim()) return { kind: 'error', text: `${cwd} 没有未提交的改动` }
            const error = tunnelPreflightError(tunnelStatus())
            if (error) return { kind: 'error', text: error }
            invocation.agent.steer(createUserMessage(
              '请只调用一次 chatgpt_bridge_handoff，task 必须为「审查这份未提交的改动，指出最该修的地方。」，includeChanges 必须为 true，由工具收集当前会话目录的改动。不要先自行审查。工具返回后，完整答案已显示在工具卡片中，不要复述，只给简短要点。',
            ))
            return { kind: 'success', text: '已交给当前会话，通过 chatgpt_bridge_handoff 转给 ChatGPT Pro' }
          } catch (error) {
            return { kind: 'error', text: error.message }
          }
        },
      }),
    )

    sub.effect(() =>
      sub.commands.register({
        name: 'cg-ask',
        description: '把一句话问题交给 ChatGPT 网页版',
        input: { hint: '要问 ChatGPT 的话' },
        handler: async (invocation) => {
          const question = invocation.rawInput
          if (!question.trim()) return { kind: 'error', text: '用法：/cg-ask <问题>' }
          const error = tunnelPreflightError(tunnelStatus())
          if (error) return { kind: 'error', text: error }
          try {
            invocation.agent.steer(createUserMessage(
              '请只调用一次 chatgpt_bridge_handoff，将下面的问题原文作为 task，不要改写，也不要先自行回答。工具返回后，完整答案已显示在工具卡片中，不要复述，只给简短要点。\n\n问题原文：\n' + question,
            ))
            return { kind: 'success', text: '已交给当前会话，通过 chatgpt_bridge_handoff 转给 ChatGPT Pro' }
          } catch (error) {
            return { kind: 'error', text: error.message }
          }
        },
      }),
    )
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'chatgpt_bridge_add_root',
      description: 'Expose one more local folder to the bridge (read-only). The path must exist.',
      parameters: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'Short alias ChatGPT uses to address this folder.' },
          path: { type: 'string', description: 'Absolute folder path.' },
          project: { type: 'string', description: 'Project name; omit to use the current session project.' },
        },
        required: ['alias', 'path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args, exec) {
        const cwd = await cwdForTool(exec)
        const project = args?.project === undefined ? projectForSession(state, exec?.agent?.id, cwd) : args.project
        if (!Object.hasOwn(state.projects, project)) return { ok: false, error: `未知项目：${project}` }
        const next = files.addRoot(rootsOf(state, project), args)
        if (next.error) return { ok: false, error: next.error }
        projectOf(state, project).roots = next.roots
        saveState(state)
        return { ok: true, project, roots: describeRoots(state, project) }
      },
    }),
  )
}
