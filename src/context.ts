import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { dedent, segment } from './plugin'
import { UnsupportedAbilityError } from './errors'
import type { Awaitable, QingCommandHandler, QingCommandOptions, QingMarkdownParams, QingPluginContext, QingBotConfig, Sendable } from './types'
import type { Logger } from './logger'

type AliasKind = 'users' | 'groups'

export interface RuntimeSendTarget {
  type: 'user' | 'group' | 'channel' | 'direct'
  id: string
}

export type RuntimeSendInterceptor = (
  target: RuntimeSendTarget,
  message: Sendable,
  source?: any,
) => Awaitable<any>

export type RuntimeSendObserver = (
  target: RuntimeSendTarget,
  message: Sendable,
  source?: any,
  result?: any,
) => Awaitable<void>

function toId(id: string | number | undefined): string {
  return id == null ? '' : String(id)
}

function reverseLookup(record: Record<string, string> | undefined, value: string): string | undefined {
  if (!record) return undefined
  return Object.entries(record).find(([, official]) => official === value)?.[0]
}

export class QingBotRuntime {
  private sendInterceptor?: RuntimeSendInterceptor
  private readonly sendObservers = new Set<RuntimeSendObserver>()

  constructor(
    private readonly officialBot: any,
    private readonly config: QingBotConfig,
    private readonly normalizeSendable: (message: any) => any,
  ) {}

  get uin() {
    return this.config.appID
  }

  get nickname() {
    return this.config.botName || 'QingBot'
  }

  get raw() {
    return this.officialBot
  }

  get client() {
    return this.officialBot
  }

  resolveUserId(id: string | number): string {
    return this.resolveAlias('users', id)
  }

  resolveGroupId(id: string | number): string {
    return this.resolveAlias('groups', id)
  }

  displayUserId(officialId: string): string {
    return this.displayAlias('users', officialId)
  }

  displayGroupId(officialId: string): string {
    return this.displayAlias('groups', officialId)
  }

  group(id: string | number) {
    const resolved = this.resolveGroupId(id)
    return this.getNativeEntry('group', resolved) || this.withNormalizedSend({
      id: resolved,
      group_id: resolved,
      send: (message: Sendable, source?: any) => this.sendGroupMsg(resolved, message, source),
      recall: (messageId: string) => this.recallGroupMsg(resolved, messageId),
      upload: (fileData: string | Buffer, options: Record<string, any> = {}) => this.uploadMedia(resolved, 'group', fileData, options),
      info: () => this.callBotMethod('getGroupInfo', resolved),
      botState: () => this.callBotMethod('getGroupBotState', resolved),
    })
  }

  user(id: string | number) {
    const resolved = this.resolveUserId(id)
    return this.getNativeEntry('user', resolved) || this.withNormalizedSend({
      id: resolved,
      user_id: resolved,
      send: (message: Sendable, source?: any) => this.sendPrivateMsg(resolved, message, source),
      recall: (messageId: string) => this.recallPrivateMsg(resolved, messageId),
      upload: (fileData: string | Buffer, options: Record<string, any> = {}) => this.uploadMedia(resolved, 'user', fileData, options),
    })
  }

  channel(id: string | number) {
    const resolved = String(id)
    return this.getNativeEntry('channel', resolved) || this.withNormalizedSend({
      id: resolved,
      channel_id: resolved,
      send: (message: Sendable, source?: any) => this.sendGuildMsg(resolved, message, source),
      recall: (messageId: string, hideWarning?: boolean) => this.officialBot.recallGuildMessage(resolved, messageId, hideWarning),
      info: () => this.callBotMethod('getChannelInfo', resolved),
      update: (updateInfo: Record<string, any>) => this.callBotMethod('updateChannel', resolved, updateInfo),
      delete: () => this.callBotMethod('deleteChannel', resolved),
    })
  }

  direct(guildId: string | number) {
    const resolved = String(guildId)
    return this.getNativeEntry('direct', resolved) || this.withNormalizedSend({
      id: resolved,
      guild_id: resolved,
      send: (message: Sendable, source?: any) => this.sendDirectMsg(resolved, message, source),
      recall: (messageId: string, hideTip?: boolean) => this.recallDirectMsg(resolved, messageId, hideTip),
      getMessage: (messageId: string) => this.callBotMethod('getDirectMessage', resolved, messageId),
    })
  }

