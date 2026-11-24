# ChatGPT Pro bridge

A local, read-only MCP endpoint over the folders of one project, with the OAuth gateway and public tunnel that let your ChatGPT web connector reach it.

## What works today

- **MCP endpoint**: `/api/chatgpt-bridge/mcp` on the DSH web server, JSON-RPC over HTTP.
  The single connector follows the running delegation's project, then the last delegated project if it still exists, then the active project.
  `/api/chatgpt-bridge/mcp/<project>` selects an existing project explicitly and returns 404 for an unknown project.
  Tools: `workspace_info`, `resolve_root`, `read_file`, `search`.
  Reads stay inside the selected project's registered folders; `.env`, `*.pem`, `id_rsa*` and similar names are refused.
- **Gateway** on `127.0.0.1:7791`: OAuth 2.1 authorization-code + S256 PKCE, dynamic client registration, one-time pairing code, Bearer-gated `/mcp` proxy. It is the only process the tunnel points at, so the DSH UI is never exposed.
- **Tunnel**: ngrok with a static domain by default, or `cloudflare-quick` for a temporary address; the public address, pairing code, and tunnel errors appear in the plugin page and in `chatgpt_bridge_status`.
  `tunnel.js` owns provider selection and child processes; `gateway.js` uses only its `start`, `stop`, and `status` port.
- **Host tools**: `chatgpt_bridge_status`, `chatgpt_bridge_pairing`, `chatgpt_bridge_rotate_pairing`, `chatgpt_bridge_probe`, `chatgpt_bridge_add_root`.

## Delegate a task

`chatgpt_bridge_handoff` drives the plugin-owned Chrome window: it puts the brief (task, diff, test output) into the chatgpt.com composer, sends it, waits for stable text with no streaming indicator, and returns the text.
A total timeout returns `ok: false`, its reason, partial text, and the number of characters read; 12 seconds of stable text while streaming continues does not complete the reply.
The driver connects over CDP to a separate Chrome process with a dedicated profile that retains the login across browser restarts and plugin reloads.
It prefers Google Chrome for Testing from the Playwright cache or Applications, then falls back to `/Applications/Google Chrome.app`.
`config.browser.executablePath` or `DSH_CHATGPT_BRIDGE_BROWSER` overrides automatic detection.

`/cg-ask <question>` steers a user message into the current session agent and returns immediately.
The message instructs the agent to call `chatgpt_bridge_handoff` once with the question verbatim as `task`, without answering first.
`/cg-review` checks `git diff` and `git status --porcelain -uall` in the session cwd and immediately rejects a clean workspace.
Otherwise it steers the same tool request with task `审查这份未提交的改动，指出最该修的地方。` and `includeChanges: true`.
Both commands leave the question and tool answer visible in the conversation and request only a brief takeaway after the tool returns.
The plugin constructs an identified, deeply frozen text-only user message matching the upstream `createUserMessage` contract and calls `agent.steer`.

The optional boolean `includeChanges` makes the tool collect `git diff --no-color --unified=3` and `git status --porcelain -uall` from the session cwd itself.
The shared brief builder truncates status to 8000 characters, diff to 60000, and test output to 20000.
When `includeChanges` is true, collected changes replace the optional `diff` argument and the delegation kind is `review`; otherwise it is `tool`.

`chatgpt_bridge_handoff`, `/cg-review`, and `/cg-ask` share one delegation queue.
The session binding selects the project first, followed by the longest matching cwd workspace or root and the active project.
The MCP scope follows that project until the handoff finishes, including when it fails, and the last delegated project is saved in `state.json`.
The tool's DSH abort signal cancels a running handoff or skips its queued turn before any record or browser work starts.
Running cancellations attempt to stop ChatGPT generation and finish the record with `ok: false`, `cancelled: true`, and an error message; the tool returns the same cancellation fields.
The Host serves the standalone lending desk at `/api/chatgpt-bridge/page/` with its own stylesheet and fixed asset routes.
`client.js` embeds it in an iframe and sends registered workspace paths, session ids, and titles through `cg:context`, reposting when the session list changes.
`/status` also provides `sessionTitles` for bound sessions; the lending desk displays the title above the short session id and shows `会话` when no title is available.
`cg:new-session` and `cg:open-session` requests receive `cg:result` with the matching `requestId`; both halves check the same-origin frame relationship.
The page polls status every two seconds during a delegation and every six seconds while idle, pausing when hidden and preserving input drafts.

