# dsh-chatgpt-pro-bridge

[English](README.md) | 简体中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：提供只读 MCP 桥接与委托驱动，将 ChatGPT 网页版接入 DSH 会话。

ChatGPT 通过只读 MCP 读取你授权的本地目录；DSH 在插件托管的独立 Chrome 窗口中驱动 `chatgpt.com`，自动提交任务简报（问题、改动 diff、测试输出）并回收回答。

## 提供的能力

- **只读 MCP 端点**：按项目暴露多个只读文件夹，提供 `workspace_info`、`resolve_root`、`read_file`、`search` 四个工具。
- **本地 OAuth 2.1 网关**（`127.0.0.1:7791`）：支持授权码 + S256 PKCE、动态客户端注册、一次性配对码与 Bearer 鉴权的 `/mcp` 代理；隧道只指向网关，不暴露 DSH 界面。
- **借阅台管理页**：Host 托管的独立页面，嵌入 DSH 左侧栏 **ChatGPT Pro**，用于管理项目、关联工作区/会话、只读文件夹、连接器凭证，以及按委托分组的访问记录。
- **公网隧道**：随插件自动启动，默认使用带静态域名的 `ngrok`，也支持临时地址的 `cloudflare-quick`；公网地址和配对码直接显示在借阅台页面。
- **Host 工具**：`chatgpt_bridge_status`、`chatgpt_bridge_use`、`chatgpt_bridge_pairing`、`chatgpt_bridge_rotate_pairing`、`chatgpt_bridge_probe`、`chatgpt_bridge_browser`、`chatgpt_bridge_handoff`、`chatgpt_bridge_add_root`。
- **斜杠命令**：`/cg-use [项目名]`（查看或绑定当前会话所属项目）、`/cg-review`（审查当前目录未提交改动）、`/cg-ask <问题>`（将问题转交给 ChatGPT）。后两个命令会向当前会话注入一条用户消息并立即返回，由 Agent 调用一次 `chatgpt_bridge_handoff`，完整回答显示在工具卡片中，随后仅附简短要点。

## 环境要求

- DSH `>=0.2.1-rc.2`，Node.js `>=20`。
- 浏览器优先使用 Playwright 缓存或 Applications 中的 Google Chrome for Testing，找不到时回退到 `/Applications/Google Chrome.app`。
  可通过 `config.browser.executablePath` 或环境变量 `DSH_CHATGPT_BRIDGE_BROWSER` 覆盖自动探测。
  Chrome 使用独立 profile 与 `--remote-debugging-port=9333` 启动。
- **默认隧道（ngrok）**：`PATH` 中安装 ngrok v3（`brew install ngrok`），先执行 `ngrok config add-authtoken <token>`，并准备 ngrok 账号分配的免费静态域名。
  插件启动 ngrok 时会剥离 HTTP(S)/ALL 代理环境变量（免费版拒绝经代理连接），同时请确保 `ngrok.yml` 中没有 `proxy_url`。
- **备选隧道**：`PATH` 中安装 `cloudflared`（`brew install cloudflared`），并配置 `config.gateway.tunnel.provider: cloudflare-quick`。

## 安装

```bash
dsh plugin --profile web add github:hotheat/dsh-chatgpt-pro-bridge
```

该插件包含前端 client bundle，安装或更新后需要重启 `dsh web` 才会生效。

## 配置

请在你自己的 DSH profile patch（例如 `~/.dsh/profiles/web/cordis.patch.yml`）中配置隧道域名，不要直接修改插件包内文件：

```yaml
- id: dsh-chatgpt-pro-bridge
  config:
    gateway:
      port: 7791
      tunnel:
        provider: ngrok
        domain: your-static-domain.ngrok-free.app
```