  guild(id: string | number) {
    const resolved = String(id)
    return this.getNativeEntry('guild', resolved) || {
      id: resolved,
      guild_id: resolved,
      info: () => this.callBotMethod('getGuildInfo', resolved),
      channels: () => this.callBotMethod('getChannelList', resolved),
      roles: () => this.callBotMethod('getGuildRoles', resolved),
      mute: (seconds: number, endTime?: number) => this.callBotMethod('muteGuild', resolved, seconds, endTime),
      unmute: () => this.callBotMethod('unMuteGuild', resolved),
    }
  }

  async sendPrivateMsg(userId: string | number, message: Sendable, source?: any) {
    const resolved = this.resolveUserId(userId)
    const payload = this.normalizeSendable(message)
    if (this.sendInterceptor) return this.sendInterceptor({ type: 'user', id: resolved }, payload, source)
    return this.sendWithObservers(
      { type: 'user', id: resolved },
      payload,
      source,
      () => this.officialBot.sendPrivateMessage(resolved, payload, source),
    )
  }

  async sendGroupMsg(groupId: string | number, message: Sendable, source?: any) {
    const resolved = this.resolveGroupId(groupId)
    const payload = this.normalizeSendable(message)
    if (this.sendInterceptor) return this.sendInterceptor({ type: 'group', id: resolved }, payload, source)
    return this.sendWithObservers(
      { type: 'group', id: resolved },
      payload,
      source,
      () => this.officialBot.sendGroupMessage(resolved, payload, source),
    )
  }

  async sendGuildMsg(channelId: string | number, message: Sendable, source?: any) {
    const resolved = String(channelId)
    const payload = this.normalizeSendable(message)
    if (this.sendInterceptor) return this.sendInterceptor({ type: 'channel', id: resolved }, payload, source)
    return this.sendWithObservers(
      { type: 'channel', id: resolved },
      payload,
      source,
      () => this.officialBot.sendGuildMessage(resolved, payload, source),
    )
  }

  async sendDirectMsg(guildId: string | number, message: Sendable, source?: any) {
    const resolved = String(guildId)
    const payload = this.normalizeSendable(message)
    if (this.sendInterceptor) return this.sendInterceptor({ type: 'direct', id: resolved }, payload, source)
    return this.sendWithObservers(
      { type: 'direct', id: resolved },
      payload,
      source,
      () => this.officialBot.sendDirectMessage(resolved, payload, source),
    )
  }

  async withSendInterceptor<T>(interceptor: RuntimeSendInterceptor, task: () => Awaitable<T>): Promise<T> {
    const previous = this.sendInterceptor
    this.sendInterceptor = interceptor
    try {
      return await task()
    } finally {
      this.sendInterceptor = previous
    }
  }

  onSend(observer: RuntimeSendObserver) {
    this.sendObservers.add(observer)
    return () => this.sendObservers.delete(observer)
  }

  private async sendWithObservers(target: RuntimeSendTarget, payload: Sendable, source: any, send: () => Awaitable<any>) {
    const result = await send()
    this.notifySendObservers(target, payload, source, result)
    return result
  }

  private notifySendObservers(target: RuntimeSendTarget, payload: Sendable, source?: any, result?: any) {
    for (const observer of this.sendObservers) {
      void Promise.resolve(observer(target, payload, source, result)).catch(() => undefined)
    }
  }

  async recallPrivateMsg(userId: string | number, messageId: string) {
    return this.officialBot.recallPrivateMessage(this.resolveUserId(userId), messageId)
  }

  async recallGroupMsg(groupId: string | number, messageId: string) {
    return this.officialBot.recallGroupMessage(this.resolveGroupId(groupId), messageId)
  }

  async recallGuildMsg(channelId: string | number, messageId: string) {
    return this.officialBot.recallGuildMessage(String(channelId), messageId)
  }

  async recallDirectMsg(guildId: string | number, messageId: string, hideTip?: boolean) {
    return this.officialBot.recallDirectMessage(String(guildId), messageId, hideTip)
  }

