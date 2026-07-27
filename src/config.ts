import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import type { QingBotConfig } from './types'

const DEFAULT_PLUGINS = ['ping']
const DEFAULT_INTENTS = ['GROUP_AND_C2C_EVENT']
const MANAGED_ENV_PREFIXES = ['QQ_', 'QINGBOT_', 'OPENAI_', 'DEEPSEEK_', 'GEMINI_']

let loadedDotenvKeys = new Set<string>()

function splitEnvList(value?: string): string[] {
  return value
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : []
}

function isManagedEnvKey(key: string) {
  return MANAGED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

function readBoolean(value: unknown, fallback = false) {
  if (value == null || value === '') return fallback
  return String(value).toLowerCase() === 'true'
}

function readPort(value: unknown, fallback: number) {
  const port = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}

export function reloadEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env')
  const parsed = fs.existsSync(envPath)
    ? dotenv.parse(fs.readFileSync(envPath))
    : {}
  const nextKeys = new Set(Object.keys(parsed).filter(isManagedEnvKey))
  const touchedKeys = new Set([...loadedDotenvKeys, ...nextKeys])

  for (const key of touchedKeys) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      process.env[key] = parsed[key]
    } else if (loadedDotenvKeys.has(key)) {
      delete process.env[key]
    }
  }

  loadedDotenvKeys = nextKeys
  return parsed
}

export function loadConfig(cwd = process.cwd()): QingBotConfig {
  reloadEnv(cwd)

  const jsonPath = path.join(cwd, 'qingbot.config.json')
  const fileConfig = fs.existsSync(jsonPath)
    ? JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    : {}
  const envPlugins = splitEnvList(process.env.QINGBOT_PLUGINS)
  const envOwnerIds = splitEnvList(process.env.QINGBOT_OWNER_IDS)
  const envAdminIds = splitEnvList(process.env.QINGBOT_ADMIN_IDS)
  const envIntents = splitEnvList(process.env.QINGBOT_INTENTS)

  const config: QingBotConfig = {
    appID: process.env.QQ_APP_ID || fileConfig.appID || fileConfig.appId || '',
    appSecret: process.env.QQ_APP_SECRET || fileConfig.appSecret || fileConfig.secret || '',
    sandbox: readBoolean(process.env.QQ_SANDBOX ?? fileConfig.sandbox),
    botName: process.env.QINGBOT_NAME || fileConfig.botName || 'QingBot',
    plugins: envPlugins.length
      ? envPlugins
      : Array.isArray(fileConfig.plugins)
        ? fileConfig.plugins
        : DEFAULT_PLUGINS,
    pluginDir: process.env.QINGBOT_PLUGIN_DIR || fileConfig.pluginDir,
    web: {
      enabled: readBoolean(process.env.QINGBOT_WEB_ENABLED ?? fileConfig.web?.enabled, true),
      host: process.env.QINGBOT_WEB_HOST || fileConfig.web?.host || '127.0.0.1',
      port: readPort(process.env.QINGBOT_WEB_PORT ?? fileConfig.web?.port, 3300),
      token: process.env.QINGBOT_WEB_TOKEN || fileConfig.web?.token || '',
    },
    ownerIds: envOwnerIds.length
      ? envOwnerIds
      : fileConfig.ownerIds || [],
    adminIds: envAdminIds.length
      ? envAdminIds
      : fileConfig.adminIds || [],
    allowPublicControl: readBoolean(process.env.QINGBOT_ALLOW_PUBLIC_CONTROL ?? fileConfig.allowPublicControl, true),
    aliases: fileConfig.aliases || {},
    legacyIdMode: fileConfig.legacyIdMode || 'alias',
    intents: envIntents.length
      ? envIntents
      : Array.isArray(fileConfig.intents)
        ? fileConfig.intents
        : DEFAULT_INTENTS,
  }

  return config
}
