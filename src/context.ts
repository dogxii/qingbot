import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { dedent, segment } from './plugin'
import { UnsupportedAbilityError } from './errors'
import type { QingPluginContext, QingBotConfig } from './types'
import type { Logger } from './logger'

type AliasKind = 'users' | 'groups'

function toId(id: string | number | undefined): string {
  return id == null ? '' : String(id)
}

function reverseLookup(record: Record<string, string> | undefined, value: string): string | undefined {
  if (!record) return undefined
  return Object.entries(record).find(([, official]) => official === value)?.[0]
}

export class QingBotRuntime {
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

  async sendPrivateMsg(userId: string | number, message: any, source?: any) {
    const resolved = this.resolveUserId(userId)
    return this.officialBot.sendPrivateMessage(resolved, this.normalizeSendable(message), source)
  }

  async sendGroupMsg(groupId: string | number, message: any, source?: any) {
    const resolved = this.resolveGroupId(groupId)
    return this.officialBot.sendGroupMessage(resolved, this.normalizeSendable(message), source)
  }

  async sendGuildMsg(channelId: string | number, message: any, source?: any) {
    return this.officialBot.sendGuildMessage(String(channelId), this.normalizeSendable(message), source)
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

  noticeGroups = async (groups: Array<string | number>, message: any) => {
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
    http: axios,
    axios,
    fs,
    path,
    oicq: { segment },
    handle: options.app.handle,
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
  if (event?.reply) await event.reply(`QingBot 插件执行出错：${error instanceof Error ? error.message : String(error)}`)
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
