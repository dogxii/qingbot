import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { segment as qqSegment } from 'qq-official-bot'
import type {
  GroupMessageEvent as QQGroupMessageEvent,
  GuildMessageEvent as QQGuildMessageEvent,
  ImageElem as QQImageElem,
  MessageElem as QQMessageElem,
  PrivateMessageEvent as QQPrivateMessageEvent,
  SegmentFactory,
  Sendable as QQSendable,
} from 'qq-official-bot'
import type { PluginConfig, PluginDefinition } from './types'

export function definePlugin<TConfig extends PluginConfig = PluginConfig>(plugin: PluginDefinition<TConfig>): PluginDefinition<TConfig> {
  return plugin
}

export const segment = {
  ...qqSegment,
  image(
    file: string | Buffer,
    optionsOrCache?: { url?: string; name?: string } | boolean,
    _timeout?: number,
    _headers?: Record<string, string>,
  ) {
    const options = typeof optionsOrCache === 'object' ? optionsOrCache : undefined
    return qqSegment.image(file as any, options as any)
  },
  record(file: string | Buffer, options?: Record<string, unknown>) {
    return qqSegment.audio(file as any, options as any)
  },
  audio(file: string | Buffer, options?: Record<string, unknown>) {
    return qqSegment.audio(file as any, options as any)
  },
}

export const http = axios
export { axios, fs, path }

export function dedent(strings: TemplateStringsArray | string, ...values: unknown[]): string {
  const raw = typeof strings === 'string'
    ? strings
    : strings.reduce((text, chunk, index) => text + chunk + (values[index] ?? ''), '')
  const lines = raw.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n')
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim())
      .map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  )
  return lines.map((line) => line.slice(indent)).join('\n')
}

export type Sendable = QQSendable
export type ImageElem = QQImageElem
export type MessageElem = QQMessageElem
export type Segment = SegmentFactory
export type QingPluginContext = import('./types').QingPluginContext
export type PluginContext = import('./types').QingPluginContext
export type AllMessageEvent = any
export type GroupMessageEvent = QQGroupMessageEvent
export type PrivateMessageEvent = QQPrivateMessageEvent
export type GuildMessageEvent = QQGuildMessageEvent
export type DiscussMessageEvent = any
export type MusicPlatform = any

export async function getMentionedUserId(event: any): Promise<string | number> {
  const at = event?.message?.find?.((item: any) => item?.type === 'at')
  return at?.data?.user_id || at?.qq || ''
}

export async function getMentionedImage(event: any): Promise<string | undefined> {
  const image = event?.message?.find?.((item: any) => item?.type === 'image')
  return image?.data?.url || image?.data?.file || image?.url || image?.file
}

export namespace oicq {
  export type Sendable = any
  export type GroupMessageEvent = any
  export type PrivateMessageEvent = any
  export type MessageEvent = any
}
