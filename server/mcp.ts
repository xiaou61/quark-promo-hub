#!/usr/bin/env node
// MCP 服务器：通过 stdio 把网盘操作暴露给 AI。
// 复用同一份 server/*.ts 与本地 db，所以 Web 端登录过的账号这里直接可用。
//
// 工具名沿用 quark_* 前缀（历史原因），但底层走平台适配层，夸克/UC/百度都支持。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.ts";
import * as quark from "./quark.ts";
import * as uc from "./uc.ts";
import * as baidu from "./baidu.ts";
import * as dircache from "./dircache.ts";
import * as resourceClaim from "./resource.ts";
import { PLATFORM_NAMES, type Platform, type Resource } from "../shared/types.ts";

const server = new McpServer({ name: "quark-promo-hub", version: "0.1.0" });

// ---- 平台适配 ----
// 和 server/index.ts 的 adapters 保持一致：路由层只跟这一组函数打交道。

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
    createShare: quark.createShare,
    shareToken: quark.shareToken,
    listShare: quark.listShare,
    saveShare: quark.saveShare,
    parseShareUrl: quark.parseShareUrl,
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
    createShare: uc.createShare,
    shareToken: uc.shareToken,
    listShare: uc.listShare,
    saveShare: uc.saveShare,
    parseShareUrl: uc.parseShareUrl,
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
    createShare: baidu.createShare,
    shareToken: baidu.shareToken,
    listShare: baidu.listShare,
    saveShare: baidu.saveShare,
    parseShareUrl: baidu.parseShareUrl,
  },
} as const;

/** 当前账号。MCP 是本地单机工具，固定取第一个账号。 */
async function account() {
  const row = await store.getActiveAny();
  if (!row) throw new Error("还没有登录网盘账号，请先在网页端扫码登录");
  return row;
}

const api = async () => adapters[(await account()).account.platform] ?? adapters.quark;

async function cookie(): Promise<string> {
  return (await account()).cookie;
}

/** MCP 是本地单机工具，固定用第一个账号所属用户。 */
async function uid(): Promise<string> {
  const row = await store.getActiveAny();
  if (!row?.account.userId) throw new Error("还没有登录网盘账号，请先在网页端扫码登录");
  return row.account.userId;
}

