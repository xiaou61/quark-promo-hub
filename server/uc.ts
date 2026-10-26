// UC 网盘的网页版内部接口。和夸克同构（都是 /1/clouddrive），差异只在域名、
// 必需的 pr=UCBrowser 参数和下载 UA。接口变动时只需要改这一个文件。
const BASE = "https://pc-api.uc.cn/1/clouddrive";

// 直链必须用客户端 UA，否则 CDN 回 403/412
const DL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 " +
  "Safari/537.36 Channel/pckk_other_ch";

const HEADERS = {
  "user-agent": DL_UA,
  referer: "https://drive.uc.cn/",
  origin: "https://drive.uc.cn",
  accept: "application/json, text/plain, */*",
};

// 扫码登录走 CAS，UA 用普通浏览器（客户端 UA 会被拒）
const CAS_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36",
  referer: "https://drive.uc.cn/",
  origin: "https://drive.uc.cn",
  accept: "application/json, text/plain, */*",
};

type Envelope<T> = { status: number; code: number; message: string; data: T };

export class UcError extends Error {
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
    /** 下载接口必须用客户端 UA，否则会被大小限制拦掉 */
    ua?: string;
  } = {},
): Promise<T> {
  const url = new URL(BASE + path);
  // pr=UCBrowser 是硬要求，缺了 /member 会直接 401
  url.searchParams.set("pr", "UCBrowser");
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
  let json: Envelope<T>;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new UcError(`UC 返回了非 JSON 内容（HTTP ${res.status}）`, -1);
  }
  if (json.code !== 0) throw new UcError(json.message || `UC 接口错误 ${json.code}`, json.code);
  return json.data;
}

export type UcFile = {
  fid: string;
  file_name: string;
  dir: boolean;
  size: number;
  updated_at: number;
};

export async function whoami(cookie: string): Promise<string> {
  const d = await call<{ nickname?: string }>(cookie, "/member", { query: { uc_param_str: "" } });
  return d.nickname || "UC用户";
}

export async function capacity(cookie: string): Promise<{
  total: number;
  used: number;
  memberType: string;
  composition: { label: string; size: number }[];
  expiresAt: string | null;
  saveQuota: { used: number; total: number } | null;
}> {
  const d = await call<{
    total_capacity?: number;
    use_capacity?: number;
    member_type?: string;
    exp_at?: number;
    extend_capacity_composition?: Record<string, number>;
    member_info?: { file_save_to_remains?: number; file_save_to_total?: number };
  }>(cookie, "/member", { query: { uc_param_str: "" } });

  const labels: Record<string, string> = {
    sign_reward: "签到奖励",
    activity: "活动赠送",
    buy: "购买容量",
    member: "会员容量",
  };
  const composition = Object.entries(d.extend_capacity_composition ?? {})
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => ({ label: labels[k] ?? k, size: v }));

  const remains = d.member_info?.file_save_to_remains;
  return {
    total: d.total_capacity ?? 0,
    used: d.use_capacity ?? 0,
    memberType: d.member_type ?? "",
    composition,
    expiresAt: d.exp_at ? new Date(d.exp_at).toISOString().slice(0, 10) : null,
    saveQuota:
      typeof remains === "number"
        ? { used: d.member_info?.file_save_to_total ?? 0, total: remains }
        : null,
  };
}

export async function listFiles(
  cookie: string,
  pdir: string,
  page: number,
  size: number,
): Promise<{ list: UcFile[]; total: number }> {
  const d = await call<{ list?: UcFile[]; total?: number }>(cookie, "/file/sort", {
    query: {
      pdir_fid: pdir,
      _page: page,
      _size: size,
      _fetch_total: 1,
      _sort: "file_type:asc,updated_at:desc",
      uc_param_str: "",
    },
  });
  return { list: d.list ?? [], total: d.total ?? d.list?.length ?? 0 };
}

export async function createFolder(cookie: string, pdir: string, name: string): Promise<void> {
  await call(cookie, "/file", {
    method: "POST",
    body: { pdir_fid: pdir, file_name: name, dir_path: "", dir_init_lock: false },
  });
}

export async function deleteFiles(cookie: string, fids: string[]): Promise<void> {
  const d = await call<{ task_id?: string }>(cookie, "/file/delete", {
    method: "POST",
    body: { action_type: 2, filelist: fids, exclude_fids: [] },
  });
  if (d.task_id) await waitTask(cookie, d.task_id);
}

export async function renameFile(cookie: string, fid: string, name: string): Promise<void> {
  await call(cookie, "/file/rename", { method: "POST", body: { fid, file_name: name } });
}

async function waitTask(cookie: string, taskId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const d = await call<{ status: number; message?: string }>(cookie, "/task", {
      query: { task_id: taskId, retry_index: i },
    });
    if (d.status === 2) return;
    if (d.status === 3) throw new UcError(d.message || "UC 任务失败", -2);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new UcError("UC 任务超时", -3);
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
  if (!url) throw new UcError("UC 没有返回下载地址", -4);
  return url;
}

/** 直链下载所需的请求头。少一个都会被 CDN 挡。 */
export async function downloadHeaders(cookie: string) {
  return {
    "user-agent": DL_UA,
    referer: "https://drive.uc.cn/",
    cookie: await ensureDownloadCookie(cookie),
  };
}

