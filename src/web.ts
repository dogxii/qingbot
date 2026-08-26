import fs from 'fs'
import path from 'path'
import http, { type IncomingMessage, type ServerResponse } from 'http'
import type { Logger } from './logger'
import type { QingBotWebConfig } from './types'

type Awaitable<T> = T | Promise<T>
const MAX_REQUEST_BODY_BYTES = 512 * 1024

export interface WebConfigFile {
  id: string
  label: string
  path: string
  exists: boolean
  kind: 'root' | 'local' | 'plugin'
  pluginName?: string
}

export interface WebConfigFileContent extends WebConfigFile {
  content: string
}

export interface WebPluginOperationResult {
  ok: boolean
  message: string
}

export type WebMessageTargetType = 'group' | 'user' | 'channel' | 'direct'
export type WebMessageFormat = 'text' | 'markdown'
export type WebSimulateMessageType = 'group' | 'private' | 'guild'

export interface WebSendMessageInput {
  targetType: WebMessageTargetType
  targetId: string
  format?: WebMessageFormat
  content: string
}

export interface WebCapturedMessage {
  id: string
  targetType: WebMessageTargetType
  targetId: string
  format: WebMessageFormat | 'mixed'
  content: string
  payload: unknown
  source?: unknown
  createdAt: string
}

export interface WebMessageLogEntry {
  id: string
  direction: 'in' | 'out'
  targetType: WebMessageTargetType
  targetId: string
  displayTarget?: string
  userId?: string
  nickname?: string
  format: WebMessageFormat | 'mixed'
  content: string
  payload?: unknown
  source?: unknown
  createdAt: string
}

export interface WebMessageConversation {
  key: string
  targetType: WebMessageTargetType
  targetId: string
  alias?: string
  title: string
  lastContent?: string
  lastDirection?: 'in' | 'out'
  lastAt?: string
  createdAt: string
  updatedAt: string
}

export interface WebMessageConversationInput {
  targetType: WebMessageTargetType
  targetId: string
  alias?: string
}

export interface WebSimulateMessageInput {
  messageType?: WebSimulateMessageType
  userId?: string
  nickname?: string
  groupId?: string
  channelId?: string
  guildId?: string
  role?: string
  content: string
}

export interface WebSimulateMessageResult {
  event: {
    messageType: WebSimulateMessageType
    userId: string
    nickname: string
    groupId?: string
    channelId?: string
    guildId?: string
    role?: string
    content: string
  }
  replies: WebCapturedMessage[]
}

export interface WebConsoleTarget {
  getStatus(): unknown
  getWebToken?(): string
  getConfigFiles(): Awaitable<WebConfigFile[]>
  readConfigFile(id: string): Awaitable<WebConfigFileContent>
  saveConfigFile(id: string, content: string): Awaitable<WebConfigFileContent>
  getWebMessageLog(targetType?: WebMessageTargetType, targetId?: string): Awaitable<WebMessageLogEntry[]>
  getWebMessageConversations(): Awaitable<WebMessageConversation[]>
  saveWebMessageConversation(input: WebMessageConversationInput): Promise<WebMessageConversation>
  resolveWebMediaFile?(source: string): Awaitable<string | undefined>
  sendWebMessage(input: WebSendMessageInput): Promise<WebPluginOperationResult>
  simulateWebMessage(input: WebSimulateMessageInput): Promise<WebSimulateMessageResult>
  reloadConfig(): Promise<unknown>
  reloadAllPlugins(): Promise<string[]>
  reloadPlugin(name: string): Promise<boolean>
  enablePlugin(name: string): Promise<WebPluginOperationResult>
  disablePlugin(name: string): Promise<WebPluginOperationResult>
  stop(): Promise<void>
}

export interface WebConsole {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createWebConsole(target: WebConsoleTarget, config: QingBotWebConfig, logger: Logger): WebConsole {
  const host = config.host || '127.0.0.1'
  const port = config.port || 3300
  const server = http.createServer((req, res) => {
    void route(req, res, target)
  })

  if (!getWebToken(target, config) && !isLoopbackHost(host)) {
    logger.warn('Web 管理台未设置 token，建议只监听 127.0.0.1，公网或反代访问请设置 web.token。')
  }

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

async function route(req: IncomingMessage, res: ServerResponse, target: WebConsoleTarget) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const token = getWebToken(target)

