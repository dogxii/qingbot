import { loadConfig } from './config'
import { QingBot } from './qingbot'

let shuttingDown = false

async function main() {
  const app = new QingBot(loadConfig())
  bindShutdownHandlers(app)
  await app.start()
}

function bindShutdownHandlers(bot: QingBot) {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`[QingBot] 收到 ${signal}，正在优雅关闭...`)
    try {
      await bot.stop()
      process.exitCode = 0
    } catch (error) {
      console.error('[QingBot] 关闭失败', error)
      process.exitCode = 1
    } finally {
      setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref()
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGHUP', () => void shutdown('SIGHUP'))
}

main().catch((error) => {
  console.error('[QingBot] 启动失败', error)
  process.exitCode = 1
})
