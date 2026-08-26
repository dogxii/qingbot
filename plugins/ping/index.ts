import { definePlugin } from 'qingbot'

type PingConfig = {
  commands: string[]
  reply: string
}

export default definePlugin<PingConfig>({
  name: 'ping',
  version: '1.0.0',
  setup(ctx) {
    const config = ctx.getConfig({
      commands: ['ping', '#ping'],
      reply: 'pong',
    })

    ctx.command(config.commands, (event) => event.reply(config.reply))
  },
})
