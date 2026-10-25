// 资源站核心：把别人分享的文件转存到号主网盘，再生成号主自己的分享链接。
// 只在第一次「获取」时做一次，结果写回 resource，后续直接返回缓存的链接。
import * as quark from "./quark.ts";
import * as store from "./store.ts";
import type { Resource } from "../shared/types.ts";

/**
 * 转存并重新分享。返回自己的分享链接。
 *
 * 步骤：解析分享 → 取 stoken → 列内容 → 转存到指定目录 → 重新列目录拿新 fid
 * → 用新 fid 建分享。
 *
 * 为什么要重新列目录：转存接口只返回 task_id，不返回转存后的 fid，
 * 而建分享必须用「我网盘里的 fid」。
 */
export async function claim(
  cookie: string,
  resource: Resource,
): Promise<{ url: string; passcode: string }> {
  const { pwdId, passcode: urlPwd } = quark.parseShareUrl(resource.sourceUrl);
  const passcode = resource.sourcePasscode || urlPwd;

  const stoken = await quark.shareToken(cookie, pwdId, passcode);
  const { raw } = await quark.listShare(cookie, pwdId, stoken, "0");
  if (!raw.length) throw new Error("分享内容为空");

  const names = raw.map((f) => String(f.file_name));
  await quark.saveShare(
    cookie,
    pwdId,
    stoken,
    raw.map((f) => String(f.fid)),
    raw.map((f) => String(f.share_fid_token)),
    resource.toPdir || "0",
  );

  // 转存是异步任务，saveShare 内部已等完成。这里按文件名回查新 fid。
  const listed = await quark.listFiles(cookie, resource.toPdir || "0", 1, 100);
  const fids = listed.list
    .filter((f) => names.includes(String(f.file_name)))
    .map((f) => String(f.fid));
  if (!fids.length) throw new Error("转存后没在目标目录找到文件，可能被同名文件占用");

  const created = await quark.createShare(cookie, fids, resource.title);
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
