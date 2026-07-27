import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import cron from 'node-cron'
import { Bot, ReceiverMode, segment } from 'qq-official-bot'
import { loadConfig } from './config'
import { createContext, handleRuntimeError, normalizeEvent, QingBotRuntime } from './context'
import { createLogger, type Logger } from './logger'
import type { PluginDefinition, QingBotConfig, QingBotEventName, QingBotHandler, QingPluginContext } from './types'
import { createWebConsole, type WebConsole } from './web'

const requireModule = createRequire(__filename)
const INTERNAL_PLUGIN = '__qingbot__'
const CONTROL_PREFIXES = ['#插件', '#重载配置', '#重载插件', '#加载插件', '#卸载插件']

type HandlerRecord = {
  pluginName: string
  handler: QingBotHandler
}

type LoadedPlugin = {
  definition: PluginDefinition
  cronTasks: any[]
}

type QingBotState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped'

export class QingBot {
  readonly logger: Logger
  readonly bot: any
  readonly ctx: QingPluginContext
  private readonly handlers = new Map<string, HandlerRecord[]>()
  private readonly loadedPlugins = new Map<string, LoadedPlugin>()
  private readonly runtime: QingBotRuntime
  private state: QingBotState = 'created'
  private startedAt = 0
  private webConsole?: WebConsole

