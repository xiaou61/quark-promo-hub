import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import qrcode from "qrcode-generator";
import { safeJoin } from "./paths.ts";
import {
  clearCookieHeader,
  cookieHeader,
  hashPassword,
  login,
  makeToken,
  migrateLegacyUser,
  newSalt,
  userIdFrom,
} from "./auth.ts";
import * as store from "./store.ts";
import * as dircache from "./dircache.ts";
import * as quark from "./quark.ts";
import * as uc from "./uc.ts";
import * as baidu from "./baidu.ts";
import * as resourceClaim from "./resource.ts";
import type { Platform, Resource, Share } from "../shared/types.ts";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "web", "dist");
const PORT = Number(process.env.PORT ?? 5180);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `缺少 ${field}`);
  return v.trim();
}

function fids(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, "缺少 fids");
  const list = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (!list.length) throw new HttpError(400, "fids 无效");
  return list;
}

// 三个平台的接口形状不同（夸克/UC 用 fid，百度用路径），这里抹平差异，
// 路由层只跟这一组函数打交道。百度没有文件夹大小接口，size 直接给 0。
const adapters = {
  quark: {
    whoami: quark.whoami,
    capacity: quark.capacity,
    listFiles: quark.listFiles,
    createFolder: quark.createFolder,
    deleteFiles: quark.deleteFiles,
    renameFile: quark.renameFile,
    downloadUrl: quark.downloadUrl,
    downloadHeaders: quark.downloadHeaders,
  },
  uc: {
    whoami: uc.whoami,
    capacity: uc.capacity,
    listFiles: uc.listFiles,
    createFolder: uc.createFolder,
    deleteFiles: uc.deleteFiles,
    renameFile: uc.renameFile,
    downloadUrl: uc.downloadUrl,
    downloadHeaders: uc.downloadHeaders,
  },
  baidu: {
    whoami: baidu.whoami,
    capacity: baidu.capacity,
    listFiles: baidu.listFiles,
    createFolder: baidu.createFolder,
    deleteFiles: baidu.deleteFiles,
    renameFile: baidu.renameFile,
    downloadUrl: baidu.downloadUrl,
    downloadHeaders: baidu.downloadHeaders,
  },
} as const;

function adapterFor(platform: Platform) {
  return adapters[platform] ?? adapters.quark;
}

async function activeRow(userId: string) {
  const row = await store.getActive(userId);
  if (!row) throw new HttpError(401, "还没有登录网盘账号");
  return row;
}