/** 百度用路径当 id，夸克/UC 用 fid。工具入参统一叫 fid，这里转换。 */
async function listDir(pdir: string) {
  const a = await api();
  return a.listFiles(await cookie(), pdir || "0", 1, 100);
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

// 把异常收成 MCP 错误结果，避免整个进程挂掉
const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

// 百度返回 server_filename/isdir，夸克/UC 返回 file_name/dir。统一成一种形状。
function normalize(f: Record<string, unknown>) {
  return {
    fid: "fs_id" in f ? String(f.path) : String(f.fid),
    name: "server_filename" in f ? String(f.server_filename) : String(f.file_name),
    isDir: "isdir" in f ? f.isdir === 1 : Boolean(f.dir),
    size: Number(f.size ?? 0),
  };
}

const platformNote = async () =>
  `当前平台：${PLATFORM_NAMES[(await account()).account.platform]}`;

// ---- 网盘操作 ----

server.tool(
  "quark_capacity",
  "查看网盘容量：总量、已用、会员类型。支持夸克/UC/百度",
  {},
  wrap(async () => {
    const a = await api();
    return { platform: (await platformNote()), ...(await a.capacity(await cookie())) };
  }),
);

server.tool(
  "quark_list_files",
  "列出某个目录下的文件。pdir 为目录 fid，根目录用 0（百度用路径如 / 或 /子目录）",
  { pdir: z.string().optional().describe("目录 fid 或路径，默认根目录") },
  wrap(async ({ pdir }: { pdir?: string }) => {
    const { list, total } = await listDir(pdir || "0");
    return {
      total,
      items: (list as Record<string, unknown>[]).map((f) => {
        const n = normalize(f);
        return { ...n, sizeText: human(n.size) };
      }),
    };
  }),
);

server.tool(
  "quark_search",
  "按文件名搜索（在当前目录列表里过滤，没有全盘搜索接口）",
  { keyword: z.string().describe("文件名关键字"), pdir: z.string().optional() },
  wrap(async ({ keyword, pdir }: { keyword: string; pdir?: string }) => {
    const { list } = await listDir(pdir || "0");
    const hit = (list as Record<string, unknown>[])
      .map(normalize)
      .filter((f) => f.name.includes(keyword));
    return { count: hit.length, items: hit };
  }),
);

server.tool(
  "quark_create_folder",
  "新建文件夹",
  { name: z.string(), pdir: z.string().optional() },
  wrap(async ({ name, pdir }: { name: string; pdir?: string }) => {
    const a = await api();
    await a.createFolder(await cookie(), pdir || "0", name);
    return { ok: true, name };
  }),
);

server.tool(
  "quark_rename",
  "重命名文件或文件夹。fid 对百度来说就是完整路径",
  { fid: z.string(), name: z.string() },
  wrap(async ({ fid, name }: { fid: string; name: string }) => {
    const a = await api();
    await a.renameFile(await cookie(), fid, name);
    return { ok: true, fid, name };
  }),
);

server.tool(
  "quark_delete",
  "删除文件（进回收站，不是永久删除）。fids 是文件 id 数组",
  { fids: z.array(z.string()).min(1) },
  wrap(async ({ fids }: { fids: string[] }) => {
    const a = await api();
    await a.deleteFiles(await cookie(), fids);
    return { ok: true, deleted: fids.length };
  }),
);

server.tool(
  "quark_download_link",
  "获取文件下载直链。注意：UC/百度的直链必须用下载器（带客户端 UA）或服务端代理，浏览器直接访问会 403",
  { fid: z.string().describe("文件 fid，百度传完整路径") },
  wrap(async ({ fid }: { fid: string }) => {
    const a = await api();
    const url = await a.downloadUrl(await cookie(), fid);
    return { url, platform: await platformNote() };
  }),
);

server.tool(
  "quark_folder_size",
  "递归统计目录大小（文件数、子目录数）。目录很大时要发几千次请求，可能耗时较久",
  { fid: z.string().describe("目录 fid，百度传完整路径") },
  wrap(async ({ fid }: { fid: string }) => {
    const row = await account();
    // 走和 Web 端同一套缓存，避免重复扫
    const cached = await dircache.peek(row.account.id, fid);
    if (cached) return cached;
    const state = await dircache.start(row.account.id, fid, row.cookie, row.account.platform);
    if (state.status === "done") return state;
    return { ...state, hint: "计算已放后台，稍后再查一次同一目录" };
  }),
);

// ---- 分享 ----

server.tool(
  "quark_create_share",
  "对指定文件创建分享链接",
  { fids: z.array(z.string()).min(1), title: z.string().optional() },
  wrap(async ({ fids, title }: { fids: string[]; title?: string }) => {
    const a = await api();
    const row = await account();
    const created = await a.createShare(await cookie(), fids, title || "分享");
    await store.addShare({
      id: crypto.randomUUID(),
      userId: row.account.userId,
      accountId: row.account.id,
      shareId: created.shareId,
      title: title || "分享",
      url: created.url,
      passcode: created.passcode,
      fids,
      createdAt: new Date().toISOString(),
      groupId: null,
    });
    return created;
  }),
);

server.tool("quark_list_shares", "列出已记录的分享链接（含分组）", {}, wrap(async () => {
  const row = await account();
  const u = row.account.userId ?? "";
  const [shares, groups] = await Promise.all([store.listShares(u), store.listGroups(u)]);
  return { groups, shares };
}));

server.tool(
  "quark_preview_share",
  "预览别人的分享链接里有什么（不转存）。url 可以是链接或 pwd_id/surl",
  { url: z.string(), passcode: z.string().optional() },
  wrap(async ({ url, passcode }: { url: string; passcode?: string }) => {
    const a = await api();
    const c = await cookie();
    const parsed = a.parseShareUrl(url);
    const pwd = passcode || parsed.passcode;
    const stoken = await a.shareToken(c, parsed.pwdId, pwd);
    const { list } = await a.listShare(c, parsed.pwdId, stoken, "0");
    return { pwdId: parsed.pwdId, items: list };
  }),
);

server.tool(
  "quark_transfer",
  "把别人的分享转存到自己网盘。url 可以是分享链接或 id；to 是目标目录（夸克/UC 传 fid，百度传路径）",
  { url: z.string(), passcode: z.string().optional(), to: z.string().optional() },
  wrap(async ({ url, passcode, to }: { url: string; passcode?: string; to?: string }) => {
    const a = await api();
    const c = await cookie();
    const parsed = a.parseShareUrl(url);
    const stoken = await a.shareToken(c, parsed.pwdId, passcode || parsed.passcode);
    const { raw } = await a.listShare(c, parsed.pwdId, stoken, "0");
    if (!raw.length) throw new Error("分享内容为空");
    const fidOf = (f: Record<string, unknown>) =>
      "fs_id" in f ? String(f.fs_id) : String(f.fid);
    await a.saveShare(
      c,
      parsed.pwdId,
      stoken,
      raw.map((f) => fidOf(f)),
      raw.map((f) => String((f as { share_fid_token?: string }).share_fid_token ?? "")),
      to || "0",
    );
    return { ok: true, count: raw.length, pwdId: parsed.pwdId };
  }),
);

// ---- 账号 ----

server.tool(
  "account_list",
  "列出已登录的网盘账号，标出当前使用中的那个",
  {},
  wrap(async () => {
    const row = await store.getActiveAny();
    const u = row?.account.userId;
    const accounts = u ? await store.listAccounts(u) : [];
    return {
      active: row?.account.id ?? null,
      items: accounts.map((a) => ({
        id: a.id,
        nickname: a.nickname,
        platform: a.platform,
        platformName: PLATFORM_NAMES[a.platform],
        addedAt: a.addedAt,
      })),
    };
  }),
);

server.tool(
  "account_switch",
  "切换当前使用的网盘账号。id 来自 account_list",
  { id: z.string() },
  wrap(async ({ id }: { id: string }) => {
    const u = await uid();
    const done = await store.setActive(u, id);
    if (!done) throw new Error("账号不存在");
    const row = (await store.getActiveAny())!;
    return { ok: true, nickname: row.account.nickname, platform: PLATFORM_NAMES[row.account.platform] };
  }),
);

server.tool(
  "account_remove",
  "移除一个网盘账号（只解除绑定，不会动网盘里的文件）",
  { id: z.string() },
  wrap(async ({ id }: { id: string }) => {
    const done = await store.removeAccount(await uid(), id);
    if (!done) throw new Error("账号不存在");
    return { ok: true };
  }),
);

// ---- 分享分组 ----

server.tool(
  "share_group_create",
  "新建分享分组",
  { name: z.string() },
  wrap(async ({ name }: { name: string }) => {
    return await store.addGroup(await uid(), name);
  }),
);

server.tool(
  "share_group_delete",
  "删除分享分组。组内分享会退回未分组，分享本身不会失效",
  { id: z.string() },
  wrap(async ({ id }: { id: string }) => {
    const done = await store.removeGroup(await uid(), id);
    if (!done) throw new Error("分组不存在");
    return { ok: true };
  }),
);

server.tool(
  "share_assign_group",
  "把一条分享记录移到指定分组，groupId 传空则退回未分组",
  { shareId: z.string(), groupId: z.string().optional() },
  wrap(async ({ shareId, groupId }: { shareId: string; groupId?: string }) => {
    const done = await store.assignShareGroup(await uid(), shareId, groupId || null);
    if (!done) throw new Error("分享或分组不存在");
    return { ok: true };
  }),
);

server.tool(
  "share_remove",
  "删除一条分享记录（只删本地记录，线上分享链接不会失效）",
  { id: z.string() },
  wrap(async ({ id }: { id: string }) => {
    const done = await store.removeShare(await uid(), id);
    if (!done) throw new Error("分享记录不存在");
    return { ok: true };
  }),
);

// ---- 资源站：收集同行的分享链接，转存到自己网盘并生成自己的分享 ----

server.tool(
  "resource_list",
  "列出已登记的资源（同行的分享链接），含状态和自己的分享链接",
  {},
  wrap(async () => {
    const rows = await store.listResources(await uid());
    return {
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        sourceUrl: r.sourceUrl,
        status: r.status,
        ownUrl: r.ownUrl,
        hits: r.hits,
        error: r.error,
      })),
    };
  }),
);

