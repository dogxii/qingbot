# QingBot Plugins

插件目录：`plugins/<name>/index.ts`。

可选配置：`plugins/<name>/config.json`。

QingBot 默认只带 `ping` 作为最小演示插件。业务插件建议按“一个目录一个插件”放在 `plugins/`，再用 `#插件 启用 插件名` 或根 `config.json` 的 `plugins` 数组启用。

内置管理命令：

- `#菜单` / `#帮助`：查看内置菜单。
- `#状态`：查看运行状态和内存。
- `#插件 列表`：查看插件目录下所有插件，包括未启用的插件。
- `#插件 启用 插件名` / `#插件 禁用 插件名`：持久化更新插件列表并立即加载或卸载。
- `#插件 重载 [插件名]`：重载全部已启用插件或单个已启用插件。
- `#重载`：重新读取配置并同步插件。

## 底层 SDK 参考

QingBot 基于 [`qq-official-bot`](https://zhinjs.github.io/qq-official-bot/) 封装。插件里优先使用 QingBot 提供的 `ctx.command()`、`event.reply()`、`ctx.bot.*.send()`、`ctx.segment` 和 `ctx.markdown()`；需要查更完整的 QQ 官方能力时，再参考底层 SDK 文档。

常用入口：

- [快速开始](https://zhinjs.github.io/qq-official-bot/guide/start.html)：了解连接模式、`intents`、消息监听和服务模块。
- [群聊 API](https://zhinjs.github.io/qq-official-bot/api/group.html)：查询群消息、群成员、群管理等底层接口。
- [消息段](https://zhinjs.github.io/qq-official-bot/segment/)：查看文本、图片、At、Markdown、按钮等消息段写法。

## 插件依赖

插件如果需要额外 npm 包，建议在插件目录放自己的 `package.json`，不要把业务插件依赖加到 QingBot 根 `package.json`。

```json
{
  "name": "qingbot-plugin-example",
  "private": true,
  "dependencies": {
    "sharp": "^0.34.0"
  }
}
```

QingBot 会读取插件的 `dependencies`、`optionalDependencies` 和 `peerDependencies`：

- `dependencies`：运行必需依赖，缺失时插件不会加载。
- `peerDependencies`：默认按必需依赖检测；可用 `peerDependenciesMeta` 标记为可选。
- `optionalDependencies`：只在 Web 管理台提示，不阻止插件加载。
- `devDependencies`：用于插件开发，不参与运行时检测。

安装插件依赖：

```bash
npm install --prefix plugins/my-plugin
```

Web 管理台的插件页会显示依赖是否已满足，并在缺失时显示当前运行目录对应的安装命令。源码开发时通常是 `plugins/<name>`，编译运行时通常是 `dist/plugins/<name>`。QingBot 默认不会从 Web 管理台执行 npm 安装，避免把管理台变成远程命令入口。

## 最小插件

```ts
import { definePlugin } from 'qingbot'

type Config = {
  commands: string[]
  reply: string
}

export default definePlugin<Config>({
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
```

## 消息与命令

- `ctx.command(command | commands, handler, options)`：监听精确文本命令，默认会 `trim()` 并忽略大小写；`handler(event, matchedCommand, ctx)` 会拿到命中的原始命令。
- `ctx.config`：当前插件配置。
- `ctx.configPath` / `ctx.pluginDir`：当前插件配置文件和目录路径。
- `ctx.saveConfig(config)` / `ctx.updateConfig(patch)`：保存当前插件配置，并同步更新 `ctx.config`。
- `ctx.handle(eventName, handler)`：监听 QingBot 事件。
- `ctx.on(eventName, handler)`：`ctx.handle()` 的别名，命名更贴近 `qq-official-bot`。
- `ctx.getText(event)`：读取纯文本，通常配合 `ctx.command()` 之外的自定义解析。
- `event.reply(message)`：回复当前消息来源，QingBot 会携带官方被动回复需要的来源信息。
- `ctx.markdown(content)`：创建 Markdown 消息段。
- `ctx.replyMarkdown(event, content)`：用 Markdown 回复当前事件。

```ts
ctx.command(['#help', '#帮助'], async (event, command) => {
  await event.reply(`matched: ${command}`)
})

ctx.handle('message.group', async (event) => {
  if (ctx.getText(event).includes('hello')) await event.reply('hi')
})

ctx.command('#md', (event) => {
  return ctx.replyMarkdown(event, '**hello**')
})
```

## 主动发送

- `ctx.bot.group(id).send(message)`：发送群消息，`id` 会走根配置 `aliases.groups`。
- `ctx.bot.user(id).send(message)`：发送 QQ 单聊消息，`id` 会走根配置 `aliases.users`。
- `ctx.bot.channel(id).send(message)`：发送频道子频道消息。
- `ctx.bot.direct(guildId).send(message)`：发送频道私信。
- `ctx.bot.raw` / `ctx.bot.client`：底层 `qq-official-bot` 实例，用于 QingBot 没封装的 SDK 能力。

```ts
await ctx.bot.group('my-group').send('群通知')
await ctx.bot.user('admin').send('任务完成')
await ctx.bot.channel('123456').send('频道消息')
```

根配置里的 alias 用来把易读名字或旧 QQ 号映射到官方 `openid` / `group_openid`：

```json
{
  "aliases": {
    "users": { "admin": "USER_OPENID" },
    "groups": { "my-group": "GROUP_OPENID" }
  }
}
```

## 消息段

`ctx.segment` 是 `qq-official-bot` 的消息段工厂，常用段包括 `text`、`image`、`at`、`face`、`audio`、`video`、`markdown`、`button`、`reply`。

```ts
await event.reply([
  ctx.segment.at(event.user_id),
  ctx.segment.text(' 收到'),
])

await ctx.bot.group('my-group').send(ctx.segment.image('https://example.com/a.png'))
```

## 事件名

常用消息事件：

- `message`：所有消息事件，也会包含 SDK 的消息审核事件。
- `message.group` / `message.group.at`：群聊消息 / 群聊 @ 机器人消息。
- `message.private` / `message.private.friend` / `message.private.direct`：私聊消息、QQ 单聊、频道私信。
- `message.guild`：频道消息。
- `message.audit` / `message.audit.pass` / `message.audit.reject`：消息审核结果。

常用通知事件：

- `notice.friend.increase` / `notice.friend.decrease`：用户添加或删除机器人。
- `notice.friend.receive_open` / `notice.friend.receive_close`：QQ 单聊主动消息开关。
- `notice.group.increase` / `notice.group.decrease`：机器人被加入或移出群。
- `notice.group.member.increase` / `notice.group.member.decrease`：群成员进退，需订阅 `GROUP_MEMBER`。
- `notice.group.join_request`：入群申请事件，新版 SDK 支持；当前项目安装版 SDK 未必会发出。
- `notice.group.receive_open` / `notice.group.receive_close`：群主动消息开关。
- `notice.guild.*` / `notice.channel.*` / `notice.reaction.*` / `notice.forum.*`：频道、子频道、表态、论坛相关事件。

## 官方限制

- 群聊和 QQ 单聊事件通常需要订阅 `GROUP_AND_C2C_EVENT`。
- 群成员进退需要额外订阅 `GROUP_MEMBER`。
- 官方用户、群、频道 ID 是当前 Bot AppID 下的 openid，不同 Bot 之间不能通用。
- 被动回复有时间窗口：QQ 单聊约 60 分钟，群聊和频道约 5 分钟；超时后应改用主动发送接口。
- 同一事件可能重复推送，做扣费、签到、抽奖等插件时要按 `event_id`、`message_id`、`msg_seq` 去重。
- 主动消息有频控和每日上限，群推送插件应合并内容，避免刷屏。
- 富媒体消息依赖官方上传或 URL 转存；本地文件建议先通过 `ctx.bot.group(id).upload()` / `ctx.bot.user(id).upload()` 获取 `file_info`。

## 定时任务

```ts
export default definePlugin({
  name: 'daily-job',
  cron: [
    ['0 6 * * *', async (ctx) => {
      await ctx.bot.group('my-group').send('早上好')
    }],
  ],
})
```

本地生成的数据建议放在插件目录的 `data/` 或 `.state/` 中，这两个目录默认不会提交。