- `domain` 填 ngrok 分配的纯主机名，不要带 `https://` 或路径；authtoken 保留在 ngrok 自身配置中。
- 如改用 Cloudflare Quick Tunnel，将 `provider` 设为 `cloudflare-quick` 并省略 `domain` 即可。
- 可选浏览器配置（位于 `config.browser` 下）：
  - `executablePath`：指定 Chrome / Chromium 可执行文件路径（也支持环境变量 `DSH_CHATGPT_BRIDGE_BROWSER`）。
  - `idleTimeoutMs`：空闲自动关闭浏览器的延迟毫秒数，默认 `600000`（10 分钟），设为 `0` 关闭自动退出。
- 可选首次初始化配置（仅在 `~/.dsh/chatgpt-pro-bridge/state.json` 尚不存在时生效）：`project`（默认 `'default'`）与 `roots`（`[{ alias, path }]`）。

## 接入 ChatGPT

1. 启动（或重启）`dsh web`，在左侧栏打开 **ChatGPT Pro**（借阅台）。
2. 从凭证卡片复制 `https://<domain>/mcp` 地址和 8 位配对码（按 4+4 分组显示）。
3. 打开 ChatGPT → **设置 → 连接器（Connectors）** → 新建连接器并填入上述地址。
4. 在弹出的浏览器授权页完成 OAuth 授权：使用 ngrok 免费版首次访问时会看到提示页，点击 **Visit Site** 后输入配对码（授权后配对码自动轮换）。
5. 在借阅台点击 **打开登录窗口**，在插件专用 Chrome 窗口中登录 `chatgpt.com`。

## 运行状态与工作流

运行态数据保存在插件包外，位于 `~/.dsh/chatgpt-pro-bridge/`：

- `state.json`：项目列表、只读目录、会话绑定、已保存的 ChatGPT 对话链接、委托记录与最近一次委托的项目。
- `oauth.json`：已注册的 OAuth 客户端、已签发 token 与当前配对码。
- `chrome-profile/`：用于 `chatgpt.com` 的独立浏览器配置目录。

所有项目共用同一个连接器地址 `/api/chatgpt-bridge/mcp`。
委托执行期间，MCP 作用域切换为本次委托对应的项目；空闲时保持为最近一次委托的项目，若该项目已删除则回退到当前激活项目。
每个项目独立维护只读文件夹、可选关联的 DSH 工作区路径，以及一条可复用的 ChatGPT 对话 URL。
项目解析优先级：当前会话的显式绑定 > 匹配当前工作目录最长的项目工作区或只读目录 > 当前激活项目。

在侧栏 **ChatGPT Pro** 借阅台中：