/**
 * 补全 __puus。和夸克同一个毛病：CDN 回调校验登录态，手工粘的 cookie 常缺这个字段。
 * 实测 /member 会通过 Set-Cookie 下发。结果按原始 cookie 缓存，保证取链接和下载用同一套。
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
  url.searchParams.set("pr", "UCBrowser");
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

// ---- 分享 ----

export async function createShare(
  cookie: string,
  fids: string[],
  title: string,
): Promise<{ shareId: string; url: string; passcode: string }> {
  const task = await call<{ task_id: string }>(cookie, "/share", {
    method: "POST",
    body: { fid_list: fids, title, url_type: 1, expired_type: 1 },
  });

  // 分享是异步任务，和夸克一样查 /task
  let shareId = "";
  for (let i = 0; i < 20; i++) {
    const t = await call<{ status: number; share_id?: string; message?: string }>(cookie, "/task", {
      query: { task_id: task.task_id, retry_index: i },
    });
    if (t.status === 2 && t.share_id) {
      shareId = t.share_id;
      break;
    }
    if (t.status === 3) throw new UcError(t.message || "UC 分享任务失败", -4);
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!shareId) throw new UcError("UC 分享任务超时", -5);

  const info = await call<{ share_url?: string; pwd_id?: string; passcode?: string }>(
    cookie,
    "/share/password",
    { method: "POST", body: { share_id: shareId } },
  );
  return {
    shareId,
    url: info.share_url || `https://drive.uc.cn/s/${info.pwd_id ?? shareId}`,
    passcode: info.passcode ?? "",
  };
}

export type ShareEntry = { fid: string; name: string; isDir: boolean; size: number };
export type ShareRaw = { fid: string; file_name: string; dir: boolean; size: number; share_fid_token: string };

export async function shareToken(cookie: string, pwdId: string, passcode: string): Promise<string> {
  const d = await call<{ stoken?: string }>(cookie, "/share/sharepage/token", {
    method: "POST",
    body: { pwd_id: pwdId, passcode },
  });
  if (!d.stoken) throw new UcError("无法获取分享 token（链接无效或提取码错误）", -12);
  return d.stoken;
}

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
  });
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

/** 从分享链接里取 pwd_id：https://drive.uc.cn/s/<pwd_id> */
export function parseShareUrl(input: string): { pwdId: string; passcode: string } {
  const text = input.trim();
  const hit = text.match(/drive\.uc\.cn\/s\/([0-9a-zA-Z]+)/);
  const pwdId = hit ? hit[1] : text.match(/^[0-9a-zA-Z]{8,}$/)?.[0] ?? "";
  if (!pwdId) throw new UcError("无法识别 UC 分享链接", -13);
  const pwd = text.match(/(?:提取码|密码|pwd)[^\w]{0,4}([0-9a-zA-Z]{4})/);
  return { pwdId, passcode: pwd ? pwd[1] : "" };
}

// ---- 扫码登录 ----
// 流程和夸克几乎一致：取 token → 二维码指向 su.uc.cn → 轮询 service_ticket
// → 用 ticket 请求 /account/info 换 cookie。
// 注意：UC 的二维码页面在手机上是「确认登录」页，不是直接登录。
type ScanSession = { token: string; jar: Map<string, string>; createdAt: number };
const scans = new Map<string, ScanSession>();

function qrContent(token: string): string {
  const url = new URL("https://su.uc.cn/1_n0ZCv");
  url.searchParams.set("uc_param_str", "dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt");
  url.searchParams.set("token", token);
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
    "https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=" +
      crypto.randomUUID(),
    { headers: CAS_HEADERS },
  );
  const json = (await res.json()) as { status: number; data?: { members?: { token?: string } } };
  const token = json.data?.members?.token;
  if (json.status !== 2000000 || !token) throw new UcError("获取 UC 扫码 token 失败", -10);

  const jar = new Map<string, string>();
  absorbCookies(res, jar);
  const scanId = crypto.randomUUID();
  scans.set(scanId, { token, jar, createdAt: Date.now() });
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
    `https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=${encodeURIComponent(s.token)}&request_id=${crypto.randomUUID()}`,
    { headers: CAS_HEADERS },
  );
  absorbCookies(res, s.jar);
  const json = (await res.json()) as {
    status: number;
    data?: { members?: { service_ticket?: string } };
  };

  if (json.status === 50004001) return { state: "waiting" };
  if (json.status !== 2000000) {
    if (json.status === 50004002 || json.status === 50004003) return { state: "scanned" };
    return { state: "failed" };
  }

  const ticket = json.data?.members?.service_ticket;
  if (!ticket) return { state: "waiting" };

  // 用 ticket 换 cookie：注意是 drive.uc.cn，不是 api.open.uc.cn（后者 404）
  const info = await fetch("https://drive.uc.cn/account/info?st=" + encodeURIComponent(ticket), {
    headers: { ...CAS_HEADERS, cookie: cookieHeader(s.jar) },
  });
  absorbCookies(info, s.jar);
  const infoJson = (await info.json()) as {
    success?: boolean;
    data?: { nickname?: string; nick_name?: string };
    msg?: string;
  };
  if (!infoJson.success) throw new UcError(infoJson.msg || "UC 票据兑换失败", -11);

  // 关键：__puus 是下载鉴权用的会话主键，必须包含在 cookie 里，
  // 否则直链会返回 403「require login [auth not found]」。
  const jar = s.jar;
  let cookie = cookieHeader(jar);
  if (!jar.has("__puus")) {
    // 补一次首页访问，让服务端下发 __puus
    try {
      const warm = await fetch("https://drive.uc.cn/", {
        headers: { ...CAS_HEADERS, cookie },
      });
      absorbCookies(warm, jar);
      cookie = cookieHeader(jar);
    } catch {
      // 拿不到就先用现有 cookie，下载时会报错
    }
  }

  scans.delete(scanId);
  return {
    state: "waiting",
    cookie,
    nickname: infoJson.data?.nickname || infoJson.data?.nick_name || "UC用户",
  };
}