  if (req.method === 'GET' && url.pathname === '/') {
    if (!token && !isLoopbackRequest(req, url)) {
      return sendText(res, 403, 'Web console is local-only when web.token is empty.')
    }
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

    if (req.method === 'GET' && url.pathname === '/api/config-files') {
      return sendJson(res, 200, { ok: true, data: await target.getConfigFiles() })
    }

    if (req.method === 'GET' && url.pathname === '/api/config-file') {
      const id = String(url.searchParams.get('id') || '').trim()
      if (!id) return sendJson(res, 400, { ok: false, error: 'missing config file id' })
      return sendJson(res, 200, { ok: true, data: await target.readConfigFile(id) })
    }

    if (req.method === 'GET' && url.pathname === '/api/message-log') {
      const targetType = String(url.searchParams.get('targetType') || '').trim() as WebMessageTargetType
      const targetId = String(url.searchParams.get('targetId') || '').trim()
      return sendJson(res, 200, { ok: true, data: await target.getWebMessageLog(targetType || undefined, targetId || undefined) })
    }

    if (req.method === 'GET' && url.pathname === '/api/message-conversations') {
      return sendJson(res, 200, { ok: true, data: await target.getWebMessageConversations() })
    }

    if (req.method === 'GET' && url.pathname === '/api/media') {
      const source = String(url.searchParams.get('path') || '').trim()
      if (!source) return sendText(res, 400, 'missing media path')
      const filePath = await target.resolveWebMediaFile?.(source)
      if (!filePath) return sendText(res, 404, 'media not found')
      return sendFile(res, filePath)
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

    if (url.pathname === '/api/reload-config') {
      return sendJson(res, 200, { ok: true, data: await target.reloadConfig() })
    }

    if (url.pathname === '/api/reload-all') {
      return sendJson(res, 200, { ok: true, data: await target.reloadAllPlugins() })
    }

    const body = await readJson(req)

    if (url.pathname === '/api/config-file') {
      const id = String(body.id || '').trim()
      const content = String(body.content || '')
      if (!id) return sendJson(res, 400, { ok: false, error: 'missing config file id' })
      const saved = await target.saveConfigFile(id, content)
      const reloaded = body.reload ? await target.reloadConfig() : undefined
      return sendJson(res, 200, { ok: true, data: { ...saved, reloaded } })
    }

    if (url.pathname === '/api/send-message') {
      return sendPluginOperation(res, await target.sendWebMessage(body as WebSendMessageInput))
    }

    if (url.pathname === '/api/message-conversation') {
      return sendJson(res, 200, { ok: true, data: await target.saveWebMessageConversation(body as WebMessageConversationInput) })
    }

    if (url.pathname === '/api/simulate-message') {
      return sendJson(res, 200, { ok: true, data: await target.simulateWebMessage(body as WebSimulateMessageInput) })
    }

    const name = String(body.name || '').trim()

    if (url.pathname === '/api/reload-plugin') {
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing plugin name' })
      const ok = await target.reloadPlugin(name)
      return sendPluginOperation(res, {
        ok,
        message: ok ? `插件已重载：${name}` : `插件不存在或加载失败：${name}`,
      })
    }

    if (url.pathname === '/api/enable-plugin') {
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing plugin name' })
      return sendPluginOperation(res, await target.enablePlugin(name))
    }

    if (url.pathname === '/api/disable-plugin') {
      if (!name) return sendJson(res, 400, { ok: false, error: 'missing plugin name' })
      return sendPluginOperation(res, await target.disablePlugin(name))
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

function getWebToken(target: WebConsoleTarget, fallback?: QingBotWebConfig) {
  return target.getWebToken?.() || fallback?.token || ''
}

function isAuthorized(req: IncomingMessage, url: URL, token: string) {
  if (!token) return isLoopbackRequest(req, url)
  const header = req.headers.authorization || ''
  return header === `Bearer ${token}` || url.searchParams.get('token') === token
}

function isLoopbackRequest(req: IncomingMessage, url: URL) {
  return isLoopbackAddress(req.socket.remoteAddress || '') || isLoopbackHost(url.hostname)
}

function isLoopbackAddress(address: string) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(address)
}

function isLoopbackHost(host: string) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host)
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0
    let data = ''

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

function sendHtml(res: ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendPluginOperation(res: ServerResponse, result: WebPluginOperationResult) {
  return sendJson(res, result.ok ? 200 : 400, {
    ok: result.ok,
    data: result,
    error: result.ok ? undefined : result.message,
  })
}

function sendEmpty(res: ServerResponse, status: number) {
  res.writeHead(status)
  res.end()
}

function sendFile(res: ServerResponse, filePath: string) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) return sendText(res, 404, 'media not found')

  res.writeHead(200, {
    'content-type': getMediaContentType(filePath),
    'content-length': stat.size,
    'cache-control': 'private, max-age=300',
  })
  fs.createReadStream(filePath).pipe(res)
}

function getMediaContentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

function renderPage(hasToken: boolean) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>QingBot</title>
  <script>
    try {
      var savedTheme = localStorage.getItem('qingbot-theme')
      if (savedTheme) document.documentElement.dataset.theme = savedTheme
      var savedRailWidth = Number(localStorage.getItem('qingbot-sidebar-width') || '')
      if (Number.isFinite(savedRailWidth) && savedRailWidth >= 196 && savedRailWidth <= 360) {
        document.documentElement.style.setProperty('--rail-width', savedRailWidth + 'px')
      }
    } catch (error) {}
  </script>
  <style>
    :root {
      color-scheme: light;
      --page: oklch(98.5% .001 286.376);
      --canvas: oklch(96.1% .002 247.84);
      --surface: oklch(100% 0 0);
      --surface-2: oklch(96.1% .002 247.84);
      --inset: oklch(97.9% .002 247.839);
      --field: oklch(96.1% .001 286.375);
      --hover: oklch(97% .002 247.839);
      --ink: oklch(24.7% .006 258.361);
      --ink-2: oklch(50.6% .01 264.477);
      --ink-3: oklch(69.5% .009 264.505);
      --line: oklch(94.6% .003 264.542);
      --line-soft: oklch(94.6% .003 264.542);
      --line-strong: oklch(91.2% .005 258.326);
      --card-border: oklch(95.8% .002 264.542);
      --rail-border: oklch(88.8% .006 264.542);
      --accent: oklch(62.6% .205 254.947);
      --accent-ink: oklch(55.6% .187 255.617);
      --accent-soft: color-mix(in srgb, var(--accent) 8%, var(--surface));
      --orange: oklch(68.9% .179 49.902);
      --orange-soft: color-mix(in srgb, var(--orange) 14%, var(--surface));
      --red: oklch(62.1% .192 23.042);
      --red-soft: color-mix(in srgb, var(--red) 11%, var(--surface));
      --hairline: 0 0 0 1px var(--line);
      --shadow: 0 18px 47px 0 #00000008, 0 7.5px 19px 0 #00000005, 0 4px 10.5px 0 #00000005;
      --card-shadow: 0 1px 2px #00000005;
      --button-shadow: 0 0 0 1px var(--line-strong), 0 1px 2px #00000008, 0 0 4px 0 #0000000a;
      --focus: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
      --rail-width: 236px;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --page: oklch(20.9% .004 264.477);
        --canvas: oklch(23.1% .004 264.487);
        --surface: oklch(26% .006 271.191);
        --surface-2: oklch(23.1% .004 264.487);
        --inset: oklch(24.3% .004 264.492);
        --field: oklch(29.3% .006 271.223);
        --hover: oklch(28.9% .006 271.22);
        --ink: oklch(96.4% .002 247.839);
        --ink-2: oklch(73.1% .008 260.731);
        --ink-3: oklch(54.1% .01 264.484);
        --line: oklch(30.8% .006 258.354);
        --line-soft: oklch(30.8% .006 258.354);
        --line-strong: oklch(35.6% .007 264.474);
        --card-border: oklch(32.8% .006 264.474);
        --rail-border: var(--line);
        --accent: oklch(68% .173 253.301);
        --accent-ink: oklch(78.8% .113 248.33);
        --accent-soft: color-mix(in srgb, var(--accent) 22%, var(--surface));
        --orange: oklch(74.6% .156 55.642);
        --orange-soft: color-mix(in srgb, var(--orange) 22%, var(--surface));
        --red: oklch(66.6% .18 21.433);
        --red-soft: color-mix(in srgb, var(--red) 20%, var(--surface));
        --hairline: 0 0 0 1px var(--line);
        --shadow: 0 1px 2px oklch(0% 0 0/.2), 0 2px 6px oklch(0% 0 0/.2);
        --card-shadow: 0 1px 2px oklch(0% 0 0/.16);
        --button-shadow: 0 0 0 1px oklch(100% 0 0/.1), 0 1px 2px oklch(0% 0 0/.3);
        --focus: 0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent);
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --page: oklch(20.9% .004 264.477);
      --canvas: oklch(23.1% .004 264.487);
      --surface: oklch(26% .006 271.191);
      --surface-2: oklch(23.1% .004 264.487);
      --inset: oklch(24.3% .004 264.492);
      --field: oklch(29.3% .006 271.223);
      --hover: oklch(28.9% .006 271.22);
      --ink: oklch(96.4% .002 247.839);
      --ink-2: oklch(73.1% .008 260.731);
      --ink-3: oklch(54.1% .01 264.484);
      --line: oklch(30.8% .006 258.354);
      --line-soft: oklch(30.8% .006 258.354);
      --line-strong: oklch(35.6% .007 264.474);
      --card-border: oklch(32.8% .006 264.474);
      --rail-border: var(--line);
      --accent: oklch(68% .173 253.301);
      --accent-ink: oklch(78.8% .113 248.33);
      --accent-soft: color-mix(in srgb, var(--accent) 22%, var(--surface));
      --orange: oklch(74.6% .156 55.642);
      --orange-soft: color-mix(in srgb, var(--orange) 22%, var(--surface));
      --red: oklch(66.6% .18 21.433);
      --red-soft: color-mix(in srgb, var(--red) 20%, var(--surface));
      --hairline: 0 0 0 1px var(--line);
      --shadow: 0 1px 2px oklch(0% 0 0/.2), 0 2px 6px oklch(0% 0 0/.2);
      --card-shadow: 0 1px 2px oklch(0% 0 0/.16);
      --button-shadow: 0 0 0 1px oklch(100% 0 0/.1), 0 1px 2px oklch(0% 0 0/.3);
      --focus: 0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent);
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; }
    body {
      min-height: 100vh;
      margin: 0;
      background: var(--page);
      color: var(--ink);
      font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select, textarea {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
      letter-spacing: 0;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      min-width: 0;
      height: 34px;
      padding: 0 11px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 650;
      white-space: nowrap;
      transition: background-color .14s ease, border-color .14s ease, color .14s ease, transform .14s ease;
    }
    button:hover { background: var(--hover); }
    button:active { transform: translateY(1px); }
    button:disabled {
      opacity: .45;
      cursor: not-allowed;
      transform: none;
    }
    button.primary {
      border-color: var(--ink);
      background: var(--ink);
      color: var(--surface);
      box-shadow: var(--button-shadow);
    }
    button.primary:hover {
      border-color: var(--ink);
      background: color-mix(in srgb, var(--ink) 92%, var(--surface));
    }
    button.ghost {
      border-color: transparent;
      background: transparent;
      color: var(--ink-2);
    }
    button.ghost:hover {
      background: var(--hover);
      color: var(--ink);
    }
    button.danger {
      border-color: transparent;
      background: transparent;
      color: var(--red);
    }
    button.danger:hover {
      border-color: var(--red-soft);
      background: var(--red-soft);
    }
    input, select {
      height: 34px;
      padding: 0 10px;
      background: var(--field);
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: var(--focus);
      outline: 0;
    }
    textarea {
      width: 100%;
      min-height: 520px;
      padding: 14px;
      background: var(--surface-2);
      font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      resize: vertical;
      tab-size: 2;
    }
    [hidden] { display: none !important; }
    .login {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .login-panel {
      width: min(100%, 370px);
      padding: 24px;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .workspace-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 40px;
      margin: 0 2px 16px;
    }
    .workspace-button {
      min-width: 0;
      flex: 1 1 auto;
      justify-content: flex-start;
      border-color: transparent;
      background: transparent;
      padding: 0 6px;
      color: var(--ink);
    }
    .workspace-button:hover { background: var(--hover); }
    button.icon-button {
      width: 32px;
      height: 32px;
      padding: 0;
      border-color: transparent;
      background: transparent;
      color: var(--ink-3);
    }
    button.icon-button:hover {
      background: var(--hover);
      color: var(--ink);
    }
    .brand-mark {
      display: grid;
      width: 28px;
      height: 28px;
      place-items: center;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--field);
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
      box-shadow: var(--button-shadow);
    }
    .login-title {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 760;
    }
    .login-subtitle {
      margin: 4px 0 22px;
      color: var(--ink-3);
      font-size: 13px;
    }
    .login-panel form {
      display: grid;
      gap: 10px;
    }
    .login-panel input,
    .login-panel button {
      width: 100%;
      height: 40px;
    }
    .login-error {
      min-height: 20px;
      color: var(--red);
      font-size: 12px;
    }
    .app-shell {
      min-height: 100vh;
      width: 100%;
      display: grid;
      grid-template-columns: var(--rail-width) minmax(0, 1fr);
      background: var(--page);
      transition: grid-template-columns .22s cubic-bezier(.16,1,.3,1);
    }
    body.sidebar-resizing {
      cursor: col-resize;
      user-select: none;
    }
    body.sidebar-resizing .app-shell {
      transition: none;
    }
    body.sidebar-collapsed .app-shell {
      grid-template-columns: 64px minmax(0, 1fr);
    }
    body.sidebar-collapsed .sidebar-copy,
    body.sidebar-collapsed .brand-title {
      opacity: 0;
      pointer-events: none;
      transform: translateX(-8px);
    }
    body.sidebar-collapsed .workspace-row {
      justify-content: center;
      margin-inline: 0;
    }
    body.sidebar-collapsed .workspace-button {
      display: none;
    }
    .rail {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px 10px;
      border-right: 1px dashed var(--rail-border);
      background: var(--page);
      overflow: hidden;
    }
    .rail-resizer {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 2;
      width: 10px;
      cursor: col-resize;
      outline: 0;
    }
    .rail-resizer::after {
      content: "";
      position: absolute;
      top: 14px;
      right: 0;
      bottom: 14px;
      width: 2px;
      border-radius: 999px;
      background: transparent;
      transition: background-color .14s ease, width .14s ease;
    }
    .rail-resizer:hover::after,
    .rail-resizer:focus-visible::after,
    body.sidebar-resizing .rail-resizer::after {
      width: 3px;
      background: color-mix(in srgb, var(--accent) 45%, var(--rail-border));
    }
    body.sidebar-collapsed .rail-resizer {
      display: none;
    }
    .brand-title {
      min-width: 0;
      transition: opacity .18s ease, transform .18s ease;
    }
    .brand-title h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      font-weight: 760;
    }
    .brand-title p {
      margin: 2px 0 0;
      overflow: hidden;
      color: var(--ink-3);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ink-3);
    }
    .dot.running { background: var(--accent); }
    .dot.starting { background: var(--orange); }
    .dot.stopping,
    .dot.stopped { background: var(--red); }
    .nav-list {
      display: grid;
      gap: 6px;
    }
    .nav-popover {
      display: contents;
    }
    button.nav {
      width: 100%;
      justify-content: flex-start;
      gap: 8px;
      height: 38px;
      border-color: transparent;
      background: transparent;
      color: var(--ink-2);
      font-size: 13.5px;
      font-weight: 560;
      text-align: left;
    }
    button.nav.active {
      background: var(--hover);
      color: var(--ink);
      box-shadow: none;
      font-weight: 650;
    }
    .nav-icon {
      display: inline-flex;
      width: 18px;
      height: 18px;
      flex: 0 0 18px;
      align-items: center;
      justify-content: center;
    }
    .sidebar-copy {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: opacity .18s ease, transform .18s ease;
    }
    .rail-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      margin-top: auto;
      padding: 0 2px;
      color: var(--ink-3);
      font-size: 12px;
    }
    #themeToggle {
      width: 32px;
      height: 32px;
      padding: 0;
      border-color: transparent;
      background: transparent;
      color: var(--ink-3);
    }
    #themeToggle:hover {
      background: var(--hover);
      color: var(--ink);
    }
    #themeToggle svg {
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
    }
    body.sidebar-collapsed .rail-footer {
      justify-content: center;
      padding: 0;
    }
    .workspace {
      min-width: 0;
      --chat-height: min(720px, calc(100vh - 150px));
      padding: 22px clamp(18px, 3.6vw, 42px) 48px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      min-height: 44px;
      margin-bottom: 20px;
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--ink-3);
      font-size: 12px;
      font-weight: 650;
    }
    h2 {
      margin: 0;
      font-size: 25px;
      line-height: 1.15;
      font-weight: 760;
    }
    .top-actions,
    .actions,
    .toolbar,
    .config-toolbar,
    .form-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .last-refresh {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      color: var(--ink-3);
      font-size: 12px;
      white-space: nowrap;
    }
    .last-refresh strong {
      display: inline-block;
      min-width: 56px;
      color: var(--ink-2);
      text-align: left;
    }
    .panel {
      display: none;
      animation: fadeIn .18s ease both;
    }
    .panel.active { display: block; }
    .section {
      padding: 22px 0;
      border-top: 1px dashed var(--line);
    }
    .section:first-child {
      padding-top: 0;
      border-top: 0;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 13px;
    }
    .section-title {
      margin: 0;
      color: var(--ink-2);
      font-size: 12px;
      font-weight: 720;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      min-height: 86px;
      padding: 13px;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--card-shadow);
    }
    .metric-label {
      margin-bottom: 8px;
      color: var(--ink-3);
      font-size: 12px;
      font-weight: 650;
    }
    .metric-value {
      overflow-wrap: anywhere;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 760;
    }
    .metric-note {
      margin-top: 7px;
      overflow: hidden;
      color: var(--ink-3);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--card-shadow);
      overflow: hidden;
    }
    .detail-item {
      min-width: 0;
      padding: 12px 14px;
      border-right: 1px solid var(--line-soft);
      border-bottom: 1px solid var(--line-soft);
    }
    .detail-item:nth-child(2n) { border-right: 0; }
    .detail-item:nth-last-child(-n+2) { border-bottom: 0; }
    .label {
      margin-bottom: 5px;
      color: var(--ink-3);
      font-size: 12px;
      font-weight: 650;
    }
    .value {
      min-width: 0;
      overflow-wrap: anywhere;
      font-size: 13px;
      font-weight: 620;
    }
    .toolbar {
      justify-content: space-between;
      margin-bottom: 14px;
    }
    .toolbar-main {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    #pluginSearch {
      width: 220px;
    }
    .segmented {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: 999px;
      background: var(--field);
      box-shadow: inset 0 0 0 1px var(--line);
    }
    .segmented button {
      height: 28px;
      border-color: transparent;
      border-radius: 999px;
      background: transparent;
      color: var(--ink-3);
      font-size: 12px;
    }
    .segmented button.active {
      background: var(--surface);
      color: var(--ink);
      box-shadow: var(--button-shadow);
    }
    .count {
      min-width: 18px;
      padding: 0 5px;
      border-radius: 5px;
      background: var(--field);
      color: var(--ink-3);
      font-size: 11px;
      line-height: 17px;
      text-align: center;
    }
    .selected-name {
      max-width: 220px;
      overflow: hidden;
      color: var(--ink-2);
      font-size: 13px;
      font-weight: 680;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .table-shell {
      overflow-x: auto;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--card-shadow);
    }
    table {
      width: 100%;
      min-width: 820px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    col.name-col { width: auto; }
    col.status-col { width: 118px; }
    col.version-col { width: 108px; }
    col.handlers-col { width: 96px; }
    col.cron-col { width: 84px; }
    col.deps-col { width: 132px; }
    col.config-col { width: 64px; }
    th, td {
      height: 46px;
      padding: 0 12px;
      border-bottom: 1px solid var(--line-soft);
      text-align: left;
      vertical-align: middle;
    }
    th {
      height: 34px;
      color: var(--ink-3);
      font-size: 12px;
      font-weight: 700;
    }
    tbody tr {
      cursor: pointer;
      transition: background-color .12s ease;
    }
    tbody tr:hover { background: var(--hover); }
    tbody tr.selected { background: var(--accent-soft); }
    tbody tr:last-child td { border-bottom: 0; }
    .name-cell {
      overflow-wrap: anywhere;
      font-weight: 720;
    }
    .plugin-name {
      min-width: 0;
    }
    .plugin-mobile-meta {
      display: none;
    }
    .cell-actions {
      display: flex;
      height: 46px;
      align-items: center;
      justify-content: flex-end;
    }
    button.table-icon {
      width: 30px;
      height: 30px;
      padding: 0;
      border-color: transparent;
      background: transparent;
      color: var(--ink-3);
    }
    button.table-icon:hover {
      background: var(--hover);
      color: var(--ink);
    }
    .muted-cell {
      color: var(--ink-3);
      font-size: 13px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      min-width: 58px;
      padding: 0 8px;
      border-radius: 7px;
      background: var(--field);
      color: var(--ink-2);
      font-size: 12px;
      font-weight: 680;
      white-space: nowrap;
    }
    .badge.loaded {
      background: var(--accent-soft);
      color: var(--accent-ink);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .badge.enabled {
      background: var(--field);
      color: var(--ink-2);
      box-shadow: inset 0 0 0 1px var(--line-strong);
    }
    .badge.missing {
      background: var(--orange-soft);
      color: var(--orange);
    }
    .badge.idle {
      background: var(--field);
      color: var(--ink-3);
    }
    .badge.deps-ok {
      background: var(--accent-soft);
      color: var(--accent-ink);
    }
    .badge.deps-missing,
    .badge.deps-error {
      background: var(--red-soft);
      color: var(--red);
    }
    .badge.deps-optional {
      background: var(--orange-soft);
      color: var(--orange);
    }
    .badge.deps-none {
      background: var(--field);
      color: var(--ink-3);
    }
    .dependency-cell {
      display: grid;
      align-content: center;
      gap: 4px;
      min-width: 0;
    }
    .dependency-hint {
      overflow: hidden;
      color: var(--ink-3);
      font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .config-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .config-toolbar {
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .config-select {
      width: min(100%, 340px);
    }
    .config-mode {
      flex: 0 0 auto;
    }
    .config-path {
      min-width: 0;
      overflow: hidden;
      color: var(--ink-3);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .config-form {
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--card-shadow);
      overflow: hidden;
    }
    .config-group {
      padding: 15px;
      border-top: 1px solid var(--line-soft);
    }
    .config-group:first-child {
      border-top: 0;
    }
    .config-group-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .config-group-title {
      margin: 0;
      color: var(--ink);
      font-size: 13px;
      font-weight: 720;
    }
    .config-group-note {
      color: var(--ink-3);
      font-size: 12px;
      font-weight: 600;
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .config-grid.three {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .config-field {
      min-width: 0;
      display: grid;
      gap: 6px;
    }
    .config-field.wide {
      grid-column: 1 / -1;
    }
    .config-field label {
      color: var(--ink-2);
      font-size: 12px;
      font-weight: 660;
    }
    .config-field input,
    .config-field select,
    .config-field textarea {
      width: 100%;
    }
    .config-field textarea {
      min-height: 88px;
      background: var(--field);
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .config-field textarea.tall {
      min-height: 116px;
    }
    .secret-control {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 34px;
      gap: 6px;
    }
    .secret-control button {
      width: 34px;
      height: 34px;
      padding: 0;
      color: var(--ink-3);
    }
    .secret-control button:hover {
      color: var(--ink);
    }
    .config-json-shell {
      margin-top: 12px;
    }
    .editor-shell {
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--card-shadow);
      overflow: hidden;
    }
    .editor-shell textarea {
      display: block;
      border: 0;
      border-radius: 0;
    }
    .config-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 32px;
      padding: 0 2px;
      color: var(--ink-3);
      font-size: 12px;
    }
    .config-error {
      color: var(--red);
      overflow-wrap: anywhere;
    }
    .operation-list {
      display: grid;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--card-shadow);
      overflow: hidden;
    }
    .operation-row {
      display: grid;
      grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      min-height: 64px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line-soft);
    }
    .operation-row:last-child { border-bottom: 0; }
    .operation-title {
      color: var(--ink-2);
      font-size: 13px;
      font-weight: 700;
    }
    .work-grid,
    .message-grid {
      display: grid;
      grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .message-grid {
      grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
      align-items: stretch;
    }
    .form-card,
    .chat-card,
    .log-card {
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--card-shadow);
      overflow: hidden;
    }
    .form-card {
      padding: 14px;
    }
    .field-stack {
      display: grid;
      gap: 6px;
      margin-bottom: 12px;
    }
    .field-stack label {
      color: var(--ink-2);
      font-size: 12px;
      font-weight: 650;
    }
    .field-stack input,
    .field-stack select,
    .field-stack textarea {
      width: 100%;
    }
    .field-stack textarea {
      min-height: 148px;
      background: var(--field);
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .form-card button[type="submit"] {
      width: 100%;
    }
    .log-card {
      min-height: 324px;
      padding: 12px;
    }
    .conversation-panel {
      display: flex;
      height: var(--chat-height);
      min-height: 520px;
      flex-direction: column;
      padding: 12px;
    }
    .conversation-list {
      min-height: 0;
      overflow-y: auto;
      padding-right: 2px;
    }
    .message-list {
      display: grid;
      gap: 8px;
    }
    .message-entry {
      width: 100%;
      height: auto;
      min-height: 64px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 4px;
      align-items: start;
      justify-items: stretch;
      padding: 10px;
      border-color: var(--card-border);
      background: var(--inset);
      color: var(--ink);
      text-align: left;
      white-space: normal;
    }
    .message-entry:hover {
      border-color: var(--line-strong);
      background: var(--hover);
    }
    .message-entry.selected {
      border-color: color-mix(in srgb, var(--accent) 38%, var(--line));
      background: var(--accent-soft);
    }
    .message-entry.out {
      background: var(--surface);
    }
    .message-main {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .message-title {
      min-width: 0;
      overflow: hidden;
      color: var(--ink);
      font-size: 13px;
      font-weight: 680;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .message-preview {
      min-width: 0;
      overflow: hidden;
      color: var(--ink-2);
      font-size: 12px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .message-meta {
      color: var(--ink-3);
      font-size: 11.5px;
      font-weight: 600;
      white-space: nowrap;
    }
    .log-list {
      display: grid;
      gap: 8px;
    }
    .log-empty,
    .chat-empty {
      color: var(--ink-3);
      font-size: 13px;
    }
    .log-item {
      display: grid;
      gap: 4px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--inset);
    }
    .log-item.ok { border-color: var(--line-strong); }
    .log-item.error { border-color: color-mix(in srgb, var(--red) 28%, var(--line)); }
    .log-title {
      color: var(--ink);
      font-size: 13px;
      font-weight: 650;
    }
    .log-meta {
      color: var(--ink-3);
      font-size: 12px;
    }
    .chat-card {
      display: flex;
      height: var(--chat-height);
      min-height: 520px;
      flex-direction: column;
    }
    .conversation-card {
      min-width: 0;
    }
    .chat-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 44px;
      padding: 6px;
      border-bottom: 1px solid var(--line);
    }
    .chat-title {
      padding: 0 8px;
      color: var(--ink-2);
      font-size: 12px;
      font-weight: 650;
    }
    .message-target-bar {
      display: grid;
      grid-template-columns: 112px minmax(180px, 1fr) minmax(140px, 220px) 126px auto;
      gap: 8px;
      align-items: end;
      padding: 10px;
      border-bottom: 1px solid var(--line);
    }
    .inline-field {
      min-width: 0;
      display: grid;
      gap: 5px;
    }
    .inline-field label {
      color: var(--ink-3);
      font-size: 11.5px;
      font-weight: 650;
    }
    .inline-field input,
    .inline-field select {
      width: 100%;
    }
    .chat-stream {
      display: flex;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
      padding: 14px;
      background: var(--surface);
    }
    .bubble {
      max-width: min(76%, 620px);
      padding: 8px 10px;
      border-radius: 12px;
      color: var(--ink);
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
      animation: fadeIn .18s ease both;
    }
    .bubble.user {
      align-self: flex-end;
      background: var(--field);
    }
    .bubble.bot {
      align-self: flex-start;
      border: 1px solid var(--line);
      background: var(--inset);
    }
    .bubble.system {
      align-self: center;
      max-width: 100%;
      border: 1px dashed var(--line);
      background: transparent;
      color: var(--ink-3);
      font-size: 12px;
    }
    .bubble-meta {
      display: block;
      margin-bottom: 3px;
      color: var(--ink-3);
      font-size: 11.5px;
      font-weight: 650;
    }
    .bubble-body {
      display: grid;
      gap: 8px;
    }
    .bubble-text {
      white-space: pre-wrap;
    }
    .bubble-media {
      display: grid;
      gap: 8px;
    }
    .media-wrap {
      position: relative;
      display: block;
      width: fit-content;
      max-width: min(100%, 360px);
      overflow: hidden;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: var(--field);
    }
    .media-wrap img {
      display: block;
      max-width: 100%;
      max-height: 360px;
      object-fit: contain;
    }
    .media-wrap::after {
      position: absolute;
      right: 7px;
      bottom: 7px;
      left: 7px;
      padding: 5px 7px;
      border-radius: 7px;
      background: color-mix(in srgb, var(--ink) 86%, transparent);
      color: var(--surface);
      content: attr(data-info);
      font-size: 11px;
      line-height: 1.35;
      opacity: 0;
      overflow: hidden;
      pointer-events: none;
      text-overflow: ellipsis;
      transform: translateY(4px);
      transition: opacity .14s ease, transform .14s ease;
      white-space: nowrap;
    }
    .media-wrap:hover::after,
    .media-wrap:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
    .composer {
      padding: 8px;
      border-top: 1px solid var(--line);
      background: var(--surface);
    }
    .composer-box {
      display: flex;
      align-items: end;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--field);
      padding: 8px;
      transition: border-color .14s ease, box-shadow .14s ease;
    }
    .composer-box:focus-within {
      border-color: var(--line-strong);
      box-shadow: var(--button-shadow);
    }
    .composer-box textarea {
      min-height: 42px;
      max-height: 160px;
      padding: 0;
      border: 0;
      background: transparent;
      resize: vertical;
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .composer-box textarea:focus {
      box-shadow: none;
    }
    .composer-box button {
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      padding: 0;
      border-radius: 8px;
    }
    .context-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      z-index: 30;
      display: grid;
      place-items: center;
      padding: 20px;
      background: color-mix(in srgb, var(--page) 72%, transparent);
      backdrop-filter: blur(10px);
    }
    .dialog {
      width: min(100%, 360px);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      background: var(--surface);
      box-shadow: var(--shadow);
      padding: 14px;
      animation: popIn .18s cubic-bezier(.23,1,.32,1) both;
    }
    .dialog h3 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 720;
    }
    .dialog p {
      margin: 0 0 14px;
      color: var(--ink-2);
      font-size: 13px;
    }
    .config-dialog {
      width: min(920px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      display: flex;
      flex-direction: column;
      padding: 0;
      overflow: hidden;
    }
    .modal-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 14px;
      border-bottom: 1px solid var(--line);
    }
    .modal-head h3 {
      margin: 0;
    }
    .modal-body {
      min-height: 0;
      overflow: auto;
      padding: 14px;
    }
    .config-dialog .editor-shell {
      margin-top: 12px;
    }
    .config-dialog textarea {
      min-height: 460px;
      max-height: calc(100vh - 260px);
    }
    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    #toast {
      position: fixed;
      left: 50%;
      bottom: 22px;
      z-index: 50;
      max-width: min(420px, calc(100vw - 32px));
      padding: 9px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--ink);
      color: var(--surface);
      box-shadow: var(--shadow);
      font-size: 13px;
      text-align: center;
      opacity: 0;
      pointer-events: none;
      transform: translate(-50%, 8px);
      transition: opacity .16s ease, transform .16s ease;
    }
    #toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes popIn {
      from { opacity: 0; transform: scale(.96) translateY(4px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @media (max-width: 940px) {
      .workspace {
        --chat-height: min(680px, calc(100vh - 132px));
      }
      .app-shell {
        grid-template-columns: 1fr;
      }
      body.sidebar-collapsed .app-shell {
        grid-template-columns: 1fr;
      }
      body.sidebar-collapsed .workspace-row {
        justify-content: space-between;
        margin: 0;
      }
      body.sidebar-collapsed .workspace-button {
        display: flex;
      }
      body.sidebar-collapsed .sidebar-copy,
      body.sidebar-collapsed .brand-title {
        opacity: 1;
        pointer-events: auto;
        transform: none;
      }
      .rail {
        position: sticky;
        height: auto;
        z-index: 10;
        gap: 0;
        padding: 12px 14px;
        border-right: 0;
        border-bottom: 1px dashed var(--rail-border);
        overflow: visible;
      }
      .rail-resizer {
        display: none;
      }
      .workspace-row {
        min-height: 38px;
        margin: 0;
      }
      .rail .brand-row {
        justify-content: flex-start;
      }
      .nav-list {
        display: grid;
        gap: 2px;
      }
      .nav-popover {
        position: absolute;
        top: 54px;
        right: 14px;
        z-index: 20;
        display: none;
        width: min(220px, calc(100vw - 28px));
        padding: 6px;
        border: 1px solid var(--card-border);
        border-radius: 10px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      body.mobile-nav-open .nav-popover {
        display: grid;
        gap: 4px;
      }
      button.nav {
        justify-content: flex-start;
        height: 36px;
        padding: 0 10px;
      }
      .rail-footer {
        display: none;
        justify-content: flex-end;
        margin-top: 4px;
        padding: 6px 0 0;
        border-top: 1px dashed var(--line);
      }
      body.mobile-nav-open .rail-footer {
        display: flex;
      }
      .workspace {
        padding: 24px 20px 44px;
      }
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 680px) {
      .topbar,
      .section-head,
      .toolbar,
      .config-toolbar {
        align-items: flex-start;
        flex-direction: column;
      }
      h2 {
        font-size: 22px;
      }
      .top-actions,
      .actions,
      .toolbar-main,
      .config-actions,
      .config-mode,
      .config-toolbar,
      .work-grid,
      .message-grid {
        width: 100%;
      }
      #pluginSearch,
      .config-select {
        width: 100%;
      }
      .top-actions button,
      .actions button,
      .config-actions button,
      .form-controls button {
        width: auto;
        flex: 0 0 auto;
      }
      .metrics,
      .config-grid,
      .config-grid.three,
      .detail-grid {
        grid-template-columns: 1fr;
      }
      .detail-item,
      .detail-item:nth-child(2n),
      .detail-item:nth-last-child(-n+2) {
        border-right: 0;
        border-bottom: 1px solid var(--line-soft);
      }
      .detail-item:last-child { border-bottom: 0; }
      .segmented {
        width: 100%;
      }
      .segmented button {
        flex: 1 1 0;
      }
      .table-shell {
        overflow-x: visible;
        border: 0;
        background: transparent;
        box-shadow: none;
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
      tbody {
        display: grid;
        gap: 9px;
      }
      tbody tr {
        display: grid;
        grid-template-areas:
          "name status"
          "name actions";
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px 12px;
        min-height: 0;
        padding: 12px;
        border: 1px solid var(--card-border);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--card-shadow);
      }
      tbody tr:hover,
      tbody tr.selected {
        background: var(--surface);
        border-color: var(--accent);
      }
      th,
      td {
        height: auto;
        padding: 0;
        border-bottom: 0;
      }
      #panel-plugins .toolbar {
        align-items: stretch;
      }
      #pluginActions {
        width: auto;
        max-width: 100%;
        align-self: flex-end;
        justify-content: flex-end;
      }
      #pluginActions .selected-name {
        max-width: min(36vw, 150px);
      }
      #panel-plugins .name-cell {
        grid-area: name;
        display: grid;
        gap: 5px;
        align-content: start;
      }
      .plugin-mobile-meta {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        gap: 6px;
        color: var(--ink-3);
        font-size: 11.5px;
        font-weight: 600;
        line-height: 1.35;
      }
      td:nth-child(2) {
        grid-area: status;
        justify-self: end;
      }
      td:nth-child(3),
      td:nth-child(4),
      td:nth-child(5),
      td:nth-child(6) {
        display: none;
      }
      td:nth-child(7) {
        grid-area: actions;
        display: flex;
        align-items: center;
        justify-self: end;
        align-self: end;
      }
      .cell-actions {
        height: auto;
        min-height: 30px;
      }
      td[data-label]::before {
        content: attr(data-label);
        color: var(--ink-2);
        font-weight: 650;
      }
      textarea {
        min-height: 420px;
      }
      .composer-box textarea {
        min-height: 42px;
      }
      .operation-row {
        grid-template-columns: 1fr;
      }
      .work-grid,
      .message-grid {
        grid-template-columns: 1fr;
      }
      #panel-debug .chat-card {
        order: -1;
      }
      .message-target-bar {
        grid-template-columns: 1fr;
      }
      .message-target-bar button {
        justify-self: start;
      }
      .conversation-panel,
      .chat-card {
        min-height: 460px;
      }
      .config-dialog textarea {
        min-height: 360px;
      }
      .bubble {
        max-width: 90%;
      }
    }
  </style>