- 凭证区展示当前生效的 MCP 作用域、配对码过期时间、客户端/token 数量；当观测到的隧道公网地址变化时会弹出提醒，更新 ChatGPT 连接器后点击 **已更新连接器** 确认。
- 顶部状态胶囊显示 **桥接浏览器 运行中**（附浏览器标签）或 **桥接浏览器 未启动**，悬浮提示显示空闲自动退出时间；可用 **打开登录窗口** 拉起浏览器，空闲时可用 **关闭浏览器** 退出进程。
- 队列中的委托开始前，若检测到隧道地址变更会直接拦截而不拉起浏览器；`/cg-review` 与 `/cg-ask` 在触发模型回合前也会做同样检查并提示当前地址与 **已更新连接器** 操作。公网地址为空时不阻塞委托。
- 右侧访问记录展示被拒绝的敏感文件读取以及委托成功/失败结果，支持 **本项目 / 全部** 筛选。
- 停止 DSH 会话会自动取消对应委托：排队中的委托直接跳过，运行中的委托会尝试停止 ChatGPT 网页生成。也可在实时委托条点击 **停止** 或调用 `chatgpt_bridge_browser(action="stop")` 手动取消；浏览器空闲运行时，**停止网页生成** 会尝试中止页面上残留的生成任务。被取消的记录标记为 **已取消**。
- 委托成功后会记录 `mcpCalls`；若调用次数为 0，会在工具回答顶部和返回值 `warning` 字段添加警告，并在账本显示 **未读取文件**。若回答提到 MCP 错误，请检查连接器地址是否过期或当前对话是否启用了连接器。
- 在项目页选择已登记的 DSH 工作区并点击 **新会话**，可在该工作区创建会话并自动绑定到当前项目；已绑定会话可点击 **打开** 回到对应会话，也可用 `/cg-use <项目名>` 绑定已有会话。
- 新建项目时可顺带把所选工作区作为第一个只读目录；后续修改或清空关联工作区不会改动只读目录。
- 项目菜单支持重命名、**换新对话**（重置已保存对话 URL）与二次确认删除；移除只读目录后可通过 toast 撤销恢复。存在运行中或排队中委托的项目会拒绝重命名与删除（HTTP 400），直到任务结束。
- `chatgpt_bridge_handoff` 支持可选参数 `includeChanges: true`，由工具自动采集当前会话目录的 `git diff --no-color --unified=3` 与 `git status --porcelain -uall`（状态最多 8,000 字符，diff 最多 60,000 字符），无需 Agent 把 diff 粘贴进参数。`/cg-review` 遇到干净工作区会立即报错，否则自动携带该选项发起审查。
- 所有委托入口都会复用项目已保存的对话 URL，除非 `chatgpt_bridge_handoff` 显式传入 `conversationUrl`。只有成功完成的委托，且起始快照与当前已保存 URL 一致、期间未执行过对话重置时，才会回写新的对话 URL；**换新对话** 会立即清空已保存 URL（含委托进行中）。

## 边界与限制

- **严格只读**：无写文件工具、无 shell、无代码执行路径；`.env`、`*.pem`、`id_rsa*` 等敏感路径片段始终拒绝读取。`read_file` 单次最多返回 400 行且拒绝超过 512 KiB 的文件；`search` 最多扫描 4,000 个文件、深度 8 层。
- **ngrok**：静态域名跨重启保持不变，持久化 OAuth token（有效期 30 天，暂未实现 refresh 流程）可让原连接器继续复用。ngrok 免费版首次打开 OAuth 授权页时会显示提醒页，点 **Visit Site** 即可继续。
- **cloudflare-quick**：每次插件重载地址都会变化，需要同步更新 ChatGPT 连接器地址。
- **串行委托**：`chatgpt_bridge_handoff`、`/cg-review`、`/cg-ask` 共用同一队列，同一时间只驱动一个委托。浏览器的登录、关闭、状态、探测与调试共用同一占有权，委托排队或执行期间会拒绝这些请求；管理页的连接状态只读 CDP 端点，委托期间仍可查看。
- **按需拉起与空闲退出**：Chrome 仅在登录、委托或诊断时按需启动，`chatgpt_bridge_browser(action="status")` 与空闲 `stop` 不会拉起浏览器。默认空闲 10 分钟后自动退出（通过 `config.browser.idleTimeoutMs` 调整，`0` 表示关闭）。
- **回答判定**：必须等回复文本稳定且流式生成指示消失后才算完成；流式未结束时即便文本 12 秒未变也不会提前结束。总超时后返回失败，同时附带已读取的部分文本及字数。

## 开发与卸载

在本地克隆目录中运行：

```bash
npm install
npm test
```

模块划分：`index.js` 负责适配 DSH 工具与 HTTP 路由，`projects.js` 负责纯项目状态迁移，`files.js` 负责只读根目录与文件读取/搜索，`delegation.js` 负责回答完成判定与浏览器占有权，`driver.js` 负责浏览器探测与 CDP/Playwright 操作。`npm test`（`node --test test/`）使用假浏览器覆盖上述模块与插件入口。

从 DSH 卸载：

```bash
dsh plugin --profile web remove dsh-chatgpt-pro-bridge
```

## 许可证

[MIT](LICENSE) © 2026 hotheat
