import { definePlugin } from 'qingbot'

export default definePlugin({
  name: 'ping',
  version: '1.0.0',
  setup(ctx) {
    ctx.handle('message', async (event) => {
      const text = ctx.getText(event).trim().toLowerCase()
      if (text === 'ping' || text === '#ping') return event.reply('pong')
    })
  },
})
