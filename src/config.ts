import fs from 'fs'
import path from 'path'
import type { QingBotConfig, QingBotLogLevel } from './types'

const DEFAULT_PLUGINS = ['ping']
const DEFAULT_INTENTS = ['GROUP_AND_C2C_EVENT']
const LOG_LEVELS = new Set<QingBotLogLevel>(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark', 'off'])
export const CONFIG_FILE = 'config.json'

function readBoolean(value: unknown, fallback = false) {
  if (value == null || value === '') return fallback
  return String(value).toLowerCase() === 'true'
}

function readPort(value: unknown, fallback: number) {
  const port = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}

function readNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function readLogLevel(value: unknown): QingBotLogLevel | undefined {
  const level = String(value || '').toLowerCase() as QingBotLogLevel
  return LOG_LEVELS.has(level) ? level : undefined
}

export function loadRawConfig(cwd = process.cwd()) {
  return mergeConfig(readConfigFile(cwd), readOptionalConfig(cwd))
}

export function loadConfig(cwd = process.cwd()): QingBotConfig {
  const fileConfig = loadRawConfig(cwd)

  const config: QingBotConfig = {
    appID: fileConfig.appID || fileConfig.appId || '',
    appSecret: fileConfig.appSecret || fileConfig.secret || '',
    sandbox: readBoolean(fileConfig.sandbox),
    botName: fileConfig.botName || fileConfig.name || 'QingBot',
    debug: readBoolean(fileConfig.debug),
    logLevel: readLogLevel(fileConfig.logLevel),
    removeAt: readBoolean(fileConfig.removeAt, true),
    accessTokenUrl: fileConfig.accessTokenUrl,
    gatewayUrl: fileConfig.gatewayUrl,
    timeout: readNumber(fileConfig.timeout),
    maxRetry: readNumber(fileConfig.maxRetry),
    heartbeatInterval: readNumber(fileConfig.heartbeatInterval),
    maxRetries: readNumber(fileConfig.maxRetries),
    reconnectDelay: readNumber(fileConfig.reconnectDelay),
    plugins: Array.isArray(fileConfig.plugins)
      ? fileConfig.plugins
      : DEFAULT_PLUGINS,
    pluginDir: fileConfig.pluginDir,
    web: {
      enabled: readBoolean(fileConfig.web?.enabled, true),
      host: fileConfig.web?.host || '127.0.0.1',
      port: readPort(fileConfig.web?.port, 3300),
      token: fileConfig.web?.token || '',
    },
    ownerIds: fileConfig.ownerIds || [],
    adminIds: fileConfig.adminIds || [],
    allowPublicControl: readBoolean(fileConfig.allowPublicControl, true),
    aliases: fileConfig.aliases || {},
    legacyIdMode: fileConfig.legacyIdMode || 'alias',
    intents: Array.isArray(fileConfig.intents)
      ? fileConfig.intents
      : DEFAULT_INTENTS,
  }

  return config
}

function readConfigFile(cwd: string) {
  const configPath = path.join(cwd, CONFIG_FILE)
  return readJsonIfExists(configPath)
}

function readOptionalConfig(cwd: string) {
  return readJsonIfExists(path.join(cwd, 'config.local.json'))
}

function readJsonIfExists(filePath: string) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : {}
}

function mergeConfig(base: any, patch: any) {
  if (!patch || typeof patch !== 'object') return base
  if (!base || typeof base !== 'object') return patch

  const result: Record<string, any> = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(result[key]) && isPlainObject(value)) {
      result[key] = mergeConfig(result[key], value)
    } else {
      result[key] = value
    }
  }
  return result
}

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
