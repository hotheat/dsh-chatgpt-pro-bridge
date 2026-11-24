import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

function processTunnel({ provider, command, args, env, configError = '', scan, missingError, exitError, log }) {
  let state = configError ? 'error' : 'off'
  let publicBase = ''
  let error = configError
  let child

  const fail = (message) => {
    state = 'error'
    publicBase = ''
    error = message
    log(message)
  }

  return {
    start() {
      if (child) return
      if (configError) return fail(configError)
      state = 'starting'
      publicBase = ''
      error = ''
      let lastError = ''
      const running = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
      child = running
      for (const stream of [running.stdout, running.stderr]) {
        createInterface({ input: stream }).on('line', (line) => {
          if (child !== running) return
          const result = scan(line)
          if (result?.error) lastError = result.error
          if (result?.publicBase && !publicBase) {
            publicBase = result.publicBase
            state = 'online'
            log(`tunnel ready: ${publicBase}`)
          }
        })
      }
      running.on('error', (cause) => {
        if (child !== running) return
        fail(cause.code === 'ENOENT' ? missingError : `${command} 启动失败：${cause.message}`)
      })
      // close waits for both log streams, including the final error line.
      running.on('close', (code, signal) => {
        if (child !== running) return
        child = undefined
        publicBase = ''
        if (state === 'error') return
        if (code !== 0) return fail(exitError(code ?? signal, lastError))
        state = 'off'
        log(`${command} exited (${code})`)
      })
    },
    stop() {
      const running = child
      child = undefined
      state = 'off'
      publicBase = ''
      error = ''
      running?.kill('SIGTERM')
    },
    status() {
      return { provider, state, publicBase, error }
    },
  }
}

function ngrokTunnel({ port, domain, log }) {
  // ngrok's free plan rejects proxied agents (ERR_NGROK_9009).
  const env = { ...process.env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  return processTunnel({
    provider: 'ngrok',
    command: 'ngrok',
    args: ['http', `127.0.0.1:${port}`, `--url=https://${domain}`, '--log=stdout', '--log-format=json'],
    env,
    configError: domain ? '' : '请在 profile 的 cordis.patch.yml 中设置 config.gateway.tunnel.domain 为 ngrok 静态域名。',
    missingError: 'ngrok 未安装：请运行 brew install ngrok，然后运行 ngrok config add-authtoken <token>。',
    scan(line) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        return line.includes('ERR_NGROK_') ? { error: line } : null
      }
      if (entry?.msg === 'started tunnel' && entry.url) return { publicBase: `https://${domain}` }
      if (['eror', 'error', 'crit'].includes(entry?.lvl) || entry?.err || line.includes('ERR_NGROK_')) return { error: line }
    },
    exitError: (code, lastError) => `ngrok 已退出（${code}）${lastError ? `：${lastError}` : ''}${lastError.includes('ERR_NGROK_9009') ? '；检查 ngrok.yml 中的 proxy_url（免费版不支持经代理连接）' : ''}`,
    log,
  })
}

function cloudflareQuickTunnel({ port, log }) {
  return processTunnel({
    provider: 'cloudflare-quick',
    command: 'cloudflared',
    args: ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
    missingError: 'cloudflared 未安装：请运行 brew install cloudflared。',
    scan(line) {
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match) return { publicBase: match[0] }
    },
    exitError: (code) => `cloudflared 已退出（${code}）；重启后地址会变`,
    log,
  })
}

export function createTunnel({ provider = 'ngrok', port, domain, log = () => {} }) {
  if (provider === 'ngrok') return ngrokTunnel({ port, domain, log })
  if (provider === 'cloudflare-quick') return cloudflareQuickTunnel({ port, log })
  return processTunnel({ provider, configError: `未知隧道提供方：${provider}。请选择 ngrok 或 cloudflare-quick。`, log })
}
