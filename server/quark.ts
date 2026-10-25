const BASE = "https://drive-pc.quark.cn/1/clouddrive";

// 直链必须用客户端 UA，否则 CDN 回 403/412
const DL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 " +
  "Safari/537.36 Channel/pckk_other_ch";

// 夸克网盘没有开放 API，这里走的是网页版内部接口。接口一旦变动，只需要改这一个文件。
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  referer: "https://pan.quark.cn/",
  origin: "https://pan.quark.cn",
  accept: "application/json, text/plain, */*",
};

type QuarkEnvelope<T> = { status: number; code: number; message: string; data: T };

export class QuarkError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

async function call<T>(
  cookie: string,
  path: string,
  init: {
    method?: string;
    query?: Record<string, string | number>;
    body?: unknown;
    /** 下载接口必须用客户端 UA，否则会被 23018 大小限制拦掉 */
    ua?: string;
  } = {},
): Promise<T> {
  const url = new URL(BASE + path);
  url.searchParams.set("pr", "ucpro");
  url.searchParams.set("fr", "pc");
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      ...HEADERS,
      ...(init.ua ? { "user-agent": init.ua } : {}),
      cookie,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  let json: QuarkEnvelope<T>;
  try {
    json = JSON.parse(text) as QuarkEnvelope<T>;
  } catch {
    throw new QuarkError(`夸克返回了非 JSON 内容（HTTP ${res.status}）`, -1);
  }
  // 31001/31023 是登录态失效
  if (json.code !== 0) throw new QuarkError(json.message || `夸克接口错误 ${json.code}`, json.code);
  return json.data;
}

export type QuarkFile = {
  fid: string;
  file_name: string;
  dir: boolean;
  size: number;
  updated_at: number;
};

export async function whoami(cookie: string): Promise<string> {
  const data = await call<{ nickname?: string; member_type?: string }>(cookie, "/member", {
    query: { uc_param_str: "" },
  });
  return data.nickname || "夸克用户";
}

export type Capacity = {
  total: number;
  used: number;
  memberType: string;
  composition: { label: string; size: number }[];
  expiresAt: string | null;
  saveQuota: { used: number; total: number } | null;
};

const COMPOSITION_LABELS: Record<string, string> = {
  sign_reward: "签到奖励",
  activity: "活动赠送",
  buy: "购买容量",
  member: "会员容量",
};

export async function capacity(cookie: string): Promise<Capacity> {
  const d = await call<{
    total_capacity?: number;
    use_capacity?: number;
    member_type?: string;
    exp_at?: number;
    extend_capacity_composition?: Record<string, number>;
    member_info?: { file_save_to_remains?: number; file_save_to_total?: number };
  }>(cookie, "/member", { query: { uc_param_str: "" } });

  const composition = Object.entries(d.extend_capacity_composition ?? {})
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => ({ label: COMPOSITION_LABELS[k] ?? k, size: v }));

  // file_save_to_total 官方没给，按「已用 + 剩余」推算
  const remains = d.member_info?.file_save_to_remains;
  const saveQuota =
    typeof remains === "number"
      ? { used: d.member_info?.file_save_to_total ?? 0, total: remains }
      : null;

  return {
    total: d.total_capacity ?? 0,
    used: d.use_capacity ?? 0,
    memberType: d.member_type ?? "",
    composition,
    expiresAt: d.exp_at ? new Date(d.exp_at).toISOString().slice(0, 10) : null,
    saveQuota,
  };
}

export async function listFiles(
  cookie: string,
  pdir: string,
  page: number,
  size: number,
): Promise<{ list: QuarkFile[]; total: number }> {
  const data = await call<{ list: QuarkFile[]; total?: number }>(cookie, "/file/sort", {
    query: {
      pdir_fid: pdir,
      _page: page,
      _size: size,
      _fetch_total: 1,
      _sort: "file_type:asc,updated_at:desc",
      uc_param_str: "",
    },
  });
  return { list: data.list ?? [], total: data.total ?? data.list?.length ?? 0 };
}

