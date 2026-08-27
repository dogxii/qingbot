# QingBot

轻量、快速、优雅的 QQ 官方机器人框架，使用 `AppID + AppSecret` 接入

## 启动

环境要求：Node.js 20+，npm。

```bash
npm install
npm run init
npm run dev
```

`npm run init` 会交互式创建或更新根目录的 `config.json`，可填写 QQ 官方机器人的 `appID`、`appSecret`、插件列表、管理员 ID 和 Web 管理台 token。`config.json` 默认不提交，避免把密钥带进 Git。首次使用建议至少填写一个 `ownerIds` 或 `adminIds`。

编译运行：

```bash
npm run build
npm start
```

## 配置

QingBot 读取根目录的 `config.json`，仓库里的 `config.example.json` 是模板：

```json
{
  "appID": "YOUR_QQ_BOT_APP_ID",
  "appSecret": "YOUR_QQ_BOT_APP_SECRET",
  "sandbox": false,
  "botName": "QingBot",
  "debug": false,
  "removeAt": true,
  "plugins": ["ping"],
  "web": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 3300,
    "token": ""
  },
  "ownerIds": [],
  "adminIds": [],
  "allowPublicControl": false,
  "aliases": {
    "users": {},
    "groups": {}
  },
  "legacyIdMode": "alias",
  "intents": ["GROUP_AND_C2C_EVENT"]
}
```

常用项：

- `ownerIds` / `adminIds`：管理命令权限。
- `allowPublicControl`：没有管理员时是否允许公开控制，默认 `false`；仅建议在完全隔离的本地测试环境临时设为 `true`。
- `plugins`：启用插件，数组项是插件目录名。
- `pluginDir`：插件目录，默认 `plugins`，可指向外部私有插件目录。
- `web.token`：Web 管理台访问令牌；未设置时 API 只接受本机访问。
- `aliases`：旧 QQ 号到官方 `openid` / `group_openid` 的映射。

高级接入项按需配置：`logLevel`、`accessTokenUrl`、`gatewayUrl`、`timeout`、`maxRetry`、`heartbeatInterval`、`maxRetries`、`reconnectDelay`。通常不需要改。

已有 `config.json` 时再次运行 `npm run init` 会以当前配置作为默认值，按回车即可保留。可选本地覆盖文件：`config.local.json`。它会合并覆盖根 `config.json`，适合放本机密钥或个人调试项。

## 命令

聊天里可用：

```text
ping
#菜单
#帮助
#插件 列表
#插件 启用 插件名
#插件 禁用 插件名
#状态
#重载
#插件 重载
#插件 重载 ping
#关机
```

`#菜单` / `#帮助` 是内置菜单；`#插件 列表` 会显示插件目录下所有插件，包括尚未启用的插件。
`#插件 启用 插件名` / `#插件 禁用 插件名` 会写入提供 `plugins` 数组的配置文件：如果 `config.local.json` 覆盖了插件列表就写它，否则写根 `config.json`。

改插件代码后用 `#插件 重载 插件名`；改 `config.json` 或插件配置后用 `#重载`。
改 `appID`、`appSecret`、`sandbox`、`intents`、QQ 连接高级项、`web.enabled`、`web.host`、`web.port` 后需要重启进程。

## 管理台

启动后打开：

```text
http://127.0.0.1:3300
```

可查看状态、启用/禁用/重载插件、编辑配置、查看收发消息、手动发送消息、模拟插件对话、重载配置和关闭进程。

配置页可以管理：

- `config.json`：主配置。
- `config.local.json`：本地覆盖配置。
- `plugins/<name>/config.json`：插件配置。

点击“保存”只写入文件；点击“保存并重载”会保存后执行一次配置重载。`web.token` 保存并重载后会用于后续 Web API；监听地址、端口和 QQ 协议连接参数仍需重启进程。

公网部署最佳实践：

- 默认保持 `web.host` 为 `127.0.0.1`，用 SSH 隧道、内网 VPN、Tailscale 或 Cloudflare Zero Trust 访问。
- 不要把未设置 `web.token` 的管理台通过 Nginx/Caddy 等反代暴露到公网。
- 如果必须公网访问，设置足够长的随机 `web.token`，反代只走 HTTPS，并额外加访问控制或 IP 白名单。
- 防火墙不要放开 `3300` 直连端口；让管理台只被受控入口访问。
- 安全问题和凭据泄露处理见 [`SECURITY.md`](SECURITY.md)。

本地检查：

```bash
npm run check
npm audit
```

## 插件

默认只带 `ping` 这个最小演示插件。自己的插件放在插件目录中，并用 `#插件 启用 插件名` 或根配置 `plugins` 数组启用。插件如需释放定时器、连接等资源，可实现 `dispose(ctx)`。

插件可以有自己的配置文件：

```text
plugins/my-plugin/config.json
```

插件如果需要额外 npm 包，可以在插件目录放自己的 `package.json` 并单独安装：

```bash
npm install --prefix plugins/my-plugin
```

QingBot 会在启动和管理台插件页检测插件依赖；必需依赖缺失时不会加载该插件，并会提示缺失包和当前运行目录对应的安装命令。`npm run dev` 使用 `plugins/<name>`，`npm start` 使用编译后的 `dist/plugins/<name>`，按提示命令安装即可。

插件内直接读取当前插件配置：

```ts
import { definePlugin } from 'qingbot'

type MyConfig = {
  enabled: boolean
  prefix: string
}

export default definePlugin<MyConfig>({
  name: 'my-plugin',
  setup(ctx) {
    const config = ctx.getConfig<MyConfig>({
      enabled: true,
      prefix: '#my',
    })

    ctx.command(`${config.prefix} ping`, async (event) => {
      if (config.enabled) await event.reply('pong')
    })
  },
})
```

可用配置 API：

- `ctx.config`：当前插件的 `config.json` 内容。
- `ctx.getConfig<T>(fallback)`：合并默认值后的当前插件配置。
- `ctx.configPath` / `ctx.pluginDir`：当前插件配置文件和目录路径。
- `ctx.saveConfig(config)` / `ctx.updateConfig(patch)`：保存当前插件配置，并同步更新 `ctx.config`。
- `ctx.rootConfig`：根目录 `config.json` 的机器人配置。
- `ctx.command(command, fn)`：监听精确文本命令，默认忽略大小写并去掉首尾空白。
- `ctx.handle(event, fn)` / `ctx.on(event, fn)`：监听消息、通知等事件。
- `ctx.segment`：QQ 官方消息段工厂。
- `ctx.markdown(content)` / `ctx.replyMarkdown(event, content)`：创建或回复 Markdown 消息。
- `ctx.bot.group(id).send(message)` / `ctx.bot.user(id).send(message)`：主动发送消息，自动应用 ID alias。

本地生成的数据建议放在插件目录的 `data/` 或 `.state/` 中，这两个目录默认不会提交。

更多事件名、消息段和主动发送示例见 `plugins/README.md`。

## 许可

ISC
