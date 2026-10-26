// 百度网盘的网页版内部接口。
// 和夸克/UC 不同，百度有两套：web 接口（/api/*，靠 bdstoken）和
// xpan 开放接口（/rest/2.0/xpan/*，靠 access_token）。这里用 web 接口，
// 因为扫码登录拿到的是网页 cookie，没有 OAuth token。
const PAN = "https://pan.baidu.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "user-agent": UA,
  referer: "https://pan.baidu.com/disk/main",
  accept: "application/json, text/plain, */*",
};

// 直链必须用 pan.baidu.com 作为 UA，否则超过 50MB 的文件直接 403
const DL_UA = "pan.baidu.com";

type Envelope<T> = { errno: number; errmsg?: string; request_id?: number } & T;

export class BaiduError extends Error {
  errno: number;
  constructor(message: string, errno: number) {
    super(message);
    this.errno = errno;
  }
}

// 百度所有接口都返回 errno=0 表示成功，非 0 时消息五花八门
function assertOk(json: { errno?: number; errmsg?: string }): void {
  if (json.errno === 0 || json.errno === undefined) return;
  const msg =
    json.errno === -6
      ? "登录态失效，请重新扫码"
      : json.errno === 9019
        ? "需要验证，请在浏览器里打开百度网盘完成一次验证"
        : json.errmsg || `百度接口错误 ${json.errno}`;
  throw new BaiduError(msg, json.errno);
}

async function get<T>(
  cookie: string,
  path: string,
  query: Record<string, string | number> = {},
): Promise<T> {
  const url = new URL(PAN + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { ...HEADERS, cookie } });
  const text = await res.text();
  let json: Envelope<T>;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new BaiduError(`百度返回了非 JSON 内容（HTTP ${res.status}）`, -1);
  }
  assertOk(json);
  return json;
}

export type BaiduFile = {
  fs_id: number;
  server_filename: string;
  isdir: number;
  size: number;
  server_mtime: number;
  path: string;
};

// bdstoken 是写操作的必填项，藏在首页 HTML 里。取一次缓存 30 分钟。
const tokenCache = new Map<string, { token: string; at: number }>();

export async function bdstoken(cookie: string): Promise<string> {
  const hit = tokenCache.get(cookie);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.token;

  const res = await fetch(`${PAN}/api/gettemplatevariable?fields=${encodeURIComponent('["bdstoken"]')}`, {
    headers: { ...HEADERS, cookie },
  });
  const json = (await res.json()) as { errno: number; result?: { bdstoken?: string } };
  assertOk(json);
  const token = json.result?.bdstoken;
  if (!token) throw new BaiduError("取不到 bdstoken，登录态可能已失效", -6);
  tokenCache.set(cookie, { token, at: Date.now() });
  return token;
}

export async function whoami(cookie: string): Promise<string> {
  const res = await fetch(`${PAN}/api/gettemplatevariable?fields=${encodeURIComponent('["username"]')}`, {
    headers: { ...HEADERS, cookie },
  });
  const json = (await res.json()) as { errno: number; result?: { username?: string } };
  assertOk(json);
  return json.result?.username || "百度用户";
}

export async function capacity(cookie: string): Promise<{
  total: number;
  used: number;
  memberType: string;
  composition: { label: string; size: number }[];
  expiresAt: string | null;
  saveQuota: { used: number; total: number } | null;
}> {
  const json = await get<{ total?: number; used?: number }>(cookie, "/api/quota", {
    checkexpire: 1,
    checkfree: 1,
    clienttype: 0,
    app_id: 250528,
    web: 1,
  });
  const total = (json as { total?: number }).total ?? 0;
  const used = (json as { used?: number }).used ?? 0;
  return {
    total,
    used,
    memberType: "",
    composition: [],
    expiresAt: null,
    // 百度普通用户没有转存额度概念
    saveQuota: null,
  };
}

