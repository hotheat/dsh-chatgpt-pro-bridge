# dsh-chatgpt-pro-bridge

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle providing a read-only MCP bridge and a delegation driver that puts ChatGPT web behind a DSH session.

ChatGPT reads the folders you expose over MCP; DSH drives `chatgpt.com` in a plugin-owned Chrome window to send briefs (task, diff, test output) and read the answer back.

## What it provides

- **MCP endpoint** (read-only) with `workspace_info`, `resolve_root`, `read_file`, and `search` over N folders per project.
- **OAuth 2.1 gateway** on `127.0.0.1:7791`: authorization code + S256 PKCE, dynamic client registration, one-time pairing code, and a Bearer-gated `/mcp` proxy so the DSH UI is never exposed through the tunnel.
- **Lending desk (借阅台)**: a standalone Host-served page embedded in DSH (`ChatGPT Pro` in the sidebar) with projects, workspace/session actions, read-only folders, a connection ticket, and access records grouped by delegation.
- **Public tunnel** started with the plugin: `ngrok` with a static domain by default, or `cloudflare-quick` for a temporary address; the public address and pairing code appear on the plugin page.
- **Host tools**: `chatgpt_bridge_status`, `chatgpt_bridge_use`, `chatgpt_bridge_pairing`, `chatgpt_bridge_rotate_pairing`, `chatgpt_bridge_probe`, `chatgpt_bridge_browser`, `chatgpt_bridge_handoff`, and `chatgpt_bridge_add_root`.
- **Commands**: `/cg-use [project]` (inspect or bind the current session's project), `/cg-review` (review uncommitted changes), and `/cg-ask <question>` steer a user message into the current session agent and return immediately.
  The agent calls `chatgpt_bridge_handoff` once; the question and tool answer appear in the conversation, followed by a brief takeaway.

## Requirements

- DSH `>=0.2.1-rc.2`, Node.js `>=20`.
- Google Chrome for Testing (from the Playwright cache or Applications) or `/Applications/Google Chrome.app` as fallback.
  Set `config.browser.executablePath` or `DSH_CHATGPT_BRIDGE_BROWSER` to override automatic detection.
  Chrome runs with a dedicated profile and `--remote-debugging-port=9333`.
- **Tunnel (default: ngrok)**: ngrok v3 on `PATH` (`brew install ngrok`), an authtoken configured with `ngrok config add-authtoken <token>`, and the free static domain assigned to your ngrok account.
  The plugin starts ngrok without HTTP(S)/ALL proxy environment variables because the free plan rejects proxied agents; also remove any `proxy_url` from `ngrok.yml`.
- **Alternative tunnel**: `cloudflared` on `PATH` (`brew install cloudflared`) with `config.gateway.tunnel.provider: cloudflare-quick` for a temporary address.

## Install

```bash
dsh plugin --profile web add github:hotheat/dsh-chatgpt-pro-bridge
```

Restart `dsh web` after installing or updating so DSH loads the client bundle.

## Configure

Configure your tunnel domain in your DSH profile patch (for example `~/.dsh/profiles/web/cordis.patch.yml`), not inside the installed package:

```yaml
- id: dsh-chatgpt-pro-bridge
  config:
    gateway:
      port: 7791
      tunnel:
        provider: ngrok
        domain: your-static-domain.ngrok-free.app
```

- Set `domain` to your assigned ngrok hostname without `https://` or a path; the authtoken stays in ngrok's own config.
- To use Cloudflare Quick Tunnel instead, set `provider: cloudflare-quick` and omit `domain`.
- Optional browser settings under `config.browser`:
  - `executablePath`: custom Chrome/Chromium executable path (also supported via `DSH_CHATGPT_BRIDGE_BROWSER`).
  - `idleTimeoutMs`: idle auto-exit delay in milliseconds (default `600000` / 10 minutes; `0` disables auto-exit).
- Optional initial seed settings (only used when `~/.dsh/chatgpt-pro-bridge/state.json` does not exist yet): `project` (default `'default'`) and `roots` (`[{ alias, path }]`).

## Connect ChatGPT

1. Start (or restart) `dsh web` and open **ChatGPT Pro** in the DSH sidebar.
2. Copy the `https://<domain>/mcp` address and the 8-character pairing code from the ticket.
3. In ChatGPT, go to **Settings → Connectors** and create a connector with that URL.
4. Complete OAuth authorization in the browser: on ngrok's free plan, click **Visit Site** on the first browser warning, then enter the pairing code (the bridge rotates the code after authorization).
5. Click **打开登录窗口** on the lending desk page to sign into `chatgpt.com` inside the plugin-owned Chrome profile.

## State and workflow

Runtime state lives outside the package in `~/.dsh/chatgpt-pro-bridge/`:

- `state.json`: projects, read-only roots, session bindings, saved conversation URLs, delegation records, and last delegated project.
- `oauth.json`: registered OAuth clients, issued tokens, and pairing code.
- `chrome-profile/`: the dedicated browser profile used for `chatgpt.com`.

One connector serves all projects through `/api/chatgpt-bridge/mcp`.
During a delegation it exposes that delegation's project; while idle it exposes the last delegated project, falling back to the active project when that project is missing.
Each project keeps its read-only roots, an optional DSH workspace path, and one saved ChatGPT conversation URL.
Session bindings take priority over the longest matching cwd workspace or root, followed by the active project.

Open **ChatGPT Pro** in the DSH sidebar to use the lending desk (借阅台):

- The ticket shows the live MCP scope, pairing expiry, client/token counts, and a warning when a previously observed tunnel address changes. Use **已更新连接器** after updating the connector.
- The header pill shows **桥接浏览器 运行中** alongside the browser label, or **桥接浏览器 未启动** when stopped, with the idle auto-exit hint in its tooltip. Use **打开登录窗口** to open the bridge browser and **关闭浏览器** to exit it while idle.
- Before a queued delegation starts, a changed tunnel address blocks it without opening the browser. Both `/cg-review` and `/cg-ask` also check before steering a model turn and report the current address and the **已更新连接器** action. An empty public address does not block delegation.
- The ledger includes refused reads and completed or failed delegation results, with **本项目 / 全部** filters.
- Stopping the DSH session cancels its handoff: queued handoffs are skipped, and a running handoff attempts to stop ChatGPT generation. Use **停止** in the live delegation band or `chatgpt_bridge_browser(action="stop")` to cancel manually. While idle with the browser running, **停止网页生成** attempts to stop any generation left on the page. Cancelled ledger entries show **已取消**.
- Successful delegations store `mcpCalls`; zero calls add a warning above the tool answer and in its returned `warning` field, and show **未读取文件** in the ledger. If the answer mentions MCP errors, check whether the connector address is stale or the connector is enabled in that conversation.
- On the project page, choose a registered DSH workspace and click **新会话** to create a session there and bind it to the project. Bound sessions can be reopened with **打开**; `/cg-use <project>` binds an existing session.
- When creating a project, the selected workspace can also become its first read-only root. Changing or clearing the workspace association leaves the read-only roots unchanged.
- The project menu supports rename, conversation reset, and confirmed deletion; removed roots can be restored through the toast. Projects with running or queued delegations reject rename and deletion with HTTP 400 until their tasks finish.
- `chatgpt_bridge_handoff` accepts optional `includeChanges: true` to collect `git diff --no-color --unified=3` and `git status --porcelain -uall` from the session cwd (up to 8,000 status characters and 60,000 diff characters). `/cg-review` rejects a clean workspace immediately and otherwise requests this option.
- All delegation entries reuse the project's saved conversation unless `chatgpt_bridge_handoff` supplies an explicit `conversationUrl`. Only completed delegations save ChatGPT conversation URLs, provided the saved URL still matches their starting snapshot and no conversation reset occurred. **换新对话** clears the saved URL immediately, including during a delegation.

## Limits

- **Read-only**: no write tool, no shell, and no execution path. `.env`, `*.pem`, `id_rsa*`, and sensitive path components are always refused. `read_file` returns at most 400 lines and refuses files over 512 KiB; `search` scans at most 4,000 files, 8 levels deep.
- **ngrok**: the static domain stays the same across restarts, and persisted OAuth tokens (valid for 30 days, no refresh flow yet) let the existing connector reconnect until expiry. ngrok's free plan shows a browser warning on the first visit to the OAuth authorization page; click **Visit Site** to continue.
- **cloudflare-quick**: the temporary address changes whenever the bundle reloads; update the ChatGPT connector when it does.
- **Serial delegation**: `chatgpt_bridge_handoff`, `/cg-review`, and `/cg-ask` share one queue—one handoff at a time for the plugin's browser page. Browser login, close, status, probe, and debug share the same owner and reject requests while a delegation is queued or running. The management page's connection indicator only reads the CDP endpoint and remains available during delegation.
- **On-demand Chrome & idle exit**: Chrome launches on demand for login, delegation, or diagnostics. `chatgpt_bridge_browser(action="status")` and idle `stop` do not launch Chrome. The bridge exits Chrome after 10 minutes of inactivity by default (`config.browser.idleTimeoutMs`, `0` disables auto-exit).
- **Reply completion**: replies finish after their text stabilizes and the streaming indicator disappears. Text remaining unchanged for 12 seconds while streaming continues does not end the wait. The total timeout returns a failure with partial text and the character count read.

## Development & uninstall

From a local clone:

```bash
npm install
npm test
```

`index.js` adapts DSH tools and HTTP routes to `projects.js` (pure project transitions), `files.js` (read-only root and file access), and `delegation.js` (reply completion and shared browser ownership). `driver.js` supplies browser detection and CDP/Playwright operations. `npm test` (`node --test test/`) checks these modules and the registered plugin entry points with a fake browser.

To uninstall from DSH:

```bash
dsh plugin --profile web remove dsh-chatgpt-pro-bridge
```

## License

[MIT](LICENSE) © 2026 hotheat