server.tool(
  "resource_add",
  "登记一条别人的分享链接。只是记录，不转存；要用 resource_claim 才真正转存到自己网盘",
  {
    title: z.string().describe("资源标题，如「2027 行测刷题营」"),
    sourceUrl: z.string().describe("别人的分享链接，夸克是 https://pan.quark.cn/s/xxx，UC 是 https://drive.uc.cn/s/xxx，百度是 https://pan.baidu.com/s/1xxx"),
    sourcePasscode: z.string().optional().describe("提取码，没有就留空"),
    description: z.string().optional(),
    toPdir: z.string().optional().describe("转存到自己的哪个目录（夸克/UC 传 fid，百度传路径），默认根目录"),
  },
  wrap(async (a: { title: string; sourceUrl: string; sourcePasscode?: string; description?: string; toPdir?: string }) => {
    const row = await store.getActiveAny();
    if (!row?.account.userId) throw new Error("还没有登录网盘账号");
    // 先解析，链接不合法就别存进库
    resourceClaim.shareApiFor(row.account.platform).parseShareUrl(a.sourceUrl);
    const now = new Date().toISOString();
    const resource: Resource = {
      id: crypto.randomUUID(),
      userId: row.account.userId,
      title: a.title,
      description: a.description ?? "",
      sourceUrl: a.sourceUrl,
      sourcePasscode: a.sourcePasscode ?? "",
      platform: row.account.platform,
      toPdir: a.toPdir || "0",
      ownUrl: null,
      ownPasscode: null,
      ownFids: null,
      status: "pending",
      error: null,
      hits: 0,
      createdAt: now,
      updatedAt: now,
    };
    await store.addResource(resource);
    return { ok: true, id: resource.id, title: resource.title };
  }),
);