export async function listFiles(
  cookie: string,
  dir: string,
  page: number,
  size: number,
): Promise<{ list: BaiduFile[]; total: number }> {
  // 百度用路径而不是 fid，根目录是 "/"
  const path = dir && dir !== "0" ? dir : "/";
  const json = await get<{ list?: BaiduFile[] }>(cookie, "/api/list", {
    dir: path,
    order: "time",
    desc: 1,
    showempty: 0,
    web: 1,
    page,
    num: size,
  });
  const list = (json as { list?: BaiduFile[] }).list ?? [];
  return { list, total: list.length };
}

export async function createFolder(cookie: string, pdir: string, name: string): Promise<void> {
  const token = await bdstoken(cookie);
  const path = pdir && pdir !== "0" ? `${pdir}/${name}` : `/${name}`;
  const body = new URLSearchParams({ path, isdir: "1", block_list: "[]" });
  const res = await fetch(
    `${PAN}/api/create?a=commit&bdstoken=${encodeURIComponent(token)}&clienttype=0&app_id=250528&web=1`,
    { method: "POST", headers: { ...HEADERS, cookie, "content-type": "application/x-www-form-urlencoded" }, body },
  );
  assertOk((await res.json()) as { errno: number; errmsg?: string });
}

export async function deleteFiles(cookie: string, paths: string[]): Promise<void> {
  const token = await bdstoken(cookie);
  const body = new URLSearchParams({ filelist: JSON.stringify(paths), async: "0" });
  const res = await fetch(
    `${PAN}/api/filemanager?opera=delete&bdstoken=${encodeURIComponent(token)}&clienttype=0&app_id=250528&web=1`,
    { method: "POST", headers: { ...HEADERS, cookie, "content-type": "application/x-www-form-urlencoded" }, body },
  );
  assertOk((await res.json()) as { errno: number; errmsg?: string });
}

export async function renameFile(cookie: string, path: string, name: string): Promise<void> {
  const token = await bdstoken(cookie);
  const body = new URLSearchParams({ filelist: JSON.stringify([{ path, newname: name }]) });
  const res = await fetch(
    `${PAN}/api/filemanager?opera=rename&bdstoken=${encodeURIComponent(token)}&clienttype=0&app_id=250528&web=1`,
    { method: "POST", headers: { ...HEADERS, cookie, "content-type": "application/x-www-form-urlencoded" }, body },
  );
  assertOk((await res.json()) as { errno: number; errmsg?: string });
}

// 百度目录的 size 恒为 0（和夸克/UC 一样），只能递归累加。
// 参数是路径而不是 fid，所以递归时拼路径。
export async function folderSize(
  cookie: string,
  path: string,
  onProgress?: (dirs: number) => void,
): Promise<{ size: number; files: number; dirs: number }> {
  let size = 0;
  let files = 0;
  let dirs = 0;
  let queue = [path && path !== "0" ? path : "/"];

  while (queue.length) {
    const batch = queue.slice(0, 6);
    queue = queue.slice(6);
    const results = await Promise.all(
      batch.map(async (p) => {
        const out: BaiduFile[] = [];
        for (let page = 1; page <= 20; page++) {
          const r = await listFiles(cookie, p, page, 100);
          out.push(...r.list);
          if (r.list.length < 100) break;
        }
        return out;
      }),
    );
    for (const list of results) {
      dirs++;
      for (const it of list) {
        if (it.isdir === 1) queue.push(it.path);
        else {
          size += it.size;
          files++;
        }
      }
    }
    onProgress?.(dirs);
    if (queue.length) await new Promise((r) => setTimeout(r, 60));
  }
  return { size, files, dirs };
}

