import http, { type IncomingMessage, type ServerResponse } from 'http'
import type { Logger } from './logger'
import type { QingBotWebConfig } from './types'

export interface WebConsoleTarget {
  getStatus(): unknown
  reloadConfig(): Promise<unknown>
  reloadAllPlugins(): Promise<string[]>
  reloadPlugin(name: string): Promise<boolean>
  loadPlugin(name: string): Promise<boolean>
  unloadPlugin(name: string): Promise<boolean>
  stop(): Promise<void>
}

export interface WebConsole {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createWebConsole(target: WebConsoleTarget, config: QingBotWebConfig, logger: Logger): WebConsole {
  const host = config.host || '127.0.0.1'
  const port = config.port || 3300
  const token = config.token || ''
  const server = http.createServer((req, res) => {
    void route(req, res, target, token)
  })

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          logger.info(`Web 管理台已启动：http://${host}:${port}`)
          resolve()
        })
      })
    },
    stop() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
      })
    },
  }
}

async function route(req: IncomingMessage, res: ServerResponse, target: WebConsoleTarget, token: string) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/') {
    return sendHtml(res, renderPage(Boolean(token)))
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    return sendEmpty(res, 204)
  }

  if (!url.pathname.startsWith('/api/')) return sendText(res, 404, 'Not Found')
  if (!isAuthorized(req, url, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, { ok: true, data: target.getStatus() })
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

    if (url.pathname === '/api/reload-config') {
      return sendJson(res, 200, { ok: true, data: await target.reloadConfig() })
    }

    if (url.pathname === '/api/reload-all') {
      return sendJson(res, 200, { ok: true, data: await target.reloadAllPlugins() })
    }

    const body = await readJson(req)
    const name = String(body.name || '').trim()

    if (url.pathname === '/api/reload-plugin') {
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing plugin name' })
      return sendJson(res, 200, { ok: await target.reloadPlugin(name) })
    }

    if (url.pathname === '/api/load-plugin') {
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing plugin name' })
      return sendJson(res, 200, { ok: await target.loadPlugin(name) })
    }

    if (url.pathname === '/api/unload-plugin') {
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing plugin name' })
      return sendJson(res, 200, { ok: await target.unloadPlugin(name) })
    }

    if (url.pathname === '/api/stop') {
      sendJson(res, 200, { ok: true })
      setTimeout(() => {
        void target.stop().finally(() => process.exit(0))
      }, 80)
      return
    }

    return sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function isAuthorized(req: IncomingMessage, url: URL, token: string) {
  if (!token) return isLoopback(req.socket.remoteAddress || '')
  const header = req.headers.authorization || ''
  return header === `Bearer ${token}` || url.searchParams.get('token') === token
}

function isLoopback(address: string) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) reject(new Error('request body too large'))
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function sendHtml(res: ServerResponse, body: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendEmpty(res: ServerResponse, status: number) {
  res.writeHead(status)
  res.end()
}

function renderPage(hasToken: boolean) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>QingBot</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f8f7;
      --text: #161a18;
      --muted: #747d77;
      --faint: #9aa39d;
      --line: #edf0ee;
      --line-strong: #d9e0dc;
      --surface: #ffffff;
      --accent: #10a66f;
      --accent-ink: #08784f;
      --accent-soft: #e4faef;
      --accent-hover: #0d955f;
      --danger: #cf4134;
      --danger-soft: #fff2f0;
      --button-hover: #f0f5f2;
      --row-hover: #f2fbf6;
      --row-selected: #e1faef;
      --pill-bg: #f0f2f4;
      --toast-bg: #15171a;
      --toast-text: #ffffff;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1412;
        --text: #edf4ef;
        --muted: #95a49b;
        --faint: #65746d;
        --line: #1e2824;
        --line-strong: #2b3832;
        --surface: #131a17;
        --accent: #36d68b;
        --accent-ink: #78f0b6;
        --accent-soft: #123a29;
        --accent-hover: #28bd79;
        --danger: #ff7065;
        --danger-soft: #341d1b;
        --button-hover: #1a2420;
        --row-hover: #13241d;
        --row-selected: #153d2c;
        --pill-bg: #1d2622;
        --toast-bg: #edf4ef;
        --toast-text: #101411;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input {
      height: 36px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover {
      background: var(--button-hover);
    }
    button:disabled {
      opacity: .42;
      cursor: not-allowed;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button.primary:hover { background: var(--accent-hover); }
    button.danger {
      border-color: transparent;
      background: transparent;
      color: var(--danger);
    }
    button.danger:hover { background: var(--danger-soft); }
    button.nav {
      width: 100%;
      height: 38px;
      justify-content: flex-start;
      border-color: transparent;
      background: transparent;
      color: var(--muted);
      text-align: left;
    }
    button.nav.active {
      background: var(--accent-soft);
      color: var(--accent-ink);
    }
    button.filter {
      height: 32px;
      border-color: transparent;
      background: transparent;
      color: var(--muted);
    }
    button.filter.active {
      border-color: transparent;
      background: var(--accent-soft);
      color: var(--accent-ink);
    }
    input {
      width: 220px;
      padding: 0 10px;
      border-color: var(--line-strong);
    }
    input:focus {
      outline: 2px solid var(--accent-soft);
      border-color: var(--accent);
    }
    .layout {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 196px minmax(0, 1fr);
    }
    .sidebar {
      min-height: 100vh;
      padding: 26px 16px;
      border-right: 1px solid var(--line);
      background: var(--surface);
    }
    .brand {
      margin-bottom: 30px;
      padding: 0 4px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1;
      font-weight: 760;
      letter-spacing: 0;
    }
    .brand h1 span {
      margin-left: 2px;
      color: var(--accent);
      font-size: .58em;
      font-weight: 650;
      vertical-align: .28em;
    }
    .state {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 13px;
      color: var(--muted);
      white-space: nowrap;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #a0a6ad;
    }
    .dot.running { background: var(--accent); }
    .nav-list {
      display: grid;
      gap: 6px;
    }
    .main {
      min-width: 0;
      width: 100%;
      max-width: 1120px;
      margin: 0 auto;
      padding: 34px 38px 64px;
    }
    .panel { display: none; }
    .panel.active { display: block; }
    .page-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 36px;
      margin-bottom: 24px;
    }
    h2 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      font-weight: 760;
      letter-spacing: 0;
    }
    .section {
      margin-bottom: 34px;
    }
    .section:last-child {
      margin-bottom: 0;
    }
    .section-title {
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      column-gap: 28px;
      row-gap: 10px;
    }
    .stat {
      min-height: 64px;
      padding: 10px 0 14px;
      border-bottom: 1px solid var(--line);
    }
    .label {
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    .value {
      overflow-wrap: anywhere;
      font-size: 15px;
      font-weight: 650;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 22px;
    }
    .summary .stat {
      min-height: 58px;
    }
    .summary .value {
      color: var(--accent-ink);
      font-size: 22px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .filters {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .toolbar-left,
    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .toolbar-right[hidden],
    .action-button[hidden] {
      display: none;
    }
    .selected-name {
      max-width: 220px;
      overflow: hidden;
      color: var(--muted);
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .table-wrap {
      overflow-x: auto;
      background: transparent;
    }
    table {
      width: 100%;
      min-width: 620px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    col.name-col { width: auto; }
    col.status-col { width: 110px; }
    col.version-col { width: 110px; }
    col.handlers-col { width: 90px; }
    th, td {
      height: 48px;
      padding: 0 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: middle;
    }
    th {
      height: 36px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    tbody tr {
      cursor: pointer;
    }
    tbody tr:hover {
      background: var(--row-hover);
    }
    tbody tr.selected {
      background: var(--row-selected);
    }
    td.name {
      overflow-wrap: anywhere;
      font-weight: 680;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 54px;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: var(--pill-bg);
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .pill.loaded {
      background: var(--accent-soft);
      color: #0f7d56;
    }
    .form-table {
      display: grid;
      background: transparent;
    }
    .form-row {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      min-height: 62px;
      border-bottom: 1px solid var(--line);
    }
    .form-label {
      padding-left: 12px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .form-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px 10px 0;
    }
    #toast {
      position: fixed;
      left: 50%;
      bottom: 22px;
      transform: translateX(-50%);
      min-width: 180px;
      padding: 9px 12px;
      border-radius: 6px;
      background: var(--toast-bg);
      color: var(--toast-text);
      text-align: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity .16s ease;
    }
    #toast.show { opacity: 1; }
    @media (max-width: 860px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .sidebar {
        min-height: 0;
        padding: 18px 20px 14px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .brand {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 16px;
        padding: 0;
      }
      .state {
        margin-top: 0;
      }
      .nav-list {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      button.nav {
        justify-content: center;
        text-align: center;
      }
      .main {
        padding: 24px 20px 48px;
      }
      .stats,
      .summary {
        grid-template-columns: 1fr 1fr;
      }
      .page-head,
      .toolbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .toolbar-left,
      .toolbar-right {
        width: 100%;
      }
      .toolbar-right {
        justify-content: flex-end;
      }
    }
    @media (max-width: 640px) {
      .stats,
      .summary {
        grid-template-columns: 1fr;
      }
      .page-head {
        min-height: 30px;
        margin-bottom: 20px;
      }
      h2 {
        font-size: 22px;
      }
      .section {
        margin-bottom: 26px;
      }
      .toolbar-left {
        display: grid;
        gap: 10px;
      }
      .toolbar-left input {
        width: 100%;
      }
      .filters {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        width: 100%;
      }
      button.filter {
        width: 100%;
      }
      .toolbar-right {
        gap: 8px;
        justify-content: flex-start;
      }
      .selected-name {
        width: 100%;
        max-width: none;
      }
      .table-wrap {
        overflow-x: visible;
      }
      table,
      colgroup,
      thead,
      tbody,
      tr,
      th,
      td {
        display: block;
      }
      table {
        min-width: 0;
      }
      thead {
        display: none;
      }
      tbody tr {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        column-gap: 14px;
        row-gap: 4px;
        min-height: 62px;
        padding: 10px 0;
        border-bottom: 1px solid var(--line);
      }
      th,
      td {
        height: auto;
        padding: 0;
        border-bottom: 0;
      }
      td.name {
        align-self: center;
      }
      td:nth-child(2) {
        align-self: center;
        justify-self: end;
      }
      td:nth-child(3),
      td:nth-child(4) {
        color: var(--faint);
        font-size: 12px;
      }
      td:nth-child(4) {
        justify-self: end;
      }
      .pill {
        min-width: 48px;
      }
      .form-row {
        grid-template-columns: 1fr;
        gap: 0;
        padding: 10px 0;
      }
      .form-label {
        padding: 0 12px 8px;
      }
      .form-controls {
        padding: 0 12px;
      }
      input {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <h1>Qing<span>Bot</span></h1>
        <div class="state"><span class="dot" id="dot"></span><span id="state">-</span></div>
      </div>
      <nav class="nav-list" aria-label="管理导航">
        <button class="nav active" data-tab="overview">概览</button>
        <button class="nav" data-tab="plugins">插件</button>
        <button class="nav" data-tab="control">操作</button>
      </nav>
    </aside>

    <main class="main">
      <section class="panel active" id="panel-overview">
        <div class="page-head">
          <h2>概览</h2>
        </div>
        <div class="section">
          <div class="section-title">运行</div>
          <div class="stats">
            <div class="stat"><div class="label">AppID</div><div class="value" id="appID">-</div></div>
            <div class="stat"><div class="label">运行时间</div><div class="value" id="uptime">-</div></div>
            <div class="stat"><div class="label">插件目录</div><div class="value" id="pluginDir">-</div></div>
            <div class="stat"><div class="label">Intents</div><div class="value" id="intents">-</div></div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">插件</div>
          <div class="summary">
            <div class="stat"><div class="label">已加载</div><div class="value" id="loadedCount">0</div></div>
            <div class="stat"><div class="label">可用</div><div class="value" id="availableCount">0</div></div>
            <div class="stat"><div class="label">启用配置</div><div class="value" id="configuredCount">0</div></div>
          </div>
        </div>
      </section>

      <section class="panel" id="panel-plugins">
        <div class="page-head">
          <h2>插件</h2>
        </div>
        <div class="toolbar">
          <div class="toolbar-left">
            <input id="pluginSearch" placeholder="搜索">
            <div class="filters">
              <button class="filter active" data-filter="all">全部</button>
              <button class="filter" data-filter="loaded">已加载</button>
              <button class="filter" data-filter="idle">未加载</button>
            </div>
          </div>
          <div class="toolbar-right" id="pluginActions" hidden>
            <span class="selected-name" id="selectedPluginName"></span>
            <button class="action-button" id="pluginLoadButton" onclick="operateSelected('/api/load-plugin')">加载</button>
            <button class="action-button" id="pluginReloadButton" onclick="operateSelected('/api/reload-plugin')">重载</button>
            <button class="action-button danger" id="pluginUnloadButton" onclick="operateSelected('/api/unload-plugin')">卸载</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <colgroup>
              <col class="name-col">
              <col class="status-col">
              <col class="version-col">
              <col class="handlers-col">
            </colgroup>
            <thead>
              <tr>
                <th>名称</th>
                <th>状态</th>
                <th>版本</th>
                <th>处理器</th>
              </tr>
            </thead>
            <tbody id="plugins"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" id="panel-control">
        <div class="page-head">
          <h2>操作</h2>
        </div>
        <div class="form-table">
          <div class="form-row">
            <div class="form-label">全局</div>
            <div class="form-controls">
              <button onclick="post('/api/reload-config')">重载配置</button>
              <button class="primary" onclick="post('/api/reload-all')">重载插件</button>
            </div>
          </div>
          <div class="form-row">
            <div class="form-label">Token</div>
            <div class="form-controls">
              <input id="tokenInput" placeholder="Web Token">
              <button onclick="saveToken()">保存</button>
              <button onclick="clearToken()">清除</button>
            </div>
          </div>
          <div class="form-row">
            <div class="form-label">进程</div>
            <div class="form-controls">
              <button class="danger" onclick="stopBot()">关闭</button>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
  <div id="toast"></div>
  <script>
    const needsToken = ${hasToken ? 'true' : 'false'}
    const qs = new URLSearchParams(location.search)
    let token = qs.get('token') || localStorage.getItem('qingbot-token') || ''
    let lastData = null
    let pluginFilter = 'all'
    let selectedPlugin = ''

    if (qs.get('token')) localStorage.setItem('qingbot-token', qs.get('token'))

    const stateText = {
      created: '已创建',
      starting: '启动中',
      running: '运行中',
      stopping: '关闭中',
      stopped: '已停止'
    }

    document.querySelectorAll('[data-tab]').forEach(button => {
      button.addEventListener('click', () => switchTab(button.dataset.tab))
    })
    document.querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => {
        pluginFilter = button.dataset.filter
        document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button))
        renderPlugins(lastData)
      })
    })
    document.getElementById('pluginSearch').addEventListener('input', () => renderPlugins(lastData))
    document.getElementById('tokenInput').value = token

    function switchTab(name) {
      document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item.dataset.tab === name))
      document.querySelectorAll('.panel').forEach(item => item.classList.toggle('active', item.id === 'panel-' + name))
    }
    function headers() {
      return token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]))
    }
    function show(text) {
      const toast = document.getElementById('toast')
      toast.textContent = text
      toast.classList.add('show')
      setTimeout(() => toast.classList.remove('show'), 1600)
    }
    function formatUptime(seconds) {
      seconds = Math.max(0, Number(seconds || 0))
      const h = Math.floor(seconds / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      const s = Math.floor(seconds % 60)
      return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + s + 's' : s + 's'
    }
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) throw new Error(json.error || 'request failed')
      return json.data ?? json
    }
    async function refresh() {
      try {
        const data = await api('/api/status')
        lastData = data
        const loadedCount = (data.loadedPlugins || []).length
        const availableCount = (data.availablePlugins || []).length
        const configuredCount = (data.configuredPlugins || []).length

        document.getElementById('state').textContent = stateText[data.state] || data.state || '-'
        document.getElementById('dot').className = 'dot ' + data.state
        document.getElementById('appID').textContent = data.appID || '-'
        document.getElementById('uptime').textContent = formatUptime(data.uptime)
        document.getElementById('pluginDir').textContent = data.pluginDir || '-'
        document.getElementById('intents').textContent = (data.intents || []).join(', ') || '-'
        document.getElementById('loadedCount').textContent = String(loadedCount)
        document.getElementById('availableCount').textContent = String(availableCount)
        document.getElementById('configuredCount').textContent = String(configuredCount)
        renderPlugins(data)
      } catch (error) {
        document.getElementById('state').textContent = needsToken ? '需要 Token' : '离线'
      }
    }
    function renderPlugins(data) {
      if (!data) return
      const loaded = new Map((data.loadedPlugins || []).map(item => [item.name, item]))
      const search = document.getElementById('pluginSearch').value.trim().toLowerCase()
      const names = Array.from(new Set([...(data.availablePlugins || []), ...(data.configuredPlugins || [])])).sort()
        .filter(name => !search || name.toLowerCase().includes(search))
        .filter(name => pluginFilter === 'all' || (pluginFilter === 'loaded' ? loaded.has(name) : !loaded.has(name)))

      if (selectedPlugin && !names.includes(selectedPlugin)) selectedPlugin = ''
      document.getElementById('plugins').innerHTML = names.map(name => {
        const item = loaded.get(name)
        const status = item ? '<span class="pill loaded">已加载</span>' : '<span class="pill">未加载</span>'
        const version = item?.version || '-'
        const handlers = item?.handlers ?? '-'
        const selected = selectedPlugin === name ? ' class="selected"' : ''
        return '<tr' + selected + ' data-plugin="' + escapeHtml(name) + '"><td class="name">' + escapeHtml(name) + '</td><td>' + status + '</td><td>' + escapeHtml(version) + '</td><td>' + escapeHtml(handlers) + '</td></tr>'
      }).join('') || '<tr><td class="name" colspan="4">无</td></tr>'
      document.querySelectorAll('#plugins tr[data-plugin]').forEach(row => {
        row.addEventListener('click', () => selectPlugin(row.dataset.plugin || ''))
      })
      syncPluginActions(data)
    }
    function selectPlugin(name) {
      selectedPlugin = name
      renderPlugins(lastData)
    }
    function syncPluginActions(data) {
      const loaded = new Set((data.loadedPlugins || []).map(item => item.name))
      const hasSelection = Boolean(selectedPlugin)
      const isLoaded = loaded.has(selectedPlugin)
      document.getElementById('pluginActions').hidden = !hasSelection
      document.getElementById('selectedPluginName').textContent = selectedPlugin
      document.getElementById('pluginLoadButton').hidden = !hasSelection || isLoaded
      document.getElementById('pluginReloadButton').hidden = !hasSelection || !isLoaded
      document.getElementById('pluginUnloadButton').hidden = !hasSelection || !isLoaded
    }
    async function post(path, body) {
      try {
        await api(path, { method: 'POST', body: JSON.stringify(body || {}) })
        show('完成')
        await refresh()
      } catch (error) {
        show(error.message)
      }
    }
    function operateSelected(path) {
      if (!selectedPlugin) return show('未选择')
      post(path, { name: selectedPlugin })
    }
    function saveToken() {
      token = document.getElementById('tokenInput').value.trim()
      if (token) localStorage.setItem('qingbot-token', token)
      else localStorage.removeItem('qingbot-token')
      show('已保存')
      refresh()
    }
    function clearToken() {
      token = ''
      document.getElementById('tokenInput').value = ''
      localStorage.removeItem('qingbot-token')
      show('已清除')
      refresh()
    }
    function stopBot() {
      if (confirm('关闭 QingBot？')) post('/api/stop')
    }
    refresh()
    setInterval(refresh, 3000)
  </script>
</body>
</html>`
}
