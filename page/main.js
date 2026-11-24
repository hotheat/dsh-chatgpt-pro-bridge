const I = {
  bridge: (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 5h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 6 11H3a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 3 5Z"/><path d="M10 5h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 13 11h-3a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 10 5Z"/><path d="M7 8h2"/></svg>`,
  plus: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 1.5v9M1.5 6h9"/></svg>`,
  chev: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 4 2.5 2.5L7.5 4"/></svg>`,
  more: `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="11" cy="7" r="1.2"/></svg>`,
  copy: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.5"/><path d="M9.5 4.5V3A1.5 1.5 0 0 0 8 1.5H3A1.5 1.5 0 0 0 1.5 3v5A1.5 1.5 0 0 0 3 9.5h1.5"/></svg>`,
  lock: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="6" width="9" height="6.5" rx="1.5"/><path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6"/></svg>`,
  follow: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 7h8M7 4l3 3-3 3"/><path d="M12 2.5v9"/></svg>`,
  chat: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>`,
  ext: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M7 1.5h3.5V5M10.5 1.5 5.5 6.5M9 7.5v2a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h2"/></svg>`,
};

function projectList() {
  const rows = S.projects.map((p) => {
    const bad = p.roots.filter((r) => !r.exists).length;
    const live = S.data.delegation?.project === p.name;
    return `<button class="prow ${p.name === S.sel ? 'on' : ''}" data-act="select" data-name="${esc(p.name)}">
      <div class="prow-name"><span class="ell">${esc(p.name)}</span>${p.name === S.data.exposedProject ? '<span class="badge">上次</span>' : ''}${live ? '<span class="dot live" style="background:var(--acc);margin-left:auto"></span>' : ''}</div>
      <div class="prow-ws mono ell">${esc(p.workspace || '未关联工作区')}</div>
      <div class="prow-meta">${p.roots.length} 个文件夹 · ${p.sessions.length} 个会话${bad ? `<span class="badge warn" style="margin-left:auto">${bad} 个失效</span>` : ''}</div>
    </button>`;
  }).join('');
  return `<nav class="plist" aria-label="项目">
    <div class="plist-head">项目 · ${S.projects.length}<button data-act="new-project" aria-label="新建项目">${I.plus}</button></div>
    ${rows || `<div class="empty-line" style="margin:0 6px">还没有项目</div>`}
  </nav>`;
}

function detail() {
  const p = proj();
  if (!p) return onboarding();
  const hint = sessionHint(p);
  const menu = S.menu ? `<div class="menu" role="menu">
    <button data-act="rename" role="menuitem">重命名</button>
    <button data-act="new-convo" role="menuitem">换新对话</button>
    <div class="sep"></div>
    <button class="danger" data-act="ask-delete" role="menuitem" ${S.projects.length <= 1 ? 'disabled title="至少保留一个项目"' : ''}>删除项目</button>
  </div>` : '';

  const roots = p.roots.map((r) => `
    <div class="mrow ${r.exists ? '' : 'bad'}">
      <span class="alias mono">${esc(r.alias)}</span>
      <span class="path mono ell" title="${esc(r.path)}">${esc(r.path)}</span>
      <span class="state"><span class="dot ${r.exists ? '' : 'err'}"></span>${r.exists ? '只读' : '不存在'}</span>
      <button class="ghost" data-act="rm-root" data-alias="${esc(r.alias)}" aria-label="移除 ${esc(r.alias)}">移除</button>
    </div>`).join('');

  const sessions = p.sessions.length ? p.sessions.map((id) => `
    <div class="srow"><div class="grow" style="min-width:0">
      <div class="s-title ell">${esc(sessionTitle(id))}</div>
      <div class="s-sub"><span class="mono ell" title="${esc(id)}">${esc(id.slice(0, 16))}</span></div>
    </div><button data-act="open-session" data-id="${esc(id)}" ${S.context ? '' : 'disabled title="请在 DSH 中打开借阅台"'}>打开</button></div>`).join('')
    : `<div class="empty-line">还没有会话。点上方「新会话」，或在会话里输入 <code>/cg-use ${esc(p.name)}</code>。</div>`;

  const conversationUrl = /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\//.test(p.conversationUrl || '') ? p.conversationUrl : null;
  const convo = conversationUrl ? `<div class="convo"><div class="convo-mark">${I.chat}</div>
    <div class="grow" style="min-width:0"><div>${esc(p.name)} · 外脑</div>
    <div class="mono t3 ell" title="${esc(conversationUrl)}">${esc(conversationUrl.replace('https://', ''))}</div></div>
    <a href="${esc(conversationUrl)}" target="_blank" rel="noreferrer">在 Chrome 打开 ${I.ext}</a>
    <button class="ghost" data-act="new-convo">换新对话</button></div>
    <div class="foot">委托会续接这条对话，ChatGPT 能看到之前的上下文。</div>`
    : `<div class="convo pending"><div class="convo-mark">${I.chat}</div><span class="t2">下次委托时会新开一条对话，并记在这里。</span></div>`;

  return `<section class="detail"><div class="detail-inner stagger">
    <div class="d-head">
      <div style="min-width:0">
        <div class="eyebrow">项目 · 工作区 <span class="mono" style="text-transform:none;letter-spacing:0">${esc(p.workspace || '未关联工作区')}</span></div>
        <h1 class="d-title">${esc(p.name)}</h1>
        <div class="d-lede">新会话开在这个工作区，并自动绑定本项目；会话也可用 <code>/cg-use</code> 绑定项目。</div>
      </div>
      <div class="d-actions">
        <button class="primary" data-act="new-session" ${hint ? `disabled title="${esc(hint)}"` : ''}>${I.plus} 新会话</button>
        <button data-act="continue-last" ${!p.sessions.length || !S.context ? 'disabled' : ''}>继续上次</button>
        <button id="more-menu" class="icon-btn" data-act="menu" aria-label="更多" aria-haspopup="menu" aria-expanded="${Boolean(S.menu)}">${I.more}</button>
        ${menu}
      </div>
    </div>

    <label class="workspace">关联工作区<select id="workspace" aria-label="关联工作区">${workspaceOptions(p.workspace || '')}</select></label>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    <div class="sec">
      <div class="sec-head"><span class="sec-no">01</span><h3>只读文件夹</h3><span class="count">${p.roots.length}</span><span class="aside">ChatGPT 只能经 MCP 读这些目录</span></div>
      <div class="manifest">
        ${roots || '<div class="mrow"><span class="t3" style="grid-column:1/-1">还没有文件夹，ChatGPT 什么也读不到。</span></div>'}
        <form id="add-root" class="madd">
          <input id="root-alias" placeholder="别名" aria-label="别名" value="${esc(S.draft.alias || '')}">
          <input id="root-path" placeholder="绝对路径，如 ~/work/my-app/web" aria-label="路径" value="${esc(S.draft.path || '')}">
          <button type="submit">添加</button>
        </form>
        ${S.rootErr ? `<div class="field-err" role="alert">${esc(S.rootErr)}</div>` : ''}
      </div>
      <div class="foot"><code>.env</code>、<code>*.pem</code>、<code>id_rsa*</code> 等敏感文件始终拒绝，拒绝也会记在右侧访问记录里。</div>
    </div>

    <div class="sec">
      <div class="sec-head"><span class="sec-no">02</span><h3>绑定的会话</h3><span class="count">${p.sessions.length}</span><span class="aside">委托只带本项目的文件夹</span></div>
      ${sessions}
    </div>

    <div class="sec">
      <div class="sec-head"><span class="sec-no">03</span><h3>ChatGPT 对话</h3></div>
      ${convo}
    </div>
  </div></section>`;
}

function onboarding() {
  return `<section class="detail"><div class="detail-inner stagger">
    <div class="eyebrow">开始</div>
    <h1 class="d-title">把 ChatGPT 接成只读外脑</h1>
    <div class="d-lede">ChatGPT 只读你开放的文件夹，不写文件、不执行命令。三步接好：</div>
    <div class="steps">
      <div class="step"><div><b>新建项目</b><p>选一个 DSH 工作区，它的根目录就是第一个只读文件夹。</p></div><button class="primary" data-act="new-project">新建项目</button></div>
      <div class="step"><div><b>在 ChatGPT 添加连接器</b><p>设置 → 连接器 → 新建，填右侧的地址，授权时输入配对码。</p></div><button data-act="copy-url">复制地址</button></div>
      <div class="step"><div><b>从项目页新建会话</b><p>会话自动绑定项目；在会话里用 <span class="mono">/cg-review</span> 或 <span class="mono">/cg-ask</span> 委托。</p></div></div>
    </div>
  </div></section>`;
}


const S = { data: null, projects: [], sel: '', context: null, filter: 'project', menu: false,
  drafts: {}, draft: {}, rootErr: '', error: '', busy: false };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const proj = () => S.projects.find((p) => p.name === S.sel);
const normalized = (path) => path.replace(/\/+$/, '');
const workspaces = () => S.context?.workspaces || [];
const sessionTitle = (id) => S.context?.titles?.[id] || workspaces().flatMap((w) => w.sessions || []).find((s) => s.id === id)?.title || S.data?.sessionTitles?.[id] || '会话';
function sessionHint(p) {
  if (!S.context) return '请在 DSH 中打开借阅台，才能新建和打开会话。';
  if (!p.workspace) return '先关联一个 DSH 工作区，再新建会话。';
  if (!workspaces().some((w) => normalized(w.path) === normalized(p.workspace))) return `工作区未在 DSH 中注册：${p.workspace}`;
  return '';
}
function workspaceOptions(selected) {
  const paths = [...new Set(workspaces().map((w) => w.path))];
  if (selected && !paths.includes(selected)) paths.unshift(selected);
  return `<option value="">未关联工作区</option>${paths.map((path) => `<option value="${esc(path)}" ${path === selected ? 'selected' : ''}>${esc(path)}</option>`).join('')}`;
}
const time = (value) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
async function api(path, body) {
  const response = await fetch('/api/chatgpt-bridge' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error || data.ok === false) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
function pills() {
  const { gateway: g, tunnel, browser } = S.data;
  const tunnelError = g?.tunnelState === 'error';
  const tunnelText = tunnelError ? '启动失败' : tunnel?.changed ? '地址已变' : g?.provider === 'starting' ? '启动中' : g?.tunnelState === 'online' ? '在线' : '未启动';
  const tunnelClass = tunnelError ? 'err' : tunnel?.changed || g?.provider === 'starting' ? 'warn' : g?.tunnelState === 'online' ? '' : 'idle';
  const idleHint = browser?.idleCloseAt ? `空闲将于 ${time(browser.idleCloseAt)} 自动退出`
    : browser?.idleTimeoutMs ? `空闲 ${Math.max(1, Math.round(browser.idleTimeoutMs / 60000))} 分钟自动退出` : '需手动关闭';
  const browserTitle = browser?.connected
    ? `独立桥接浏览器正在运行（${browser.label || 'Chrome'}），${idleHint}`
    : `按需启动桥接浏览器${browser?.label ? `（${browser.label}）` : ''}，${idleHint}`;
  return `<div class="pills">
    <span class="pill"><span class="dot ${g ? '' : 'idle'}"></span>网关 <b class="mono">${esc(g ? g.port : '未启动')}</b></span>
    <span class="pill ${tunnelClass}" title="${esc(g?.tunnelError || g?.provider || 'off')}"><span class="dot ${tunnelClass}"></span>隧道 <b>${esc(tunnelText)}</b></span>
    ${browser?.connected
      ? `<span class="pill active" title="${esc(browserTitle)}"><span class="dot"></span>桥接浏览器 <b>运行中</b>${browser.label ? `<span class="t3">· ${esc(browser.label)}</span>` : ''}<button data-act="login">打开登录窗口</button>${S.data.delegation ? '' : '<button data-act="stop">停止网页生成</button>'}<button data-act="close-browser"${S.data.delegation ? ' disabled title="委托进行中无法关闭浏览器"' : ''}>关闭浏览器</button></span>`
      : `<span class="pill" title="${esc(browserTitle)}"><span class="dot idle"></span>桥接浏览器 <b>未启动</b><button data-act="login">打开登录窗口</button></span>`}
  </div>`;
}
function ticket() {
  const { gateway: g, tunnel, delegation: d, exposedProject, lastDelegatedProject } = S.data;
  const url = g?.publicUrl || g?.localUrl || '';
  const code = String(g?.pairingCode || '');
  const cut = Math.ceil(code.length / 2);
  const digits = (part) => [...part].map((v) => `<b>${esc(v)}</b>`).join('');
  return `<div><div class="rail-label">连接凭证</div><div class="ticket-wrap"><div class="ticket">
    <div class="t-main"><div class="t-k">MCP 地址 · ChatGPT 连接器填这个</div>
    <div class="t-url"><span class="mono ell" title="${esc(url)}">${esc(url || '网关未启动')}</span><button class="icon-btn" data-act="copy-url" aria-label="复制地址" ${url ? '' : 'disabled'}>${I.copy}</button></div>
    <div class="t-k" style="margin-top:10px">配对码 · 授权页输入，用后即换</div>
    ${code ? `<div class="code" aria-label="配对码 ${esc(code)}">${digits(code.slice(0, cut))}<i></i>${digits(code.slice(cut))}</div>` : '<div class="hint">网关启动后显示配对码</div>'}
    <div class="t-meta">${g ? `${esc(g.clients)} 个客户端 · ${esc(g.tokens)} 个令牌` : '网关未启动'}<button class="ghost" data-act="rotate" ${g ? '' : 'disabled'}>换配对码</button></div>
    ${g?.pairingExpiresAt ? `<div class="hint">配对码到期：${esc(dateTime(g.pairingExpiresAt))}</div>` : ''}
    ${g?.tunnelState === 'error' ? `<div class="t-warn" role="alert">隧道启动失败：${esc(g.tunnelError)}</div>` : ''}
    ${tunnel?.changed ? '<div class="t-warn">隧道地址已变。在 ChatGPT 的 设置 → 连接器 中更新为上面的新地址。<br><button data-act="ack-tunnel">已更新连接器</button></div>' : ''}
    <div class="t-scope ${d ? 'locked' : ''}">${d ? I.lock : I.follow}<span class="grow">开放：<b>${esc(d?.project || exposedProject || '无')}</b></span><span class="hint">${d ? `委托 #${esc(d.id)} 期间锁定` : lastDelegatedProject ? '跟随最近一次委托' : '当前活动项目'}</span></div>
    </div><div class="t-stub"><span>一个连接器 · 全部项目</span></div></div></div></div>`;
}
function ledger() {
  const groups = [];
  const byId = new Map();
  for (const call of S.data.calls || []) {
    let group;
    if (call.delegation != null) {
      group = byId.get(call.delegation);
      if (!group) {
        group = { id: call.delegation, at: call.at, rows: [] };
        byId.set(call.delegation, group); groups.push(group);
      }
    } else {
      group = groups.at(-1);
      if (!group || group.id != null) { group = { id: null, at: call.at, rows: [] }; groups.push(group); }
    }
    group.rows.push(call);
  }
  const records = new Map((S.data.delegations || []).map((d) => [d.id, d]));
  if (S.data.delegation) records.set(S.data.delegation.id, S.data.delegation);
  for (const d of records.values()) {
    if (!byId.has(d.id)) groups.push({ id: d.id, at: d.startedAt, rows: [] });
  }
  const body = groups.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((g) => {
    const d = records.get(g.id);
    const rows = g.rows.filter((row) => S.filter === 'all' || row.project === S.sel);
    if (!rows.length && !(d && (S.filter === 'all' || d.project === S.sel))) return '';
    const live = d && d.finishedAt == null && S.data.delegation?.id === d.id;
    const result = live ? '等待回复…' : d?.finishedAt ? `${time(d.finishedAt)} · ${d.ok ? `${d.characters} 字${d.mcpCalls === 0 ? ' · 未读取文件' : ''}` : `${d.cancelled ? '已取消' : '失败'} · ${d.error || '未知错误'}`}` : '';
    const title = g.id == null ? '直接在 ChatGPT 提问' : `委托 #${g.id}${d?.title ? ` · ${d.title}` : ''}`;
    const projects = [...new Set(rows.map((r) => r.project).concat(d ? [d.project] : []))];
    return `<div class="l-group"><span class="group-title ell" title="${esc(title)}">${esc(title)}</span>${S.filter === 'all' ? projects.map((p) => `<span class="badge mute">${esc(p)}</span>`).join('') : ''}<span class="r ${live ? 'live' : ''}">${esc(result)}</span></div>
      ${rows.map((r) => `<div class="l-row ${r.refused ? 'refused' : ''}"><span class="mono t3" title="${esc(dateTime(r.at))}">${esc(time(r.at))}</span><span class="mono tool" title="${esc(r.tool)}">${esc(r.tool)}</span><span class="tgt"><span class="mono ell" title="${esc(r.target)}">${esc(r.target)}</span><small class="mono" title="${esc(r.note)}">${esc(r.refused ? '拒绝 · 敏感' : r.note)}</small></span></div>`).join('')}`;
  }).join('');
  const d = S.data.delegation;
  const band = d && (S.filter === 'all' || d.project === S.sel) ? `<div class="lock-band"><span class="dot live"></span>委托 #${esc(d.id)} 进行中 · 只开放 ${esc(d.project)}<span class="mono" id="elapsed"></span><button data-act="stop">停止</button></div>` : '';
  return `<div><div class="rail-label">访问记录<span class="seg"><button data-act="filter" data-v="project" aria-pressed="${S.filter === 'project'}">本项目</button><button data-act="filter" data-v="all" aria-pressed="${S.filter === 'all'}">全部</button></span></div>
    <div class="ledger">${band}${body ? `<div class="l-body">${body}</div>` : `<div class="l-empty">${S.projects.length ? 'ChatGPT 还没读过这个项目的任何文件。' : '还没有访问记录。第一次委托后，ChatGPT 读了什么都会记在这里。'}</div>`}</div></div>`;
}
function tickElapsed() {
  const el = document.getElementById('elapsed');
  if (el && S.data?.delegation) el.textContent = `${Math.max(0, Math.floor((Date.now() - Date.parse(S.data.delegation.startedAt)) / 1000))}s`;
}
function render() {
  const app = document.getElementById('app');
  if (!S.data) {
    app.innerHTML = `<div class="l-empty" role="alert">${esc(S.error || '正在读取借阅台…')}</div>`;
    return;
  }
  const active = document.activeElement;
  const focus = app.contains(active) ? { id: active.id, act: active.dataset.act, name: active.dataset.name, value: active.dataset.v,
    alias: active.dataset.alias, session: active.dataset.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const scroll = ['.pp-grid', '.plist', '.detail', '.rail'].map((key) => [key, app.querySelector(key)?.scrollTop || 0]);
  app.innerHTML = `<div class="pp"><header class="pp-top"><div class="pp-brand">${I.bridge(18)}<b>ChatGPT Pro</b><span>只读外脑 · 借阅台</span></div>${pills()}</header>
    ${S.error ? `<div class="error-banner" role="alert">${esc(S.error)}</div>` : ''}<div class="pp-grid">${projectList()}${detail()}<aside class="rail">${ticket()}${ledger()}</aside></div></div>`;
  app.setAttribute('aria-busy', 'false');
  if (focus) {
    const next = focus.id ? document.getElementById(focus.id) : [...app.querySelectorAll('[data-act]')].find((el) => el.dataset.act === focus.act && el.dataset.name === focus.name && el.dataset.v === focus.value && el.dataset.alias === focus.alias && el.dataset.id === focus.session);
    next?.focus({ preventScroll: true });
    if (focus.start != null && next?.setSelectionRange) next.setSelectionRange(focus.start, focus.end);
  }
  for (const [key, top] of scroll) { const el = app.querySelector(key); if (el) el.scrollTop = top; }
  tickElapsed();
}
let pollTimer, loading;
async function refresh() {
  if (loading) return loading;
  clearTimeout(pollTimer);
  loading = (async () => {
    try {
      S.data = await api('/status'); S.projects = S.data.projects; S.error = '';
      if (!proj()) S.sel = S.data.exposedProject || S.projects[0]?.name || '';
      S.draft = S.drafts[S.sel] ||= {};
    } catch (error) { S.error = error.message; }
    render();
  })();
  try { await loading; } finally {
    loading = null;
    if (!document.hidden) pollTimer = setTimeout(refresh, S.data?.delegation ? 2000 : 6000);
  }
}
document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) tickElapsed(); }, 1000);