  constructor(private readonly config: QingBotConfig, private readonly cwd = process.cwd()) {
    this.logger = createLogger(config.botName || 'QingBot')
    this.bot = new Bot({
      appid: config.appID,
      secret: config.appSecret,
      sandbox: config.sandbox ?? false,
      removeAt: true,
      logLevel: process.env.QINGBOT_DEBUG ? 'debug' : 'info',
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
  }

  handle(eventName: QingBotEventName, handler: QingBotHandler, pluginName = INTERNAL_PLUGIN) {
    const handlers = this.handlers.get(eventName) || []
    handlers.push({ pluginName, handler })
    this.handlers.set(eventName, handlers)
  }

  async start() {
    if (!this.config.appID || !this.config.appSecret) {
      throw new Error('缺少 QQ_APP_ID / QQ_APP_SECRET。请填写 .env 或 qingbot.config.json。')
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
    return {
      botName: this.config.botName || 'QingBot',
      state: this.state,
      appID: this.config.appID,
      sandbox: this.config.sandbox ?? false,
      intents: this.config.intents || [],
      pluginDir: this.getPluginDir(),
      configuredPlugins: this.getConfiguredPluginNames(),
      availablePlugins: this.getAvailablePluginNames(),
      loadedPlugins: [...this.loadedPlugins.entries()].map(([name, item]) => ({
        name,
        version: item.definition.version || '0.0.0',
        handlers: this.countPluginHandlers(name),
        cronTasks: item.cronTasks.length,
      })),
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
    }
  }

  private registerOfficialEvents() {
    this.bot.on('message', (event: any) => {
      const normalized = normalizeEvent(event, this.runtime, this.normalizeSendable.bind(this))
      void this.routeMessage(normalized)
    })

    this.bot.on('notice', (event: any) => {
      const normalized = normalizeEvent(event, this.runtime, this.normalizeSendable.bind(this))
      void this.dispatch('notice', normalized)
      if (event?.post_type && event?.notice_type) void this.dispatch(`${event.post_type}.${event.notice_type}`, normalized)
    })
  }

  private async routeMessage(event: any) {
    if (await this.handleControlCommand(event)) return

    const specific = this.getSpecificMessageEvent(event)
    await this.dispatch('message', event)
    if (specific) await this.dispatch(specific, event)
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

  private getSpecificMessageEvent(event: any): string | undefined {
    if (event.message_type === 'group') return 'message.group'
    if (event.message_type === 'guild') return 'message.guild'
    if (event.message_type === 'private') {
      return event.sub_type ? `message.private.${event.sub_type}` : 'message.private'
    }
    return undefined
  }

  private async loadPlugins() {
    for (const name of this.getConfiguredPluginNames()) {
      await this.loadPlugin(name)
    }
  }

  async loadPlugin(name: string) {
    if (this.loadedPlugins.has(name)) return true

    const pluginDir = this.getPluginDir()
    const plugin = await this.importPlugin(pluginDir, name)
    if (!plugin) return false

    const pluginCtx = this.createPluginContext(name)
    await plugin.setup?.(pluginCtx)
    const cronTasks = this.registerCron(plugin, pluginCtx)
    this.loadedPlugins.set(name, { definition: plugin, cronTasks })
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
    }
    const nextConfig = loadConfig(this.cwd)
    this.applyConfig(nextConfig)
    const pluginNames = await this.reloadAllPlugins()

    const protocolChanged =
      previousProtocolConfig.appID !== nextConfig.appID ||
      previousProtocolConfig.appSecret !== nextConfig.appSecret ||
      previousProtocolConfig.sandbox !== nextConfig.sandbox ||
      previousProtocolConfig.intents.join(',') !== (nextConfig.intents || []).join(',')

    return { pluginNames, protocolChanged }
  }

  private applyConfig(nextConfig: QingBotConfig) {
    for (const key of Object.keys(this.config)) {
      delete (this.config as any)[key]
    }
    Object.assign(this.config, nextConfig)
  }

  private createPluginContext(pluginName: string): QingPluginContext {
    return {
      ...this.ctx,
      handle: (eventName, handler) => this.handle(eventName, handler, pluginName),
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
      ? this.config.plugins
      : fs.existsSync(pluginDir)
        ? fs.readdirSync(pluginDir).filter((name) => fs.statSync(path.join(pluginDir, name)).isDirectory())
        : []
  }

  getAvailablePluginNames() {
    const pluginDir = this.getPluginDir()
    return fs.existsSync(pluginDir)
      ? fs.readdirSync(pluginDir).filter((name) => fs.statSync(path.join(pluginDir, name)).isDirectory())
      : []
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
    const shutdown = raw === '#关机' || raw === '#关闭机器人'
    if (!shutdown && !CONTROL_PREFIXES.some((prefix) => raw.startsWith(prefix))) return false

    if (!this.canControlPlugins(event)) {
      await event.reply(`权限不足。请把当前用户 ID 加入 QINGBOT_OWNER_IDS 或 QINGBOT_ADMIN_IDS：${event.sender?.user_id || event.user_id || 'unknown'}`)
      return true
    }

    if (raw === '#插件' || raw === '#插件帮助') {
      await event.reply([
        'QingBot 插件控制',
        '#插件列表 - 查看已加载插件',
        '#重载配置 - 重新读取 .env/json，并按新配置同步插件',
        '#重载插件 - 重载当前启用插件',
        '#重载插件 <名称> - 重载单个插件，例如 #重载插件 gemini',
        '#加载插件 <名称> - 临时加载插件',
        '#卸载插件 <名称> - 临时卸载插件',
        '#关机 - 优雅关闭机器人进程',
      ].join('\n'))
      return true
    }

    if (shutdown) {
      await event.reply('QingBot 正在关闭')
      setTimeout(() => {
        void this.stop().finally(() => {
          process.exit(0)
        })
      }, 100)
      return true
    }

    if (raw === '#重载配置') {
      const { pluginNames, protocolChanged } = await this.reloadConfig()
      await event.reply([
        `配置已重载，已同步 ${pluginNames.length} 个插件：${pluginNames.join(', ')}`,
        protocolChanged
          ? '注意：QQ_APP_ID、QQ_APP_SECRET、QQ_SANDBOX 或 QINGBOT_INTENTS 已变化，协议连接参数需要重启进程后才会真正生效。'
          : '',
      ].filter(Boolean).join('\n'))
      return true
    }

    if (raw === '#插件列表') {
      const loaded = [...this.loadedPlugins.entries()]
        .map(([name, item]) => `${name}@${item.definition.version || '0.0.0'}`)
        .join('\n')
      await event.reply(`已加载插件：\n${loaded || '无'}`)
      return true
    }

    if (raw === '#重载插件') {
      const names = await this.reloadAllPlugins()
      await event.reply(`已重载 ${names.length} 个插件：${names.join(', ')}`)
      return true
    }

    if (raw.startsWith('#重载插件')) {
      const name = raw.replace('#重载插件', '').trim()
      if (!name) return true
      const ok = await this.reloadPlugin(name)
      await event.reply(ok ? `插件已重载：${name}` : `插件不存在或加载失败：${name}`)
      return true
    }

    if (raw.startsWith('#加载插件')) {
      const name = raw.replace('#加载插件', '').trim()
      if (!name) return true
      if (this.loadedPlugins.has(name)) {
        await event.reply(`插件已加载：${name}`)
        return true
      }
      this.clearPluginCache(this.getPluginDir(), name)
      const ok = await this.loadPlugin(name)
      await event.reply(ok ? `插件已加载：${name}` : `插件不存在或加载失败：${name}`)
      return true
    }

    if (raw.startsWith('#卸载插件')) {
      const name = raw.replace('#卸载插件', '').trim()
      if (!name) return true
      const ok = await this.unloadPlugin(name)
      await event.reply(ok ? `插件已卸载：${name}` : `插件未加载：${name}`)
      return true
    }

    return false
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
    if (message == null) return ''
    if (typeof message === 'string') return message
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