/** 拿下载直链。百度的直链要先用 sign+timestamp 换，且必须带 DL_UA 才能下。 */
export async function downloadUrl(cookie: string, fsId: string): Promise<string> {
  const token = await bdstoken(cookie);
  // tplconfig 给出本次会话的 sign/timestamp
  const signJson = await get<{ data?: { sign?: string; timestamp?: number } }>(
    cookie,
    "/share/tplconfig",
    {
      fields: "sign,timestamp",
      channel: "chunlei",
      web: 1,
      app_id: 250528,
      clienttype: 0,
      view_mode: 1,
    },
  );
  const sign = (signJson as { data?: { sign?: string } }).data?.sign;
  const timestamp = (signJson as { data?: { timestamp?: number } }).data?.timestamp;
  if (!sign || !timestamp) throw new BaiduError("百度没有返回 sign/timestamp", -2);

  const body = new URLSearchParams({
    encrypt: "0",
    product: "share",
    fid_list: JSON.stringify([fsId]),
    primaryid: "0",
    uk: "0",
  });
  const url = new URL(`${PAN}/api/download`);
  url.searchParams.set("sign", sign);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("bdstoken", token);
  url.searchParams.set("channel", "chunlei");
  url.searchParams.set("clienttype", "0");
  url.searchParams.set("web", "1");
  url.searchParams.set("app_id", "250528");

  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, cookie, "user-agent": "netdisk;", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    errno: number;
    errmsg?: string;
    dlink?: { dlink?: string }[];
  };
  assertOk(json);
  const dlink = json.dlink?.[0]?.dlink;
  if (!dlink) throw new BaiduError("百度没有返回下载地址", -3);
  // 百度给的 dlink 带 https://d.pcs.baidu.com，要换成 pan.baidu.com 才不会被 403
  return dlink.replace("https://d.pcs.baidu.com", `${PAN}`);
}

export async function downloadHeaders(cookie: string) {
  return {
    "user-agent": DL_UA,
    referer: "https://pan.baidu.com/",
    cookie,
  };
}

// ---- 分享 ----
// 百度的分享体系和夸克/UC 完全不同：
// - 链接是 /s/1xxxxxxxx（surl），不是 pwd_id
// - 读分享要先从分享页 HTML 里抠出 shareid 和 share_uk
// - 转存走 /share/transfer，参数含 sekey（有提取码时）
// - 建分享走 /share/set，要 sign + timestamp + bdstoken

/** 从 https://pan.baidu.com/s/1xxxx 里取 surl（去掉开头的 1） */
export function parseShareUrl(input: string): { pwdId: string; passcode: string } {
  const text = input.trim();
  const hit = text.match(/pan\.baidu\.com\/s\/1([0-9a-zA-Z_-]+)/);
  // 百度的 surl 在接口里不带开头的 1
  const pwdId = hit ? hit[1] : text.match(/^1?([0-9a-zA-Z_-]{8,})$/)?.[1] ?? "";
  if (!pwdId) throw new BaiduError("无法识别百度分享链接", -13);
  const pwd = text.match(/(?:提取码|密码|pwd)[^\w]{0,4}([0-9a-zA-Z]{4})/);
  return { pwdId, passcode: pwd ? pwd[1] : "" };
}

