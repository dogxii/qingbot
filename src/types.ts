import type { SegmentFactory, Sendable as QQSendable } from 'qq-official-bot'
import type { Logger } from './logger'

export type Awaitable<T> = T | Promise<T>
export type Sendable = QQSendable

export type QingBotKnownEventName =
  | 'message'
  | 'message.audit'
  | 'message.audit.pass'
  | 'message.audit.reject'
  | 'message.group'
  | 'message.group.at'
  | 'message.private'
  | 'message.private.friend'
  | 'message.private.direct'
  | 'message.guild'
  | 'notice'
  | 'notice.friend'
  | 'notice.friend.action'
  | 'notice.friend.increase'
  | 'notice.friend.decrease'
  | 'notice.friend.receive_close'
  | 'notice.friend.receive_open'
  | 'notice.group'
  | 'notice.group.action'
  | 'notice.group.increase'
  | 'notice.group.decrease'
  | 'notice.group.member'
  | 'notice.group.member.increase'
  | 'notice.group.member.decrease'
  | 'notice.group.join_request'
  | 'notice.group.receive_close'
  | 'notice.group.receive_open'
  | 'notice.guild'
  | 'notice.guild.action'
  | 'notice.guild.increase'
  | 'notice.guild.update'
  | 'notice.guild.decrease'
  | 'notice.guild.member'
  | 'notice.guild.member.increase'
  | 'notice.guild.member.update'
  | 'notice.guild.member.decrease'
  | 'notice.channel'
  | 'notice.channel.enter'
  | 'notice.channel.exit'
  | 'notice.channel.increase'
  | 'notice.channel.update'
  | 'notice.channel.decrease'
  | 'notice.reaction.add'
  | 'notice.reaction.remove'
  | 'notice.forum'
  | 'notice.forum.thread'
  | 'notice.forum.thread.create'
  | 'notice.forum.thread.update'
  | 'notice.forum.thread.delete'
  | 'notice.forum.audit'
  | 'notice.forum.post'
  | 'notice.forum.post.create'
  | 'notice.forum.post.delete'
  | 'notice.forum.reply'
  | 'notice.forum.reply.create'
  | 'notice.forum.reply.delete'

export type QingBotEventName =
  | QingBotKnownEventName
  | (string & {})

export type QingBotHandler = (event: any) => Awaitable<void | boolean | unknown>
export type PluginConfig = Record<string, any>
export type QingBotLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'mark' | 'off'
export type QingMarkdownParams = Array<{ key: string; values: string }>
export type QingCommandHandler<TConfig extends PluginConfig = PluginConfig> = (
  event: any,
  matchedCommand: string,
  ctx: QingPluginContext<TConfig>,
) => Awaitable<void | boolean | unknown>

export interface QingCommandOptions {
  trim?: boolean
  ignoreCase?: boolean
}

export interface QingBotFacade {
  readonly uin: string
  readonly nickname: string
  readonly raw: any
  readonly client: any
  group(id: string | number): any
  user(id: string | number): any
  channel(id: string | number): any
  direct(guildId: string | number): any
  guild(id: string | number): any
  sendPrivateMsg(userId: string | number, message: Sendable, source?: any): Promise<any>
  sendGroupMsg(groupId: string | number, message: Sendable, source?: any): Promise<any>
  sendGuildMsg(channelId: string | number, message: Sendable, source?: any): Promise<any>
  sendDirectMsg(guildId: string | number, message: Sendable, source?: any): Promise<any>
  recallPrivateMsg(userId: string | number, messageId: string): Promise<any>
  recallGroupMsg(groupId: string | number, messageId: string): Promise<any>
  recallGuildMsg(channelId: string | number, messageId: string): Promise<any>
  recallDirectMsg(guildId: string | number, messageId: string, hideTip?: boolean): Promise<any>
  uploadMedia(targetId: string | number, targetType: 'user' | 'group', fileData: string | Buffer, options?: Record<string, any>): Promise<any>
  noticeGroups(groups: Array<string | number>, message: Sendable): Promise<void>
  resolveUserId(id: string | number): string
  resolveGroupId(id: string | number): string
  displayUserId(officialId: string): string
  displayGroupId(officialId: string): string
  getSelfInfo(): Promise<any>
}

export type CronTask<TConfig extends PluginConfig = PluginConfig> = [string, (ctx: QingPluginContext<TConfig>) => Awaitable<void>]

export interface PluginDefinition<TConfig extends PluginConfig = PluginConfig> {
  name: string
  version?: string
  setup?: (ctx: QingPluginContext<TConfig>) => Awaitable<void>
  dispose?: (ctx: QingPluginContext<TConfig>) => Awaitable<void>
  cron?: CronTask<TConfig>[]
}

