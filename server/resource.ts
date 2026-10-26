// 资源站核心：把别人分享的文件转存到号主网盘，再生成号主自己的分享链接。
// 只在第一次「获取」时做一次，结果写回 resource，后续直接返回缓存的链接。
//
// 夸克和 UC 的分享接口完全同构（sharepage/token → detail → save → share → password），
// 只是域名和 pr 参数不同，所以共用同一套流程。百度签名机制不同，暂不支持。
import * as quark from "./quark.ts";
import * as uc from "./uc.ts";
import * as baidu from "./baidu.ts";
import * as store from "./store.ts";
import type { Platform, Resource } from "../shared/types.ts";

type ShareApi = {
  parseShareUrl: (input: string) => { pwdId: string; passcode: string };
  shareToken: (cookie: string, pwdId: string, passcode: string) => Promise<string>;
  listShare: (
    cookie: string,
    pwdId: string,
    stoken: string,
    pdir: string,
  ) => Promise<{
    raw: { fid: string; file_name: string; dir: boolean; size: number; share_fid_token: string }[];
    list: { fid: string; name: string; isDir: boolean; size: number }[];
  }>;
  saveShare: (
    cookie: string,
    pwdId: string,
    stoken: string,
    fidList: string[],
    fidTokens: string[],
    toPdir: string,
  ) => Promise<void>;
  createShare: (
    cookie: string,
    fids: string[],
    title: string,
  ) => Promise<{ shareId: string; url: string; passcode: string }>;
  listFiles: (
    cookie: string,
    pdir: string,
    page: number,
    size: number,
  ) => Promise<{ list: { fid: string; file_name: string; dir: boolean; size: number }[] }>;
};

const apis: Record<string, ShareApi> = {
  quark: quark as unknown as ShareApi,
  uc: uc as unknown as ShareApi,
  // 百度字段名不同（fs_id/server_filename/isdir），这里包一层归一化
  baidu: {
    parseShareUrl: baidu.parseShareUrl,
    shareToken: baidu.shareToken,
    saveShare: baidu.saveShare,
    createShare: baidu.createShare,
    listShare: async (cookie, surl, sekey, dir) => {
      const { raw } = await baidu.listShare(cookie, surl, sekey, dir);
      const norm = raw.map((f) => ({
        fid: String(f.fs_id),
        file_name: String(f.server_filename),
        dir: f.isdir === 1,
        size: Number(f.size ?? 0),
        share_fid_token: "",
      }));
      return {
        raw: norm,
        list: norm.map((f) => ({ fid: f.fid, name: f.file_name, isDir: f.dir, size: f.size })),
      };
    },
    listFiles: async (cookie, pdir, page, size) => {
      const { list } = await baidu.listFiles(cookie, pdir, page, size);
      return {
        list: list.map((f) => ({
          fid: f.path,
          file_name: f.server_filename,
          dir: f.isdir === 1,
          size: Number(f.size ?? 0),
        })),
      };
    },
  },
};

export function shareApiFor(platform: Platform): ShareApi {
  const api = apis[platform];
  if (!api) throw new Error(`资源站暂不支持${platform}`);
  return api;
}

/**
 * 转存并重新分享。返回自己的分享链接。
 *
 * 为什么要重新列目录：转存接口只返回 task_id，不返回转存后的 fid，
 * 而建分享必须用「我网盘里的 fid」。
 */
export async function claim(
  cookie: string,
  resource: Resource,
): Promise<{ url: string; passcode: string }> {
  const api = shareApiFor(resource.platform);
  const { pwdId, passcode: urlPwd } = api.parseShareUrl(resource.sourceUrl);
  const passcode = resource.sourcePasscode || urlPwd;

  const stoken = await api.shareToken(cookie, pwdId, passcode);
  const { raw } = await api.listShare(cookie, pwdId, stoken, "0");
  if (!raw.length) throw new Error("分享内容为空");

  const names = raw.map((f) => String(f.file_name));
  await api.saveShare(
    cookie,
    pwdId,
    stoken,
    raw.map((f) => String(f.fid)),
    raw.map((f) => String(f.share_fid_token)),
    resource.toPdir || "0",
  );

  // 转存是异步任务，saveShare 内部已等完成。这里按文件名回查新 fid。
  const listed = await api.listFiles(cookie, resource.toPdir || "0", 1, 100);
  const fids = listed.list
    .filter((f) => names.includes(String(f.file_name)))
    .map((f) => String(f.fid));
  if (!fids.length) throw new Error("转存后没在目标目录找到文件，可能被同名文件占用");

  const created = await api.createShare(cookie, fids, resource.title);
  return { url: created.url, passcode: created.passcode };
}

/** 处理一条资源：转存 → 建分享 → 落库。失败也落库，避免反复重试打爆接口。 */
export async function claimAndSave(
  userId: string,
  cookie: string,
  resource: Resource,
): Promise<Resource> {
  try {
    const { url, passcode } = await claim(cookie, resource);
    return (
      (await store.updateResource(userId, resource.id, {
        ownUrl: url,
        ownPasscode: passcode,
        status: "ready",
        error: null,
      })) ?? resource
    );
  } catch (e) {
    return (
      (await store.updateResource(userId, resource.id, {
        status: "failed",
        error: e instanceof Error ? e.message : "转存失败",
      })) ?? resource
    );
  }
}