// 目录大小：夸克目录的 size 恒为 0，也没有对应接口，只能递归累加。
// 实测大目录要 2000+ 次请求，所以调用方必须放后台跑并缓存。
// 请求量大会偶发 fetch failed（对端断开/限流），单页失败重试两次再放弃。
async function listAllPages(cookie: string, pdir: string): Promise<QuarkFile[]> {
  const out: QuarkFile[] = [];
  for (let page = 1; page <= 20; page++) {
    let res: { list: QuarkFile[]; total: number } | null = null;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = await listFiles(cookie, pdir, page, 100);
      } catch {
        if (attempt === 2) throw new Error("目录读取失败，请稍后重试");
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (!res) break;
    out.push(...res.list);
    if (out.length >= res.total || res.list.length === 0) break;
  }
  return out;
}

export async function folderSize(
  cookie: string,
  fid: string,
  onProgress?: (dirs: number) => void,
): Promise<{ size: number; files: number; dirs: number }> {
  let size = 0;
  let files = 0;
  let dirs = 0;
  let queue = [fid];

  while (queue.length) {
    const batch = queue.slice(0, 6);
    queue = queue.slice(6);
    const results = await Promise.all(batch.map((id) => listAllPages(cookie, id)));
    for (const list of results) {
      dirs++;
      for (const it of list) {
        if (it.dir) queue.push(it.fid);
        else {
          size += it.size;
          files++;
        }
      }
    }
    onProgress?.(dirs);
    // 轻微间隔，避免连续几千次请求被对端掐断
    if (queue.length) await new Promise((r) => setTimeout(r, 60));
  }
  return { size, files, dirs };
}

export async function createFolder(cookie: string, pdir: string, name: string): Promise<void> {
  await call(cookie, "/file", {
    method: "POST",
    body: { pdir_fid: pdir, file_name: name, dir_path: "", dir_init_lock: false },
  });
}

export async function deleteFiles(cookie: string, fids: string[]): Promise<void> {
  const data = await call<{ task_id?: string }>(cookie, "/file/delete", {
    method: "POST",
    body: { action_type: 2, filelist: fids, exclude_fids: [] },
  });
  if (data.task_id) await waitTask(cookie, data.task_id);
}

export async function renameFile(cookie: string, fid: string, name: string): Promise<void> {
  await call(cookie, "/file/rename", { method: "POST", body: { fid, file_name: name } });
}

/** 拿下载直链。返回的 URL 必须带 downloadHeaders 才能下载。 */
export async function downloadUrl(cookie: string, fid: string): Promise<string> {
  // 必须和下载用同一套 cookie，否则 CDN 校验对不上
  const full = await ensureDownloadCookie(cookie);
  const d = await call<{ download_url: string }[]>(full, "/file/download", {
    method: "POST",
    query: { entry: "ft" },
    body: { fids: [fid] },
    ua: DL_UA,
  });
  const url = d[0]?.download_url;
  if (!url) throw new QuarkError("夸克没有返回下载地址", -4);
  return url;
}

/** 直链下载所需的请求头。cookie 先补 __puus，否则 CDN 会 403。 */
export async function downloadHeaders(cookie: string) {
  return {
    "user-agent": DL_UA,
    referer: "https://pan.quark.cn/",
    cookie: await ensureDownloadCookie(cookie),
  };
}

/**
 * 补全 __puus。夸克 CDN 的回调会把请求 cookie 转发给 drive-auth.quark.cn 校验，
 * 手工粘的 cookie 通常没有 __puus，直链就会 403「require login [auth miss]」。
 * 实测 /member 会通过 Set-Cookie 下发它，不需要浏览器。
 * 结果按原始 cookie 缓存，保证「取链接」和「下载」用的是同一套 cookie。
 */
const warmed = new Map<string, string>();

export async function ensureDownloadCookie(cookie: string): Promise<string> {
  if (cookie.includes("__puus=")) return cookie;
  const key = cookie.slice(-32);
  const hit = warmed.get(key);
  if (hit) return hit;

  const jar = new Map<string, string>();
  for (const c of cookie.split(";")) {
    const i = c.indexOf("=");
    if (i > 0) jar.set(c.slice(0, i).trim(), c.slice(i + 1).trim());
  }

  const url = new URL(BASE + "/member");
  url.searchParams.set("pr", "ucpro");
  url.searchParams.set("fr", "pc");
  const res = await fetch(url, { headers: { ...HEADERS, cookie } });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const full = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (jar.has("__puus")) warmed.set(key, full);
  return full;
}