  async uploadMedia(targetId: string | number, targetType: 'user' | 'group', fileData: string | Buffer, options: Record<string, any> = {}) {
    const resolvedId = targetType === 'group' ? this.resolveGroupId(targetId) : this.resolveUserId(targetId)
    const uploadOptions = {
      fileType: 1,
      ...options,
      targetId: resolvedId,
      targetType,
    }

    if (typeof this.officialBot.uploadMedia === 'function') {
      return this.officialBot.uploadMedia.length >= 3
        ? this.officialBot.uploadMedia(resolvedId, targetType, fileData, options)
        : this.officialBot.uploadMedia(fileData, uploadOptions)
    }

    if (typeof this.officialBot.fileProcessor?.uploadMedia === 'function') {
      return this.officialBot.fileProcessor.uploadMedia(fileData, uploadOptions)
    }

    throw new UnsupportedAbilityError('bot.uploadMedia')
  }

  async getSelfInfo() {
    return this.officialBot.getSelfInfo()
  }

  async makeForwardMsg(items: Array<{ nickname?: string; user_id?: string | number; message: any }>) {
    const blocks = items.map((item, index) => {
      const name = item.nickname || item.user_id || `#${index + 1}`
      return `${name}:\n${this.flattenMessage(item.message)}`
    })
    return `合并转发（QingBot 降级渲染）\n\n${blocks.join('\n\n---\n\n')}`
  }

  async getStrangerInfo(userId: string | number) {
    return { user_id: userId, nickname: String(userId) }
  }

  pickMember(groupId: string | number, userId: string | number) {
    return createUnsupportedMember(String(groupId), String(userId))
  }

  noticeGroups = async (groups: Array<string | number>, message: Sendable) => {
    for (const group of groups) {
      await this.sendGroupMsg(group, message)
    }
  }

  setAvatar(): never {
    throw new UnsupportedAbilityError('bot.setAvatar')
  }

  setNickname(): never {
    throw new UnsupportedAbilityError('bot.setNickname')
  }

  setSignature(): never {
    throw new UnsupportedAbilityError('bot.setSignature')
  }

  addFriend(): never {
    throw new UnsupportedAbilityError('bot.addFriend')
  }

  deleteFriend(): never {
    throw new UnsupportedAbilityError('bot.deleteFriend')
  }

  setGroupLeave(): never {
    throw new UnsupportedAbilityError('bot.setGroupLeave')
  }

  private resolveAlias(kind: AliasKind, id: string | number): string {
    const key = String(id)
    return this.config.aliases?.[kind]?.[key] || key
  }

  private displayAlias(kind: AliasKind, officialId: string): string {
    if (this.config.legacyIdMode === 'official') return officialId
    return reverseLookup(this.config.aliases?.[kind], officialId) || officialId
  }

  private flattenMessage(message: any): string {
    if (message == null) return ''
    if (typeof message === 'string') return message
    if (Array.isArray(message)) return message.map((item) => this.flattenMessage(item)).join('')
    if (message.type === 'text') return message.data?.text || ''
    if (message.type === 'image') return `[图片:${message.data?.file || message.data?.url || ''}]`
    if (message.type === 'audio') return `[语音:${message.data?.file || message.data?.url || ''}]`
    if (message.type === 'video') return `[视频:${message.data?.file || message.data?.url || ''}]`
    if (message.type === 'at') return `@${message.data?.user_id || ''}`
    if (message.type === 'face') return `[表情:${message.data?.id || ''}]`
    return JSON.stringify(message)
  }

