import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import cron from 'node-cron'
import { Bot, ReceiverMode, segment } from 'qq-official-bot'
import { CONFIG_FILE, loadConfig } from './config'
import { createContext, handleRuntimeError, normalizeEvent, QingBotRuntime, type RuntimeSendTarget } from './context'
import { createLogger, type Logger } from './logger'
import type { PluginDefinition, QingBotConfig, QingBotEventName, QingBotHandler, QingPluginContext } from './types'
import {
  createWebConsole,
  type WebCapturedMessage,
  type WebConfigFile,
  type WebConfigFileContent,
  type WebConsole,
  type WebMessageConversation,
  type WebMessageConversationInput,
  type WebMessageLogEntry,
  type WebMessageFormat,
  type WebMessageTargetType,
  type WebSendMessageInput,
  type WebSimulateMessageType,
  type WebSimulateMessageInput,
  type WebSimulateMessageResult,
} from './web'

const requireModule = createRequire(__filename)
const INTERNAL_PLUGIN = '__qingbot__'
const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/
const WEB_MESSAGE_LOG_LIMIT = 160
const WEB_MESSAGE_TARGETS_FILE = path.join('data', 'web-message-targets.json')

type PluginCommand = {
  action: string
  name: string
}

type HandlerRecord = {
  pluginName: string
  handler: QingBotHandler
}

type LoadedPlugin = {
  definition: PluginDefinition
  context: QingPluginContext
  cronTasks: any[]
}

type PluginDependencySource = 'dependencies' | 'optionalDependencies' | 'peerDependencies'

type PluginDependencyStatus = {
  name: string
  requested: string
  source: PluginDependencySource
  optional: boolean
  installed: boolean
  resolved?: string
  error?: string
}

type PluginDependencySummary = {
  name: string
  hasPackage: boolean
  packagePath: string
  total: number
  required: number
  installed: number
  missing: string[]
  optionalMissing: string[]
  installCommand?: string
  error?: string
  dependencies: PluginDependencyStatus[]
}

type QingBotState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped'

export class QingBot {
  readonly logger: Logger
  readonly bot: any
  readonly ctx: QingPluginContext
  private readonly handlers = new Map<string, HandlerRecord[]>()
  private readonly loadedPlugins = new Map<string, LoadedPlugin>()
  private readonly runtime: QingBotRuntime
  private readonly webMessageLog: WebMessageLogEntry[] = []
  private state: QingBotState = 'created'
  private startedAt = 0
  private webConsole?: WebConsole

  constructor(private readonly config: QingBotConfig, private readonly cwd = process.cwd()) {
    const logLevel = config.logLevel || (config.debug ? 'debug' : 'info')
    this.logger = createLogger(config.botName || 'QingBot', Boolean(config.debug) || logLevel === 'debug' || logLevel === 'trace')
    this.bot = new Bot({
      appid: config.appID,
      secret: config.appSecret,
      sandbox: config.sandbox ?? false,
      removeAt: config.removeAt ?? true,
      logLevel,
      accessTokenUrl: config.accessTokenUrl,
      gatewayUrl: config.gatewayUrl,
      timeout: config.timeout,
      maxRetry: config.maxRetry,
      heartbeatInterval: config.heartbeatInterval,
      maxRetries: config.maxRetries,
      reconnectDelay: config.reconnectDelay,
      intents: config.intents as any,
      mode: ReceiverMode.WEBSOCKET,
    })

    this.ctx = createContext({
      app: { handle: this.handle.bind(this) },
      officialBot: this.bot,
      config,
      logger: this.logger,
      normalizeSendable: this.normalizeSendable.bind(this),
    })
    this.runtime = this.ctx.bot as QingBotRuntime
    this.runtime.onSend((target, message, source) => {
      this.recordOutgoingWebMessage(target, message, source)
    })
  }

  handle(eventName: QingBotEventName, handler: QingBotHandler, pluginName = INTERNAL_PLUGIN) {
    const handlers = this.handlers.get(eventName) || []
    handlers.push({ pluginName, handler })
    this.handlers.set(eventName, handlers)
  }

  async start() {
    if (!this.config.appID || !this.config.appSecret) {
      throw new Error('缺少 appID / appSecret。请运行 npm run init，或编辑根目录 config.json。')
    }

    this.state = 'starting'
    this.registerOfficialEvents()
    await this.loadPlugins()
    await this.bot.start()
    this.state = 'running'
    this.startedAt = Date.now()
    await this.startWebConsole()
    this.logger.info('QingBot 已启动')
  }

