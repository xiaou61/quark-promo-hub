# 夸克网盘推广聚合

一个自托管的网盘管理面板：**夸克 / UC / 百度**三平台统一界面，多用户注册，支持浏览、直链、分享。

TS 全栈：Node 原生 HTTP 后端（`server/`）+ React 前端（`web/`），零框架依赖，一个进程跑完。

> [!WARNING]
> 本项目通过各网盘**网页版内部接口**工作，非官方 API。可能随时因平台改动失效，也可能违反平台服务条款，账号风险自负。仅供个人学习与自用。

## 特性

- **三平台统一**：夸克、UC、百度，同一页面切换
- **多用户**：注册即用，账号/分享/分组按用户隔离
- **扫码登录**：三平台都支持（UC 的短信登录有滑块，未实现）
- **直链下载**：一键复制直链给 IDM/迅雷，或走服务端代理直接浏览器下载
- **文件管理**：浏览、新建文件夹、改名、删除
- **分享管理**：创建分享、分组归类、记录提取码（仅夸克）
- **MCP 服务**：`server/mcp.ts` 让 AI 直接操作网盘

## 运行

```bash
npm install
npm run dev      # 前端 5181（/api 代理到 5180），后端 5180
# 或
npm run build && npm start   # 单进程，全部在 5180
```

其他：`npm run typecheck`、`npm test`。

## 部署

```bash
npm install
npm run build
APP_SECRET=$(openssl rand -hex 32) npm start
```

默认监听 5180，用 `PORT` 改。生产环境建议交给 systemd / pm2 托管，参考 `scripts/quark-promo-hub.service`。

### 环境变量

放在项目根目录的 `.env`（systemd 用 `EnvironmentFile=` 加载），或直接注入环境变量：

- `APP_SECRET`（**强烈建议**）：会话签名密钥。不设则每次重启所有会话失效（但不会退化成不校验）。
- `ALLOW_REGISTER=0`：关闭注册，只允许已有用户登录。不设则默认开放注册。
- `APP_USER` + `APP_PASSWORD_HASH`：**旧单口令配置，仅用于迁移**。启动时若还没有任何用户，会用这对值建出第一个用户，之后一律走用户表。
- `PORT`：监听端口，默认 5180。

```bash
printf 'APP_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
```

> 注意：`data/` 里存的是**明文的网盘 cookie**，已在 `.gitignore` 排除。备份或迁移时按密钥对待。

## 用户与数据隔离

- 打开页面即可注册（用户名 2-32 字符，密码至少 6 位），密码用 scrypt 加盐存哈希
- 每个用户**只看到自己的网盘账号、分享、分组**，互相隔离
- 会话是签名 cookie（`uid.exp.sig`），30 天有效，退出后立即失效
- **第一个注册的用户会继承旧版单用户时代的数据**（那时没有 userId），之后注册的用户拿到的是空库

## 登录方式

夸克网盘**没有开放的个人账号 API**，第三方只能用网页版 cookie。登录步骤：

1. 浏览器打开 https://pan.quark.cn 并登录
2. F12 → Application/存储 → Cookies → `pan.quark.cn`
3. 复制成 `k1=v1; k2=v2` 形式，至少要含 `__puus`（旧版是 `__pus`）
4. 粘到页面顶部输入框点「登录」

cookie 会先用对应平台的接口校验，无效会直接报错，不会存进库。
验证通过后存到 `data/db.json`（权限 600），**是明文**，别把 `data/` 提交进仓库（已在 `.gitignore`）。

## 功能

- **平台**：夸克 / UC / 百度，同一页面切换，各自扫码或粘 Cookie 登录
- 多账号：添加、切换、移除（按用户隔离）
- 文件：浏览目录（面包屑）、新建文件夹、改名、删除（批量）、分页列表
- **直链下载**：文件行点「直链」复制下载地址
- 分享：对选中项创建分享链接（**仅夸克**），记录标题/链接/提取码，可复制、移除

## MCP（让 AI 操作网盘）

`server/mcp.ts` 是一个 stdio MCP 服务器，复用同一份 `data/db.json`，所以网页端扫码登录过的账号这里直接用。

```bash
node server/mcp.ts
```

在 ZCode / Claude Desktop 等客户端里配置：

```json
{
  "mcpServers": {
    "quark": {
      "command": "node",
      "args": ["/absolute/path/to/quark-promo-hub/server/mcp.ts"]
    }
  }
}
```

提供的工具：

| 工具 | 作用 |
|---|---|
| `quark_capacity` | 容量：总量/已用/会员类型 |
| `quark_list_files` | 列目录（含每个文件大小） |
| `quark_search` | 按文件名过滤 |
| `quark_create_folder` | 新建文件夹 |
| `quark_rename` | 改名 |
| `quark_delete` | 删除（进回收站） |
| `quark_create_share` | 创建分享 |
| `quark_list_shares` | 列出已记录分享与分组 |
| `quark_preview_share` | 预览别人分享的内容 |
| `quark_transfer` | 转存别人分享到自己网盘 |

注意：夸克不允许转存**自己**的分享，会返回 `用户禁止转存自己的分享`。

## 已知限制

- 走的是网页版内部接口，平台改接口时改对应文件：`server/quark.ts` / `server/uc.ts` / `server/baidu.ts`
- 删除是进回收站（`action_type: 2`），没有做永久删除
- 分享固定「有提取码 + 永久有效」，没有做有效期/免密选项，且**仅夸克支持**
- 创建分享 / 转存仅夸克支持；UC 和百度目前只有浏览 + 直链
- 目录大小递归统计仅夸克支持，其他平台显示「无法计算」
- 直链有时效（几小时），且 UC/百度的直链必须用下载器（带客户端 UA）打开，浏览器直接访问会 403
- 一个 cookie 对应一个登录态，多设备登录可能让旧 cookie 失效
- 没有找回密码功能，忘记密码需要管理员直接改 `data/db.json` 或删库重来