async function waitTask(cookie: string, taskId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const data = await call<{ status: number; message?: string }>(cookie, "/task", {
      query: { task_id: taskId, retry_index: i },
    });
    if (data.status === 2) return;
    if (data.status === 3) throw new QuarkError(data.message || "夸克任务失败", -2);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new QuarkError("夸克任务超时", -3);
}

export async function createShare(
  cookie: string,
  fids: string[],
  title: string,
): Promise<{ shareId: string; url: string; passcode: string }> {
  const task = await call<{ task_id: string }>(cookie, "/share", {
    method: "POST",
    body: { fid_list: fids, title, url_type: 1, expired_type: 1 },
  });

  // 分享是异步任务：查结果用 /task，不是 /share/task（那个是 404）
  let shareId = "";
  for (let i = 0; i < 20; i++) {
    const t = await call<{ status: number; share_id?: string; message?: string }>(cookie, "/task", {
      query: { task_id: task.task_id, retry_index: i },
    });
    if (t.status === 2 && t.share_id) {
      shareId = t.share_id;
      break;
    }
    if (t.status === 3) throw new QuarkError(t.message || "分享任务失败", -4);
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!shareId) throw new QuarkError("分享任务超时", -5);

  // 详情接口给出真正的分享链接和提取码
  const info = await call<{ share_url?: string; pwd_id?: string; passcode?: string }>(
    cookie,
    "/share/password",
    { method: "POST", body: { share_id: shareId } },
  );
  return {
    shareId,
    url: info.share_url || `https://pan.quark.cn/s/${info.pwd_id ?? shareId}`,
    passcode: info.passcode ?? "",
  };
}

// ---- 转存他人分享 ----
export type ShareEntry = { fid: string; name: string; isDir: boolean; size: number };

export async function shareToken(
  cookie: string,
  pwdId: string,
  passcode: string,
): Promise<string> {
  const d = await call<{ stoken?: string }>(cookie, "/share/sharepage/token", {
    method: "POST",
    body: { pwd_id: pwdId, passcode },
  });
  if (!d.stoken) throw new QuarkError("无法获取分享 token（链接无效或提取码错误）", -12);
  return d.stoken;
}

export type ShareRaw = { fid: string; file_name: string; dir: boolean; size: number; share_fid_token: string };

export async function listShare(
  cookie: string,
  pwdId: string,
  stoken: string,
  pdir: string,
): Promise<{ list: ShareEntry[]; raw: ShareRaw[] }> {
  const d = await call<{ list?: ShareRaw[] }>(cookie, "/share/sharepage/detail", {
      query: {
        pwd_id: pwdId,
        stoken,
        pdir_fid: pdir,
        _page: 1,
        _size: 100,
        _fetch_total: 1,
        _sort: "file_type:asc,updated_at:desc",
      },
    },
  );
  const raw = d.list ?? [];
  return {
    raw,
    list: raw.map((f) => ({
      fid: String(f.fid),
      name: String(f.file_name),
      isDir: Boolean(f.dir),
      size: Number(f.size ?? 0),
    })),
  };
}

export async function saveShare(
  cookie: string,
  pwdId: string,
  stoken: string,
  fidList: string[],
  fidTokens: string[],
  toPdir: string,
): Promise<void> {
  const d = await call<{ task_id?: string }>(cookie, "/share/sharepage/save", {
    method: "POST",
    body: {
      fid_list: fidList,
      fid_token_list: fidTokens,
      to_pdir_fid: toPdir,
      pwd_id: pwdId,
      stoken,
      pdir_fid: "0",
      scene: "link",
    },
  });
  if (d.task_id) await waitTask(cookie, d.task_id);
}