Both `/status` and `chatgpt_bridge_status` report the current scope in `exposedProject` and the running project in `delegating` (`null` while idle).
They also expose the live `delegation`, recent `delegations`, tunnel acknowledgement state, and browser state including the label, idle timeout, and scheduled exit time.
The ledger joins calls to delegation records for completion time, character count or error; consecutive calls outside a delegation form direct-question groups.
At plugin startup, delegation records without a finish time are marked as interrupted failures and saved with the current time.
Refused sensitive reads remain visible in the ledger.
After a successful handoff, `mcpCalls` counts retained `state.calls` entries whose `delegation` matches its id.
Zero calls add a Chinese `warning` to the return value and delegation record, prefix the rendered tool output with it, and show **未读取文件** in the ledger.
The warning explains that ChatGPT read nothing through the bridge and that MCP errors may indicate a stale connector address or a connector disabled in that conversation.
Their `projects` entries also include `workspace`, `conversationUrl`, and explicitly bound session ids in `sessions`; the top-level `bindings` map contains all explicit bindings.

Each project has an optional DSH workspace and a saved ChatGPT conversation URL alongside its read-only roots.
The project page lists registered workspaces, creates and binds new sessions with **新会话**, and reopens bound sessions with **打开**.
Session creation requires a workspace registered in DSH; the page subscribes to the current session before starting it, waits up to 15 seconds for a new id, then persists the binding.
`/cg-use <project>` binds an existing session; cwd inference uses the longest path-boundary match across workspaces and read-only roots.

All three delegation entries read the project's saved conversation URL when their turn in the shared queue starts.
An explicit `chatgpt_bridge_handoff.conversationUrl` takes priority.
A completed handoff (`ok: true`) saves `https://chatgpt.com/c/...` or `https://chatgpt.com/g/.../c/...` URLs only if the project still exists, its saved URL matches the starting snapshot, and no conversation reset occurred.
**换新对话** clears the saved URL immediately and prevents that running handoff from restoring it, including when the starting URL was `null`.
When no conversation URL is supplied and the browser is on a ChatGPT conversation, the driver opens the ChatGPT home page before sending the brief to start a new conversation.

`POST /api/chatgpt-bridge/config` accepts these project operations:

- `{ createProject, workspace?, seedRoot? }` creates a project with an optional existing absolute workspace directory.
  With `seedRoot: true`, that workspace becomes the first read-only root, using its basename as alias (`root` for `/`).
- `{ setWorkspace: { project, workspace } }` updates the workspace association; `workspace: null` clears it without changing roots.
- `{ resetConversation: project }` clears the saved conversation URL.
- `{ renameProject: { from, to } }` renames the specified project and rejects duplicate names.
- `{ deleteProject: project }` removes the project and its bindings; at least one project must remain.

`POST /api/chatgpt-bridge/bind` accepts `{ session, project }` and persists an explicit binding, or deletes it when `project` is `null`.
The session must be a non-empty string and a named project must exist; invalid values return HTTP 400.
Renaming a project preserves its workspace, conversation URL and bindings; deleting it clears its bindings.
Projects register as busy on enqueue and stay busy until their individual task finishes.
Rename and deletion of a busy project return HTTP 400 with `{ error }`; conversation reset remains available.
State remains at v2, with missing workspace and conversation URL fields treated as `null`.

`POST /api/chatgpt-bridge/roots` accepts an optional `project` and defaults to the active project.
`chatgpt_bridge_add_root` accepts an optional `project` and defaults to the current session's project using the same binding and cwd rules.
Both return the selected `project` and its `roots`.
The `roots` field in `POST /api/chatgpt-bridge/config` edits the active project.
Root paths must be existing directories; `/roots` expands `~` and `~/...`.
`/roots { project, remove: alias }` removes a root registration; the lending desk toast can re-add its alias and path.

