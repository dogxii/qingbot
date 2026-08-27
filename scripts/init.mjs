#!/usr/bin/env node
import crypto from 'node:crypto'
import * as fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

const CONFIG_FILE = 'config.json'
const TEMPLATE_FILE = 'config.example.json'
const APP_ID_PLACEHOLDER = 'YOUR_QQ_BOT_APP_ID'
const APP_SECRET_PLACEHOLDER = 'YOUR_QQ_BOT_APP_SECRET'

const fallbackConfig = {
  appID: APP_ID_PLACEHOLDER,
  appSecret: APP_SECRET_PLACEHOLDER,
  sandbox: false,
  botName: 'QingBot',
  debug: false,
  removeAt: true,
  plugins: ['ping'],
  web: {
    enabled: true,
    host: '127.0.0.1',
    port: 3300,
    token: '',
  },
  ownerIds: [],
  adminIds: [],
  allowPublicControl: false,
  aliases: {
    users: {},
    groups: {},
  },
  legacyIdMode: 'alias',
  intents: ['GROUP_AND_C2C_EVENT'],
}

const cwd = process.cwd()
const configPath = path.join(cwd, CONFIG_FILE)
const templatePath = path.join(cwd, TEMPLATE_FILE)
const isTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)
const scriptedAnswers = isTerminal ? [] : fsSync.readFileSync(0, 'utf8').split(/\r?\n/)
let scriptedAnswerIndex = 0
const rl = isTerminal
  ? readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  : undefined

let maskInput = false
const writeToOutput = rl?._writeToOutput?.bind(rl)
if (writeToOutput) {
  rl._writeToOutput = (text) => {
    if (!maskInput) return writeToOutput(text)
    if (/^\r?\n$/.test(text)) return rl.output.write(text)
    if (text) return rl.output.write('*')
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rl?.close()
}

async function main() {
  const template = mergeConfig(fallbackConfig, await readJsonIfExists(templatePath) || {})
  const existing = await readJsonIfExists(configPath)
  const config = mergeConfig(template, existing || {})

  console.log('QingBot 初始化配置')
  console.log(existing ? `检测到 ${CONFIG_FILE}，回车保留当前值。` : `将创建 ${CONFIG_FILE}。`)
  console.log('Web token 可输入 random 自动生成，输入 none 留空。')
  console.log('')

  const currentAppID = normalizePlaceholder(config.appID, APP_ID_PLACEHOLDER)
  const currentAppSecret = normalizePlaceholder(config.appSecret, APP_SECRET_PLACEHOLDER)

  config.appID = restorePlaceholder(await askText('AppID', currentAppID), APP_ID_PLACEHOLDER)
  config.appSecret = restorePlaceholder(await askSecret('AppSecret', currentAppSecret), APP_SECRET_PLACEHOLDER)
  config.sandbox = await askBoolean('使用沙箱环境', Boolean(config.sandbox))
  config.botName = await askText('机器人名称', String(config.botName || 'QingBot')) || 'QingBot'
  config.plugins = await askList('启用插件', Array.isArray(config.plugins) ? config.plugins : ['ping'])
  config.ownerIds = await askList('所有者用户 ID', Array.isArray(config.ownerIds) ? config.ownerIds : [])
  config.adminIds = await askList('管理员用户 ID', Array.isArray(config.adminIds) ? config.adminIds : [])
  config.allowPublicControl = await askBoolean('未配置管理员时允许公开管理命令', config.allowPublicControl !== false)

  const web = isPlainObject(config.web) ? { ...config.web } : {}
  web.enabled = await askBoolean('启用 Web 管理台', web.enabled !== false)
  if (web.enabled) {
    web.host = await askText('Web 监听地址', String(web.host || '127.0.0.1')) || '127.0.0.1'
    web.port = await askPort('Web 端口', Number(web.port) || 3300)
    web.token = resolveToken(await askSecret('Web token', String(web.token || '')), String(web.token || ''))
  }
  config.web = web

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  console.log('')
  console.log(`已写入 ${CONFIG_FILE}`)
  if (isPlaceholder(config.appID, APP_ID_PLACEHOLDER) || isPlaceholder(config.appSecret, APP_SECRET_PLACEHOLDER)) {
    console.log('还需要填写真实 appID 和 appSecret 后再启动。')
  }
  console.log('下一步：npm run dev')
}

function question(prompt) {
  if (!rl) {
    process.stdout.write(prompt)
    process.stdout.write('\n')
    return Promise.resolve(String(scriptedAnswers[scriptedAnswerIndex++] || '').trim())
  }

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(String(answer || '').trim()))
  })
}

async function askText(label, current = '') {
  const suffix = current ? ` [${current}]` : ''
  const answer = await question(`${label}${suffix}: `)
  return answer || current
}

async function askSecret(label, current = '') {
  const suffix = current ? ' [已设置，回车保留]' : ''
  const prompt = `${label}${suffix}: `
  if (!isTerminal || !writeToOutput) return askText(label, current)

  process.stdout.write(prompt)
  maskInput = true
  const answer = await question('')
  maskInput = false
  return answer || current
}

async function askBoolean(label, current) {
  const suffix = current ? ' [Y/n]' : ' [y/N]'
  for (;;) {
    const answer = (await question(`${label}${suffix}: `)).toLowerCase()
    if (!answer) return current
    if (['y', 'yes', 'true', '1', '是', '启用'].includes(answer)) return true
    if (['n', 'no', 'false', '0', '否', '禁用'].includes(answer)) return false
    console.log('请输入 y 或 n。')
  }
}

async function askPort(label, current) {
  for (;;) {
    const answer = await askText(label, String(current))
    const port = Number.parseInt(answer, 10)
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
    console.log('请输入 1-65535 之间的端口。')
  }
}

async function askList(label, current) {
  const answer = await askText(`${label}（逗号分隔）`, current.join(', '))
  if (['none', 'empty', 'clear', '无', '空'].includes(answer.toLowerCase())) return []
  return answer
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveToken(value, current) {
  const input = String(value || '').trim()
  if (!input) return current
  if (['none', 'empty', 'clear', '无', '空'].includes(input.toLowerCase())) return ''
  if (['random', 'generate', '随机', '生成'].includes(input.toLowerCase())) {
    return crypto.randomBytes(24).toString('base64url')
  }
  return input
}

function normalizePlaceholder(value, placeholder) {
  const text = String(value || '').trim()
  return isPlaceholder(text, placeholder) ? '' : text
}

function restorePlaceholder(value, placeholder) {
  return String(value || '').trim() || placeholder
}

function isPlaceholder(value, placeholder) {
  return !value || value === placeholder
}

function mergeConfig(base, patch) {
  if (!isPlainObject(base)) return patch
  if (!isPlainObject(patch)) return base
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(result[key]) && isPlainObject(value)
      ? mergeConfig(result[key], value)
      : value
  }
  return result
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw new Error(`读取 ${path.basename(filePath)} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
