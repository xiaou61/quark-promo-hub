#!/usr/bin/env node
// MCP 服务器：通过 stdio 把夸克网盘操作暴露给 AI。
// 复用的是同一套 server/quark.ts 与本地 db，所以 Web 端登录过的账号这里直接可用。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.ts";
import * as quark from "./quark.ts";

const server = new McpServer({ name: "quark-promo-hub", version: "0.1.0" });

async function cookie(): Promise<string> {
  const row = await store.getActiveAny();
  if (!row) throw new Error("还没有登录夸克账号，请先在网页端扫码登录");
  return row.cookie;
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

server.tool("quark_capacity", "查看网盘容量：总量、已用、会员类型", {}, wrap(async () => {
  return await quark.capacity(await cookie());
}));

server.tool(
  "quark_list_files",
  "列出某个目录下的文件。pdir 为目录 fid，根目录用 0",
  { pdir: z.string().optional().describe("目录 fid，默认根目录 0") },
  wrap(async ({ pdir }: { pdir?: string }) => {
    const c = await cookie();
    const { list, total } = await quark.listFiles(c, pdir || "0", 1, 100);
    return {
      total,
      items: list.map((f) => ({
        fid: f.fid,
        name: f.file_name,
        isDir: f.dir,
        size: f.size,
        sizeText: human(f.size),
      })),
    };
  }),
);

server.tool(
  "quark_search",
  "按文件名搜索（在当前目录列表里过滤，夸克没有全盘搜索接口）",
  { keyword: z.string().describe("文件名关键字"), pdir: z.string().optional() },
  wrap(async ({ keyword, pdir }: { keyword: string; pdir?: string }) => {
    const c = await cookie();
    const { list } = await quark.listFiles(c, pdir || "0", 1, 100);
    const hit = list.filter((f) => f.file_name.includes(keyword));
    return { count: hit.length, items: hit.map((f) => ({ fid: f.fid, name: f.file_name, isDir: f.dir, size: f.size })) };
  }),
);

server.tool(
  "quark_create_folder",
  "新建文件夹",
  { name: z.string(), pdir: z.string().optional() },
  wrap(async ({ name, pdir }: { name: string; pdir?: string }) => {
    await quark.createFolder(await cookie(), pdir || "0", name);
    return { ok: true, name };
  }),
);

server.tool(
  "quark_rename",
  "重命名文件或文件夹",
  { fid: z.string(), name: z.string() },
  wrap(async ({ fid, name }: { fid: string; name: string }) => {
    await quark.renameFile(await cookie(), fid, name);
    return { ok: true, fid, name };
  }),
);

server.tool(
  "quark_delete",
  "删除文件（进回收站，不是永久删除）。fids 是文件 id 数组",
  { fids: z.array(z.string()).min(1) },
  wrap(async ({ fids }: { fids: string[] }) => {
    await quark.deleteFiles(await cookie(), fids);
    return { ok: true, deleted: fids.length };
  }),
);

server.tool(
  "quark_create_share",
  "对指定文件创建分享链接",
  { fids: z.array(z.string()).min(1), title: z.string().optional() },
  wrap(async ({ fids, title }: { fids: string[]; title?: string }) => {
    const c = await cookie();
    const row = (await store.getActiveAny())!;
    const created = await quark.createShare(c, fids, title || "夸克分享");
    await store.addShare({
      id: crypto.randomUUID(),
      userId: row.account.userId,
      accountId: row.account.id,
      shareId: created.shareId,
      title: title || "夸克分享",
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
  const row = await store.getActiveAny();
  if (!row) return { shares: [] };
  const uid = row.account.userId ?? "";
  const [shares, groups] = await Promise.all([store.listShares(uid), store.listGroups(uid)]);
  return { groups, shares };
}));

server.tool(
  "quark_preview_share",
  "预览别人的分享链接里有什么（不转存）。url 可以是链接或 pwd_id",
  { url: z.string(), passcode: z.string().optional() },
  wrap(async ({ url, passcode }: { url: string; passcode?: string }) => {
    const c = await cookie();
    const parsed = quark.parseShareUrl(url);
    const pwd = passcode || parsed.passcode;
    const stoken = await quark.shareToken(c, parsed.pwdId, pwd);
    const { list } = await quark.listShare(c, parsed.pwdId, stoken, "0");
    return { pwdId: parsed.pwdId, items: list };
  }),
);

server.tool(
  "quark_transfer",
  "把别人的分享转存到自己网盘。url 可以是分享链接或 pwd_id；to 是目标目录 fid（默认根目录）",
  { url: z.string(), passcode: z.string().optional(), to: z.string().optional() },
  wrap(async ({ url, passcode, to }: { url: string; passcode?: string; to?: string }) => {
    const c = await cookie();
    const parsed = quark.parseShareUrl(url);
    const stoken = await quark.shareToken(c, parsed.pwdId, passcode || parsed.passcode);
    const { raw } = await quark.listShare(c, parsed.pwdId, stoken, "0");
    if (!raw.length) throw new Error("分享内容为空");
    await quark.saveShare(
      c,
      parsed.pwdId,
      stoken,
      raw.map((f) => String(f.fid)),
      raw.map((f) => String(f.share_fid_token)),
      to || "0",
    );
    return { ok: true, count: raw.length, pwdId: parsed.pwdId };
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