server.tool(
  "resource_claim",
  "把资源转存到自己的网盘，并生成自己的分享链接。第一次会真转存（大课程可能几十 GB），之后复用缓存的链接",
  { id: z.string().describe("资源 id，来自 resource_list / resource_add") },
  wrap(async ({ id }: { id: string }) => {
    const u = await uid();
    const resource = await store.getResource(u, id);
    if (!resource) throw new Error("资源不存在");
    if (resource.ownUrl) {
      await store.updateResource(u, id, { hits: resource.hits + 1 });
      return { url: resource.ownUrl, passcode: resource.ownPasscode ?? "", cached: true };
    }
    const row = await store.getActiveAny();
    const done = await resourceClaim.claimAndSave(u, row!.cookie, resource);
    if (done.status === "failed") throw new Error(done.error || "转存失败");
    await store.updateResource(u, id, { hits: done.hits + 1 });
    return { url: done.ownUrl, passcode: done.ownPasscode ?? "", cached: false };
  }),
);

server.tool(
  "resource_remove",
  "从资源站移除一条记录（已生成的分享链接不会失效，网盘里的文件也不会删）",
  { id: z.string() },
  wrap(async ({ id }: { id: string }) => {
    const done = await store.removeResource(await uid(), id);
    if (!done) throw new Error("资源不存在");
    return { ok: true };
  }),
);

function human(n: number): string {
  if (!n) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

await server.connect(new StdioServerTransport());
