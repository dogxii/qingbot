# QingBot

轻量、快速、优雅的 QQ 官方机器人框架，使用 `AppID + AppSecret` 接入

## 启动

```bash
npm install
cp .env.example .env
npm run dev
```

编译运行：

```bash
npm run build
npm start
```

## 配置

推荐只用 `.env`：

```env
QQ_APP_ID=
QQ_APP_SECRET=
QQ_SANDBOX=false
QINGBOT_INTENTS=GROUP_AND_C2C_EVENT
QINGBOT_PLUGINS=ping
QINGBOT_PLUGIN_DIR=plugins
QINGBOT_WEB_ENABLED=true
QINGBOT_WEB_PORT=3300
```

常用项：

- `QINGBOT_OWNER_IDS` / `QINGBOT_ADMIN_IDS`：管理命令权限。
- `QINGBOT_ALLOW_PUBLIC_CONTROL`：没有管理员时是否允许公开控制，测试期可用 `true`。
- `QINGBOT_PLUGINS`：启用插件，多个插件用英文逗号分隔。
- `QINGBOT_PLUGIN_DIR`：插件目录，默认 `plugins`，可指向外部私有插件目录。
- `QINGBOT_WEB_TOKEN`：Web 管理台访问令牌；未设置时 API 只接受本机访问。

`qingbot.config.json` 是可选补充，主要用于旧 QQ 号到官方 `openid` 的映射。

## 命令

聊天里可用：

```text
ping
#插件列表
#重载配置
#重载插件
#重载插件 ping
#关机
```

改插件代码后用 `#重载插件 <名称>`；改 `.env` 后用 `#重载配置`。  
改 `QQ_APP_ID`、`QQ_APP_SECRET`、`QQ_SANDBOX`、`QINGBOT_INTENTS` 后需要重启进程。

## 管理台

启动后打开：

```text
http://127.0.0.1:3300
```

可查看状态、加载/卸载/重载插件、重载配置和关闭进程。

## 插件

默认只带一个 `ping` 示例插件。自己的插件放在插件目录中，在 `.env` 的 `QINGBOT_PLUGINS` 中启用。

`.env` 和本地插件默认不提交，上传 GitHub 前请保持密钥只在本地。
