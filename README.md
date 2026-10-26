# 网盘推广聚合

自托管的网盘管理面板：**夸克 / UC / 百度**三平台统一界面，多用户注册，支持浏览、直链下载、分享，以及**资源站自动转存**。

Node 原生 HTTP 后端 + React 前端，零框架依赖，一个进程跑完。

> [!WARNING]
> 通过各网盘**网页版内部接口**工作，非官方 API。可能随时因平台改动失效，也可能违反平台服务条款，账号风险自负。仅供个人学习与自用。

## 它解决什么问题

做网盘推广/资源分享的人，日常是：在同行那里看到好资源 → 转存到自己网盘 → 再生成自己的分享链接分发。网页上来回点十几下，每来一个新资源都要重做一遍。

这个项目把它压缩成：**登记一条别人的链接 → 点一次「获取」→ 拿到自己的分享链接**。首次获取自动完成「转存 + 建分享」，之后所有人拿到同一条链接，不再重复占容量。同样的能力也做成了 MCP 工具，可以让 AI 批量收集整理。

## 功能矩阵

| 功能 | 夸克 | UC | 百度 |
|---|---|---|---|
| 扫码登录 | ✅ | ✅ | ✅ |
| 浏览文件 / 新建 / 改名 / 删除 | ✅ | ✅ | ✅ |
| 容量显示 | ✅ | ✅ | ✅ |
| 直链获取 | ✅ | ✅ | ✅ |
| 浏览器代理下载 | ✅ | ✅ | ✅ |
| 创建分享 | ✅ | ✅ | ✅ |
| 转存别人分享 | ✅ | ✅ | ✅ |
| **资源站（自动转存+重分享）** | ✅ | ✅ | ✅ |
| 目录大小递归统计 | ✅ | ✅ | ✅ |

三家接口差异很大，适配代码分别在 `server/quark.ts` / `uc.ts` / `baidu.ts`：

- **夸克 / UC** 同构：`sharepage/token` → `detail` → `save`，用 `pwd_id` 定位分享
- **百度** 不同：链接是 `surl`（要先去开头的 `1`），读分享要先从分享页 HTML 抠出 `shareid`/`share_uk`，转存走 `/share/transfer`，建分享走 `/share/set` 且要 `sign`+`timestamp`+`bdstoken` 三件套

## 运行

```bash
npm install
npm run dev                    # 前端 5181（/api 代理到 5180），后端 5180
npm run build && npm start     # 或单进程，全部在 5180
npm run typecheck && npm test
```

### 环境变量

放在项目根目录 `.env`，或直接注入环境变量：

| 变量 | 说明 |
|---|---|
| `APP_SECRET` | **强烈建议**。会话签名密钥，不设则每次重启所有会话失效（但不会退化成不校验） |
| `ALLOW_REGISTER=0` | 关闭注册，只允许已有用户登录。不设则默认开放 |
| `PORT` | 监听端口，默认 5180 |
| `APP_USER` + `APP_PASSWORD_HASH` | 旧单口令配置，**仅用于迁移**。启动时若还没有用户，会用这对值建出第一个用户 |

```bash
printf 'APP_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
```

生产部署参考 `scripts/quark-promo-hub.service`（systemd）。

## 多用户

打开页面即可注册（用户名 2-32 字符，密码至少 6 位），密码用 scrypt 加盐存哈希。每个用户只看到自己的网盘账号、分享、分组和资源，互相隔离。会话是签名 cookie，30 天有效。

第一个注册的用户会继承旧版单用户时代的数据（那时没有 userId）。

> `data/` 里存的是**明文网盘 cookie**，已在 `.gitignore` 排除。备份或迁移时按密钥对待。

## 资源站是怎么工作的

登记一条资源后，第一次有人「获取」时服务端按顺序做：

1. 解析分享链接，取出 `pwd_id` 和提取码
2. 用你的登录态换 `stoken`
3. 列出分享里的文件
4. 转存到你指定的目录（`toPdir`，默认根目录）
5. **按文件名回查目标目录，拿到转存后的新 fid** —— 转存接口不返回 fid，但建分享必须用自己网盘里的 fid
6. 用新 fid 建一条你的分享，链接和提取码写回资源记录

之后再有人获取，直接返回第 6 步缓存的链接，不再转存、不再占容量。失败会记录原因，不会静默吞掉。

## MCP（让 AI 操作网盘）

`server/mcp.ts` 是 stdio MCP 服务器，复用同一份 `data/db.json`，网页端登录过的账号这里直接用。

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

工具共 23 个，**全部支持夸克 / UC / 百度**（工具名沿用 `quark_` 前缀是历史原因，底层走平台适配层）：

| 分组 | 工具 |
|---|---|
| 网盘 | `quark_capacity`、`quark_list_files`、`quark_search`、`quark_create_folder`、`quark_rename`、`quark_delete`、`quark_download_link`、`quark_folder_size` |
| 分享 | `quark_create_share`、`quark_list_shares`、`quark_preview_share`、`quark_transfer` |
| 账号 | `account_list`、`account_switch`、`account_remove` |
| 分组 | `share_group_create`、`share_group_delete`、`share_assign_group`、`share_remove` |
| 资源站 | `resource_list`、`resource_add`、`resource_claim`、`resource_remove` |

典型用法：让 AI 把一批同行链接丢进 `resource_add`，逐个 `resource_claim`，最后用 `resource_list` 汇总出自己的分享链接清单。

注意：`fid` 在百度下就是完整路径（如 `/我的课程`），因为百度没有 fid 概念。

## 已知限制

- 走网页版内部接口，平台改接口时改对应文件：`server/quark.ts` / `server/uc.ts` / `server/baidu.ts`
- 目录大小递归统计要发几千次请求，只适合后台跑（已做缓存）
- 删除是进回收站，没有永久删除
- 分享固定「有提取码 + 永久有效」，没有有效期/免密选项
- 直链有时效（几小时），UC/百度的直链必须用下载器或走代理，浏览器直接开会 403
- 代理下载会占用服务器带宽，大文件建议用直链
- 转存按**文件名**回查新 fid，目标目录若有同名文件可能匹配错，建议每条资源用独立目录
- 没有找回密码功能
- 一个 cookie 对应一个登录态，多设备登录可能让旧 cookie 失效

## License

MIT