`chatgpt_bridge_browser` accepts `status` (default), `probe`, `debug`, `login`, `stop`, and `close` actions.
`stop` shares its handler with `POST /api/chatgpt-bridge/delegation/stop` and the lending desk's **停止** / **停止网页生成** controls.
While a delegation is running, it requests manual cancellation and returns `{ ok: true, cancelled: <id> }`.
While idle, it attempts to stop page generation and returns `{ ok: true, cancelled: null, stopped: <bool> }`.
Status, probe, debug, login, and close share browser ownership with delegations and reject requests while a delegation is running or queued.
The running stop path aborts the delegation directly; idle stop acquires browser ownership before stopping page generation.
A delegation waits for a browser operation that started before it was queued.
Chrome launches on demand for delegation, login, or diagnostics.
`status` and idle `stop` do not launch Chrome, and idle `stop` returns `stopped: false` when the browser is down.
Delegations and browser operations cancel the pending idle timer when they start.
The bridge closes a connected browser after 10 idle minutes by default, with `config.browser.idleTimeoutMs` controlling the delay and `0` disabling auto-exit.
`close` cancels the timer and shuts down the Chrome process via CDP, with SIGTERM as a fallback for the process launched by the driver.
The management status connection check only reads the CDP endpoint and does not acquire a browser page.

## Connect ChatGPT

1. Install ngrok v3 (`brew install ngrok`) and configure its authtoken with `ngrok config add-authtoken <token>`.
2. Set `config.gateway.tunnel.provider: ngrok` and `config.gateway.tunnel.domain` under the `dsh-chatgpt-pro-bridge` entry in your DSH profile patch (`~/.dsh/profiles/web/cordis.patch.yml`) to your account's assigned static hostname, such as `xxx.ngrok-free.app`.
   Use the hostname without `https://` or a path; the authtoken stays in ngrok's own config.
   A missing domain reports an error and leaves the tunnel stopped.
3. Start DSH and open **ChatGPT Pro** in the sidebar; copy the `https://<domain>/mcp` address and the code.
4. ChatGPT → Settings → Connectors → create one with that address.
5. The authorization page opens; on ngrok's free plan, click **Visit Site** on the first browser warning, then type the pairing code.
   Codes contain eight characters, displayed as 4+4 on the ticket; the bridge rotates the code after authorization.

**打开登录窗口** posts to `/api/chatgpt-bridge/browser/login` to open the bridge browser for sign-in.
The pill shows **桥接浏览器 运行中** and the browser label when CDP is reachable, and **桥接浏览器 未启动** when CDP is unreachable.
The tooltip shows the idle auto-exit hint.
**关闭浏览器** is disabled during a delegation and posts to `/api/chatgpt-bridge/browser/close` when clicked while idle.
The page then refreshes status and shows **已关闭桥接浏览器**.
The first observed public tunnel URL is acknowledged automatically and persisted; a later different URL triggers the ticket warning.
Before every queued delegation starts, the tunnel preflight rejects a changed address without touching the browser.
Both slash commands also run this check before steering a user message, returning an immediate error with the current public URL.
The error asks the user to update the ChatGPT connector and click **已更新连接器** on the 借阅台 page.
An empty public URL does not block delegation; the post-delegation MCP check still applies.
After updating the connector, **已更新连接器** posts to `/api/chatgpt-bridge/tunnel/ack`.

## Limits

- The plugin starts ngrok without HTTP(S)/ALL proxy environment variables because the free plan rejects proxied agents; also remove any `proxy_url` from `ngrok.yml`.
- The ngrok static domain and persisted OAuth tokens let the same connector reconnect after restart until the tokens expire.
- ngrok's free plan shows a browser warning before the OAuth authorization page on the first visit; click **Visit Site** to continue.
- With `config.gateway.tunnel.provider: cloudflare-quick`, install `cloudflared` on `PATH`; its address changes on every restart, requiring a connector update.
- Read-only: there is no write tool, no shell, and no execution path.
- `read_file` returns at most 400 lines and refuses files over 512 KiB; `search` scans at most 4000 files, 8 levels deep.
- Tokens last 30 days; there is no refresh flow yet.