  async stop() {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.state = 'stopping'
    this.logger.info('QingBot 正在关闭')

    try {
      await this.webConsole?.stop()
    } catch (error) {
      this.logger.warn(`关闭 Web 管理台失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.webConsole = undefined

    for (const name of [...this.loadedPlugins.keys()]) {
      await this.unloadPlugin(name)
    }
    this.handlers.clear()

    try {
      await this.bot.stop?.()
    } catch (error) {
      this.logger.warn(`关闭 QQ 连接失败：${error instanceof Error ? error.message : String(error)}`)
    }

    this.state = 'stopped'
    this.logger.info('QingBot 已关闭')
  }

  getStatus() {
    const memory = process.memoryUsage()
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const availablePlugins = this.getAvailablePluginNames()
    const configuredPlugins = this.getConfiguredPluginNames()

    return {
      botName: this.config.botName || 'QingBot',
      state: this.state,
      appID: this.config.appID,
      sandbox: this.config.sandbox ?? false,
      intents: this.config.intents || [],
      pluginDir: this.getPluginDir(),
      configuredPlugins,
      availablePlugins,
      loadedPlugins: [...this.loadedPlugins.entries()].map(([name, item]) => ({
        name,
        version: item.definition.version || '0.0.0',
        handlers: this.countPluginHandlers(name),
        cronTasks: item.cronTasks.length,
      })),
      pluginDependencies: availablePlugins.map((name) => this.getPluginDependencyStatus(name)),
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      system: {
        memoryUsed: totalMemory - freeMemory,
        memoryTotal: totalMemory,
      },
      process: {
        pid: process.pid,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
      },
    }
  }

  getWebToken() {
    return this.config.web?.token || ''
  }

  getConfigFiles(): WebConfigFile[] {
    return [
      this.describeConfigFile('root', CONFIG_FILE, path.join(this.cwd, CONFIG_FILE), 'root'),
      this.describeConfigFile('local', 'config.local.json', path.join(this.cwd, 'config.local.json'), 'local'),
      ...this.getAvailablePluginNames().map((name) => {
        const filePath = path.join(this.getPluginDir(), name, 'config.json')
        return this.describeConfigFile(`plugin:${name}`, `${name}/config.json`, filePath, 'plugin', name)
      }),
    ]
  }

  readConfigFile(id: string): WebConfigFileContent {
    const file = this.resolveConfigFile(id)
    return {
      ...file,
      content: fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '{}\n',
    }
  }

  saveConfigFile(id: string, content: string): WebConfigFileContent {
    const file = this.resolveConfigFile(id)
    const parsed = this.parseJsonConfig(content, file.label)
    const formatted = `${JSON.stringify(parsed, null, 2)}\n`

    fs.mkdirSync(path.dirname(file.path), { recursive: true })
    fs.writeFileSync(file.path, formatted)
    this.logger.info(`配置已保存：${file.label}`)

    return {
      ...this.describeConfigFile(file.id, file.label, file.path, file.kind, file.pluginName),
      content: formatted,
    }
  }

  getWebMessageLog(targetType?: WebMessageTargetType, targetId?: string): WebMessageLogEntry[] {
    const normalizedType = targetType ? this.normalizeWebTargetType(targetType) : undefined
    const normalizedId = String(targetId || '').trim()
    if (!normalizedType || !normalizedId) return [...this.webMessageLog]
    return this.webMessageLog.filter((entry) => entry.targetType === normalizedType && entry.targetId === normalizedId)
  }

  getWebMessageConversations(): WebMessageConversation[] {
    return this.readWebMessageConversations()
      .sort((left, right) => this.messageConversationTime(right) - this.messageConversationTime(left))
  }

  async saveWebMessageConversation(input: WebMessageConversationInput): Promise<WebMessageConversation> {
    const targetType = this.normalizeWebTargetType(input?.targetType)
    const targetId = String(input?.targetId || '').trim()
    if (!targetId) throw new Error('请填写目标 ID。')

    const alias = String(input?.alias || '').trim()
    const conversations = this.readWebMessageConversations()
    const conversation = this.upsertWebMessageConversation(conversations, {
      targetType,
      targetId,
      alias,
    })
    this.writeWebMessageConversations(conversations)
    return conversation
  }

  resolveWebMediaFile(source: string): string | undefined {
    const raw = String(source || '').trim().replace(/^file:\/\//, '')
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined

    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.cwd, raw)
    const root = path.resolve(this.cwd)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return undefined
    return resolved
  }

  async sendWebMessage(input: WebSendMessageInput) {
    const targetType = this.normalizeWebTargetType(input?.targetType)
    const format = this.normalizeWebMessageFormat(input?.format)
    const targetId = String(input?.targetId || '').trim()
    const content = String(input?.content || '')

    if (!targetId) return { ok: false, message: '请填写接收目标 ID。' }
    if (!content.trim()) return { ok: false, message: '请填写要发送的消息。' }

    try {
      const message = this.createWebMessagePayload(format, content)
      if (targetType === 'group') await this.runtime.sendGroupMsg(targetId, message)
      else if (targetType === 'user') await this.runtime.sendPrivateMsg(targetId, message)
      else if (targetType === 'channel') await this.runtime.sendGuildMsg(targetId, message)
      else await this.runtime.sendDirectMsg(targetId, message)

      return { ok: true, message: `已发送到${this.formatWebTarget(targetType)}：${targetId}` }
    } catch (error) {
      return { ok: false, message: `发送失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async simulateWebMessage(input: WebSimulateMessageInput): Promise<WebSimulateMessageResult> {
    const messageType = this.normalizeWebSimulateMessageType(input?.messageType)
    const content = String(input?.content || '')
    if (!content.trim()) throw new Error('请填写测试消息。')

    const userId = String(input?.userId || 'test-user').trim() || 'test-user'
    const nickname = String(input?.nickname || '测试用户').trim() || '测试用户'
    const groupId = String(input?.groupId || 'test-group').trim() || 'test-group'
    const channelId = String(input?.channelId || 'test-channel').trim() || 'test-channel'
    const guildId = String(input?.guildId || 'test-guild').trim() || 'test-guild'
    const role = String(input?.role || 'member').trim() || 'member'
    const createdAt = new Date()
    const replies: WebCapturedMessage[] = []

    const event: any = {
      id: `web-test-${createdAt.getTime()}`,
      message_id: `web-test-${createdAt.getTime()}`,
      event_id: `web-test-${createdAt.getTime()}`,
      post_type: 'message',
      message_type: messageType,
      sub_type: messageType === 'group' ? 'normal' : 'friend',
      time: Math.floor(createdAt.getTime() / 1000),
      raw_message: content,
      message: [segment.text(content)],
      user_id: userId,
      sender: {
        user_id: userId,
        user_name: nickname,
        nickname,
        role,
        member_role: role,
      },
    }

    if (messageType === 'group') event.group_id = groupId
    if (messageType === 'guild') {
      event.guild_id = guildId
      event.channel_id = channelId
    }

    const normalized = normalizeEvent(event, this.runtime, this.normalizeSendable.bind(this))
    await this.runtime.withSendInterceptor((target, message, source) => {
      const captured = this.createCapturedWebMessage(target, message, source)
      replies.push(captured)
      return { ok: true, id: captured.id, simulated: true }
    }, async () => {
      await this.routeMessage(normalized)
    })

    return {
      event: {
        messageType,
        userId,
        nickname,
        groupId: messageType === 'group' ? groupId : undefined,
        channelId: messageType === 'guild' ? channelId : undefined,
        guildId: messageType === 'guild' ? guildId : undefined,
        role,
        content,
      },
      replies,
    }
  }

  private normalizeWebTargetType(value: unknown): WebMessageTargetType {
    const type = String(value || 'group')
    if (type === 'group' || type === 'user' || type === 'channel' || type === 'direct') return type
    return 'group'
  }

  private normalizeWebMessageFormat(value: unknown): WebMessageFormat {
    return value === 'markdown' ? 'markdown' : 'text'
  }

  private normalizeWebSimulateMessageType(value: unknown): WebSimulateMessageType {
    const type = String(value || 'group')
    if (type === 'group' || type === 'private' || type === 'guild') return type
    return 'group'
  }

  private createWebMessagePayload(format: WebMessageFormat, content: string) {
    return format === 'markdown' ? segment.markdown(content) : segment.text(content)
  }

  private formatWebTarget(type: WebMessageTargetType) {
    const names: Record<WebMessageTargetType, string> = {
      group: '群',
      user: '用户',
      channel: '频道',
      direct: '频道私信',
    }
    return names[type]
  }

  private createCapturedWebMessage(target: RuntimeSendTarget, message: any, source?: any): WebCapturedMessage {
    const payload = this.simplifySendable(message)
    return {
      id: `web-reply-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      targetType: target.type,
      targetId: target.id,
      format: this.detectSendableFormat(message),
      content: this.flattenSendable(message),
      payload,
      source: this.simplifySendable(source),
      createdAt: new Date().toISOString(),
    }
  }

  private recordIncomingWebMessage(event: any) {
    const target = this.getIncomingWebTarget(event)
    if (!target.id) return

    this.recordWebMessage({
      id: `web-message-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      direction: 'in',
      targetType: target.type,
      targetId: target.id,
      displayTarget: this.formatWebTarget(target.type),
      userId: String(event?.sender?.user_id || event?.user_id || ''),
      nickname: String(event?.sender?.nickname || event?.sender?.user_name || event?.sender?.username || ''),
      format: this.detectSendableFormat(event?.message || event?.raw_message),
      content: String(event?.raw_message || this.flattenSendable(event?.message) || ''),
      payload: this.simplifySendable(event?.message),
      source: {
        messageId: event?.message_id || event?.id,
        eventId: event?.event_id,
        messageType: event?.message_type,
        subType: event?.sub_type,
      },
      createdAt: new Date().toISOString(),
    })
  }

  private recordOutgoingWebMessage(target: RuntimeSendTarget, message: any, source?: any) {
    this.recordWebMessage({
      id: `web-message-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      direction: 'out',
      targetType: target.type,
      targetId: target.id,
      displayTarget: this.formatWebTarget(target.type),
      format: this.detectSendableFormat(message),
      content: this.flattenSendable(message),
      payload: this.simplifySendable(message),
      source: this.simplifySendable(source),
      createdAt: new Date().toISOString(),
    })
  }

  private recordWebMessage(entry: WebMessageLogEntry) {
    this.webMessageLog.unshift(entry)
    if (this.webMessageLog.length > WEB_MESSAGE_LOG_LIMIT) {
      this.webMessageLog.splice(WEB_MESSAGE_LOG_LIMIT)
    }

    const conversations = this.readWebMessageConversations()
    this.upsertWebMessageConversation(conversations, {
      targetType: entry.targetType,
      targetId: entry.targetId,
      lastContent: entry.content,
      lastDirection: entry.direction,
      lastAt: entry.createdAt,
    })
    this.writeWebMessageConversations(conversations)
  }

  private upsertWebMessageConversation(
    conversations: WebMessageConversation[],
    patch: Pick<WebMessageConversation, 'targetType' | 'targetId'> & Partial<WebMessageConversation>,
  ): WebMessageConversation {
    const key = this.webMessageConversationKey(patch.targetType, patch.targetId)
    const now = new Date().toISOString()
    let conversation = conversations.find((item) => item.key === key)

    if (!conversation) {
      conversation = {
        key,
        targetType: patch.targetType,
        targetId: patch.targetId,
        title: this.formatConversationTitle(patch.targetType, patch.targetId, patch.alias),
        createdAt: now,
        updatedAt: now,
      }
      conversations.push(conversation)
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'alias')) conversation.alias = patch.alias || undefined
    if (Object.prototype.hasOwnProperty.call(patch, 'lastContent')) conversation.lastContent = patch.lastContent
    if (Object.prototype.hasOwnProperty.call(patch, 'lastDirection')) conversation.lastDirection = patch.lastDirection
    if (Object.prototype.hasOwnProperty.call(patch, 'lastAt')) conversation.lastAt = patch.lastAt
    conversation.targetType = patch.targetType
    conversation.targetId = patch.targetId
    conversation.title = this.formatConversationTitle(conversation.targetType, conversation.targetId, conversation.alias)
    conversation.updatedAt = now
    return conversation
  }

  private readWebMessageConversations(): WebMessageConversation[] {
    const filePath = this.getWebMessageTargetsPath()
    if (!fs.existsSync(filePath)) return []

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((item) => this.normalizeWebMessageConversation(item))
        .filter((item): item is WebMessageConversation => Boolean(item))
    } catch (error) {
      this.logger.warn(`读取消息会话失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private writeWebMessageConversations(conversations: WebMessageConversation[]) {
    const filePath = this.getWebMessageTargetsPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const sorted = conversations
      .filter((item) => item.targetId)
      .sort((left, right) => this.messageConversationTime(right) - this.messageConversationTime(left))
    const tmpPath = `${filePath}.tmp`
    fs.writeFileSync(tmpPath, `${JSON.stringify(sorted, null, 2)}\n`)
    fs.renameSync(tmpPath, filePath)
  }

  private normalizeWebMessageConversation(item: any): WebMessageConversation | undefined {
    const targetType = this.normalizeWebTargetType(item?.targetType)
    const targetId = String(item?.targetId || '').trim()
    if (!targetId) return undefined

    const alias = String(item?.alias || '').trim() || undefined
    const createdAt = this.normalizeIsoDate(item?.createdAt)
    const updatedAt = this.normalizeIsoDate(item?.updatedAt)
    const lastAt = item?.lastAt ? this.normalizeIsoDate(item.lastAt) : undefined
    const direction = item?.lastDirection === 'in' || item?.lastDirection === 'out' ? item.lastDirection : undefined

    return {
      key: this.webMessageConversationKey(targetType, targetId),
      targetType,
      targetId,
      alias,
      title: this.formatConversationTitle(targetType, targetId, alias),
      lastContent: typeof item?.lastContent === 'string' ? item.lastContent : undefined,
      lastDirection: direction,
      lastAt,
      createdAt,
      updatedAt,
    }
  }

  private getWebMessageTargetsPath() {
    return path.join(this.cwd, WEB_MESSAGE_TARGETS_FILE)
  }

  private webMessageConversationKey(targetType: WebMessageTargetType, targetId: string) {
    return `${targetType}:${targetId}`
  }

  private formatConversationTitle(targetType: WebMessageTargetType, targetId: string, alias?: string) {
    return alias || `${this.formatWebTarget(targetType)} ${targetId}`
  }

  private messageConversationTime(conversation: WebMessageConversation) {
    return new Date(conversation.lastAt || conversation.updatedAt || conversation.createdAt).getTime() || 0
  }

  private normalizeIsoDate(value: unknown) {
    const date = new Date(String(value || ''))
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
  }

  private getIncomingWebTarget(event: any): RuntimeSendTarget {
    if (event?.message_type === 'group') {
      return { type: 'group', id: String(event?.group_id || event?.group_openid || '') }
    }
    if (event?.message_type === 'guild') {
      return { type: 'channel', id: String(event?.channel_id || '') }
    }
    if (event?.message_type === 'private' && event?.sub_type === 'direct') {
      return { type: 'direct', id: String(event?.guild_id || '') }
    }
    return { type: 'user', id: String(event?.user_id || event?.sender?.user_id || '') }
  }

  private detectSendableFormat(message: any): WebMessageFormat | 'mixed' {
    if (Array.isArray(message)) {
      const formats = new Set(message.map((item) => this.detectSendableFormat(item)))
      return formats.size === 1 ? [...formats][0] : 'mixed'
    }
    if (message?.type === 'markdown') return 'markdown'
    if (message?.type === 'text' || typeof message === 'string') return 'text'
    return 'mixed'
  }

  private flattenSendable(message: any): string {
    if (message == null) return ''
    if (typeof message === 'string') return message
    if (Array.isArray(message)) return message.map((item) => this.flattenSendable(item)).join('')
    if (Buffer.isBuffer(message)) return `[Buffer ${message.byteLength} bytes]`

    if (message.type === 'text') return message.data?.text || message.text || ''
    if (message.type === 'markdown') {
      return message.data?.content || (message.data?.custom_template_id ? `[Markdown:${message.data.custom_template_id}]` : '[Markdown]')
    }
    if (message.type === 'image') return `[图片:${message.data?.file || message.data?.url || message.file || message.url || ''}]`
    if (message.type === 'audio' || message.type === 'record') return `[语音:${message.data?.file || message.data?.url || message.file || message.url || ''}]`
    if (message.type === 'video') return `[视频:${message.data?.file || message.data?.url || message.file || message.url || ''}]`
    if (message.type === 'at') return `@${message.data?.user_id || message.qq || ''}`
    if (message.type === 'face') return `[表情:${message.data?.id || ''}]`

    try {
      return JSON.stringify(this.simplifySendable(message))
    } catch {
      return String(message)
    }
  }

  private simplifySendable(value: any, depth = 0): unknown {
    if (depth > 4) return '[Object]'
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`
    if (Array.isArray(value)) return value.map((item) => this.simplifySendable(item, depth + 1))
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        result[key] = this.simplifySendable(item, depth + 1)
      }
      return result
    }
    return String(value)
  }

  private registerOfficialEvents() {
    this.bot.on('message', (event: any) => {
      const normalized = normalizeEvent(event, this.runtime, this.normalizeSendable.bind(this))
      this.recordIncomingWebMessage(normalized)
      void this.routeMessage(normalized).catch((error) => handleRuntimeError(error, normalized, this.logger))
    })

    this.bot.on('notice', (event: any) => {
      const normalized = normalizeEvent(event, this.runtime, this.normalizeSendable.bind(this))
      void this.dispatch('notice', normalized)
      for (const eventName of this.getSpecificNoticeEvents(normalized)) {
        void this.dispatch(eventName, normalized)
      }
    })
  }

  private async routeMessage(event: any) {
    if (await this.handleControlCommand(event)) return

    const specific = this.getSpecificMessageEvent(event)
    await this.dispatch('message', event)
    for (const eventName of specific) await this.dispatch(eventName, event)
  }

  private async dispatch(eventName: string, event: any) {
    const handlers = this.handlers.get(eventName) || []
    for (const { handler } of [...handlers]) {
      try {
        await handler(event)
      } catch (error) {
        await handleRuntimeError(error, event, this.logger)
      }
    }
  }

  private getSpecificMessageEvent(event: any): string[] {
    if (String(event.message_type || '').startsWith('audit')) {
      return event.message_type
        ? ['message.audit', `message.${event.message_type}`]
        : ['message.audit']
    }
    if (event.message_type === 'group') {
      return event.sub_type ? ['message.group', `message.group.${event.sub_type}`] : ['message.group']
    }
    if (event.message_type === 'guild') return ['message.guild']
    if (event.message_type === 'private') {
      return event.sub_type ? ['message.private', `message.private.${event.sub_type}`] : ['message.private']
    }
    return []
  }

  private getSpecificNoticeEvents(event: any): string[] {
    if (!event?.post_type || !event?.notice_type) return []
    const names = [event.post_type, event.notice_type, event.sub_type].filter(Boolean).join('.').split('.')
    const events: string[] = []
    for (let index = 2; index <= names.length; index += 1) {
      events.push(names.slice(0, index).join('.'))
    }
    return events
  }

  private async loadPlugins() {
    for (const name of this.getConfiguredPluginNames()) {
      await this.loadPlugin(name)
    }
  }

  async loadPlugin(name: string) {
    if (this.loadedPlugins.has(name)) return true

    const pluginDir = this.getPluginDir()
    const dependencyStatus = this.getPluginDependencyStatus(name)
    if (dependencyStatus.missing.length) {
      this.logger.warn([
        `插件依赖缺失：${name} 缺少 ${dependencyStatus.missing.join(', ')}`,
        dependencyStatus.installCommand ? `请运行：${dependencyStatus.installCommand}` : '',
      ].filter(Boolean).join('；'))
      return false
    }
    if (dependencyStatus.error) {
      this.logger.warn(`插件依赖声明读取失败：${name} ${dependencyStatus.error}`)
    }

    const plugin = await this.importPlugin(pluginDir, name)
    if (!plugin) return false

    const pluginCtx = this.createPluginContext(name)
    await plugin.setup?.(pluginCtx)
    const cronTasks = this.registerCron(plugin, pluginCtx)
    this.loadedPlugins.set(name, { definition: plugin, context: pluginCtx, cronTasks })
    this.logger.info(`插件已加载：${plugin.name}@${plugin.version || '0.0.0'}`)
    return true
  }

  private async importPlugin(pluginDir: string, name: string): Promise<PluginDefinition | undefined> {
    const pluginPath = path.join(pluginDir, name, 'index.ts')
    const compiledPath = path.join(pluginDir, name, 'index.js')
    const target = fs.existsSync(pluginPath) ? pluginPath : compiledPath
    if (!fs.existsSync(target)) {
      this.logger.warn(`插件不存在：${name}`)
      return undefined
    }

    const mod = requireModule(target)
    return mod.default || mod.plugin
  }

  private registerCron(plugin: PluginDefinition, pluginCtx: QingPluginContext) {
    const cronTasks: any[] = []
    for (const task of plugin.cron || []) {
      const [expression, handler] = task
      const cronTask = cron.schedule(expression, () => {
        void pluginCtx.runWithErrorHandler(() => handler(pluginCtx))
      })
      cronTasks.push(cronTask)
    }
    return cronTasks
  }

  async unloadPlugin(name: string) {
    const loaded = this.loadedPlugins.get(name)
    if (!loaded) return false

    for (const [eventName, handlers] of this.handlers) {
      const kept = handlers.filter((entry) => entry.pluginName !== name)
      if (kept.length) this.handlers.set(eventName, kept)
      else this.handlers.delete(eventName)
    }

    for (const task of loaded.cronTasks) {
      try {
        task.stop?.()
        task.destroy?.()
      } catch (error) {
        this.logger.warn(`停止插件定时任务失败：${name} ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    try {
      await loaded.definition.dispose?.(loaded.context)
    } catch (error) {
      this.logger.warn(`卸载插件清理失败：${name} ${error instanceof Error ? error.message : String(error)}`)
    }

    this.loadedPlugins.delete(name)
    return true
  }

  async reloadPlugin(name: string) {
    const pluginDir = this.getPluginDir()
    await this.unloadPlugin(name)
    this.clearPluginCache(pluginDir, name)
    return this.loadPlugin(name)
  }

  async reloadAllPlugins() {
    const names = this.getConfiguredPluginNames()
    const configured = new Set(names)
    for (const name of [...this.loadedPlugins.keys()]) {
      if (!configured.has(name)) await this.unloadPlugin(name)
    }
    for (const name of names) {
      await this.reloadPlugin(name)
    }
    return names
  }

  async reloadConfig() {
    const previousProtocolConfig = {
      appID: this.config.appID,
      appSecret: this.config.appSecret,
      sandbox: this.config.sandbox,
      intents: [...(this.config.intents || [])],
      accessTokenUrl: this.config.accessTokenUrl,
      gatewayUrl: this.config.gatewayUrl,
      timeout: this.config.timeout,
      maxRetry: this.config.maxRetry,
      heartbeatInterval: this.config.heartbeatInterval,
      maxRetries: this.config.maxRetries,
      reconnectDelay: this.config.reconnectDelay,
    }
    const nextConfig = loadConfig(this.cwd)
    this.applyConfig(nextConfig)
    const pluginNames = await this.reloadAllPlugins()

    const protocolChanged =
      previousProtocolConfig.appID !== nextConfig.appID ||
      previousProtocolConfig.appSecret !== nextConfig.appSecret ||
      previousProtocolConfig.sandbox !== nextConfig.sandbox ||
      previousProtocolConfig.intents.join(',') !== (nextConfig.intents || []).join(',') ||
      previousProtocolConfig.accessTokenUrl !== nextConfig.accessTokenUrl ||
      previousProtocolConfig.gatewayUrl !== nextConfig.gatewayUrl ||
      previousProtocolConfig.timeout !== nextConfig.timeout ||
      previousProtocolConfig.maxRetry !== nextConfig.maxRetry ||
      previousProtocolConfig.heartbeatInterval !== nextConfig.heartbeatInterval ||
      previousProtocolConfig.maxRetries !== nextConfig.maxRetries ||
      previousProtocolConfig.reconnectDelay !== nextConfig.reconnectDelay

    return { pluginNames, protocolChanged }
  }

  private applyConfig(nextConfig: QingBotConfig) {
    for (const key of Object.keys(this.config)) {
      delete (this.config as any)[key]
    }
    Object.assign(this.config, nextConfig)
  }

  private createPluginContext(pluginName: string): QingPluginContext {
    const config = this.readPluginConfig(pluginName)
    const pluginDir = path.join(this.getPluginDir(), pluginName)
    const configPath = path.join(pluginDir, 'config.json')
    let pluginCtx: QingPluginContext

    const savePluginConfig = <TConfig extends Record<string, any>>(nextConfig: TConfig): TConfig => {
      if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) {
        throw new Error('插件配置必须是 JSON 对象')
      }

      const saved = this.saveConfigFile(`plugin:${pluginName}`, JSON.stringify(nextConfig, null, 2))
      const parsed = JSON.parse(saved.content)
      for (const key of Object.keys(config)) delete config[key]
      Object.assign(config, parsed)
      pluginCtx.config = config
      return config as TConfig
    }

    pluginCtx = {
      ...this.ctx,
      config,
      pluginDir,
      configPath,
      getConfig<T extends Record<string, any> = Record<string, any>>(fallback?: T): T {
        return { ...(fallback || {}), ...config } as T
      },
      saveConfig: savePluginConfig,
      updateConfig<T extends Record<string, any> = Record<string, any>>(patch: Partial<T>): T {
        return savePluginConfig({ ...config, ...patch } as T)
      },
      handle: (eventName, handler) => this.handle(eventName, handler, pluginName),
    }

    return pluginCtx
  }

  private readPluginConfig(pluginName: string) {
    const configPath = path.join(this.getPluginDir(), pluginName, 'config.json')
    if (!fs.existsSync(configPath)) return {}

    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (error) {
      throw new Error(`插件配置读取失败：${pluginName}/config.json ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private getPluginDir() {
    if (this.config.pluginDir) return path.resolve(this.cwd, this.config.pluginDir)
    if (this.isCompiledRuntime()) return path.resolve(this.cwd, 'dist/plugins')
    return path.resolve(this.cwd, 'plugins')
  }

  private getConfiguredPluginNames() {
    const pluginDir = this.getPluginDir()
    return Array.isArray(this.config.plugins)
      ? this.normalizePluginNames(this.config.plugins)
      : fs.existsSync(pluginDir)
        ? this.readPluginDirectoryNames(pluginDir)
        : []
  }

  getAvailablePluginNames() {
    const pluginDir = this.getPluginDir()
    return fs.existsSync(pluginDir) ? this.readPluginDirectoryNames(pluginDir) : []
  }

  private getPluginDependencyStatus(name: string): PluginDependencySummary {
    const pluginRoot = path.join(this.getPluginDir(), name)
    const packagePath = path.join(pluginRoot, 'package.json')
    const summary: PluginDependencySummary = {
      name,
      hasPackage: fs.existsSync(packagePath),
      packagePath,
      total: 0,
      required: 0,
      installed: 0,
      missing: [],
      optionalMissing: [],
      dependencies: [],
    }

    if (!summary.hasPackage) return summary
    summary.installCommand = `npm install --prefix ${this.formatShellPath(pluginRoot)}`

    let manifest: any
    try {
      manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error)
      return summary
    }

    const dependencies = this.readPluginDependencies(manifest)
      .map((dependency) => this.resolvePluginDependency(pluginRoot, dependency))

    summary.dependencies = dependencies
    summary.total = dependencies.length
    summary.required = dependencies.filter((dependency) => !dependency.optional).length
    summary.installed = dependencies.filter((dependency) => dependency.installed).length
    summary.missing = dependencies
      .filter((dependency) => !dependency.optional && !dependency.installed)
      .map((dependency) => dependency.name)
    summary.optionalMissing = dependencies
      .filter((dependency) => dependency.optional && !dependency.installed)
      .map((dependency) => dependency.name)

    return summary
  }

  private readPluginDependencies(manifest: any): PluginDependencyStatus[] {
    const result = new Map<string, PluginDependencyStatus>()
    this.addPluginDependencies(result, manifest?.dependencies, 'dependencies', false)
    this.addPluginDependencies(result, manifest?.peerDependencies, 'peerDependencies', false, manifest?.peerDependenciesMeta)
    this.addPluginDependencies(result, manifest?.optionalDependencies, 'optionalDependencies', true)
    return [...result.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  private addPluginDependencies(
    result: Map<string, PluginDependencyStatus>,
    record: unknown,
    source: PluginDependencySource,
    optional: boolean,
    peerMeta?: Record<string, { optional?: boolean }>,
  ) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return

    for (const [name, requested] of Object.entries(record)) {
      if (!name || result.has(name)) continue
      result.set(name, {
        name,
        requested: String(requested),
        source,
        optional: optional || Boolean(peerMeta?.[name]?.optional),
        installed: false,
      })
    }
  }

  private resolvePluginDependency(pluginRoot: string, dependency: PluginDependencyStatus): PluginDependencyStatus {
    const pluginRequire = createRequire(path.join(pluginRoot, 'index.js'))
    try {
      return {
        ...dependency,
        installed: true,
        resolved: pluginRequire.resolve(dependency.name),
      }
    } catch (firstError) {
      try {
        return {
          ...dependency,
          installed: true,
          resolved: pluginRequire.resolve(`${dependency.name}/package.json`),
        }
      } catch {
        return {
          ...dependency,
          installed: false,
          error: firstError instanceof Error ? firstError.message : String(firstError),
        }
      }
    }
  }

  private formatShellPath(filePath: string) {
    const relative = path.relative(this.cwd, filePath)
    const displayPath = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative
      : filePath
    return /^[A-Za-z0-9_./:@-]+$/.test(displayPath)
      ? displayPath
      : `'${displayPath.replace(/'/g, "'\\''")}'`
  }

  private describeConfigFile(
    id: string,
    label: string,
    filePath: string,
    kind: WebConfigFile['kind'],
    pluginName?: string,
  ): WebConfigFile {
    return {
      id,
      label,
      path: filePath,
      exists: fs.existsSync(filePath),
      kind,
      pluginName,
    }
  }

  private resolveConfigFile(id: string): WebConfigFile {
    if (id === 'root') {
      return this.describeConfigFile('root', CONFIG_FILE, path.join(this.cwd, CONFIG_FILE), 'root')
    }

    if (id === 'local') {
      return this.describeConfigFile('local', 'config.local.json', path.join(this.cwd, 'config.local.json'), 'local')
    }

    if (id.startsWith('plugin:')) {
      const name = id.slice('plugin:'.length).trim()
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('插件名不合法')
      if (!this.getAvailablePluginNames().includes(name)) throw new Error(`插件不存在：${name}`)

      const pluginRoot = path.resolve(this.getPluginDir(), name)
      const pluginDir = `${path.resolve(this.getPluginDir())}${path.sep}`
      if (!pluginRoot.startsWith(pluginDir)) throw new Error('插件路径不合法')

      return this.describeConfigFile(
        `plugin:${name}`,
        `${name}/config.json`,
        path.join(pluginRoot, 'config.json'),
        'plugin',
        name,
      )
    }

    throw new Error(`未知配置文件：${id}`)
  }

  private parseJsonConfig(content: string, label: string) {
    try {
      const parsed = JSON.parse(content || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('配置内容必须是 JSON 对象')
      }
      return parsed
    } catch (error) {
      throw new Error(`JSON 格式错误：${label} ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private readPluginDirectoryNames(pluginDir: string) {
    return fs.readdirSync(pluginDir)
      .filter((name) => fs.statSync(path.join(pluginDir, name)).isDirectory())
      .sort((left, right) => left.localeCompare(right))
  }

  private normalizePluginNames(names: unknown[]) {
    const result: string[] = []
    for (const item of names) {
      const name = String(item || '').trim()
      if (name && !result.includes(name)) result.push(name)
    }
    return result
  }

  private readJsonConfigFile(file: WebConfigFile) {
    const content = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '{}'
    return this.parseJsonConfig(content, file.label)
  }

  private getPluginListConfigFile() {
    const localFile = this.resolveConfigFile('local')
    if (fs.existsSync(localFile.path)) {
      const localConfig = this.readJsonConfigFile(localFile)
      if (Object.prototype.hasOwnProperty.call(localConfig, 'plugins')) {
        return { file: localFile, config: localConfig }
      }
    }

    const rootFile = this.resolveConfigFile('root')
    return { file: rootFile, config: this.readJsonConfigFile(rootFile) }
  }

  private savePluginNames(pluginNames: string[]) {
    const target = this.getPluginListConfigFile()
    target.config.plugins = pluginNames
    this.saveConfigFile(target.file.id, JSON.stringify(target.config, null, 2))
    this.applyConfig(loadConfig(this.cwd))
    return target.file.label
  }

  async enablePlugin(name: string) {
    if (!this.isValidPluginName(name)) {
      return { ok: false, message: '插件名不合法，只能包含字母、数字、点、下划线和短横线。' }
    }

    const available = this.getAvailablePluginNames()
    if (!available.includes(name)) {
      return {
        ok: false,
        message: [
          `插件不存在：${name}`,
          `可用插件：${available.join(', ') || '无'}`,
        ].join('\n'),
      }
    }

    const current = this.getConfiguredPluginNames()
    const next = current.includes(name) ? current : [...current, name]
    const configFile = current.includes(name) ? undefined : this.savePluginNames(next)

    if (this.loadedPlugins.has(name)) {
      return {
        ok: true,
        message: current.includes(name)
          ? `插件已启用并已加载：${name}`
          : `插件已启用：${name}\n已写入 ${configFile}，当前已加载。`,
      }
    }

    this.clearPluginCache(this.getPluginDir(), name)
    const loaded = await this.loadPlugin(name)
    return {
      ok: loaded,
      message: loaded
        ? [
          `插件已启用：${name}`,
          configFile ? `已写入 ${configFile} 并加载。` : '配置中已启用，已重新尝试加载。',
        ].join('\n')
        : [
          configFile ? `已写入 ${configFile}，但插件加载失败：${name}` : `插件加载失败：${name}`,
          '请查看控制台日志或插件入口文件。',
        ].join('\n'),
    }
  }

  async disablePlugin(name: string) {
    if (!this.isValidPluginName(name)) {
      return { ok: false, message: '插件名不合法，只能包含字母、数字、点、下划线和短横线。' }
    }

    const current = this.getConfiguredPluginNames()
    const next = current.filter((item) => item !== name)
    const configFile = next.length === current.length ? undefined : this.savePluginNames(next)
    const unloaded = await this.unloadPlugin(name)

    if (configFile) {
      return {
        ok: true,
        message: [
          `插件已禁用：${name}`,
          `已写入 ${configFile}${unloaded ? ' 并卸载。' : '。'}`,
        ].join('\n'),
      }
    }

    return {
      ok: true,
      message: unloaded
        ? `插件已卸载：${name}\n配置中原本未启用。`
        : `插件未启用：${name}`,
    }
  }

  private isValidPluginName(name: string) {
    return PLUGIN_NAME_PATTERN.test(name)
  }

  private formatMenu() {
    const commands = [
      '#插件 列表 - 查看所有插件状态',
      '#插件 启用 插件名 - 启用插件并写入配置',
      '#插件 禁用 插件名 - 禁用插件并写入配置',
      '#插件 重载 [插件名] - 重载插件',
      '#重载 - 重新读取配置',
      '#状态 - 查看运行状态',
      '#关机 - 优雅关闭进程',
    ]
    if (this.loadedPlugins.has('ping')) commands.unshift('ping - 连通性测试')
    return commands.join('\n')
  }

  private formatPluginHelp() {
    return [
      '#插件 列表 - 查看插件目录、启用状态和加载状态',
      '#插件 启用 插件名 - 写入配置并加载插件',
      '#插件 禁用 插件名 - 从配置移除并卸载插件',
      '#插件 重载 - 重载所有已启用插件',
      '#插件 重载 插件名 - 重载单个已启用插件',
      '#重载 - 重新读取 config.json / config.local.json 并同步插件',
      '#状态 - 查看运行状态',
    ].join('\n')
  }

  private formatPluginList() {
    const available = new Set(this.getAvailablePluginNames())
    const configured = new Set(this.getConfiguredPluginNames())
    const names = this.normalizePluginNames([...available, ...configured]).sort((left, right) => left.localeCompare(right))
    const lines = names.map((name, index) => `${index + 1}. ${this.formatPluginStatus(name, available, configured)}`)

    return lines.length ? lines.join('\n') : '无'
  }

  private formatPluginStatus(name: string, available: Set<string>, configured: Set<string>) {
    const loaded = this.loadedPlugins.get(name)
    if (loaded) {
      const version = loaded.definition.version || '0.0.0'
      return `\`${name}@${version}\` - 已加载`
    }
    if (configured.has(name) && available.has(name)) return `\`${name}\` - 已启用，未加载`
    if (configured.has(name)) return `\`${name}\` - 已启用，目录缺失`
    return `\`${name}\` - 未启用`
  }

  private formatRuntimeStatus() {
    const memory = process.memoryUsage()
    const loaded = this.loadedPlugins.size
    const available = this.getAvailablePluginNames().length
    return [
      `- 状态：${this.formatState(this.state)}`,
      `- 运行：${this.formatDuration(this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0)}`,
      `- 内存：RSS ${this.formatBytes(memory.rss)}，Heap ${this.formatBytes(memory.heapUsed)}/${this.formatBytes(memory.heapTotal)}`,
      `- 系统：${this.formatBytes(os.totalmem() - os.freemem())}/${this.formatBytes(os.totalmem())}`,
      `- 插件：${loaded}/${available}`,
      `- 进程：${process.pid}，Node ${process.version}`,
    ].join('\n')
  }

  private formatState(state: QingBotState) {
    const names: Record<QingBotState, string> = {
      created: '已创建',
      starting: '启动中',
      running: '在线',
      stopping: '关闭中',
      stopped: '已停止',
    }
    return names[state] || state
  }

  private formatDuration(seconds: number) {
    const total = Math.max(0, Math.floor(seconds))
    const days = Math.floor(total / 86400)
    const hours = Math.floor((total % 86400) / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const rest = total % 60
    if (days) return `${days}d ${hours}h ${minutes}m`
    if (hours) return `${hours}h ${minutes}m`
    if (minutes) return `${minutes}m ${rest}s`
    return `${rest}s`
  }

  private formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let index = 0
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024
      index += 1
    }
    const digits = value >= 100 || index === 0 ? 0 : 1
    return `${value.toFixed(digits)} ${units[index]}`
  }

  private parsePluginCommand(raw: string): PluginCommand | undefined {
    if (raw === '#插件') return { action: '帮助', name: '' }
    if (!raw.startsWith('#插件 ')) return undefined

    const [action = '帮助', ...nameParts] = raw.slice('#插件'.length).trim().split(/\s+/)
    return {
      action,
      name: nameParts.join(' ').trim(),
    }
  }

  private isReadonlyPluginCommand(action: string) {
    return ['帮助', '菜单', '列表'].includes(action)
  }

  private async reloadConfiguredPlugin(name: string) {
    if (!this.isValidPluginName(name)) return false
    if (!this.getAvailablePluginNames().includes(name)) return false
    if (!this.getConfiguredPluginNames().includes(name)) return undefined
    return this.reloadPlugin(name)
  }

  private clearPluginCache(pluginDir: string, name: string) {
    const pluginRoot = path.resolve(pluginDir, name)
    const entryFiles = new Set([path.join(pluginRoot, 'index.ts'), path.join(pluginRoot, 'index.js')])
    const childRoot = pluginRoot + path.sep

    for (const cachedPath of Object.keys(require.cache)) {
      const resolved = path.resolve(cachedPath)
      if (entryFiles.has(resolved) || resolved.startsWith(childRoot)) delete require.cache[cachedPath]
    }
  }

  private isCompiledRuntime() {
    return path.basename(__dirname) === 'src' && path.basename(path.dirname(__dirname)) === 'dist'
  }

  private async handleControlCommand(event: any): Promise<boolean> {
    const raw = String(event.raw_message || '').trim()
    const shutdown = raw === '#关机'
    const pluginCommand = this.parsePluginCommand(raw)
    const menuCommand = raw === '#菜单' || raw === '#帮助'
    const statusCommand = raw === '#状态'
    const reloadConfigCommand = raw === '#重载'

    if (!shutdown && !pluginCommand && !menuCommand && !statusCommand && !reloadConfigCommand) return false

    if (menuCommand) {
      await this.replyMarkdown(event, this.formatMenu())
      return true
    }

    if (statusCommand) {
      await this.replyMarkdown(event, this.formatRuntimeStatus())
      return true
    }

    if (pluginCommand && this.isReadonlyPluginCommand(pluginCommand.action)) {
      const listCommand = pluginCommand.action === '列表'
      await this.replyMarkdown(event, listCommand ? this.formatPluginList() : this.formatPluginHelp())
      return true
    }

    if (!this.canControlPlugins(event)) {
      await this.replyMarkdown(event, `**权限不足**\n请把当前用户 ID 加入 \`config.json\` 的 \`ownerIds\` 或 \`adminIds\`：\`${event.sender?.user_id || event.user_id || 'unknown'}\``)
      return true
    }

    if (shutdown) {
      await this.replyMarkdown(event, '**正在关闭**')
      setTimeout(() => {
        void this.stop().finally(() => {
          process.exit(0)
        })
      }, 100)
      return true
    }

    if (pluginCommand) {
      if (pluginCommand.action === '启用') {
        if (!pluginCommand.name) {
          await this.replyMarkdown(event, '用法：`#插件 启用 插件名`')
          return true
        }
        const result = await this.enablePlugin(pluginCommand.name)
        await this.replyMarkdown(event, result.message)
        return true
      }

      if (pluginCommand.action === '禁用') {
        if (!pluginCommand.name) {
          await this.replyMarkdown(event, '用法：`#插件 禁用 插件名`')
          return true
        }
        const result = await this.disablePlugin(pluginCommand.name)
        await this.replyMarkdown(event, result.message)
        return true
      }

      if (pluginCommand.action === '重载') {
        if (!pluginCommand.name) {
          const names = await this.reloadAllPlugins()
          await this.replyMarkdown(event, `已重载 ${names.length} 个插件：${names.map((name) => `\`${name}\``).join(', ') || '无'}`)
          return true
        }

        const ok = await this.reloadConfiguredPlugin(pluginCommand.name)
        await this.replyMarkdown(
          event,
          ok === undefined
            ? `插件未启用：\`${pluginCommand.name}\`\n请先使用 \`#插件 启用 ${pluginCommand.name}\``
            : ok
              ? `插件已重载：\`${pluginCommand.name}\``
              : `插件不存在或加载失败：\`${pluginCommand.name}\``,
        )
        return true
      }

      await this.replyMarkdown(event, this.formatPluginHelp())
      return true
    }

    if (reloadConfigCommand) {
      const { pluginNames, protocolChanged } = await this.reloadConfig()
      await this.replyMarkdown(event, [
        `配置已重载，已同步 ${pluginNames.length} 个插件：${pluginNames.join(', ')}`,
        protocolChanged
          ? '注意：QQ 协议连接参数已变化，需要重启进程后才会真正生效。'
          : '',
      ].filter(Boolean).join('\n'))
      return true
    }

    return false
  }

  private replyMarkdown(event: any, content: string) {
    return event.reply(segment.markdown(content))
  }

  private canControlPlugins(event: any) {
    const hasConfiguredAdmins = Boolean(this.config.ownerIds?.length || this.config.adminIds?.length)
    if (!hasConfiguredAdmins && this.config.allowPublicControl !== false) return true
    return this.ctx.hasRight(event)
  }

  private countPluginHandlers(name: string) {
    let count = 0
    for (const handlers of this.handlers.values()) {
      count += handlers.filter((entry) => entry.pluginName === name).length
    }
    return count
  }

  private async startWebConsole() {
    if (!this.config.web?.enabled) return

    try {
      this.webConsole = createWebConsole(this, this.config.web, this.logger)
      await this.webConsole.start()
    } catch (error) {
      this.webConsole = undefined
      this.logger.warn(`Web 管理台启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  normalizeSendable(message: any): any {
    if (message == null) return segment.text('')
    if (typeof message === 'string') return segment.text(message)
    if (Array.isArray(message)) return message.map((item) => this.normalizeSendable(item))
    if (message.type === 'at' && message.data?.user_id && message.data.user_id !== 'all') {
      return segment.at(this.runtime.resolveUserId(message.data.user_id))
    }
    if (message.type === 'record') {
      return segment.audio(message.data?.file || message.file)
    }
    return message
  }
}