  private withNormalizedSend<T extends object>(entry: T): T {
    return new Proxy(entry, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver)
        if (property === 'send' && typeof value === 'function') {
          return (message: Sendable, source?: any, ...args: any[]) => value.call(target, this.normalizeSendable(message), source, ...args)
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  private getNativeEntry(methodName: 'group' | 'user' | 'channel' | 'direct' | 'guild', id: string): any {
    const factory = this.officialBot[methodName]
    if (typeof factory !== 'function') return undefined
    const entry = factory.call(this.officialBot, id)
    return entry && typeof entry === 'object' ? this.withNormalizedSend(entry) : undefined
  }

  private callBotMethod(methodName: string, ...args: any[]) {
    const method = this.officialBot[methodName]
    if (typeof method !== 'function') throw new UnsupportedAbilityError(`bot.${methodName}`)
    return method.call(this.officialBot, ...args)
  }
}

export function createContext(options: {
  app: { handle: QingPluginContext['handle'] }
  officialBot: any
  config: QingBotConfig
  logger: Logger
  normalizeSendable: (message: any) => any
}): QingPluginContext {
  const runtime = new QingBotRuntime(
    options.officialBot,
    options.config,
    options.normalizeSendable,
  )

  const ownerIds = () => new Set((options.config.ownerIds || []).map(String))
  const adminIds = () => new Set([...(options.config.adminIds || []), ...(options.config.ownerIds || [])].map(String))

  const ctx: QingPluginContext = {
    bot: runtime,
    config: {},
    pluginDir: '',
    configPath: '',
    rootConfig: options.config,
    logger: options.logger,
    http: axios,
    axios,
    fs,
    path,
    oicq: { segment },
    segment,
    markdown(contentOrTemplateId: string, params?: QingMarkdownParams) {
      return segment.markdown(contentOrTemplateId, params)
    },
    replyMarkdown(event: any, contentOrTemplateId: string, params?: QingMarkdownParams) {
      return event.reply(segment.markdown(contentOrTemplateId, params))
    },
    handle: options.app.handle,
    on(eventName, handler) {
      return this.handle(eventName, handler)
    },
    command(commands: string | string[], handler: QingCommandHandler, commandOptions: QingCommandOptions = {}) {
      const list = this.ensureArray(commands).map(String)
      const trim = commandOptions.trim !== false
      const ignoreCase = commandOptions.ignoreCase !== false

      this.handle('message', async (event) => {
        let text = this.getText(event)
        if (trim) text = text.trim()
        const input = ignoreCase ? text.toLowerCase() : text
        const matched = list.find((command) => (ignoreCase ? command.toLowerCase() : command) === input)
        if (matched) return handler(event, matched, this)
      })
    },
    hasRight(input: any) {
      const id = getInputUserId(input)
      return ownerIds().has(id) || adminIds().has(id)
    },
    isOwner(input: any) {
      return ownerIds().has(getInputUserId(input))
    },
    isAdmin(input: any) {
      const id = getInputUserId(input)
      const role = input?.sender?.role || input?.sender?.member_role || input?.member_role
      return adminIds().has(id) || role === 'admin' || role === 'owner'
    },
    isGroupMsg(input: any) {
      return input?.message_type === 'group' || Boolean(input?.group_id)
    },
    isPrivateMsg(input: any) {
      return input?.message_type === 'private'
    },
    isFunction(input: any): input is Function {
      return typeof input === 'function'
    },
    isString(input: any): input is string {
      return typeof input === 'string'
    },
    ensureArray<T>(input: T | T[]): T[] {
      return Array.isArray(input) ? input : [input]
    },
    randomItem<T>(input: T[]): T {
      return input[Math.floor(Math.random() * input.length)]
    },
    getText(event: any) {
      return event?.raw_message || ''
    },
    getConfig<T extends Record<string, any> = Record<string, any>>(fallback?: T): T {
      return { ...(fallback || {}), ...(this.config || {}) } as T
    },
    saveConfig(): never {
      throw new UnsupportedAbilityError('ctx.saveConfig')
    },
    updateConfig(): never {
      throw new UnsupportedAbilityError('ctx.updateConfig')
    },
    dedent,
    noticeGroups: runtime.noticeGroups,
    async runWithErrorHandler<T>(task: () => Promise<T> | T, event?: any) {
      try {
        return await task()
      } catch (error) {
        await handleRuntimeError(error, event, options.logger)
        return undefined
      }
    },
    resolveUserId: runtime.resolveUserId.bind(runtime),
    resolveGroupId: runtime.resolveGroupId.bind(runtime),
    async getMentionedImageUrl(event: any) {
      const image = event?.message?.find?.((item: any) => item?.type === 'image')
      return image?.data?.url || image?.data?.file || image?.url || image?.file
    },
    async getQuoteMessage(event: any) {
      return event?.source
    },
    unsupported(name: string): never {
      throw new UnsupportedAbilityError(name)
    },
    getAuthCodeOfBot() {
      throw new UnsupportedAbilityError('ctx.getAuthCodeOfBot')
    },
    getAuthCodeViaTicket() {
      throw new UnsupportedAbilityError('ctx.getAuthCodeViaTicket')
    },
    getViolationRecords() {
      throw new UnsupportedAbilityError('ctx.getViolationRecords')
    },
    requestLoginViaDevTools() {
      throw new UnsupportedAbilityError('ctx.requestLoginViaDevTools')
    },
    queryDevToolsLoginStatus() {
      throw new UnsupportedAbilityError('ctx.queryDevToolsLoginStatus')
    },
  }

  return ctx
}

export function normalizeEvent(event: any, runtime: QingBotRuntime, normalizeSendable: (message: any) => any) {
  const officialUserId = toId(
    event?.sender?.user_openid
      || event?.sender?.user_id
      || event?.user_openid
      || event?.member_openid
      || event?.user_id,
  )
  const officialGroupId = toId(event?.group_openid || event?.group_id)

  if (officialUserId) {
    const displayUserId = runtime.displayUserId(officialUserId)
    event.user_id = displayUserId
    event.sender ||= {}
    event.sender.user_id = displayUserId
    event.sender.openid = officialUserId
    event.sender.nickname ||= event.sender.user_name || displayUserId
  }

  if (officialGroupId) {
    event.group_id = runtime.displayGroupId(officialGroupId)
    event.group_openid = officialGroupId
  }

  event.message_type ||= officialGroupId ? 'group' : event.guild_id ? 'guild' : 'private'
  event.raw_message ||= ''
  event.message ||= []
  for (const item of event.message) {
    if (item?.type === 'text') item.text ||= item.data?.text
    if (['image', 'audio', 'video'].includes(item?.type)) {
      item.url ||= item.data?.url
      item.file ||= item.data?.file || item.data?.url || item.data?.name
    }
    if (item?.type === 'at') item.qq ||= item.data?.user_id
  }
  event.toString = () => {
    if (event.raw_message) return event.raw_message
    return (event.message || []).map((item: any) => {
      if (typeof item === 'string') return item
      if (item?.type === 'text') return item.data?.text || item.text || ''
      if (item?.type === 'image') return `<image:${item.data?.url || item.data?.file || item.url || item.file || ''}>`
      if (item?.type === 'audio') return `<audio:${item.data?.url || item.data?.file || item.url || item.file || ''}>`
      return ''
    }).join('')
  }

  const replySource = { id: event.message_id || event.id, event_id: event.event_id }
  event.reply = async (message: any) => {
    const payload = normalizeSendable(message)
    if (event.message_type === 'group') {
      return runtime.sendGroupMsg(officialGroupId || event.group_id, payload, replySource)
    }
    if (event.message_type === 'guild') {
      return runtime.sendGuildMsg(event.channel_id, payload, replySource)
    }
    if (event.message_type === 'private' && event.sub_type === 'direct') {
      return runtime.sendDirectMsg(event.guild_id, payload, replySource)
    }
    return runtime.sendPrivateMsg(officialUserId || event.user_id, payload, replySource)
  }

  if (event.message_type === 'group') {
    event.group = createGroupFacade(event)
  }

  return event
}

export async function handleRuntimeError(error: unknown, event: any, logger: Logger) {
  if (error instanceof UnsupportedAbilityError) {
    logger.warn(error.message)
    if (event?.reply) await event.reply(error.message)
    return
  }
  logger.error(error)
  if (event?.reply) await event.reply(`插件执行出错：${error instanceof Error ? error.message : String(error)}`)
}

function getInputUserId(input: any): string {
  if (typeof input === 'string' || typeof input === 'number') return String(input)
  return toId(input?.sender?.user_id || input?.user_id)
}

function createGroupFacade(event: any) {
  const role = event?.sender?.role || event?.sender?.member_role
  return {
    group_id: event.group_id,
    is_owner: role === 'owner',
    is_admin: role === 'admin' || role === 'owner',
    pickMember(userId: string | number) {
      return createUnsupportedMember(String(event.group_id), String(userId))
    },
    recallMsg(): never {
      throw new UnsupportedAbilityError('group.recallMsg')
    },
    setAdmin(): never {
      throw new UnsupportedAbilityError('group.setAdmin')
    },
    setTitle(): never {
      throw new UnsupportedAbilityError('group.setTitle')
    },
    setName(): never {
      throw new UnsupportedAbilityError('group.setName')
    },
    setAvatar(): never {
      throw new UnsupportedAbilityError('group.setAvatar')
    },
    muteAll(): never {
      throw new UnsupportedAbilityError('group.muteAll')
    },
  }
}

function createUnsupportedMember(groupId: string, userId: string) {
  return {
    group_id: groupId,
    user_id: userId,
    card: userId,
    nickname: userId,
    kick(): never {
      throw new UnsupportedAbilityError('member.kick')
    },
    mute(): never {
      throw new UnsupportedAbilityError('member.mute')
    },
    setCard(): never {
      throw new UnsupportedAbilityError('member.setCard')
    },
  }
}