async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  const parts = path.split("/").filter(Boolean);

  // 是否开放注册：没人时一定开放（首个用户），之后看 ALLOW_REGISTER（默认开）
  const allowRegister = process.env.ALLOW_REGISTER !== "0";

  if (method === "GET" && path === "/api/auth") {
    const uid = userIdFrom(req);
    const me = uid ? await store.getUser(uid) : null;
    return send(res, 200, {
      required: true,
      ok: Boolean(me),
      user: me ? store.publicUser(me) : null,
      canRegister: allowRegister || (await store.countUsers()) === 0,
    });
  }

  if (method === "POST" && path === "/api/register") {
    const users = await store.countUsers();
    if (users > 0 && !allowRegister) throw new HttpError(403, "已关闭注册，请联系管理员");
    const b = await body(req);
    const username = str(b.username, "username");
    const password = str(b.password, "password");
    if (username.length < 2 || username.length > 32) throw new HttpError(400, "用户名长度需在 2-32 之间");
    if (password.length < 6) throw new HttpError(400, "密码至少 6 位");
    if (await store.findUserByName(username)) throw new HttpError(409, "用户名已被占用");

    const salt = newSalt();
    const user = await store.createUser(username, salt, hashPassword(password, salt));
    // 第一个用户继承旧版单用户时代的数据
    if (users === 0) await store.claimLegacy(user.id);
    res.setHeader("set-cookie", cookieHeader(makeToken(user.id)));
    return send(res, 200, { ok: true, user: store.publicUser(user) });
  }

  if (method === "POST" && path === "/api/login") {
    const b = await body(req);
    const username = str(b.username, "username");
    const password = str(b.password, "password");
    const token = await login(username, password);
    if (!token) throw new HttpError(401, "用户名或密码错误");
    res.setHeader("set-cookie", cookieHeader(token));
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/logout") {
    res.setHeader("set-cookie", clearCookieHeader());
    return send(res, 200, { ok: true });
  }

  // 下面的接口都要登录，且只作用于当前用户的数据
  const userId = userIdFrom(req);
  if (path.startsWith("/api/") && !userId) throw new HttpError(401, "需要登录");
  const me = userId ? await store.getUser(userId) : null;
  if (path.startsWith("/api/") && !me) throw new HttpError(401, "登录已失效，请重新登录");

  if (method === "GET" && path === "/api/session") {
    const row = await store.getActive(me!.id);
    return send(res, 200, {
      user: store.publicUser(me!),
      accounts: await store.listAccounts(me!.id),
      activeId: row?.account.id ?? null,
    });
  }

  if (method === "POST" && path === "/api/accounts") {
    const b = await body(req);
    // 扫码登录拿到的是 cookie，手动粘贴也是 cookie，两条路共用
    const cookie = str(b.cookie, "cookie");
    const platform = (typeof b.platform === "string" && b.platform) || "quark";
    if (!(platform in adapters)) throw new HttpError(400, `不支持的平台：${platform}`);
    const nickname =
      typeof b.nickname === "string" && b.nickname.trim()
        ? b.nickname.trim()
        : await adapterFor(platform as Platform).whoami(cookie);
    return send(res, 200, await store.addAccount(me!.id, nickname, cookie, platform as Platform));
  }

  if (method === "POST" && path === "/api/scan/start") {
    const b = await body(req);
    const platform = (typeof b.platform === "string" && b.platform) || "quark";
    if (!(platform in adapters)) throw new HttpError(400, `不支持的平台：${platform}`);

    // 百度直接给二维码图片，夸克/UC 给需要自己渲染的字符串
    if (platform === "baidu") {
      const { scanId, img } = await baidu.startScan();
      return send(res, 200, { scanId, platform, img });
    }
    const mod = platform === "uc" ? uc : quark;
    const { scanId, content } = await mod.startScan();
    const svg = qrcode(0, "M");
    svg.addData(content);
    svg.make();
    // cellSize 取 6 让 SVG 原生尺寸接近显示尺寸，缩小倍数越小边缘越实；
    // 再叠 crispEdges 关掉抗锯齿，否则密模块会被糊成灰色。
    return send(res, 200, {
      scanId,
      platform,
      qr: svg.createSvgTag({ cellSize: 6, margin: 1, scalable: true }),
    });
  }

  if (method === "GET" && path === "/api/folder-size") {
    const row = (await store.getActive(me!.id))!;
    const fid = url.searchParams.get("fid") || "";
    if (!fid) throw new HttpError(400, "缺少 fid");
    // 递归算目录大小目前只有夸克实现了；其他平台直接返回不可用
    if (row.account.platform !== "quark") {
      return send(res, 200, { status: "error", size: 0, files: 0, dirs: 0, updatedAt: Date.now() });
    }
    // 已有结果直接返回，否则触发后台计算（不阻塞）
    const state = (await dircache.peek(row.account.id, fid)) ?? (await dircache.start(row.account.id, fid, row.cookie));
    return send(res, 200, state);
  }

  if (method === "GET" && path === "/api/capacity") {
    const row = await activeRow(me!.id);
    return send(res, 200, await adapterFor(row.account.platform).capacity(row.cookie));
  }

  if (method === "GET" && path === "/api/groups") {
    return send(res, 200, await store.listGroups(me!.id));
  }

  if (method === "POST" && path === "/api/groups") {
    return send(res, 200, await store.addGroup(me!.id, str((await body(req)).name, "name")));
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "groups" && parts[2]) {
    const ok = await store.removeGroup(me!.id, parts[2]);
    if (!ok) throw new HttpError(404, "分组不存在");
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "shares" && parts[2] && parts[3] === "group") {
    const b = await body(req);
    const gid = typeof b.groupId === "string" && b.groupId ? b.groupId : null;
    const ok = await store.assignShareGroup(me!.id, parts[2], gid);
    if (!ok) throw new HttpError(404, "分享或分组不存在");
    return send(res, 200, { ok: true });
  }

  // 转存别人分享到自己网盘：先取 stoken，再列出内容，最后 save
  if (method === "POST" && path === "/api/transfer") {
    const row = await activeRow(me!.id);
    if (row.account.platform !== "quark") {
      throw new HttpError(400, "转存目前只支持夸克网盘");
    }
    const cookie = row.cookie;
    const b = await body(req);
    const { pwdId, passcode: urlPwd } = quark.parseShareUrl(str(b.url, "url"));
    const passcode = (typeof b.passcode === "string" && b.passcode) || urlPwd;
    const stoken = await quark.shareToken(cookie, pwdId, passcode);

    if (b.preview === true) {
      const { list } = await quark.listShare(cookie, pwdId, stoken, "0");
      return send(res, 200, { pwdId, stoken, items: list });
    }

    const { raw } = await quark.listShare(cookie, pwdId, stoken, "0");
    if (!raw.length) throw new HttpError(400, "分享内容为空");
    const fidList = raw.map((f) => String(f.fid));
    const tokenList = raw.map((f) => String(f.share_fid_token));
    await quark.saveShare(cookie, pwdId, stoken, fidList, tokenList, (b.to as string) || "0");
    return send(res, 200, { ok: true, count: fidList.length });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "scan" && parts[2] === "poll" && parts[3]) {
    const platform = url.searchParams.get("platform") || "quark";
    const mod = platform === "uc" ? uc : platform === "baidu" ? baidu : quark;
    const result = await mod.pollScan(parts[3]);
    if (result.cookie) {
      const account = await store.addAccount(
        me!.id,
        result.nickname ?? "网盘用户",
        result.cookie,
        platform as Platform,
      );
      return send(res, 200, { state: "done", account });
    }
    return send(res, 200, { state: result.state });
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "accounts" && parts[2]) {
    const ok = await store.removeAccount(me!.id, parts[2]);
    if (!ok) throw new HttpError(404, "账号不存在");
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "accounts" && parts[3] === "active") {
    const ok = await store.setActive(me!.id, parts[2]);
    if (!ok) throw new HttpError(404, "账号不存在");
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/files") {
    const row = await activeRow(me!.id);
    const pdir = url.searchParams.get("pdir") || "0";
    const page = Number(url.searchParams.get("page") ?? 1);
    const size = Math.min(Number(url.searchParams.get("size") ?? 50), 100);
    const data = await adapterFor(row.account.platform).listFiles(row.cookie, pdir, page, size);
    return send(res, 200, {
      total: data.total,
      items: data.list.map((f) => ({
        // 百度没有 fid，用 path 当 id；夸克/UC 用 fid
        fid: "fs_id" in f ? f.path : f.fid,
        name: "server_filename" in f ? f.server_filename : f.file_name,
        isDir: "isdir" in f ? f.isdir === 1 : f.dir,
        size: f.size,
        updatedAt: "server_mtime" in f ? f.server_mtime * 1000 : f.updated_at,
      })),
    });
  }

  // 拿直链：前端拿去丢给下载器，或直接在新标签打开
  if (method === "POST" && path === "/api/download") {
    const row = await activeRow(me!.id);
    const b = await body(req);
    const url2 = await adapterFor(row.account.platform).downloadUrl(row.cookie, str(b.fid, "fid"));
    return send(res, 200, { url: url2 });
  }

  // 浏览器直下：直链本身要带登录 cookie 才不 403，但 cookie 在服务端，
  // 浏览器拿不到。这里代为请求并转发字节流。
  // shortcut: 服务器带宽是瓶颈，大文件会很慢，能用下载器就别走这里。
  if (method === "GET" && path === "/api/download/stream") {
    const row = await activeRow(me!.id);
    const fid = url.searchParams.get("fid") || "";
    if (!fid) throw new HttpError(400, "缺少 fid");
    const name = url.searchParams.get("name") || "download";
    const target = await adapterFor(row.account.platform).downloadUrl(row.cookie, fid);
    const headers = await adapterFor(row.account.platform).downloadHeaders(row.cookie);

    // 透传 Range，浏览器才能断点续传/拖动进度条
    const range = req.headers.range;
    const upstream = await fetch(target, { headers: range ? { ...headers, range } : headers });
    if (!upstream.ok && upstream.status !== 206) {
      throw new HttpError(502, `网盘拒绝了下载（HTTP ${upstream.status}）`);
    }

    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      ...(upstream.headers.get("content-length")
        ? { "content-length": upstream.headers.get("content-length")! }
        : {}),
      ...(upstream.headers.get("content-range")
        ? { "content-range": upstream.headers.get("content-range")! }
        : {}),
      "accept-ranges": "bytes",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    // 浏览器断开时把上游也取消，别让下载在后台空转
    res.on("close", () => void upstream.body?.cancel().catch(() => {}));
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
    return;
  }

  if (method === "POST" && path === "/api/folder") {
    const row = await activeRow(me!.id);
    const b = await body(req);
    await adapterFor(row.account.platform).createFolder(
      row.cookie,
      (b.pdir as string) || "0",
      str(b.name, "name"),
    );
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/delete") {
    const row = await activeRow(me!.id);
    await adapterFor(row.account.platform).deleteFiles(row.cookie, fids((await body(req)).fids));
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/rename") {
    const row = await activeRow(me!.id);
    const b = await body(req);
    await adapterFor(row.account.platform).renameFile(row.cookie, str(b.fid, "fid"), str(b.name, "name"));
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/shares") {
    const row = await store.getActive(me!.id);
    if (!row) throw new HttpError(401, "还没有登录网盘账号");
    return send(res, 200, await store.listShares(me!.id));
  }

  if (method === "POST" && path === "/api/shares") {
    const row = await activeRow(me!.id);
    // 创建分享目前只实现了夸克，其他平台先明确拒绝，别让前端以为成功了
    if (row.account.platform !== "quark") {
      throw new HttpError(400, "当前账号所在平台还不支持创建分享，请切换到夸克账号");
    }
    const b = await body(req);
    const list = fids(b.fids);
    const title = (typeof b.title === "string" && b.title.trim()) || "夸克分享";
    const created = await quark.createShare(row.cookie, list, title);
    const share: Share = {
      id: randomUUID(),
      userId: me!.id,
      accountId: row.account.id,
      shareId: created.shareId,
      title,
      url: created.url,
      passcode: created.passcode,
      fids: list,
      createdAt: new Date().toISOString(),
      groupId: typeof b.groupId === "string" && b.groupId ? b.groupId : null,
    };
    await store.addShare(share);
    return send(res, 200, share);
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "shares" && parts[2]) {
    const ok = await store.removeShare(me!.id, parts[2]);
    if (!ok) throw new HttpError(404, "分享记录不存在");
    return send(res, 200, { ok: true });
  }

  // ---- 资源站 ----
  if (method === "GET" && path === "/api/resources") {
    return send(res, 200, await store.listResources(me!.id));
  }

  if (method === "POST" && path === "/api/resources") {
    const b = await body(req);
    const row = await activeRow(me!.id);
    const now = new Date().toISOString();
    const resource: Resource = {
      id: randomUUID(),
      userId: me!.id,
      title: str(b.title, "title"),
      description: typeof b.description === "string" ? b.description : "",
      sourceUrl: str(b.sourceUrl, "sourceUrl"),
      sourcePasscode: typeof b.sourcePasscode === "string" ? b.sourcePasscode : "",
      platform: row.account.platform,
      toPdir: (b.toPdir as string) || "0",
      ownUrl: null,
      ownPasscode: null,
      ownFids: null,
      status: "pending",
      error: null,
      hits: 0,
      createdAt: now,
      updatedAt: now,
    };
    // 先校验链接能不能解析，别把错的存进库
    quark.parseShareUrl(resource.sourceUrl);
    return send(res, 200, await store.addResource(resource));
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "resources" && parts[2]) {
    const ok = await store.removeResource(me!.id, parts[2]);
    if (!ok) throw new HttpError(404, "资源不存在");
    return send(res, 200, { ok: true });
  }

  // 用户点「获取」：没有自己的链接就先转存+建分享，然后返回
  if (method === "POST" && parts[0] === "api" && parts[1] === "resources" && parts[2] && parts[3] === "claim") {
    const resource = await store.getResource(me!.id, parts[2]);
    if (!resource) throw new HttpError(404, "资源不存在");
    if (resource.ownUrl) {
      await store.updateResource(me!.id, resource.id, { hits: resource.hits + 1 });
      return send(res, 200, { url: resource.ownUrl, passcode: resource.ownPasscode ?? "" });
    }
    const row = await activeRow(me!.id);
    const done = await resourceClaim.claimAndSave(me!.id, row.cookie, resource);
    if (done.status === "failed") throw new HttpError(502, done.error || "转存失败");
    await store.updateResource(me!.id, done.id, { hits: done.hits + 1 });
    return send(res, 200, { url: done.ownUrl, passcode: done.ownPasscode ?? "" });
  }

  if (path.startsWith("/api/")) throw new HttpError(404, "接口不存在");
  return serveStatic(res, path);
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const target = safeJoin(DIST, path);
  if (!target) throw new HttpError(403, "禁止访问");
  try {
    const info = await stat(target);
    if (info.isFile()) return sendFile(res, target, info.size);
  } catch {
    // 落到 index.html，交给前端路由
  }
  try {
    const info = await stat(join(DIST, "index.html"));
    return sendFile(res, join(DIST, "index.html"), info.size);
  } catch {
    throw new HttpError(404, "前端还没构建，先跑 npm run build");
  }
}

async function sendFile(res: ServerResponse, file: string, size: number): Promise<void> {
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": "no-cache",
  });
  res.end(await readFile(file));
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

// 旧单口令部署迁成用户表，只在实际需要时才动库
await migrateLegacyUser();

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  handle(req, res, url).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 502;
    const message = err instanceof Error ? err.message : "未知错误";
    if (!res.headersSent) send(res, status, { error: message });
  });
}).listen(PORT, () => {
  console.log(`夸克网盘推广聚合 → http://localhost:${PORT}`);
});
