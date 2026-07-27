export type Awaitable<T> = T | Promise<T>

export type QingBotEventName =
  | 'message'
  | 'message.group'
  | 'message.private'
  | 'message.private.friend'
  | 'message.private.direct'
  | 'message.guild'
  | 'notice'
  | string

export type QingBotHandler = (event: any) => Awaitable<void | boolean | unknown>

export type CronTask = [string, (ctx: QingPluginContext) => Awaitable<void>]

export interface PluginDefinition {
  name: string
  version?: string
  setup?: (ctx: QingPluginContext) => Awaitable<void>
  cron?: CronTask[]
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

export interface QingPluginContext {
  bot: any
  http: any
  axios: any
  fs: typeof import('fs')
  path: typeof import('path')
  oicq: any
  handle(eventName: QingBotEventName, handler: QingBotHandler): void
  hasRight(input: any): boolean
  isOwner(input: any): boolean
  isAdmin(input: any): boolean
  isGroupMsg(input: any): boolean
  isPrivateMsg(input: any): boolean
  isFunction(input: any): input is Function
  isString(input: any): input is string
  ensureArray<T>(input: T | T[]): T[]
  randomItem<T>(input: T[]): T
  getText(event: any): string
  dedent(strings: TemplateStringsArray | string, ...values: unknown[]): string
  noticeGroups(groups: Array<string | number>, message: any): Promise<void>
  runWithErrorHandler<T>(task: () => Awaitable<T>, event?: any): Promise<T | undefined>
  resolveUserId(id: string | number): string
  resolveGroupId(id: string | number): string
  getMentionedImageUrl(event: any): Promise<string | undefined>
  getQuoteMessage(event: any): Promise<any>
  unsupported(name: string): never
  [key: string]: any
}