</head>
<body>
  <div class="login" id="loginView" ${hasToken ? '' : 'hidden'}>
    <section class="login-panel">
      <div class="brand-row">
        <div class="brand-mark">Q</div>
        <div>
          <h1 class="login-title">QingBot</h1>
          <p class="login-subtitle">管理入口</p>
        </div>
      </div>
      <form id="loginForm">
        <input type="text" name="username" autocomplete="username" value="qingbot" hidden>
        <input id="loginTokenInput" type="password" placeholder="Token" autocomplete="current-password" autofocus>
        <button class="primary" type="submit">登录</button>
        <div class="login-error" id="loginError"></div>
      </form>
    </section>
  </div>

  <div class="app-shell" id="appView" ${hasToken ? 'hidden' : ''}>
    <aside class="rail">
      <div class="workspace-row">
        <button class="workspace-button" type="button" onclick="switchTab('overview', '主页')">
          <div class="brand-title sidebar-copy">
            <h1 id="botName">QingBot</h1>
          </div>
        </button>
        <button class="icon-button" id="sidebarToggle" type="button" aria-label="折叠侧栏">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h16M4 19h16"/></svg>
        </button>
      </div>

      <div class="nav-popover">
        <nav class="nav-list" aria-label="管理导航">
          <button class="nav active" data-tab="overview" data-title="主页"><span class="nav-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v10h14V10"/></svg></span><span class="sidebar-copy">主页</span></button>
          <button class="nav" data-tab="plugins" data-title="插件"><span class="nav-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8v6H8zM4 15h7v6H4zM13 15h7v6h-7z"/><path d="M12 9v3M7.5 12h9"/></svg></span><span class="sidebar-copy">插件</span></button>
          <button class="nav" data-tab="config" data-title="配置"><span class="nav-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span><span class="sidebar-copy">配置</span></button>
          <button class="nav" data-tab="messages" data-title="消息"><span class="nav-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H7l-3 3z"/><path d="M8 9h8M8 13h5"/></svg></span><span class="sidebar-copy">消息</span></button>
          <button class="nav" data-tab="debug" data-title="调试"><span class="nav-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8h8v8H8z"/><path d="M3 12h5M16 12h5M12 3v5M12 16v5"/></svg></span><span class="sidebar-copy">调试</span></button>
          <button class="nav" data-tab="control" data-title="系统"><span class="nav-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4"/><path d="M7 5.7A8 8 0 1 0 17 5.7"/></svg></span><span class="sidebar-copy">系统</span></button>
        </nav>

        <div class="rail-footer">
          <button id="themeToggle" type="button" aria-label="切换主题" title="切换主题"></button>
        </div>
      </div>
      <div class="rail-resizer" id="railResizer" role="separator" aria-orientation="vertical" aria-valuemin="196" aria-valuemax="360" tabindex="0" aria-label="调整导航宽度" title="拖动调整导航宽度"></div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div>
          <h2 id="pageTitle">主页</h2>
        </div>
        <div class="top-actions">
          <span class="last-refresh">已更新&nbsp;<strong id="updatedAt">-</strong></span>
          <button class="ghost" type="button" onclick="refresh()">刷新</button>
        </div>
      </header>

      <section class="panel active" id="panel-overview">
        <div class="section">
          <div class="metrics">
            <div class="metric">
              <div class="metric-label">机器人</div>
              <div class="metric-value" id="overviewState">-</div>
              <div class="metric-note" id="sandbox">-</div>
            </div>
            <div class="metric">
              <div class="metric-label">在线时长</div>
              <div class="metric-value" id="uptime">-</div>
              <div class="metric-note" id="pid">-</div>
            </div>
            <div class="metric">
              <div class="metric-label">插件</div>
              <div class="metric-value"><span id="loadedCount">0</span>/<span id="availableCount">0</span></div>
              <div class="metric-note">已启用 <span id="configuredCount">0</span></div>
            </div>
            <div class="metric">
              <div class="metric-label">内存</div>
              <div class="metric-value" id="rss">-</div>
              <div class="metric-note" id="heap">-</div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-head">
            <p class="section-title">系统信息</p>
          </div>
          <div class="detail-grid">
            <div class="detail-item">
              <div class="label">AppID</div>
              <div class="value" id="appID">-</div>
            </div>
            <div class="detail-item">
              <div class="label">Intents</div>
              <div class="value" id="intents">-</div>
            </div>
            <div class="detail-item">
              <div class="label">插件目录</div>
              <div class="value" id="pluginDir">-</div>
            </div>
            <div class="detail-item">
              <div class="label">Node</div>
              <div class="value" id="nodeVersion">-</div>
            </div>
            <div class="detail-item">
              <div class="label">平台</div>
              <div class="value" id="platform">-</div>
            </div>
            <div class="detail-item">
              <div class="label">系统内存</div>
              <div class="value" id="systemMemory">-</div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel" id="panel-plugins">
        <div class="section">
          <div class="toolbar">
            <div class="toolbar-main">
              <input id="pluginSearch" placeholder="搜索插件" autocomplete="off">
              <div class="segmented" role="tablist" aria-label="插件筛选">
                <button class="filter active" data-filter="all" type="button">全部 <span class="count" id="filterAllCount">0</span></button>
                <button class="filter" data-filter="loaded" type="button">已加载 <span class="count" id="filterLoadedCount">0</span></button>
                <button class="filter" data-filter="idle" type="button">未加载 <span class="count" id="filterIdleCount">0</span></button>
              </div>
            </div>
            <div class="actions" id="pluginActions" hidden>
              <span class="selected-name" id="selectedPluginName"></span>
              <button id="pluginLoadButton" type="button" onclick="operateSelected('/api/enable-plugin')">启用</button>
              <button id="pluginReloadButton" type="button" onclick="operateSelected('/api/reload-plugin')">重载</button>
              <button class="danger" id="pluginUnloadButton" type="button" onclick="operateSelected('/api/disable-plugin')">禁用</button>
            </div>
          </div>

          <div class="table-shell">
            <table>
              <colgroup>
                <col class="name-col">
                <col class="status-col">
                <col class="version-col">
                <col class="handlers-col">
                <col class="cron-col">
                <col class="deps-col">
                <col class="config-col">
              </colgroup>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>版本</th>
                  <th>处理器</th>
                  <th>定时</th>
                  <th>依赖</th>
                  <th>配置</th>
                </tr>
              </thead>
              <tbody id="plugins"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="panel" id="panel-config">
        <div class="section">
          <div class="section-head">
            <p class="section-title">配置文件</p>
            <div class="config-actions">
              <button type="button" onclick="loadConfigFiles(false)">刷新</button>
              <button id="configFormatButton" type="button" onclick="formatConfigEditor()" hidden>格式化 JSON</button>
              <button type="button" onclick="saveConfigFile(false)">保存</button>
              <button class="primary" type="button" onclick="saveConfigFile(true)">保存并重载</button>
            </div>
          </div>
          <div class="config-toolbar">
            <select class="config-select" id="configFileSelect"></select>
            <div class="segmented config-mode" role="tablist" aria-label="配置编辑模式">
              <button class="filter active" data-config-mode="form" type="button">表单</button>
              <button class="filter" data-config-mode="json" type="button">JSON</button>
            </div>
            <span class="config-path" id="configPath">-</span>
          </div>
          <form class="config-form" id="configForm" autocomplete="off">
            <div class="config-group">
              <div class="config-group-head">
                <p class="config-group-title">机器人</p>
                <span class="config-group-note">基础连接与消息行为</span>
              </div>
              <div class="config-grid">
                <div class="config-field">
                  <label for="cfgBotName">名称</label>
                  <input id="cfgBotName" data-config-field="botName" autocomplete="off">
                </div>
                <div class="config-field">
                  <label for="cfgAppID">AppID</label>
                  <input id="cfgAppID" data-config-field="appID" autocomplete="off">
                </div>
                <div class="config-field wide">
                  <label for="cfgAppSecret">AppSecret</label>
                  <div class="secret-control">
                    <input id="cfgAppSecret" data-config-field="appSecret" type="password" autocomplete="new-password">
                    <button type="button" data-secret-toggle="cfgAppSecret" aria-label="显示 AppSecret" title="显示 AppSecret"></button>
                  </div>
                </div>
                <div class="config-field">
                  <label for="cfgSandbox">沙箱模式</label>
                  <select id="cfgSandbox" data-config-field="sandbox">
                    <option value="">默认</option>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </div>
                <div class="config-field">
                  <label for="cfgRemoveAt">移除 @</label>
                  <select id="cfgRemoveAt" data-config-field="removeAt">
                    <option value="">默认</option>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </div>
                <div class="config-field">
                  <label for="cfgDebug">调试日志</label>
                  <select id="cfgDebug" data-config-field="debug">
                    <option value="">默认</option>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </div>
                <div class="config-field">
                  <label for="cfgLogLevel">日志级别</label>
                  <select id="cfgLogLevel" data-config-field="logLevel">
                    <option value="">默认</option>
                    <option value="trace">trace</option>
                    <option value="debug">debug</option>
                    <option value="info">info</option>
                    <option value="warn">warn</option>
                    <option value="error">error</option>
                    <option value="fatal">fatal</option>
                    <option value="mark">mark</option>
                    <option value="off">off</option>
                  </select>
                </div>
              </div>
            </div>

            <div class="config-group">
              <div class="config-group-head">
                <p class="config-group-title">Web 访问</p>
                <span class="config-group-note">管理页监听与访问令牌</span>
              </div>
              <div class="config-grid">
                <div class="config-field">
                  <label for="cfgWebEnabled">管理页</label>
                  <select id="cfgWebEnabled" data-config-field="web.enabled">
                    <option value="">默认</option>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </div>
                <div class="config-field">
                  <label for="cfgWebHost">监听地址</label>
                  <input id="cfgWebHost" data-config-field="web.host" autocomplete="off" placeholder="127.0.0.1">
                </div>
                <div class="config-field">
                  <label for="cfgWebPort">端口</label>
                  <input id="cfgWebPort" data-config-field="web.port" type="number" min="1" max="65535" inputmode="numeric" placeholder="3300">
                </div>
                <div class="config-field">
                  <label for="cfgWebToken">访问令牌</label>
                  <div class="secret-control">
                    <input id="cfgWebToken" data-config-field="web.token" type="password" autocomplete="new-password">
                    <button type="button" data-secret-toggle="cfgWebToken" aria-label="显示访问令牌" title="显示访问令牌"></button>
                  </div>
                </div>
              </div>
            </div>

            <div class="config-group">
              <div class="config-group-head">
                <p class="config-group-title">插件与权限</p>
                <span class="config-group-note">一行一个，或用逗号分隔</span>
              </div>
              <div class="config-grid">
                <div class="config-field wide">
                  <label for="cfgPlugins">启用插件</label>
                  <textarea id="cfgPlugins" class="tall" data-config-field="plugins" spellcheck="false"></textarea>
                </div>
                <div class="config-field">
                  <label for="cfgPluginDir">插件目录</label>
                  <input id="cfgPluginDir" data-config-field="pluginDir" autocomplete="off" placeholder="plugins">
                </div>
                <div class="config-field">
                  <label for="cfgAllowPublicControl">公开控制命令</label>
                  <select id="cfgAllowPublicControl" data-config-field="allowPublicControl">
                    <option value="">默认</option>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </div>
                <div class="config-field">
                  <label for="cfgLegacyIdMode">ID 显示</label>
                  <select id="cfgLegacyIdMode" data-config-field="legacyIdMode">
                    <option value="">默认</option>
                    <option value="alias">别名</option>
                    <option value="official">官方 ID</option>
                  </select>
                </div>
                <div class="config-field">
                  <label for="cfgOwnerIds">所有者 ID</label>
                  <textarea id="cfgOwnerIds" data-config-field="ownerIds" spellcheck="false"></textarea>
                </div>
                <div class="config-field">
                  <label for="cfgAdminIds">管理员 ID</label>
                  <textarea id="cfgAdminIds" data-config-field="adminIds" spellcheck="false"></textarea>
                </div>
              </div>
            </div>

            <div class="config-group">
              <div class="config-group-head">
                <p class="config-group-title">连接</p>
                <span class="config-group-note">通常保持默认即可</span>
              </div>
              <div class="config-grid three">
                <div class="config-field wide">
                  <label for="cfgIntents">事件订阅</label>
                  <textarea id="cfgIntents" data-config-field="intents" spellcheck="false"></textarea>
                </div>
                <div class="config-field wide">
                  <label for="cfgAccessTokenUrl">Token 地址</label>
                  <input id="cfgAccessTokenUrl" data-config-field="accessTokenUrl" autocomplete="off">
                </div>
                <div class="config-field wide">
                  <label for="cfgGatewayUrl">网关地址</label>
                  <input id="cfgGatewayUrl" data-config-field="gatewayUrl" autocomplete="off">
                </div>
                <div class="config-field">
                  <label for="cfgTimeout">超时</label>
                  <input id="cfgTimeout" data-config-field="timeout" type="number" min="0" inputmode="numeric">
                </div>
                <div class="config-field">
                  <label for="cfgMaxRetry">最大重试</label>
                  <input id="cfgMaxRetry" data-config-field="maxRetry" type="number" min="0" inputmode="numeric">
                </div>
                <div class="config-field">
                  <label for="cfgHeartbeatInterval">心跳间隔</label>
                  <input id="cfgHeartbeatInterval" data-config-field="heartbeatInterval" type="number" min="0" inputmode="numeric">
                </div>
                <div class="config-field">
                  <label for="cfgMaxRetries">重连次数</label>
                  <input id="cfgMaxRetries" data-config-field="maxRetries" type="number" min="0" inputmode="numeric">
                </div>
                <div class="config-field">
                  <label for="cfgReconnectDelay">重连延迟</label>
                  <input id="cfgReconnectDelay" data-config-field="reconnectDelay" type="number" min="0" inputmode="numeric">
                </div>
              </div>
            </div>

            <div class="config-group">
              <div class="config-group-head">
                <p class="config-group-title">别名</p>
                <span class="config-group-note">格式：别名 = 官方 ID</span>
              </div>
              <div class="config-grid">
                <div class="config-field">
                  <label for="cfgUserAliases">用户别名</label>
                  <textarea id="cfgUserAliases" data-config-field="aliases.users" spellcheck="false"></textarea>
                </div>
                <div class="config-field">
                  <label for="cfgGroupAliases">群别名</label>
                  <textarea id="cfgGroupAliases" data-config-field="aliases.groups" spellcheck="false"></textarea>
                </div>
              </div>
            </div>
          </form>
          <div class="editor-shell config-json-shell" id="configEditorShell" hidden>
            <textarea id="configEditor" spellcheck="false" autocomplete="off" autocapitalize="off" disabled></textarea>
          </div>
          <div class="config-meta">
            <span id="configDirty"></span>
            <span class="config-error" id="configError"></span>
          </div>
        </div>
      </section>

      <section class="panel" id="panel-messages">
        <div class="section">
          <div class="message-grid">
            <aside class="log-card conversation-panel">
              <div class="section-head">
                <p class="section-title">会话</p>
                <button type="button" onclick="refreshMessageArea(true)">刷新</button>
              </div>
              <div class="message-list conversation-list" id="conversationList">
                <div class="log-empty">暂无会话</div>
              </div>
            </aside>
            <div class="chat-card conversation-card">
              <div class="message-target-bar">
                <div class="inline-field">
                  <label for="sendTargetType">类型</label>
                  <select id="sendTargetType">
                    <option value="group">群</option>
                    <option value="user">用户</option>
                    <option value="channel">频道</option>
                    <option value="direct">频道私信</option>
                  </select>
                </div>
                <div class="inline-field">
                  <label for="sendTargetId">目标 ID</label>
                  <input id="sendTargetId" autocomplete="off" placeholder="目标 ID">
                </div>
                <div class="inline-field">
                  <label for="conversationAlias">备注</label>
                  <input id="conversationAlias" autocomplete="off" placeholder="自定义名称">
                </div>
                <div class="inline-field">
                  <label for="sendFormat">格式</label>
                  <select id="sendFormat">
                    <option value="text">文本</option>
                    <option value="markdown">Markdown</option>
                  </select>
                </div>
                <button type="button" onclick="saveCurrentConversation()">保存</button>
              </div>
              <div class="chat-stream" id="messageTimeline">
                <div class="chat-empty">选择会话或填写目标 ID</div>
              </div>
              <form class="composer" id="sendForm">
                <div class="composer-box">
                  <textarea id="sendContent" placeholder="输入要发送的内容"></textarea>
                  <button class="primary" type="submit" aria-label="发送消息">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </section>

      <section class="panel" id="panel-debug">
        <div class="section">
          <div class="work-grid">
            <aside class="form-card">
              <div class="field-stack">
                <label for="debugMessageType">场景</label>
                <select id="debugMessageType">
                  <option value="group">群聊</option>
                  <option value="private">私聊</option>
                  <option value="guild">频道</option>
                </select>
              </div>
              <div class="context-grid">
                <div class="field-stack">
                  <label for="debugUserId">用户 ID</label>
                  <input id="debugUserId" value="test-user" autocomplete="off">
                </div>
                <div class="field-stack">
                  <label for="debugNickname">昵称</label>
                  <input id="debugNickname" value="测试用户" autocomplete="off">
                </div>
                <div class="field-stack">
                  <label for="debugGroupId">群 ID</label>
                  <input id="debugGroupId" value="test-group" autocomplete="off">
                </div>
                <div class="field-stack">
                  <label for="debugRole">角色</label>
                  <select id="debugRole">
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                    <option value="owner">群主</option>
                  </select>
                </div>
                <div class="field-stack">
                  <label for="debugGuildId">频道 Guild</label>
                  <input id="debugGuildId" value="test-guild" autocomplete="off">
                </div>
                <div class="field-stack">
                  <label for="debugChannelId">频道 ID</label>
                  <input id="debugChannelId" value="test-channel" autocomplete="off">
                </div>
              </div>
            </aside>
            <div class="chat-card">
              <div class="chat-head">
                <div class="chat-title">模拟对话</div>
                <button class="ghost" type="button" onclick="clearDebugChat()">清空</button>
              </div>
              <div class="chat-stream" id="debugTimeline">
                <div class="chat-empty">从下面发送一条测试消息</div>
              </div>
              <form class="composer" id="debugForm">
                <div class="composer-box">
                  <textarea id="debugContent" placeholder="输入消息"></textarea>
                  <button class="primary" type="submit" aria-label="发送测试消息">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </section>

      <section class="panel" id="panel-control">
        <div class="section">
          <div class="operation-list">
            <div class="operation-row">
              <div class="operation-title">配置</div>
              <div class="form-controls">
                <button type="button" onclick="post('/api/reload-config')">重载配置</button>
                <button class="primary" type="button" onclick="post('/api/reload-all')">重载插件</button>
              </div>
            </div>
            ${hasToken ? '<div class="operation-row"><div class="operation-title">登录</div><div class="form-controls"><button type="button" onclick="logout()">退出登录</button></div></div>' : ''}
            <div class="operation-row">
              <div class="operation-title">进程</div>
              <div class="form-controls">
                <button class="danger" type="button" onclick="stopBot()">关闭进程</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div id="toast"></div>
  <div class="dialog-backdrop" id="confirmDialog" hidden>
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
      <h3 id="confirmTitle">确认操作</h3>
      <p id="confirmMessage"></p>
      <div class="dialog-actions">
        <button type="button" onclick="closeConfirmDialog()">取消</button>
        <button class="danger" type="button" id="confirmButton">确认</button>
      </div>
    </section>
  </div>

  <div class="dialog-backdrop" id="pluginConfigDialog" hidden>
    <section class="dialog config-dialog" role="dialog" aria-modal="true" aria-labelledby="pluginConfigName">
      <div class="modal-head">
        <div>
          <h3 id="pluginConfigName">插件配置</h3>
          <p class="config-path" id="pluginConfigPath">-</p>
        </div>
        <button class="icon-button" type="button" onclick="closePluginConfigDialog()" aria-label="关闭配置" title="关闭配置">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="config-actions">
          <button type="button" onclick="loadSelectedPluginConfig(false)">刷新</button>
          <button type="button" onclick="formatPluginConfigEditor()">格式化</button>
          <button type="button" onclick="savePluginConfig(false)">保存</button>
          <button class="primary" type="button" onclick="savePluginConfig(true)">保存并重载</button>
        </div>
        <div class="editor-shell">
          <textarea id="pluginConfigEditor" spellcheck="false" autocomplete="off" autocapitalize="off" disabled></textarea>
        </div>
        <div class="config-meta">
          <span id="pluginConfigDirty"></span>
          <span class="config-error" id="pluginConfigError"></span>
        </div>
      </div>
    </section>
  </div>

  <script>
    const needsToken = ${hasToken ? 'true' : 'false'}
    const qs = new URLSearchParams(location.search)
    let token = qs.get('token') || localStorage.getItem('qingbot-token') || ''
    let lastData = null
    let pluginFilter = 'all'
    let selectedPlugin = ''
    let configFiles = []
    let selectedConfigFile = 'root'
    let configMode = localStorage.getItem('qingbot-config-mode') === 'json' ? 'json' : 'form'
    let configDirty = false
    let configPlugin = ''
    let selectedPluginConfigFile = ''
    let pluginConfigDirty = false
    let activeTab = 'overview'
    let messageConversations = []
    let selectedConversationKey = ''
    let messageLog = []
    let pluginListSignature = ''
    let conversationListSignature = ''
    let messageTimelineSignature = ''
    let statusRefreshInFlight = false
    let messageRefreshInFlight = false
    let messageRefreshQueued = false
    let lastRefreshAt = 0
    let sidebarResizeState = null
    let toastTimer = null
    let confirmHandler = null

    if (qs.get('token')) localStorage.setItem('qingbot-token', qs.get('token'))

    const loginView = document.getElementById('loginView')
    const appView = document.getElementById('appView')
    const loginForm = document.getElementById('loginForm')
    const loginTokenInput = document.getElementById('loginTokenInput')
    const loginError = document.getElementById('loginError')
    const configFileSelect = document.getElementById('configFileSelect')
    const configForm = document.getElementById('configForm')
    const configEditorShell = document.getElementById('configEditorShell')
    const configEditor = document.getElementById('configEditor')
    const configFormatButton = document.getElementById('configFormatButton')
    const configPath = document.getElementById('configPath')
    const configDirtyEl = document.getElementById('configDirty')
    const configError = document.getElementById('configError')
    const pluginConfigDialog = document.getElementById('pluginConfigDialog')
    const pluginConfigEditor = document.getElementById('pluginConfigEditor')
    const pluginConfigPath = document.getElementById('pluginConfigPath')
    const pluginConfigDirtyEl = document.getElementById('pluginConfigDirty')
    const pluginConfigError = document.getElementById('pluginConfigError')
    const conversationList = document.getElementById('conversationList')
    const conversationAlias = document.getElementById('conversationAlias')
    const messageTimeline = document.getElementById('messageTimeline')
    const themeToggle = document.getElementById('themeToggle')
    const sidebarToggle = document.getElementById('sidebarToggle')
    const railResizer = document.getElementById('railResizer')
    const sendForm = document.getElementById('sendForm')
    const debugForm = document.getElementById('debugForm')
    const debugContent = document.getElementById('debugContent')
    const debugTimeline = document.getElementById('debugTimeline')
    const confirmDialog = document.getElementById('confirmDialog')
    const confirmMessage = document.getElementById('confirmMessage')
    const confirmButton = document.getElementById('confirmButton')

    const sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
    const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.99 13A9 9 0 1 1 11 3.01 7 7 0 0 0 20.99 13Z"/></svg>'
    const sidebarCollapseIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m16 15-3-3 3-3"/></svg>'
    const sidebarExpandIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m14 9 3 3-3 3"/></svg>'
    const menuIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
    const closeIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    const settingsIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.67 3.5 9 5.6a7.2 7.2 0 0 0-1.23.72L5.6 5.86 3.5 9.5l1.48 1.55a7.2 7.2 0 0 0 0 1.9L3.5 14.5l2.1 3.64 2.17-.46c.38.28.79.52 1.23.72l.67 2.1h4.2l.67-2.1c.44-.2.85-.44 1.23-.72l2.17.46 2.1-3.64-1.48-1.55a7.2 7.2 0 0 0 0-1.9l1.48-1.55-2.1-3.64-2.17.46a7.2 7.2 0 0 0-1.23-.72l-.67-2.1z"/><circle cx="11.77" cy="12" r="2.6"/></svg>'
    const eyeIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
    const eyeOffIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58"/><path d="M9.88 4.24A10.7 10.7 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-3.1 4.35"/><path d="M6.61 6.61A18 18 0 0 0 2 12s3.5 8 10 8a10.8 10.8 0 0 0 5.39-1.39"/></svg>'
    const sidebarWidthStorageKey = 'qingbot-sidebar-width'
    const sidebarWidthDefault = 236
    const sidebarWidthMin = 196
    const sidebarWidthMax = 360
    const mobileNavQuery = window.matchMedia('(max-width: 940px)')

    const stateText = {
      created: '未启动',
      starting: '启动中',
      running: '在线',
      stopping: '停止中',
      stopped: '已停止'
    }

    if (loginForm) {
      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault()
        token = loginTokenInput.value.trim()
        loginError.textContent = ''
        if (!token) {
          loginError.textContent = '请输入 Token'
          return
        }
        localStorage.setItem('qingbot-token', token)
        if (!(await refresh())) {
          localStorage.removeItem('qingbot-token')
        }
      })
    }

    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => switchTab(button.dataset.tab, button.dataset.title))
    })
    document.querySelectorAll('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        pluginFilter = button.dataset.filter
        document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button))
        renderPlugins(lastData)
      })
    })
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', () => {
        if (isMobileNav()) setMobileNavOpen(!document.body.classList.contains('mobile-nav-open'))
        else setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'))
      })
    }
    document.addEventListener('click', (event) => {
      if (!isMobileNav() || !document.body.classList.contains('mobile-nav-open')) return
      if (event.target?.closest?.('.rail')) return
      setMobileNavOpen(false)
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isMobileNav()) setMobileNavOpen(false)
    })
    document.getElementById('pluginSearch').addEventListener('input', () => renderPlugins(lastData))
    configFileSelect.addEventListener('change', () => loadConfigFile(configFileSelect.value))
    configEditor.addEventListener('input', () => {
      configDirty = true
      syncConfigDirty()
      configError.textContent = ''
    })
    if (configForm) {
      configForm.addEventListener('submit', (event) => event.preventDefault())
      configForm.addEventListener('input', () => markConfigDirty())
      configForm.addEventListener('change', () => markConfigDirty())
    }
    document.querySelectorAll('[data-config-mode]').forEach((button) => {
      button.addEventListener('click', () => setConfigMode(button.dataset.configMode || 'form'))
    })
    document.querySelectorAll('[data-secret-toggle]').forEach((button) => {
      button.innerHTML = eyeIcon
      button.addEventListener('click', () => toggleSecretInput(button.dataset.secretToggle || '', button))
    })
    pluginConfigEditor.addEventListener('input', () => {
      pluginConfigDirty = true
      syncPluginConfigDirty()
      pluginConfigError.textContent = ''
    })
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
        applyTheme(current === 'dark' ? 'light' : 'dark', true)
      })
      applyTheme(document.documentElement.dataset.theme || preferredTheme(), false)
    }
    if (sendForm) sendForm.addEventListener('submit', sendMessage)
    const sendContent = document.getElementById('sendContent')
    if (sendContent) {
      sendContent.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          sendForm.requestSubmit()
        }
      })
    }
    const sendTargetId = document.getElementById('sendTargetId')
    if (sendTargetId) {
      sendTargetId.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          openManualConversation()
        }
      })
    }
    if (debugForm) debugForm.addEventListener('submit', simulateMessage)
    if (debugContent) {
      debugContent.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          debugForm.requestSubmit()
        }
      })
    }
    if (confirmDialog) {
      confirmDialog.addEventListener('click', (event) => {
        if (event.target === confirmDialog) closeConfirmDialog()
      })
    }
    if (pluginConfigDialog) {
      pluginConfigDialog.addEventListener('click', (event) => {
        if (event.target === pluginConfigDialog) closePluginConfigDialog()
      })
    }
    if (railResizer) {
      railResizer.addEventListener('pointerdown', startSidebarResize)
      railResizer.addEventListener('dblclick', () => applySidebarWidth(sidebarWidthDefault, true))
      railResizer.addEventListener('keydown', handleSidebarResizeKey)
    }
    if (confirmButton) {
      confirmButton.addEventListener('click', () => {
        const handler = confirmHandler
        closeConfirmDialog()
        if (handler) handler()
      })
    }

    if (mobileNavQuery.addEventListener) mobileNavQuery.addEventListener('change', syncNavigationMode)
    else mobileNavQuery.addListener(syncNavigationMode)
    applySidebarWidth(readSavedSidebarWidth(), false)
    setSidebarCollapsed(false)
    syncConfigModeUi()
    syncNavigationMode()

    function preferredTheme() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    function applyTheme(theme, persist) {
      document.documentElement.dataset.theme = theme
      if (themeToggle) {
        const nextLabel = theme === 'dark' ? '切换为浅色' : '切换为深色'
        themeToggle.innerHTML = theme === 'dark' ? sunIcon : moonIcon
        themeToggle.setAttribute('aria-label', nextLabel)
        themeToggle.title = nextLabel
      }
      if (persist) localStorage.setItem('qingbot-theme', theme)
    }
    function isMobileNav() {
      return mobileNavQuery.matches
    }
    function clampSidebarWidth(width) {
      return Math.min(sidebarWidthMax, Math.max(sidebarWidthMin, Math.round(Number(width) || sidebarWidthDefault)))
    }
    function readSavedSidebarWidth() {
      try {
        return clampSidebarWidth(Number(localStorage.getItem(sidebarWidthStorageKey) || sidebarWidthDefault))
      } catch {
        return sidebarWidthDefault
      }
    }
    function currentSidebarWidth() {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--rail-width')
      return clampSidebarWidth(Number.parseFloat(raw))
    }
    function applySidebarWidth(width, persist) {
      const next = clampSidebarWidth(width)
      document.documentElement.style.setProperty('--rail-width', next + 'px')
      if (railResizer) {
        railResizer.setAttribute('aria-valuenow', String(next))
        railResizer.setAttribute('aria-valuetext', next + ' 像素')
      }
      if (persist) {
        try {
          localStorage.setItem(sidebarWidthStorageKey, String(next))
        } catch {}
      }
      return next
    }
    function startSidebarResize(event) {
      if (isMobileNav() || document.body.classList.contains('sidebar-collapsed')) return
      event.preventDefault()
      sidebarResizeState = { startX: event.clientX, startWidth: currentSidebarWidth() }
      document.body.classList.add('sidebar-resizing')
      window.addEventListener('pointermove', moveSidebarResize)
      window.addEventListener('pointerup', stopSidebarResize, { once: true })
      window.addEventListener('pointercancel', stopSidebarResize, { once: true })
      window.addEventListener('blur', stopSidebarResize, { once: true })
    }
    function moveSidebarResize(event) {
      if (!sidebarResizeState) return
      applySidebarWidth(sidebarResizeState.startWidth + event.clientX - sidebarResizeState.startX, false)
    }
    function stopSidebarResize() {
      if (!sidebarResizeState) return
      window.removeEventListener('pointermove', moveSidebarResize)
      window.removeEventListener('blur', stopSidebarResize)
      document.body.classList.remove('sidebar-resizing')
      sidebarResizeState = null
      applySidebarWidth(currentSidebarWidth(), true)
    }
    function handleSidebarResizeKey(event) {
      if (isMobileNav() || document.body.classList.contains('sidebar-collapsed')) return
      const step = event.shiftKey ? 24 : 12
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        applySidebarWidth(currentSidebarWidth() - step, true)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        applySidebarWidth(currentSidebarWidth() + step, true)
      } else if (event.key === 'Home') {
        event.preventDefault()
        applySidebarWidth(sidebarWidthMin, true)
      } else if (event.key === 'End') {
        event.preventDefault()
        applySidebarWidth(sidebarWidthMax, true)
      }
    }
    function setSidebarCollapsed(collapsed) {
      document.body.classList.toggle('sidebar-collapsed', collapsed)
      syncNavigationToggle()
    }
    function setMobileNavOpen(open) {
      document.body.classList.toggle('mobile-nav-open', open)
      syncNavigationToggle()
    }
    function syncNavigationMode() {
      if (isMobileNav()) setMobileNavOpen(false)
      syncNavigationToggle()
    }
    function syncNavigationToggle() {
      if (!sidebarToggle) return
      const mobile = isMobileNav()
      const collapsed = document.body.classList.contains('sidebar-collapsed')
      const menuOpen = document.body.classList.contains('mobile-nav-open')
      const label = mobile ? (menuOpen ? '关闭菜单' : '打开菜单') : (collapsed ? '展开侧栏' : '折叠侧栏')
      sidebarToggle.innerHTML = mobile ? (menuOpen ? closeIcon : menuIcon) : (collapsed ? sidebarExpandIcon : sidebarCollapseIcon)
      sidebarToggle.setAttribute('aria-label', label)
      sidebarToggle.title = label
    }
    function switchTab(name, title) {
      activeTab = name
      document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item.dataset.tab === name))
      document.querySelectorAll('.panel').forEach((item) => item.classList.toggle('active', item.id === 'panel-' + name))
      if (isMobileNav()) setMobileNavOpen(false)
      setText('pageTitle', title || name || '概览')
      if (name === 'config' && !configFiles.length) loadConfigFiles(true)
      if (name === 'messages') refreshMessageArea(true)
    }
    function headers() {
      return token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
    }
    function setText(id, value) {
      const el = document.getElementById(id)
      const next = value == null || value === '' ? '-' : String(value)
      if (el && el.textContent !== next) el.textContent = next
    }
    function valueOf(id) {
      const el = document.getElementById(id)
      return el && 'value' in el ? el.value : ''
    }
    function setFieldValue(id, value) {
      const el = document.getElementById(id)
      if (el && 'value' in el) el.value = value == null ? '' : String(value)
    }
    function markConfigDirty() {
      configDirty = true
      syncConfigDirty()
      configError.textContent = ''
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]))
    }
    function safeSignature(value) {
      try {
        return JSON.stringify(value)
      } catch {
        return String(Date.now())
      }
    }
    function isPlainConfigObject(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    }
    function renderText(value) {
      return escapeHtml(value).replace(/\\n/g, '<br>')
    }
    function renderMessageBody(content, payload) {
      const images = extractImages(payload)
      const text = stripImagePlaceholders(content, images)
      const parts = []
      if (text.trim()) parts.push('<div class="bubble-text">' + renderText(text) + '</div>')
      if (images.length) {
        parts.push('<div class="bubble-media">' + images.map((image) => renderImage(image)).join('') + '</div>')
      }
      return '<div class="bubble-body">' + (parts.join('') || '<div class="bubble-text">' + renderText(content || '[空消息]') + '</div>') + '</div>'
    }
    function renderImage(image) {
      const info = image.label ? image.label + ' · ' + image.url : image.url
      const src = mediaSrc(image.url)
      return '<a class="media-wrap" href="' + escapeHtml(src) + '" target="_blank" rel="noreferrer" title="' + escapeHtml(info) + '" data-info="' + escapeHtml(info) + '">' +
        '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(image.label || '图片') + '" loading="lazy">' +
      '</a>'
    }
    function mediaSrc(source) {
      const value = String(source || '').trim()
      if (/^(https?:|data:|blob:)/i.test(value)) return value
      const params = new URLSearchParams({ path: value })
      if (token) params.set('token', token)
      return '/api/media?' + params.toString()
    }
    function stripImagePlaceholders(content, images) {
      let text = String(content || '')
      for (const image of images) {
        text = text.split('[图片:' + image.url + ']').join('')
        if (image.label) text = text.split('[图片:' + image.label + ']').join('')
      }
      return text.trim()
    }
    function extractImages(value, images = [], seen = new Set(), depth = 0) {
      if (value == null || depth > 5) return images
      if (Array.isArray(value)) {
        value.forEach((item) => extractImages(item, images, seen, depth + 1))
        return images
      }
      if (typeof value !== 'object') return images

      const type = String(value.type || '').toLowerCase()
      if (type === 'image') {
        const data = value.data && typeof value.data === 'object' ? value.data : {}
        const url = String(data.url || data.file || value.url || value.file || '').trim()
        const label = String(data.name || value.name || '').trim()
        if (url && !seen.has(url)) {
          seen.add(url)
          images.push({ url, label })
        }
        return images
      }

      Object.keys(value).forEach((key) => extractImages(value[key], images, seen, depth + 1))
      return images
    }
    function show(text) {
      const toast = document.getElementById('toast')
      toast.textContent = text
      toast.classList.add('show')
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1700)
    }
    function formatUptime(seconds) {
      seconds = Math.max(0, Number(seconds || 0))
      const d = Math.floor(seconds / 86400)
      const h = Math.floor((seconds % 86400) / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      const s = Math.floor(seconds % 60)
      if (d) return d + 'd ' + h + 'h'
      return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + s + 's' : s + 's'
    }
    function formatBytes(bytes) {
      let value = Number(bytes || 0)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value = value / 1024
        index += 1
      }
      const digits = value >= 100 || index === 0 ? 0 : 1
      return value.toFixed(digits) + ' ' + units[index]
    }
    function syncRefreshTime() {
      if (!lastRefreshAt) {
        setText('updatedAt', '-')
        return
      }
      const seconds = Math.max(0, Math.floor((Date.now() - lastRefreshAt) / 1000))
      let text = '刚刚'
      if (seconds >= 60) {
        const minutes = Math.floor(seconds / 60)
        text = minutes >= 60 ? Math.floor(minutes / 60) + ' 小时前' : minutes + ' 分钟前'
      } else if (seconds >= 2) {
        text = seconds + ' 秒前'
      }
      setText('updatedAt', text)
    }
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) {
        const error = new Error(json.error || 'request failed')
        error.status = res.status
        throw error
      }
      return json.data ?? json
    }
    function showLogin(message = '') {
      if (!needsToken) return
      appView.hidden = true
      loginView.hidden = false
      loginError.textContent = message
      loginTokenInput.value = token
      loginTokenInput.focus()
    }
    function showApp() {
      loginView.hidden = true
      appView.hidden = false
    }
    async function refresh() {
      if (needsToken && !token) {
        showLogin()
        return false
      }
      if (statusRefreshInFlight) return true
      statusRefreshInFlight = true
      try {
        const data = await api('/api/status')
        showApp()
        lastData = data
        lastRefreshAt = Date.now()
        syncRefreshTime()
        const loadedCount = (data.loadedPlugins || []).length
        const availableCount = (data.availablePlugins || []).length
        const configuredCount = (data.configuredPlugins || []).length
        const stateLabel = stateText[data.state] || data.state || '-'
        const memory = data.memory || {}
        const system = data.system || {}
        const processInfo = data.process || {}

        setText('botName', data.botName || 'QingBot')
        setText('overviewState', stateLabel)
        const dot = document.getElementById('dot')
        if (dot) dot.className = 'dot ' + (data.state || '')
        setText('sandbox', data.sandbox ? '沙箱模式' : '正式模式')
        setText('appID', data.appID || '-')
        setText('uptime', formatUptime(data.uptime))
        setText('pluginDir', data.pluginDir || '-')
        setText('intents', (data.intents || []).join(', ') || '-')
        setText('loadedCount', loadedCount)
        setText('availableCount', availableCount)
        setText('configuredCount', configuredCount)
        setText('rss', formatBytes(memory.rss))
        setText('heap', 'Heap ' + formatBytes(memory.heapUsed) + '/' + formatBytes(memory.heapTotal))
        setText('systemMemory', formatBytes(system.memoryUsed) + '/' + formatBytes(system.memoryTotal))
        setText('pid', processInfo.pid ? 'PID ' + processInfo.pid : '-')
        setText('nodeVersion', processInfo.node || '-')
        setText('platform', processInfo.platform || '-')
        renderPlugins(data)
        if (activeTab === 'messages') void refreshMessageArea()
        return true
      } catch (error) {
        if (needsToken && error.status === 401) {
          token = ''
          showLogin('Token 不正确或已失效')
        } else {
          setText('overviewState', needsToken ? '需要 Token' : '离线')
        }
        return false
      } finally {
        statusRefreshInFlight = false
      }
    }
    function getPluginStatus(name, loaded, configured, available) {
      if (loaded.has(name)) return { kind: 'loaded', label: '已加载' }
      if (configured.has(name) && !available.has(name)) return { kind: 'missing', label: '目录缺失' }
      if (configured.has(name)) return { kind: 'enabled', label: '已启用' }
      return { kind: 'idle', label: '未启用' }
    }
    function getDependencyStatus(info) {
      if (!info || !info.hasPackage || !info.total) {
        return { kind: 'deps-none', label: '无', detail: '未声明依赖', installCommand: '' }
      }
      if (info.error) {
        return { kind: 'deps-error', label: '声明错误', detail: info.error, installCommand: info.installCommand || '' }
      }

      const missing = info.missing || []
      const optionalMissing = info.optionalMissing || []
      if (missing.length) {
        return {
          kind: 'deps-missing',
          label: '缺失 ' + missing.length,
          detail: '缺失：' + missing.join(', '),
          installCommand: info.installCommand || '',
        }
      }
      if (optionalMissing.length) {
        return {
          kind: 'deps-optional',
          label: '可选缺 ' + optionalMissing.length,
          detail: '可选依赖缺失：' + optionalMissing.join(', '),
          installCommand: info.installCommand || '',
        }
      }

      return {
        kind: 'deps-ok',
        label: '已满足',
        detail: '依赖已满足：' + info.installed + '/' + info.total,
        installCommand: '',
      }
    }
    function renderDependencyCell(dependency) {
      const detail = dependency.installCommand
        ? dependency.detail + '\\n' + dependency.installCommand
        : dependency.detail
      const hint = dependency.installCommand
        ? '<span class="dependency-hint" title="' + escapeHtml(dependency.installCommand) + '">' + escapeHtml(dependency.installCommand) + '</span>'
        : ''
      return '<div class="dependency-cell">' +
        '<span class="badge ' + dependency.kind + '" title="' + escapeHtml(detail) + '">' + escapeHtml(dependency.label) + '</span>' +
        hint +
        '</div>'
    }
    function renderPlugins(data) {
      if (!data) return
      const loaded = new Map((data.loadedPlugins || []).map((item) => [item.name, item]))
      const configured = new Set(data.configuredPlugins || [])
      const available = new Set(data.availablePlugins || [])
      const dependencies = new Map((data.pluginDependencies || []).map((item) => [item.name, item]))
      const allNames = Array.from(new Set([...(data.availablePlugins || []), ...(data.configuredPlugins || [])])).sort()
      const search = document.getElementById('pluginSearch').value.trim().toLowerCase()

      setText('filterAllCount', allNames.length)
      setText('filterLoadedCount', allNames.filter((name) => loaded.has(name)).length)
      setText('filterIdleCount', allNames.filter((name) => !loaded.has(name)).length)

      const names = allNames
        .filter((name) => !search || name.toLowerCase().includes(search))
        .filter((name) => pluginFilter === 'all' || (pluginFilter === 'loaded' ? loaded.has(name) : !loaded.has(name)))

      if (selectedPlugin && !allNames.includes(selectedPlugin)) {
        selectedPlugin = ''
        clearSelectedPluginConfig()
      }
      const rows = names.map((name) => {
        const item = loaded.get(name)
        const status = getPluginStatus(name, loaded, configured, available)
        const dependency = getDependencyStatus(dependencies.get(name))
        return {
          name,
          status,
          dependency,
          version: item?.version || '-',
          handlers: item?.handlers ?? '-',
          cronTasks: item?.cronTasks ?? '-',
          selected: selectedPlugin === name,
        }
      })
      const signature = safeSignature({ rows, pluginFilter, search, selectedPlugin })
      if (signature === pluginListSignature) {
        syncPluginActions(data)
        return
      }
      pluginListSignature = signature

      document.getElementById('plugins').innerHTML = rows.map((row) => {
        const selected = row.selected ? ' class="selected"' : ''
        const mobileMeta = [
          'v' + row.version,
          '处理器 ' + row.handlers,
          '定时 ' + row.cronTasks,
          '依赖 ' + row.dependency.label,
        ].join(' · ')
        return '<tr' + selected + ' data-plugin="' + escapeHtml(row.name) + '">' +
          '<td class="name-cell"><span class="plugin-name">' + escapeHtml(row.name) + '</span><span class="plugin-mobile-meta">' + escapeHtml(mobileMeta) + '</span></td>' +
          '<td><span class="badge ' + row.status.kind + '">' + row.status.label + '</span></td>' +
          '<td class="muted-cell" data-label="版本">' + escapeHtml(row.version) + '</td>' +
          '<td class="muted-cell" data-label="处理器">' + escapeHtml(row.handlers) + '</td>' +
          '<td class="muted-cell" data-label="定时">' + escapeHtml(row.cronTasks) + '</td>' +
          '<td data-label="依赖">' + renderDependencyCell(row.dependency) + '</td>' +
          '<td class="cell-actions"><button class="table-icon" type="button" data-config-plugin="' + escapeHtml(row.name) + '" aria-label="编辑 ' + escapeHtml(row.name) + ' 配置" title="配置">' + settingsIcon + '</button></td>' +
          '</tr>'
      }).join('') || '<tr><td class="name-cell" colspan="7">无</td></tr>'
      document.querySelectorAll('#plugins tr[data-plugin]').forEach((row) => {
        row.addEventListener('click', () => selectPlugin(row.dataset.plugin || ''))
      })
      document.querySelectorAll('[data-config-plugin]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation()
          openPluginConfig(button.dataset.configPlugin || '')
        })
      })
      syncPluginActions(data)
    }
    function selectPlugin(name) {
      selectedPlugin = name
      renderPlugins(lastData)
    }
    function syncPluginActions(data) {
      const loaded = new Set((data.loadedPlugins || []).map((item) => item.name))
      const configured = new Set(data.configuredPlugins || [])
      const hasSelection = Boolean(selectedPlugin)
      const isLoaded = loaded.has(selectedPlugin)
      const isConfigured = configured.has(selectedPlugin)
      document.getElementById('pluginActions').hidden = !hasSelection
      setText('selectedPluginName', selectedPlugin)
      document.getElementById('pluginLoadButton').hidden = !hasSelection || isConfigured
      document.getElementById('pluginReloadButton').hidden = !hasSelection || (!isConfigured && !isLoaded)
      document.getElementById('pluginUnloadButton').hidden = !hasSelection || (!isConfigured && !isLoaded)
    }
    function openPluginConfig(name) {
      if (!name) return
      if (pluginConfigDirty && configPlugin !== name && !confirm('放弃未保存的插件配置修改？')) return
      selectedPlugin = name
      configPlugin = name
      renderPlugins(lastData)
      pluginConfigDialog.hidden = false
      setText('pluginConfigName', name + ' 配置')
      loadSelectedPluginConfig(true)
    }
    function clearSelectedPluginConfig() {
      configPlugin = ''
      selectedPluginConfigFile = ''
      pluginConfigEditor.value = ''
      pluginConfigEditor.disabled = true
      pluginConfigPath.textContent = '-'
      pluginConfigDirty = false
      pluginConfigError.textContent = ''
      syncPluginConfigDirty()
    }
    function closePluginConfigDialog() {
      if (pluginConfigDirty && !confirm('放弃未保存的插件配置修改？')) return
      pluginConfigDialog.hidden = true
      clearSelectedPluginConfig()
    }
    async function loadSelectedPluginConfig(force = false) {
      if (!configPlugin) return clearSelectedPluginConfig()
      if (!force && pluginConfigDirty && !confirm('放弃未保存的插件配置修改？')) return
      try {
        const id = 'plugin:' + configPlugin
        const file = await api('/api/config-file?id=' + encodeURIComponent(id))
        selectedPluginConfigFile = file.id
        pluginConfigEditor.value = file.content || '{}\\n'
        pluginConfigEditor.disabled = false
        pluginConfigPath.textContent = file.path || '-'
        pluginConfigDirty = false
        pluginConfigError.textContent = ''
        syncPluginConfigDirty()
      } catch (error) {
        handleApiError(error)
      }
    }
    function syncPluginConfigDirty() {
      pluginConfigDirtyEl.textContent = pluginConfigDirty ? '未保存' : ''
    }
    function formatPluginConfigEditor() {
      try {
        pluginConfigEditor.value = JSON.stringify(JSON.parse(pluginConfigEditor.value || '{}'), null, 2) + '\\n'
        pluginConfigDirty = true
        pluginConfigError.textContent = ''
        syncPluginConfigDirty()
      } catch (error) {
        pluginConfigError.textContent = error.message
      }
    }
    async function savePluginConfig(reload) {
      if (!configPlugin || !selectedPluginConfigFile) return show('未选择插件')
      try {
        JSON.parse(pluginConfigEditor.value || '{}')
      } catch (error) {
        pluginConfigError.textContent = error.message
        return
      }

      try {
        const data = await api('/api/config-file', {
          method: 'POST',
          body: JSON.stringify({
            id: selectedPluginConfigFile,
            content: pluginConfigEditor.value,
            reload: false,
          }),
        })
        pluginConfigEditor.value = data.content
        pluginConfigPath.textContent = data.path || pluginConfigPath.textContent
        pluginConfigDirty = false
        pluginConfigError.textContent = ''
        syncPluginConfigDirty()

        if (reload && configPlugin) {
          const loaded = new Set((lastData?.loadedPlugins || []).map((item) => item.name))
          const configured = new Set(lastData?.configuredPlugins || [])
          if (loaded.has(configPlugin) || configured.has(configPlugin)) {
            await api('/api/reload-plugin', { method: 'POST', body: JSON.stringify({ name: configPlugin }) })
            await refresh()
            show('已保存并重载')
            return
          }
        }

        show('已保存')
      } catch (error) {
        handleApiError(error)
      }
    }
    async function loadConfigFiles(force = false) {
      if (!force && configDirty && !confirm('放弃未保存的配置修改？')) return
      try {
        const previous = selectedConfigFile
        configFiles = await api('/api/config-files')
        renderConfigFileOptions(previous)
        if (configFileSelect.value) await loadConfigFile(configFileSelect.value, true)
      } catch (error) {
        handleApiError(error)
      }
    }
    function renderConfigFileOptions(preferId) {
      const files = configFiles.filter((file) => file.kind !== 'plugin')
      configFileSelect.innerHTML = files.map((file) => {
        const suffix = file.exists ? '' : '（未创建）'
        return '<option value="' + escapeHtml(file.id) + '">' + escapeHtml(file.label + suffix) + '</option>'
      }).join('')

      const preferred = files.find((file) => file.id === preferId) || files[0]
      selectedConfigFile = preferred?.id || ''
      configFileSelect.value = selectedConfigFile
      configEditor.disabled = !selectedConfigFile
      setConfigFormDisabled(!selectedConfigFile)
      syncConfigModeUi()
    }
    async function loadConfigFile(id, force = false) {
      if (!id) return
      if (!force && configDirty && id !== selectedConfigFile && !confirm('放弃未保存的配置修改？')) {
        configFileSelect.value = selectedConfigFile
        return
      }
      try {
        const file = await api('/api/config-file?id=' + encodeURIComponent(id))
        selectedConfigFile = file.id
        configFileSelect.value = file.id
        configEditor.value = file.content || '{}\\n'
        configPath.textContent = file.path || '-'
        configEditor.disabled = false
        hydrateConfigFormFromEditor()
        configDirty = false
        configError.textContent = ''
        syncConfigDirty()
        syncConfigModeUi()
      } catch (error) {
        handleApiError(error)
      }
    }
    function syncConfigDirty() {
      configDirtyEl.textContent = configDirty ? '未保存' : ''
    }
    function formatConfigEditor() {
      try {
        if (configMode === 'form') {
          configEditor.value = buildConfigJsonFromForm()
          configMode = 'json'
          localStorage.setItem('qingbot-config-mode', configMode)
          syncConfigModeUi()
          show('已生成 JSON')
          return
        }
        configEditor.value = JSON.stringify(JSON.parse(configEditor.value || '{}'), null, 2) + '\\n'
        configDirty = true
        configError.textContent = ''
        syncConfigDirty()
      } catch (error) {
        configError.textContent = error.message
      }
    }
    async function saveConfigFile(reload) {
      if (!selectedConfigFile) return show('未选择配置')
      let content = configEditor.value
      try {
        if (configMode === 'form') {
          content = buildConfigJsonFromForm()
          configEditor.value = content
        }
        JSON.parse(content || '{}')
      } catch (error) {
        configError.textContent = error.message
        return
      }
      try {
        const data = await api('/api/config-file', {
          method: 'POST',
          body: JSON.stringify({
            id: selectedConfigFile,
            content,
            reload,
          }),
        })
        configEditor.value = data.content
        configPath.textContent = data.path || configPath.textContent
        hydrateConfigFormFromEditor()
        configDirty = false
        configError.textContent = ''
        syncConfigDirty()
        syncConfigModeUi()
        await loadConfigFiles(true)
        show(reload ? '已保存并重载' : '已保存')
        if (reload) await refresh()
      } catch (error) {
        handleApiError(error)
      }
    }
    function formatTargetType(type) {
      const names = {
        group: '群',
        user: '用户',
        channel: '频道',
        direct: '频道私信',
      }
      return names[type] || type || '-'
    }
    function formatTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '-'
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    }
    function conversationKey(targetType, targetId) {
      return targetType + ':' + targetId
    }
    function currentMessageTarget() {
      const targetType = valueOf('sendTargetType') || 'group'
      const targetId = valueOf('sendTargetId').trim()
      if (!targetId) return undefined
      return { targetType, targetId, key: conversationKey(targetType, targetId) }
    }
    async function refreshMessageArea(force = false) {
      if (messageRefreshInFlight) {
        if (force) messageRefreshQueued = true
        return
      }
      messageRefreshInFlight = true
      try {
        do {
          messageRefreshQueued = false
          await refreshMessageConversations(true)
          await refreshMessageLog()
        } while (messageRefreshQueued)
      } finally {
        messageRefreshInFlight = false
      }
    }
    async function refreshMessageConversations(selectFirst) {
      try {
        messageConversations = await api('/api/message-conversations')
        const target = currentMessageTarget()
        if (!selectedConversationKey && selectFirst && !target && messageConversations[0]) {
          applyConversation(messageConversations[0])
        }
        renderConversationList()
      } catch (error) {
        handleApiError(error)
      }
    }
    function renderConversationList() {
      const root = conversationList
      if (!root) return
      const target = currentMessageTarget()
      const activeKey = selectedConversationKey || target?.key || ''
      const signature = safeSignature({
        activeKey,
        items: messageConversations.map((conversation) => ({
          key: conversation.key,
          title: conversation.title,
          alias: conversation.alias,
          targetType: conversation.targetType,
          targetId: conversation.targetId,
          lastContent: conversation.lastContent,
          lastAt: conversation.lastAt,
          updatedAt: conversation.updatedAt,
          lastDirection: conversation.lastDirection,
        })),
      })
      if (signature === conversationListSignature) return
      conversationListSignature = signature
      const scrollTop = root.scrollTop

      if (!messageConversations.length) {
        root.innerHTML = '<div class="log-empty">暂无会话</div>'
        root.scrollTop = scrollTop
        return
      }

      root.innerHTML = messageConversations.map((conversation) => {
        const active = conversation.key === activeKey
        const targetText = formatTargetType(conversation.targetType) + ' · ' + conversation.targetId
        const preview = conversation.lastContent || (conversation.alias ? formatTargetType(conversation.targetType) : targetText)
        const title = conversation.alias || conversation.title || targetText
        const metaTarget = conversation.alias ? formatTargetType(conversation.targetType) : targetText
        const meta = (conversation.lastAt ? formatTime(conversation.lastAt) : formatTime(conversation.updatedAt)) + ' · ' + metaTarget
        return '<button class="message-entry ' + (active ? 'selected ' : '') + (conversation.lastDirection === 'in' ? 'in' : 'out') + '" type="button" data-conversation-key="' + escapeHtml(conversation.key) + '">' +
          '<span class="message-main">' +
            '<span class="message-title">' + escapeHtml(title) + '</span>' +
            '<span class="message-preview">' + escapeHtml(preview) + '</span>' +
            '<span class="message-meta">' + escapeHtml(meta) + '</span>' +
          '</span>' +
        '</button>'
      }).join('')

      root.querySelectorAll('[data-conversation-key]').forEach((button) => {
        button.addEventListener('click', () => selectConversation(button.dataset.conversationKey || ''))
      })
      root.scrollTop = scrollTop
    }
    function applyConversation(conversation) {
      if (!conversation) return
      selectedConversationKey = conversation.key
      document.getElementById('sendTargetType').value = conversation.targetType || 'group'
      document.getElementById('sendTargetId').value = conversation.targetId || ''
      conversationAlias.value = conversation.alias || ''
    }
    async function selectConversation(key) {
      const conversation = messageConversations.find((item) => item.key === key)
      if (!conversation) return
      applyConversation(conversation)
      renderConversationList()
      await refreshMessageLog()
    }
    async function refreshMessageLog() {
      const target = currentMessageTarget()
      if (!target) {
        messageLog = []
        renderMessageTimeline()
        return
      }

      try {
        messageLog = await api('/api/message-log?targetType=' + encodeURIComponent(target.targetType) + '&targetId=' + encodeURIComponent(target.targetId))
        renderMessageTimeline()
      } catch (error) {
        handleApiError(error)
      }
    }
    function renderMessageTimeline() {
      const root = messageTimeline
      if (!root) return
      const target = currentMessageTarget()
      const signature = safeSignature({
        targetKey: target?.key || '',
        items: messageLog.map((entry) => ({
          id: entry.id,
          direction: entry.direction,
          format: entry.format,
          content: entry.content,
          createdAt: entry.createdAt,
          nickname: entry.nickname,
          userId: entry.userId,
          payload: entry.payload,
        })),
      })
      if (signature === messageTimelineSignature) return
      messageTimelineSignature = signature
      const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 48
      const scrollTop = root.scrollTop

      if (!target) {
        root.innerHTML = '<div class="chat-empty">选择会话或填写目标 ID</div>'
        return
      }
      if (!messageLog.length) {
        root.innerHTML = '<div class="chat-empty">暂无消息</div>'
        return
      }

      root.innerHTML = [...messageLog].reverse().map((entry) => {
        const outgoing = entry.direction === 'out'
        const title = outgoing ? '机器人' : (entry.nickname || entry.userId || '收到消息')
        const format = entry.format === 'markdown' ? ' · Markdown' : ''
        return '<div class="bubble ' + (outgoing ? 'user' : 'bot') + '">' +
          '<span class="bubble-meta">' + escapeHtml(title + ' · ' + formatTime(entry.createdAt) + format) + '</span>' +
          renderMessageBody(entry.content || '[空消息]', entry.payload) +
        '</div>'
      }).join('')
      root.scrollTop = nearBottom ? root.scrollHeight : scrollTop
    }
    async function saveConversation(targetType, targetId, alias) {
      return api('/api/message-conversation', {
        method: 'POST',
        body: JSON.stringify({ targetType, targetId, alias }),
      })
    }
    async function openManualConversation() {
      const target = currentMessageTarget()
      if (!target) return show('请填写目标 ID')
      try {
        const conversation = await saveConversation(target.targetType, target.targetId, valueOf('conversationAlias').trim())
        applyConversation(conversation)
        await refreshMessageConversations(false)
        await refreshMessageLog()
      } catch (error) {
        handleApiError(error)
      }
    }
    async function saveCurrentConversation() {
      const target = currentMessageTarget()
      if (!target) return show('请填写目标 ID')
      try {
        const conversation = await saveConversation(target.targetType, target.targetId, valueOf('conversationAlias').trim())
        applyConversation(conversation)
        await refreshMessageConversations(false)
        show('已保存')
      } catch (error) {
        handleApiError(error)
      }
    }
    async function sendMessage(event) {
      event.preventDefault()
      const content = valueOf('sendContent')
      const body = {
        targetType: valueOf('sendTargetType'),
        targetId: valueOf('sendTargetId').trim(),
        format: valueOf('sendFormat'),
        content,
      }
      if (!body.targetId) return show('请填写目标 ID')
      if (!content.trim()) return show('请填写消息内容')

      const button = sendForm.querySelector('button[type="submit"]')
      button.disabled = true
      try {
        const data = await api('/api/send-message', { method: 'POST', body: JSON.stringify(body) })
        const conversation = await saveConversation(body.targetType, body.targetId, valueOf('conversationAlias').trim())
        applyConversation(conversation)
        document.getElementById('sendContent').value = ''
        await refreshMessageArea(true)
        show(data.message || '已发送')
      } catch (error) {
        handleApiError(error)
      } finally {
        button.disabled = false
      }
    }
    async function simulateMessage(event) {
      event.preventDefault()
      const content = valueOf('debugContent')
      if (!content.trim()) return show('请输入测试消息')

      appendDebugBubble('user', content, valueOf('debugNickname') || valueOf('debugUserId') || '测试用户')
      document.getElementById('debugContent').value = ''
      const button = debugForm.querySelector('button[type="submit"]')
      button.disabled = true

      try {
        const result = await api('/api/simulate-message', {
          method: 'POST',
          body: JSON.stringify({
            messageType: valueOf('debugMessageType'),
            userId: valueOf('debugUserId'),
            nickname: valueOf('debugNickname'),
            groupId: valueOf('debugGroupId'),
            role: valueOf('debugRole'),
            guildId: valueOf('debugGuildId'),
            channelId: valueOf('debugChannelId'),
            content,
          }),
        })
        if (!result.replies || !result.replies.length) {
          appendDebugBubble('system', '没有插件回复', '结果')
        } else {
          result.replies.forEach((reply) => {
            appendDebugBubble('bot', reply.content || '[空消息]', reply.format === 'markdown' ? 'Markdown' : reply.targetType + ' · ' + reply.targetId, reply.payload)
          })
        }
      } catch (error) {
        appendDebugBubble('system', error.message, '错误')
        handleApiError(error)
      } finally {
        button.disabled = false
      }
    }
    function appendDebugBubble(kind, content, meta, payload) {
      const root = debugTimeline
      root.querySelector('.chat-empty')?.remove()
      const item = document.createElement('div')
      item.className = 'bubble ' + kind
      item.innerHTML = '<span class="bubble-meta">' + renderText(meta || '') + '</span>' + renderMessageBody(content, payload)
      root.appendChild(item)
      root.scrollTop = root.scrollHeight
    }
    function clearDebugChat() {
      debugTimeline.innerHTML = '<div class="chat-empty">从下面发送一条测试消息</div>'
    }
    function openConfirmDialog(message, handler) {
      confirmHandler = handler
      confirmMessage.textContent = message
      confirmDialog.hidden = false
      confirmButton.focus()
    }
    function closeConfirmDialog() {
      confirmDialog.hidden = true
      confirmHandler = null
    }
    function handleApiError(error) {
      if (needsToken && error.status === 401) showLogin('Token 不正确或已失效')
      else show(error.message)
    }
    function readConfigObject() {
      const parsed = JSON.parse(configEditor.value || '{}')
      if (!isPlainConfigObject(parsed)) throw new Error('配置必须是 JSON 对象')
      return parsed
    }
    function cloneConfigObject(value) {
      return JSON.parse(JSON.stringify(value || {}))
    }
    function setConfigFormDisabled(disabled) {
      if (!configForm) return
      configForm.querySelectorAll('input, select, textarea, button').forEach((field) => {
        field.disabled = disabled
      })
    }
    function setConfigMode(mode) {
      const nextMode = mode === 'json' ? 'json' : 'form'
      try {
        if (nextMode === 'json' && configMode === 'form') {
          configEditor.value = buildConfigJsonFromForm()
        }
        if (nextMode === 'form') hydrateConfigFormFromEditor()
        configMode = nextMode
        localStorage.setItem('qingbot-config-mode', configMode)
        configError.textContent = ''
        syncConfigModeUi()
      } catch (error) {
        configError.textContent = error.message
      }
    }
    function syncConfigModeUi() {
      const formMode = configMode !== 'json'
      if (configForm) configForm.hidden = !formMode
      if (configEditorShell) configEditorShell.hidden = formMode
      if (configFormatButton) configFormatButton.hidden = formMode
      document.querySelectorAll('[data-config-mode]').forEach((button) => {
        button.classList.toggle('active', button.dataset.configMode === (formMode ? 'form' : 'json'))
      })
      setConfigFormDisabled(!selectedConfigFile)
    }
    function toggleSecretInput(id, button) {
      const input = document.getElementById(id)
      if (!input || !('type' in input)) return
      const showSecret = input.type === 'password'
      input.type = showSecret ? 'text' : 'password'
      button.innerHTML = showSecret ? eyeOffIcon : eyeIcon
      const label = showSecret ? '隐藏密钥' : '显示密钥'
      button.setAttribute('aria-label', label)
      button.title = label
    }
    function resetSecretInputs() {
      document.querySelectorAll('[data-secret-toggle]').forEach((button) => {
        const input = document.getElementById(button.dataset.secretToggle || '')
        if (input && 'type' in input) input.type = 'password'
        button.innerHTML = eyeIcon
        button.setAttribute('aria-label', '显示密钥')
        button.title = '显示密钥'
      })
    }
    function setOptionalString(target, key, id) {
      const value = valueOf(id).trim()
      if (value) target[key] = value
      else delete target[key]
    }
    function setOptionalSelect(target, key, id) {
      const value = valueOf(id).trim()
      if (value) target[key] = value
      else delete target[key]
    }
    function setOptionalBoolean(target, key, id) {
      const value = valueOf(id)
      if (value === 'true') target[key] = true
      else if (value === 'false') target[key] = false
      else delete target[key]
    }
    function setOptionalNumber(target, key, id, label, min, max) {
      const raw = valueOf(id).trim()
      if (!raw) {
        delete target[key]
        return
      }
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new Error(label + ' 必须是数字')
      if (min != null && value < min) throw new Error(label + ' 不能小于 ' + min)
      if (max != null && value > max) throw new Error(label + ' 不能大于 ' + max)
      target[key] = value
    }
    function parseListValue(id) {
      const text = valueOf(id).trim()
      if (!text) return []
      return text.replace(/\\r/g, '\\n').split(/[\\n,]+/).map((item) => item.trim()).filter(Boolean)
    }
    function setOptionalList(target, key, id) {
      const values = parseListValue(id)
      if (values.length) target[key] = values
      else delete target[key]
    }
    function formatListValue(value) {
      return Array.isArray(value) ? value.map((item) => String(item)).join('\\n') : ''
    }
    function parseAliasMap(id, label) {
      const text = valueOf(id).trim()
      if (!text) return {}
      if (/^\\s*\\{/.test(text)) {
        const parsed = JSON.parse(text)
        if (!isPlainConfigObject(parsed)) throw new Error(label + ' 必须是 JSON 对象')
        return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [String(key), String(value)]))
      }

      const result = {}
      const lines = text.replace(/\\r/g, '\\n').split(/\\n+/)
      lines.forEach((line, index) => {
        const item = line.trim()
        if (!item || item.startsWith('#')) return
        const separator = item.includes('=') ? item.indexOf('=') : item.indexOf(':')
        if (separator <= 0) throw new Error(label + ' 第 ' + (index + 1) + ' 行格式应为：别名 = 官方 ID')
        const key = item.slice(0, separator).trim()
        const value = item.slice(separator + 1).trim()
        if (!key || !value) throw new Error(label + ' 第 ' + (index + 1) + ' 行不能为空')
        result[key] = value
      })
      return result
    }
    function formatAliasMap(value) {
      if (!isPlainConfigObject(value)) return ''
      return Object.entries(value).map(([key, id]) => String(key) + ' = ' + String(id)).join('\\n')
    }
    function setOptionalAliases(target) {
      const aliases = isPlainConfigObject(target.aliases) ? { ...target.aliases } : {}
      const users = parseAliasMap('cfgUserAliases', '用户别名')
      const groups = parseAliasMap('cfgGroupAliases', '群别名')
      if (Object.keys(users).length) aliases.users = users
      else delete aliases.users
      if (Object.keys(groups).length) aliases.groups = groups
      else delete aliases.groups
      if (Object.keys(aliases).length) target.aliases = aliases
      else delete target.aliases
    }
    function hydrateConfigFormFromEditor() {
      const config = readConfigObject()
      const web = isPlainConfigObject(config.web) ? config.web : {}
      const aliases = isPlainConfigObject(config.aliases) ? config.aliases : {}

      setFieldValue('cfgBotName', config.botName)
      setFieldValue('cfgAppID', config.appID || config.appId)
      setFieldValue('cfgAppSecret', config.appSecret || config.secret)
      setFieldValue('cfgSandbox', typeof config.sandbox === 'boolean' ? String(config.sandbox) : '')
      setFieldValue('cfgRemoveAt', typeof config.removeAt === 'boolean' ? String(config.removeAt) : '')
      setFieldValue('cfgDebug', typeof config.debug === 'boolean' ? String(config.debug) : '')
      setFieldValue('cfgLogLevel', config.logLevel)
      setFieldValue('cfgWebEnabled', typeof web.enabled === 'boolean' ? String(web.enabled) : '')
      setFieldValue('cfgWebHost', web.host)
      setFieldValue('cfgWebPort', web.port)
      setFieldValue('cfgWebToken', web.token)
      setFieldValue('cfgPlugins', formatListValue(config.plugins))
      setFieldValue('cfgPluginDir', config.pluginDir)
      setFieldValue('cfgOwnerIds', formatListValue(config.ownerIds))
      setFieldValue('cfgAdminIds', formatListValue(config.adminIds))
      setFieldValue('cfgAllowPublicControl', typeof config.allowPublicControl === 'boolean' ? String(config.allowPublicControl) : '')
      setFieldValue('cfgLegacyIdMode', config.legacyIdMode)
      setFieldValue('cfgIntents', formatListValue(config.intents))
      setFieldValue('cfgAccessTokenUrl', config.accessTokenUrl)
      setFieldValue('cfgGatewayUrl', config.gatewayUrl)
      setFieldValue('cfgTimeout', config.timeout)
      setFieldValue('cfgMaxRetry', config.maxRetry)
      setFieldValue('cfgHeartbeatInterval', config.heartbeatInterval)
      setFieldValue('cfgMaxRetries', config.maxRetries)
      setFieldValue('cfgReconnectDelay', config.reconnectDelay)
      setFieldValue('cfgUserAliases', formatAliasMap(aliases.users))
      setFieldValue('cfgGroupAliases', formatAliasMap(aliases.groups))
      resetSecretInputs()
      setConfigFormDisabled(!selectedConfigFile)
      return config
    }
    function buildConfigJsonFromForm() {
      const next = cloneConfigObject(readConfigObject())
      const web = isPlainConfigObject(next.web) ? { ...next.web } : {}

      setOptionalString(next, 'botName', 'cfgBotName')
      setOptionalString(next, 'appID', 'cfgAppID')
      delete next.appId
      setOptionalString(next, 'appSecret', 'cfgAppSecret')
      delete next.secret
      setOptionalBoolean(next, 'sandbox', 'cfgSandbox')
      setOptionalBoolean(next, 'removeAt', 'cfgRemoveAt')
      setOptionalBoolean(next, 'debug', 'cfgDebug')
      setOptionalSelect(next, 'logLevel', 'cfgLogLevel')
      setOptionalList(next, 'plugins', 'cfgPlugins')
      setOptionalString(next, 'pluginDir', 'cfgPluginDir')
      setOptionalList(next, 'ownerIds', 'cfgOwnerIds')
      setOptionalList(next, 'adminIds', 'cfgAdminIds')
      setOptionalBoolean(next, 'allowPublicControl', 'cfgAllowPublicControl')
      setOptionalSelect(next, 'legacyIdMode', 'cfgLegacyIdMode')
      setOptionalList(next, 'intents', 'cfgIntents')
      setOptionalString(next, 'accessTokenUrl', 'cfgAccessTokenUrl')
      setOptionalString(next, 'gatewayUrl', 'cfgGatewayUrl')
      setOptionalNumber(next, 'timeout', 'cfgTimeout', '超时', 0)
      setOptionalNumber(next, 'maxRetry', 'cfgMaxRetry', '最大重试', 0)
      setOptionalNumber(next, 'heartbeatInterval', 'cfgHeartbeatInterval', '心跳间隔', 0)
      setOptionalNumber(next, 'maxRetries', 'cfgMaxRetries', '重连次数', 0)
      setOptionalNumber(next, 'reconnectDelay', 'cfgReconnectDelay', '重连延迟', 0)
      setOptionalAliases(next)

      setOptionalBoolean(web, 'enabled', 'cfgWebEnabled')
      setOptionalString(web, 'host', 'cfgWebHost')
      setOptionalNumber(web, 'port', 'cfgWebPort', '端口', 1, 65535)
      setOptionalString(web, 'token', 'cfgWebToken')
      if (Object.keys(web).length) next.web = web
      else delete next.web

      return JSON.stringify(next, null, 2) + '\\n'
    }
    async function post(path, body) {
      try {
        const data = await api(path, { method: 'POST', body: JSON.stringify(body || {}) })
        show(data?.message || '完成')
        await refresh()
      } catch (error) {
        handleApiError(error)
      }
    }
    function operateSelected(path) {
      if (!selectedPlugin) return show('未选择插件')
      post(path, { name: selectedPlugin })
    }
    function logout() {
      token = ''
      localStorage.removeItem('qingbot-token')
      showLogin()
    }
    function stopBot() {
      openConfirmDialog('关闭后需要在终端重新启动。', () => post('/api/stop'))
    }

    syncRefreshTime()
    refresh()
    setInterval(syncRefreshTime, 1000)
    setInterval(refresh, 3000)
  </script>
</body>
</html>`
}