/** 分享页 HTML 里的 shareid / share_uk，转存和建分享都要用 */
export async function shareInfo(
  cookie: string,
  surl: string,
): Promise<{ shareId: string; uk: string }> {
  const res = await fetch(`${PAN}/s/1${surl}`, {
    headers: { ...HEADERS, cookie },
  });
  const html = await res.text();
  const shareId = html.match(/"shareid":\s*"?(\d+)/)?.[1];
  const uk = html.match(/"share_uk":\s*"?(\d+)/)?.[1];
  if (!shareId || !uk) throw new BaiduError("无法从分享页解析出 shareid/uk", -14);
  return { shareId, uk };
}

/** 有提取码时先 verify 换 sekey */
export async function shareToken(
  cookie: string,
  surl: string,
  passcode: string,
): Promise<string> {
  const token = await bdstoken(cookie);
  if (!passcode) return "";
  const res = await fetch(
    `${PAN}/share/verify?surl=${encodeURIComponent(surl)}&t=${Date.now()}&bdstoken=${encodeURIComponent(token)}&channel=chunlei&clienttype=0&web=1&app_id=250528`,
    {
      method: "POST",
      headers: { ...HEADERS, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pwd: passcode }),
    },
  );
  const json = (await res.json()) as { errno: number; randsk?: string };
  if (json.errno !== 0 || !json.randsk) throw new BaiduError("提取码错误", json.errno || -15);
  return json.randsk;
}

export type ShareRaw = {
  fs_id: number;
  server_filename: string;
  isdir: number;
  size: number;
  path: string;
};

export async function listShare(
  cookie: string,
  surl: string,
  sekey: string,
  dir: string,
): Promise<{ list: ShareRaw[]; raw: ShareRaw[] }> {
  const token = await bdstoken(cookie);
  const { shareId, uk } = await shareInfo(cookie, surl);
  const url = new URL(`${PAN}/share/list`);
  url.searchParams.set("shorturl", surl);
  url.searchParams.set("root", "1");
  url.searchParams.set("page", "1");
  url.searchParams.set("num", "100");
  url.searchParams.set("order", "time");
  url.searchParams.set("desc", "1");
  url.searchParams.set("showempty", "0");
  url.searchParams.set("web", "1");
  url.searchParams.set("channel", "chunlei");
  url.searchParams.set("clienttype", "0");
  url.searchParams.set("app_id", "250528");
  url.searchParams.set("bdstoken", token);
  url.searchParams.set("dir", dir || "/");
  if (sekey) url.searchParams.set("sekey", sekey);

  const res = await fetch(url, {
    headers: { ...HEADERS, cookie, referer: `https://pan.baidu.com/s/1${surl}` },
  });
  const json = (await res.json()) as { errno: number; errmsg?: string; list?: ShareRaw[] };
  assertOk(json);
  const raw = json.list ?? [];
  return { raw, list: raw };
}

export async function saveShare(
  cookie: string,
  surl: string,
  sekey: string,
  fsIds: string[],
  _tokens: string[],
  toPdir: string,
): Promise<void> {
  const token = await bdstoken(cookie);
  const { shareId, uk } = await shareInfo(cookie, surl);
  const body = new URLSearchParams({
    fsidlist: JSON.stringify(fsIds.map(Number)),
    path: toPdir && toPdir !== "0" ? toPdir : "/",
  });
  const url = new URL(`${PAN}/share/transfer`);
  url.searchParams.set("shareid", shareId);
  url.searchParams.set("from", uk);
  url.searchParams.set("bdstoken", token);
  url.searchParams.set("channel", "chunlei");
  url.searchParams.set("clienttype", "0");
  url.searchParams.set("web", "1");
  url.searchParams.set("app_id", "250528");
  if (sekey) url.searchParams.set("sekey", sekey);

  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { errno: number; errmsg?: string };
  assertOk(json);
}

export async function createShare(
  cookie: string,
  fsIds: string[],
  title: string,
): Promise<{ shareId: string; url: string; passcode: string }> {
  const token = await bdstoken(cookie);
  const signJson = await get<{ data?: { sign?: string; timestamp?: number } }>(
    cookie,
    "/share/tplconfig",
    { fields: "sign,timestamp", channel: "chunlei", web: 1, app_id: 250528, clienttype: 0, view_mode: 1 },
  );
  const sign = (signJson as { data?: { sign?: string } }).data?.sign;
  const timestamp = (signJson as { data?: { timestamp?: number } }).data?.timestamp;
  if (!sign || !timestamp) throw new BaiduError("百度没有返回 sign/timestamp", -2);

  const body = new URLSearchParams({
    period: "0",
    pwd: "",
    eflag: "0",
    channel_list: "[]",
    schannel: "4",
    fid_list: JSON.stringify(fsIds.map(Number)),
  });
  const url = new URL(`${PAN}/share/set`);
  url.searchParams.set("sign", sign);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("bdstoken", token);
  url.searchParams.set("channel", "chunlei");
  url.searchParams.set("clienttype", "0");
  url.searchParams.set("web", "1");
  url.searchParams.set("app_id", "250528");

  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { errno: number; errmsg?: string; link?: string; shorturl?: string; pwd?: string };
  assertOk(json);
  const shorturl = json.shorturl ?? "";
  if (!shorturl) throw new BaiduError("百度没有返回分享链接", -16);
  return {
    shareId: shorturl,
    url: `https://pan.baidu.com/s/1${shorturl}`,
    passcode: json.pwd ?? "",
  };
}

// ---- 扫码登录 ----
// 流程：getqrcode 拿 sign + 二维码图 → 轮询 channel/unicast（30 秒长轮询）
// → 扫码后返回 v（登录票据）→ 用 v 请求 login 换 cookie。
// 注意 unicast 是长轮询，轮询请求会挂 30 秒，不能让前端每秒打一次。
type ScanSession = {
  sign: string;
  img: string;
  jar: Map<string, string>;
  createdAt: number;
};

const scans = new Map<string, ScanSession>();

const CAS_HEADERS = {
  "user-agent": UA,
  referer: "https://pan.baidu.com/",
  accept: "application/json, text/plain, */*",
};

function absorbCookies(res: Response, jar: Map<string, string>): void {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

// 百度返回的是 callback(...) 形式，要剥掉外壳
function stripJsonp(text: string): string {
  const m = text.match(/^[^(]*\((.*)\)[^)]*$/s);
  return m ? m[1] : text;
}

export async function startScan(): Promise<{ scanId: string; img: string }> {
  const gid = crypto.randomUUID().replace(/-/g, "").slice(0, 32).toUpperCase();
  const res = await fetch(
    `${PAN.replace("pan.", "passport.")}/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=${gid}&tpl=netdisk&apiver=v3&callback=cb`,
    { headers: CAS_HEADERS },
  );
  const json = JSON.parse(stripJsonp(await res.text())) as {
    errno: number;
    sign?: string;
    imgurl?: string;
  };
  if (json.errno !== 0 || !json.sign || !json.imgurl) throw new BaiduError("获取百度二维码失败", -10);

  const jar = new Map<string, string>();
  absorbCookies(res, jar);
  const scanId = crypto.randomUUID();
  scans.set(scanId, {
    sign: json.sign,
    img: "https://" + json.imgurl.replace(/\\\//g, "/"),
    jar,
    createdAt: Date.now(),
  });
  for (const [id, s] of scans) if (Date.now() - s.createdAt > 10 * 60_000) scans.delete(id);

  return { scanId, img: scans.get(scanId)!.img };
}

export type ScanState = "waiting" | "scanned" | "expired" | "failed";

/** 轮询扫码状态。unicast 是长轮询，单次会挂最多 30 秒。 */
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
    `${PAN.replace("pan.", "passport.")}/channel/unicast?channel_id=${encodeURIComponent(s.sign)}&tpl=netdisk&apiver=v3&callback=cb`,
    { headers: CAS_HEADERS },
  );
  absorbCookies(res, s.jar);
  const json = JSON.parse(stripJsonp(await res.text())) as {
    errno: number;
    channel_v?: string;
  };

  // errno=1 是还没扫码；0 表示扫了，channel_v 里是登录票据
  if (json.errno === 1) return { state: "waiting" };
  if (json.errno !== 0) return { state: "failed" };

  const v = json.channel_v;
  if (!v) return { state: "waiting" };

  // 用票据换 cookie
  const login = await fetch(
    `${PAN.replace("pan.", "passport.")}/v2/api/login?tpl=netdisk&apiver=v3&callback=cb`,
    {
      method: "POST",
      headers: { ...CAS_HEADERS, cookie: cookieHeader(s.jar), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ v, tpl: "netdisk", apiver: "v3", tt: String(Date.now()), u: "https://pan.baidu.com/" }),
    },
  );
  absorbCookies(login, s.jar);
  const loginJson = JSON.parse(stripJsonp(await login.text())) as {
    errno: number;
    data?: { username?: string };
  };
  if (loginJson.errno !== 0) throw new BaiduError("百度登录失败", loginJson.errno);

  // 补一次首页，拿到 BDUSS 等完整登录态
  const warm = await fetch(`${PAN}/disk/main`, { headers: { ...CAS_HEADERS, cookie: cookieHeader(s.jar) } });
  absorbCookies(warm, s.jar);

  scans.delete(scanId);
  return {
    state: "waiting",
    cookie: cookieHeader(s.jar),
    nickname: loginJson.data?.username || "百度用户",
  };
}