export interface IdAliases {
  users?: Record<string, string>
  groups?: Record<string, string>
}

export interface QingBotConfig {
  appID: string
  appSecret: string
  sandbox?: boolean
  botName?: string
  debug?: boolean
  logLevel?: QingBotLogLevel
  removeAt?: boolean
  accessTokenUrl?: string
  gatewayUrl?: string
  timeout?: number
  maxRetry?: number
  heartbeatInterval?: number
  maxRetries?: number
  reconnectDelay?: number
  plugins?: string[]
  pluginDir?: string
  web?: QingBotWebConfig
  ownerIds?: string[]
  adminIds?: string[]
  allowPublicControl?: boolean
  aliases?: IdAliases
  legacyIdMode?: 'alias' | 'official'
  intents?: string[]
}

export interface QingBotWebConfig {
  enabled?: boolean
  host?: string
  port?: number
  token?: string
}

export interface QingPluginContext<TConfig extends PluginConfig = PluginConfig> {
  /** Bot facade: send messages, resolve aliases, use limited compatibility APIs. */
  bot: QingBotFacade
  /** Current plugin config loaded from plugins/<name>/config.json. */
  config: TConfig
  /** Current plugin directory. */
  pluginDir: string
  /** Current plugin config file path. */
  configPath: string
  /** Root config loaded from ./config.json. */
  rootConfig: QingBotConfig
  /** QingBot logger scoped to the current bot. */
  logger: Logger
  /** Axios instance alias. */
  http: any
  /** Axios instance. */
  axios: any
  /** Node fs module. */
  fs: typeof import('fs')
  /** Node path module. */
  path: typeof import('path')
  /** Compatibility namespace, including oicq.segment. */
  oicq: any
  /** QQ official segment factory. */
  segment: SegmentFactory
  /** Create a Markdown message segment. */
  markdown(contentOrTemplateId: string, params?: QingMarkdownParams): Sendable
  /** Reply to current event with a Markdown message. */
  replyMarkdown(event: any, contentOrTemplateId: string, params?: QingMarkdownParams): Promise<any>
  /** Listen to bot events, usually 'message', 'message.group', or 'notice'. */
  handle(eventName: QingBotEventName, handler: QingBotHandler): void
  /** Alias of handle(), closer to qq-official-bot's bot.on(). */
  on(eventName: QingBotEventName, handler: QingBotHandler): void
  /** Listen for exact text commands on message events. */
  command(commands: string | string[], handler: QingCommandHandler<TConfig>, options?: QingCommandOptions): void
  /** True when sender is owner/admin. */
  hasRight(input: any): boolean
  /** True when sender is owner. */
  isOwner(input: any): boolean
  /** True when sender is admin/owner. */
  isAdmin(input: any): boolean
  /** True for group messages. */
  isGroupMsg(input: any): boolean
  /** True for private messages. */
  isPrivateMsg(input: any): boolean
  /** Runtime function guard. */
  isFunction(input: any): input is Function
  /** Runtime string guard. */
  isString(input: any): input is string
  /** Wrap a single value as an array. */
  ensureArray<T>(input: T | T[]): T[]
  /** Pick a random item from an array. */
  randomItem<T>(input: T[]): T
  /** Get plain text from a message event. */
  getText(event: any): string
  /** Merge plugin config with defaults. */
  getConfig<T extends PluginConfig = TConfig>(fallback?: T): T
  /** Replace current plugin config file and update ctx.config. */
  saveConfig<T extends PluginConfig = TConfig>(config: T): T
  /** Shallow-merge current plugin config file and update ctx.config. */
  updateConfig<T extends PluginConfig = TConfig>(patch: Partial<T>): T
  /** Strip common indentation from template strings. */
  dedent(strings: TemplateStringsArray | string, ...values: unknown[]): string
  /** Send one message to multiple groups. */
  noticeGroups(groups: Array<string | number>, message: any): Promise<void>
  /** Run a task and reply/log errors in QingBot style. */
  runWithErrorHandler<T>(task: () => Awaitable<T>, event?: any): Promise<T | undefined>
  /** Resolve configured user alias to official id. */
  resolveUserId(id: string | number): string
  /** Resolve configured group alias to official id. */
  resolveGroupId(id: string | number): string
  /** Get first image URL from a message event. */
  getMentionedImageUrl(event: any): Promise<string | undefined>
  /** Get quoted/source message when available. */
  getQuoteMessage(event: any): Promise<any>
  /** Throw a consistent unsupported-API error. */
  unsupported(name: string): never
  [key: string]: any
}
