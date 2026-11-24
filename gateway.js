/**
 * Local OAuth 2.1 gateway in front of the read-only MCP endpoint.
 *
 * The MCP server itself stays on the DSH web server (loopback, no auth). This
 * gateway is the only process a tunnel points at, so the public surface is:
 * OAuth metadata, dynamic client registration, the pairing form, the token
 * endpoint, and a Bearer-protected /mcp proxy. It mirrors the contract the
 * ChatGPT connector already speaks: authorization_code + S256 PKCE, one-time
 * pairing code, opaque access token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createTunnel } from './tunnel.js'

const SCOPES = ['bridge.read']
const CODE_TTL_MS = 5 * 60 * 1000
const PAIRING_TTL_MS = 24 * 60 * 60 * 1000
const TOKEN_TTL_S = 30 * 24 * 60 * 60
const PENDING_TTL_MS = 10 * 60 * 1000

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function newPairingCode() {
  let code = ''
  const bytes = randomBytes(8)
  for (let index = 0; index < 8; index += 1) code += ALPHABET[bytes[index] % ALPHABET.length]
  return code
}

function base64UrlSha256(value) {
  return createHash('sha256').update(value).digest('base64url')
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function isAllowedRedirect(uri) {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function pairingPage({ requestId, pairingHint, error }) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配对 ChatGPT 与本地桥</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfbfa;color:#21211d;
font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.card{width:min(420px,92vw);background:#fff;border:1px solid rgba(24,24,21,.12);border-radius:14px;padding:26px 24px}
h1{font-size:17px;margin:0 0 6px;font-weight:600}
p{margin:0 0 16px;color:rgba(33,33,29,.62);font-size:12.5px}
input{width:100%;box-sizing:border-box;font:600 20px/1 ui-monospace,Menlo,monospace;letter-spacing:.28em;
text-transform:uppercase;padding:11px 12px;border:1px solid rgba(24,24,21,.18);border-radius:9px;background:#fff;color:inherit}
button{margin-top:14px;width:100%;padding:9px;border:0;border-radius:9px;background:#21211d;color:#fff;font:500 13px inherit;cursor:pointer}
.err{margin:0 0 12px;padding:8px 10px;border-radius:8px;background:rgba(191,59,47,.08);color:#7d241b;font-size:12px}
.hint{margin-top:14px;font-size:11.5px;color:rgba(33,33,29,.42)}
@media (prefers-color-scheme:dark){body{background:#16161a;color:#ececee}.card{background:#1e1e23;border-color:rgba(255,255,255,.12)}
p{color:rgba(236,236,238,.62)}input{background:#16161a;border-color:rgba(255,255,255,.18)}button{background:#ececee;color:#16161a}}
</style></head><body><div class="card">
<h1>配对 ChatGPT 与本地桥</h1>
<p>这是一个本机请求，确认它来自你之后，输入 DSH 里显示的配对码。</p>
${error ? `<div class="err">${htmlEscape(error)}</div>` : ''}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request_id" value="${htmlEscape(requestId)}">
  <input name="pairing_code" autocomplete="one-time-code" inputmode="latin" maxlength="8" placeholder="XXXXXXXX" autofocus>
  <button type="submit">授权</button>
</form>
<div class="hint">配对码在 DSH 的插件页或 chatgpt_bridge_status 里；输错三次会作废。</div>
</div></body></html>`
}

export function startGateway({ port, dataDir, innerBase, tunnel: tunnelConfig, log = () => {} }) {
  const tunnel = createTunnel({ ...tunnelConfig, port, log })
  const storeFile = join(dataDir, 'oauth.json')
  let store
  try {
    store = JSON.parse(readFileSync(storeFile, 'utf8'))
  } catch {
    store = {}
  }
  store.clients ||= {}
  store.codes ||= {}
  store.tokens ||= {}
  store.pending ||= {}
  store.pairing ||= { code: newPairingCode(), createdAt: Date.now(), failures: 0, used: false }

  const persist = () => {
    try {
      writeFileSync(storeFile, JSON.stringify(store, null, 2))
    } catch (error) {
      log(`oauth state 写入失败：${error.message}`)
    }
  }

  const rotatePairing = () => {
    store.pairing = { code: newPairingCode(), createdAt: Date.now(), failures: 0, used: false }
    persist()
    return store.pairing.code
  }

  const baseUrl = (req) => {
    const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`
    // ngrok appends the original request protocol to this header.
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',').at(-1).trim()
    return `${proto}://${host}`
  }

  const sendJson = (res, status, payload, extra = {}) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
    res.end(body)
  }

  const sendHtml = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  const readBody = async (req, limit = 512 * 1024) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  const authorized = (req) => {
    const header = String(req.headers.authorization || '')
    if (!header.toLowerCase().startsWith('bearer ')) return false
    const token = store.tokens[header.slice(7).trim()]
    return Boolean(token && token.expiresAt > Date.now())
  }

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    const path = url.pathname
    const base = baseUrl(req)

    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return sendJson(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
        resource_name: 'DSH ChatGPT Pro Bridge',
      })
    }
    if (
      path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/oauth-authorization-server/mcp' ||
      path === '/.well-known/openid-configuration'
    ) {
      return sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: SCOPES,
      })
    }
    if (path === '/oauth/register' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri) => isAllowedRedirect(uri)) : []
      if (!redirects.length) return sendJson(res, 400, { error: 'invalid_redirect_uri' })
      const clientId = randomToken(16)
      store.clients[clientId] = { clientId, name: String(body.client_name || '').slice(0, 120), redirects, createdAt: Date.now() }
      persist()
      return sendJson(res, 201, {
        client_id: clientId,
        client_name: store.clients[clientId].name || undefined,
        redirect_uris: redirects,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      })
    }
    if (path === '/oauth/authorize' && req.method === 'GET') {
      const clientId = url.searchParams.get('client_id') || ''
      const redirectUri = url.searchParams.get('redirect_uri') || ''
      const challenge = url.searchParams.get('code_challenge') || ''
      const method = url.searchParams.get('code_challenge_method') || ''
      const client = store.clients[clientId]
      if (!client) return sendHtml(res, 400, pairingPage({ requestId: '', pairingHint: '', error: '未知客户端，请在 ChatGPT 里重新添加连接器。' }))
      if (!client.redirects.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
        return sendHtml(res, 400, pairingPage({ requestId: '', pairingHint: '', error: '回调地址不允许。' }))
      }
      if (!challenge || method !== 'S256') {
        return sendHtml(res, 400, pairingPage({ requestId: '', pairingHint: '', error: '需要 S256 PKCE。' }))
      }
      const requestId = randomToken(12)
      store.pending[requestId] = {
        clientId,
        redirectUri,
        challenge,
        state: url.searchParams.get('state') || '',
        resource: url.searchParams.get('resource') || '',
        createdAt: Date.now(),
      }
      for (const [key, value] of Object.entries(store.pending)) {
        if (Date.now() - value.createdAt > PENDING_TTL_MS) delete store.pending[key]
      }
      persist()
      return sendHtml(res, 200, pairingPage({ requestId, pairingHint: '', error: '' }))
    }
    if (path === '/oauth/authorize' && req.method === 'POST') {
      const raw = await readBody(req)
      const form = new URLSearchParams(raw)
      const requestId = form.get('request_id') || ''
      const code = (form.get('pairing_code') || '').trim().toUpperCase()
      const pending = store.pending[requestId]
      if (!pending) return sendHtml(res, 400, pairingPage({ requestId: '', pairingHint: '', error: '这次授权已过期，请回到 ChatGPT 重新连接。' }))
      const pairing = store.pairing
      if (Date.now() - pairing.createdAt > PAIRING_TTL_MS) {
        return sendHtml(res, 410, pairingPage({ requestId, pairingHint: '', error: '配对码已过期，请在 DSH 里重新生成。' }))
      }
      if (!safeEqual(code, pairing.code)) {
        pairing.failures += 1
        persist()
        if (pairing.failures >= 3) {
          rotatePairing()
          return sendHtml(res, 410, pairingPage({ requestId, pairingHint: '', error: '错误次数过多，配对码已作废。' }))
        }
        return sendHtml(res, 401, pairingPage({ requestId, pairingHint: '', error: `配对码不对，还剩 ${3 - pairing.failures} 次。` }))
      }
      const authCode = randomToken(24)
      store.codes[authCode] = { ...pending, createdAt: Date.now() }
      delete store.pending[requestId]
      rotatePairing()
      persist()
      const redirect = new URL(pending.redirectUri)
      redirect.searchParams.set('code', authCode)
      if (pending.state) redirect.searchParams.set('state', pending.state)
      res.writeHead(302, { location: redirect.toString() })
      return res.end()
    }
    if (path === '/oauth/token' && req.method === 'POST') {
      const raw = await readBody(req)
      const isJson = String(req.headers['content-type'] || '').includes('application/json')
      const body = isJson ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw))
      if (body.grant_type !== 'authorization_code') return sendJson(res, 400, { error: 'unsupported_grant_type' })
      const record = store.codes[body.code]
      if (!record || record.clientId !== body.client_id) return sendJson(res, 400, { error: 'invalid_grant' })
      if (Date.now() - record.createdAt > CODE_TTL_MS) {
        delete store.codes[body.code]
        persist()
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code expired' })
      }
      if (body.redirect_uri && body.redirect_uri !== record.redirectUri) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
      if (!safeEqual(base64UrlSha256(body.code_verifier || ''), record.challenge)) {
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      }
      delete store.codes[body.code]
      const accessToken = randomToken(32)
      store.tokens[accessToken] = { clientId: record.clientId, scopes: SCOPES, expiresAt: Date.now() + TOKEN_TTL_S * 1000 }
      persist()
      log(`issued token for client ${record.clientId}`)
      return sendJson(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: SCOPES.join(' ') })
    }
    if (path === '/mcp') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!authorized(req)) {
        return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
      }
      const payload = await readBody(req, 2 * 1024 * 1024)
      const upstream = await fetch(`${innerBase}/api/chatgpt-bridge/mcp`, {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] || 'application/json', accept: 'application/json' },
        body: payload,
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
      return res.end(text)
    }
    return sendJson(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`gateway 处理失败：${error.message}`)
      if (!res.headersSent) sendJson(res, 500, { error: error.message })
      else res.end()
    })
  })

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          log(`gateway listening on 127.0.0.1:${port}`)
          tunnel.start()
          resolve()
        })
      })
    },
    status() {
      const { provider, state, publicBase, error } = tunnel.status()
      return {
        port,
        provider: state === 'online' ? provider : state,
        publicUrl: publicBase ? `${publicBase}/mcp` : '',
        tunnelState: state,
        tunnelError: error,
        localUrl: `http://127.0.0.1:${port}/mcp`,
        pairingCode: store.pairing.code,
        pairingExpiresAt: new Date(store.pairing.createdAt + PAIRING_TTL_MS).toISOString(),
        clients: Object.keys(store.clients).length,
        tokens: Object.keys(store.tokens).length,
      }
    },
    rotate() {
      return rotatePairing()
    },
    close() {
      tunnel.stop()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