// 从分享链接里取 pwd_id：https://pan.quark.cn/s/<pwd_id>
export function parseShareUrl(input: string): { pwdId: string; passcode: string } {
  const text = input.trim();
  const hit = text.match(/pan\.quark\.cn\/s\/([0-9a-zA-Z]+)/);
  const pwdId = hit ? hit[1] : text.match(/^[0-9a-zA-Z]{8,}$/)?.[0] ?? "";
  if (!pwdId) throw new QuarkError("无法识别分享链接", -13);
  const pwd = text.match(/(?:提取码|密码|pwd)[^\w]{0,4}([0-9a-zA-Z]{4})/);
  return { pwdId, passcode: pwd ? pwd[1] : "" };
}

// ---- 扫码登录 ----
// 流程（复刻网页版）：取 token → 二维码里放 scanLoginPage 链接 → 轮询 service_ticket
// → 用 ticket 请求 /account/info 换回 cookie。
const CAS_HEADERS = {
  "user-agent": HEADERS["user-agent"],
  referer: "https://pan.quark.cn/",
  origin: "https://pan.quark.cn",
  accept: "application/json, text/plain, */*",
};

type ScanSession = {
  token: string;
  jar: Map<string, string>;
  createdAt: number;
};

const scans = new Map<string, ScanSession>();

export function qrContent(token: string): string {
  const url = new URL("https://su.quark.cn/4_eMHBJ");
  url.searchParams.set("token", token);
  url.searchParams.set("client_id", "532");
  url.searchParams.set("ssb", "weblogin");
  url.searchParams.set("uc_param_str", "");
  url.searchParams.set("uc_biz_str", "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0");
  return url.toString();
}

function absorbCookies(res: Response, jar: Map<string, string>): void {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

export async function startScan(): Promise<{ scanId: string; content: string }> {
  const res = await fetch(
    "https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=" +
      crypto.randomUUID(),
    { headers: CAS_HEADERS },
  );
  const json = (await res.json()) as {
    status: number;
    data?: { members?: { token?: string } };
  };
  const token = json.data?.members?.token;
  if (json.status !== 2000000 || !token) throw new QuarkError("获取扫码 token 失败", -10);

  const jar = new Map<string, string>();
  absorbCookies(res, jar);
  const scanId = crypto.randomUUID();
  scans.set(scanId, { token, jar, createdAt: Date.now() });

  // 过期清理，避免 map 无限增长
  for (const [id, s] of scans) if (Date.now() - s.createdAt > 10 * 60_000) scans.delete(id);

  return { scanId, content: qrContent(token) };
}

export type ScanState = "waiting" | "scanned" | "expired" | "failed";

export async function pollScan(
  scanId: string,
): Promise<{ state: ScanState; cookie?: string; nickname?: string }> {
  const s = scans.get(scanId);
  if (!s) return { state: "expired" };
  if (Date.now() - s.createdAt > 5 * 60_000) {
    scans.delete(scanId);
    return { state: "expired" };
  }

  const res = await fetch(
    `https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=${encodeURIComponent(s.token)}&request_id=${crypto.randomUUID()}`,
    { headers: CAS_HEADERS },
  );
  absorbCookies(res, s.jar);
  const json = (await res.json()) as {
    status: number;
    message?: string;
    data?: { members?: { service_ticket?: string } };
  };

  // 50004001 = 等待扫码；50004002/3/4 = 已扫码待确认或失败
  if (json.status === 50004001) return { state: "waiting" };
  if (json.status !== 2000000) {
    if (json.status === 50004002 || json.status === 50004003) return { state: "scanned" };
    return { state: "failed" };
  }

  const ticket = json.data?.members?.service_ticket;
  if (!ticket) return { state: "waiting" };

  // 用 ticket 换 cookie
  const info = await fetch("https://pan.quark.cn/account/info?st=" + encodeURIComponent(ticket), {
    headers: { ...CAS_HEADERS, cookie: cookieHeader(s.jar) },
  });
  absorbCookies(info, s.jar);
  const infoJson = (await info.json()) as {
    success?: boolean;
    data?: { nickname?: string; nick_name?: string };
    msg?: string;
  };
  if (!infoJson.success) throw new QuarkError(infoJson.msg || "票据兑换失败", -11);

  scans.delete(scanId);
  return {
    state: "waiting",
    cookie: cookieHeader(s.jar),
    nickname: infoJson.data?.nickname || infoJson.data?.nick_name || "夸克用户",
  };
}