let toastTimer;
function toast(text, undo) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">撤销</button>' : ''}`; el.hidden = false;
  if (undo) el.querySelector('button').onclick = async () => {
    el.hidden = true;
    try { await undo(); await refresh(); toast('已恢复文件夹'); } catch (error) { toast(error.message); }
  };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 7000 : 3000);
}
const pending = new Map();
let requestSeq = 0;
function parentRequest(type, fields) {
  if (!S.context || window.parent === window) return Promise.reject(new Error('请在 DSH 中打开借阅台'));
  const requestId = `cg-${Date.now()}-${++requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('等待 DSH 响应超时，请重试。')); }, 20000);
    pending.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ type, requestId, ...fields }, window.location.origin);
  });
}
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== window.parent || window.parent === window) return;
  const msg = event.data;
  if (msg?.type === 'cg:context' && Array.isArray(msg.workspaces)) {
    S.context = { session: msg.session, titles: msg.titles && typeof msg.titles === 'object' ? msg.titles : {},
      workspaces: msg.workspaces.filter((w) => typeof w.path === 'string' && Array.isArray(w.sessions)) };
    if (S.data) render();
  }
  if (msg?.type === 'cg:result') {
    const task = pending.get(msg.requestId);
    if (!task) return;
    clearTimeout(task.timer); pending.delete(msg.requestId);
    if (msg.ok) task.resolve(msg); else task.reject(new Error(msg.error || 'DSH 操作失败'));
  }
});

const dlg = document.getElementById('dialog');
let dialogKind, dialogProject, dialogOpener;
function closeDialog() { dlg.close(); }
dlg.addEventListener('close', () => {
  dialogKind = null;
  const opener = dialogOpener?.isConnected ? dialogOpener
    : [...document.querySelectorAll('#app [data-act]')].find((el) => el.dataset.act === dialogOpener?.dataset.act) || document.getElementById('more-menu');
  opener?.focus();
});
function dialogError(text) { dlg.querySelector('[role="alert"]').textContent = text; }
function openDialog(kind) {
  dialogOpener = document.activeElement;
  S.menu = false;
  render();
  dialogKind = kind; dialogProject = proj()?.name;
  const p = proj();
  let body, label;
  if (kind === 'new-project') {
    body = `<div class="t2">项目对应一个 DSH 工作区；从这里新建的会话都开在这个工作区。</div>
      <label>项目名<input id="np-name" name="name" maxlength="60" placeholder="如 my-app" required autofocus></label>
      <label>工作区<select id="np-ws" name="workspace">${workspaceOptions('')}</select></label>
      <label class="check"><input id="np-seed" name="seed" type="checkbox" checked>把工作区根目录作为第一个只读文件夹</label>`;
    label = '新建项目';
  } else if (kind === 'rename') {
    body = `<label>项目名<input id="rename-name" name="name" maxlength="60" required value="${esc(p.name)}" autofocus></label>`; label = '重命名项目';
  } else {
    body = `<div class="t2">会解除 ${p.sessions.length} 个会话的绑定，移除 ${p.roots.length} 个只读文件夹的登记。磁盘上的文件和 ChatGPT 里的对话不受影响。</div>`;
    label = `删除「${p.name}」？`;
  }
  dlg.innerHTML = `<form id="project-form"><h2 id="dialog-title">${esc(label)}</h2>${body}<div class="field-err" role="alert"></div><div class="dlg-actions"><button type="button" class="ghost" data-act="close">取消</button><button type="submit" class="${kind === 'delete' ? 'danger' : 'primary'}">${kind === 'delete' ? '删除项目' : kind === 'rename' ? '保存' : '创建'}</button></div></form>`;
  dlg.showModal();
  if (kind === 'delete') dlg.querySelector('[data-act="close"]').focus();
}
async function saveDialog(form) {
  const name = form.elements.name?.value.trim();
  const kind = dialogKind, project = dialogProject;
  if (kind !== 'delete' && (!name || S.projects.some((p) => p.name === name && (kind !== 'rename' || p.name !== project)))) {
    dialogError(!name ? '项目名不能为空' : `项目已存在：${name}`); return;
  }
  const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    if (kind === 'new-project') await api('/config', { createProject: name, workspace: form.elements.workspace.value || null, seedRoot: form.elements.seed.checked });
    if (kind === 'rename') await api('/config', { renameProject: { from: project, to: name } });
    if (kind === 'delete') await api('/config', { deleteProject: project });
    if (kind === 'rename' && S.drafts[project]) { S.drafts[name] = S.drafts[project]; delete S.drafts[project]; }
    S.sel = kind === 'delete' ? '' : name;
    closeDialog(); await refresh(); toast(kind === 'delete' ? '已删除项目' : kind === 'rename' ? '已重命名项目' : `已创建 ${name}`);
  } catch (error) { dialogError(error.message); } finally { submit.disabled = false; }
}
async function addRoot() {
  const p = proj(), draft = S.draft;
  const alias = (draft.alias || '').trim(), path = (draft.path || '').trim();
  if (!alias || !path) { S.rootErr = '别名和路径都要填'; render(); return; }
  try {
    await api('/roots', { project: p.name, alias, path });
    draft.alias = ''; draft.path = ''; S.rootErr = ''; await refresh(); toast(`已开放 ${alias}（只读）`);
  } catch (error) { S.rootErr = error.message; render(); }
}
const actions = {
  select(el) { S.sel = el.dataset.name; S.draft = S.drafts[S.sel] ||= {}; S.rootErr = ''; S.menu = false; render(); },
  menu() { S.menu = !S.menu; render(); if (S.menu) document.querySelector('.menu button')?.focus(); },
  'new-project': () => openDialog('new-project'),
  rename: () => { S.menu = false; openDialog('rename'); },
  'ask-delete': () => { S.menu = false; openDialog('delete'); },
  close: closeDialog,
  filter(el) { S.filter = el.dataset.v; render(); },
  async 'new-session'() { const p = proj(); if (sessionHint(p)) throw new Error(sessionHint(p)); await parentRequest('cg:new-session', { project: p.name, workspace: p.workspace }); await refresh(); toast(`已新建会话并绑定到 ${p.name}`); },
  async 'open-session'(el) { await parentRequest('cg:open-session', { session: el.dataset.id }); },
  async 'continue-last'() { await parentRequest('cg:open-session', { session: proj().sessions[0] }); },
  async 'new-convo'() { const name = proj().name; await api('/config', { resetConversation: name }); S.menu = false; await refresh(); toast('下次委托会新开对话'); },
  async 'rm-root'(el) {
    const p = proj(), root = p.roots.find((r) => r.alias === el.dataset.alias);
    await api('/roots', { project: p.name, remove: root.alias }); await refresh();
    toast(`已移除 ${root.alias}，ChatGPT 不能再读它`, () => api('/roots', { project: p.name, alias: root.alias, path: root.path }));
  },
  async 'copy-url'() { const g = S.data.gateway, url = g?.publicUrl || g?.localUrl; if (!url) throw new Error('网关未启动'); await navigator.clipboard.writeText(url); toast('地址已复制'); },
  async rotate() { await api('/pairing/rotate', {}); await refresh(); toast('配对码已更换，旧码作废'); },
  async 'ack-tunnel'() { await api('/tunnel/ack', {}); await refresh(); },
  async login() { await api('/browser/login', {}); await refresh(); toast('已打开桥接浏览器登录窗口，请在窗口中完成登录'); },
  async 'close-browser'() { await api('/browser/close', {}); await refresh(); toast('已关闭桥接浏览器'); },
  async stop() { const result = await api('/delegation/stop', {}); await refresh(); toast(result.cancelled != null ? `已请求停止委托 #${result.cancelled}` : result.stopped ? '已停止网页生成' : '网页当前没有生成内容'); },
};
document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) { if (S.menu && !event.target.closest('.menu')) { S.menu = false; render(); } return; }
  if (el.disabled || !actions[el.dataset.act]) return;
  try { await actions[el.dataset.act](el); } catch (error) { toast(error.message); }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'root-alias') S.draft.alias = event.target.value;
  if (event.target.id === 'root-path') S.draft.path = event.target.value;
});
document.addEventListener('change', async (event) => {
  if (event.target.id !== 'workspace') return;
  try { await api('/config', { setWorkspace: { project: proj().name, workspace: event.target.value || null } }); await refresh(); }
  catch (error) { toast(error.message); await refresh(); }
});
document.addEventListener('submit', async (event) => {
  if (!['project-form', 'add-root'].includes(event.target.id)) return;
  event.preventDefault();
  if (S.busy) return;
  S.busy = true;
  try { if (event.target.id === 'project-form') await saveDialog(event.target); else await addRoot(); }
  finally { S.busy = false; }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && S.menu) { S.menu = false; render(); document.getElementById('more-menu')?.focus(); }
  if (S.menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const items = [...document.querySelectorAll('.menu button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  }
});
refresh();
