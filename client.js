window.__ModuleLoader__.load({
  id: 'dsh-chatgpt-pro-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    async function request(url, options) {
      const response = await fetch(url, options);
      const result = await response.json();
      if (result.error || !response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    }

    function workspaceSnapshot(ctx) {
      try {
        return ctx.get('workspaces').list.getSnapshot();
      } catch {
        return { items: [] };
      }
    }

    function sessionSnapshot(ctx) {
      try {
        return ctx.get('sessions').list.getSnapshot();
      } catch {
        return { byId: {}, projectionsBySession: {} };
      }
    }

    function currentSession(ctx) {
      return ctx.uiSession.adapter.current.getSnapshot().key;
    }

    function workspaceFor(ctx, workspace) {
      const normalized = workspace.replace(/\/+$/, '');
      const item = workspaceSnapshot(ctx).items?.find((row) => row.path?.replace(/\/+$/, '') === normalized);
      if (!item) throw new Error(`工作区未在 DSH 中注册：${workspace}`);
      return item.workspaceId;
    }

    async function startSession(ctx, workspaceId, prompt) {
      const current = ctx.uiSession.adapter.current;
      const before = currentSession(ctx);
      return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        let timer;
        let settled = false;
        function finish(error, key) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          if (error) reject(error);
          else resolve(key);
        }
        function changed() {
          const key = currentSession(ctx);
          if (typeof key === 'string' && key !== '' && key !== before) finish(null, key);
        }
        unsubscribe = current.subscribe(changed);
        timer = setTimeout(() => finish(new Error('等待新会话超时，请重试。')), 15_000);
        try {
          Promise.resolve(ctx.uiWorkspace.startSession(workspaceId, { prompt, whenDraftExists: 'replace' })).catch(finish);
          changed();
        } catch (error) {
          finish(error);
        }
      });
    }

    function contextOf(ctx) {
      const sessions = sessionSnapshot(ctx);
      const ids = new Set([...Object.keys(sessions?.byId ?? {}), ...Object.keys(sessions?.projectionsBySession ?? {})]);
      const titles = Object.create(null);
      for (const id of ids) {
        const title = sessions?.byId?.[id]?.title ?? sessions?.projectionsBySession?.[id]?.values?.title;
        if (typeof title === 'string' && title.trim()) titles[id] = title.trim();
      }
      return { type: 'cg:context', session: currentSession(ctx), titles,
        workspaces: (workspaceSnapshot(ctx).items || []).map((item) => ({
          workspaceId: item.workspaceId, path: item.path,
          sessions: (item.sessionIds || []).map((id) => titles[id] ? { id, title: titles[id] } : { id }),
        })) };
    }

    function createPanel(ctx) {
      const current = ctx.uiSession.adapter.current;
      return function BridgePanel() {
        const frame = React.useRef(null);
        const session = React.useSyncExternalStore(current.subscribe, () => currentSession(ctx) ?? '');
        const postContext = React.useCallback(() => {
          frame.current?.contentWindow?.postMessage(contextOf(ctx), window.location.origin);
        }, []);
        React.useEffect(postContext, [session, postContext]);
        React.useEffect(() => {
          try { return ctx.get('workspaces').list.subscribe(postContext); }
          catch { /* optional workspace service is unavailable */ }
        }, [postContext]);
        React.useEffect(() => {
          try { return ctx.get('sessions').list.subscribe(postContext); }
          catch {}
        }, [postContext]);
        React.useEffect(() => {
          const onMessage = async (event) => {
            if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
            const message = event.data;
            if (!message || typeof message.requestId !== 'string' || !['cg:new-session', 'cg:open-session'].includes(message.type)) return;
            let result;
            try {
              if (message.type === 'cg:new-session') {
                if (typeof message.project !== 'string' || typeof message.workspace !== 'string') throw new Error('项目和工作区不能为空');
                const session = await startSession(ctx, workspaceFor(ctx, message.workspace), '');
                await request('/api/chatgpt-bridge/bind', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ session, project: message.project }),
                });
                result = { ok: true, session };
              } else {
                if (typeof message.session !== 'string' || !message.session) throw new Error('会话不能为空');
                await ctx.uiWorkspace.openSession(message.session);
                result = { ok: true, session: message.session };
              }
            } catch (error) { result = { ok: false, error: error.message }; }
            if (frame.current?.contentWindow === event.source) {
              event.source.postMessage({ type: 'cg:result', requestId: message.requestId, ...result }, window.location.origin);
            }
          };
          window.addEventListener('message', onMessage);
          return () => window.removeEventListener('message', onMessage);
        }, []);
        return h('iframe', { ref: frame, src: '/api/chatgpt-bridge/page/', title: 'ChatGPT Pro 借阅台',
          onLoad: postContext, style: { width: '100%', height: '100%', border: 0, display: 'block', colorScheme: 'light dark' } });
      };
    }

    function BridgeIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      },
      h('path', { d: 'M3 5h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 6 11H3a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 3 5Z' }),
      h('path', { d: 'M10 5h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 13 11h-3a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 10 5Z' }),
      h('line', { x1: 7, y1: 8, x2: 9, y2: 8 }));
    }

    function apply(ctx) {
      const registerInto = (slot, make) => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject(slot, make) : make());
      registerInto('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'chatgpt-pro-bridge', label: () => 'ChatGPT Pro', order: 5 }, (owner = {}) => h(BridgeIcon, { size: owner.size ?? 16 })));
      registerInto('main', () => ctx.slots.register({ name: 'main', key: 'chatgpt-pro-bridge', label: () => 'ChatGPT Pro' }, createPanel(ctx)));
    }

    return {
      inject: ['slots', 'uiSession', 'uiWorkspace'],
      apply,
    };
  },
});
