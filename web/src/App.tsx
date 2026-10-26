import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AuthState } from "./api.ts";
import {
  PLATFORM_NAMES,
  type Account,
  type FileItem,
  type Share,
  type Session,
  type Capacity,
  type ShareGroup,
  type Platform,
  type Resource,
} from "../../shared/types.ts";

const fmtCap = (n: number) => {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i <= 1 ? 0 : 1)} ${u[i]}`;
};

// 文件大小：文件用 KB/MB 就够，目录会到 GB/TB，统一用 fmtCap
const fmtSize = (n: number) =>
  n <= 0 ? "-" : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : fmtCap(n);

const fmtTime = (t: number) =>
  t ? new Date(t > 1e12 ? t : t * 1000).toLocaleString("zh-CN") : "-";

// 目录大小要递归遍历，算好之前先显示状态
const dirSizeText = (s?: DirSize) => {
  if (!s || s.status === "idle") return "计算中…";
  if (s.status === "error") return "无法计算";
  if (s.status === "running") return s.dirs ? `计算中 ${s.dirs} 个目录` : "计算中…";
  return `${fmtSize(s.size)} · ${s.files} 个文件`;
};

// 明文 HTTP 下 navigator.clipboard 不可用，手机上会直接抛错，需要退回 execCommand。
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 落到下面的兜底
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// 单条分享：分组下拉 + 分享/复制/移除
function ShareRow({ share: s, groups, onGroup, onRemove, onShare, onCopy }: {
  share: Share;
  groups: ShareGroup[];
  onGroup: (id: string, groupId: string | null) => void;
  onRemove: (id: string) => void;
  onShare: (s: Share) => void;
  onCopy: (t: string) => void;
}) {
  return (
    <li>
      <strong>{s.title}</strong>
      <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
      <small>提取码 {s.passcode || "无"} · {new Date(s.createdAt).toLocaleString("zh-CN")}</small>
      {groups.length > 0 && (
        <select
          value={s.groupId ?? ""}
          onChange={(e) => onGroup(s.id, e.target.value || null)}
          aria-label="移动到分组"
        >
          <option value="">未分组</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      )}
      <div className="ops">
        <button onClick={() => onShare(s)}>分享</button>
        <button onClick={() => onCopy(`${s.url} 提取码 ${s.passcode}`)}>复制</button>
        <button className="danger" onClick={() => onRemove(s.id)}>移除</button>
      </div>
    </li>
  );
}

type DirSize = { status: "idle" | "running" | "done" | "error"; size: number; files: number; dirs: number };

// 容量可视化：环形图 + 明细。用 SVG 画，不引图表库。
function CapacityCard({ cap }: { cap: Capacity }) {
  const pct = cap.total ? (cap.used / cap.total) * 100 : 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  const dash = (Math.min(100, pct) / 100) * C;

  return (
    <section className="capacity">
      <div className="cap-ring">
        <svg viewBox="0 0 130 130" role="img" aria-label={`已用 ${pct.toFixed(1)}%`}>
          <circle cx="65" cy="65" r={R} fill="none" stroke="#eef2f9" strokeWidth="13" />
          <circle
            cx="65"
            cy="65"
            r={R}
            fill="none"
            stroke="url(#capGrad)"
            strokeWidth="13"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${C}`}
            transform="rotate(-90 65 65)"
          />
          <defs>
            <linearGradient id="capGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#2f6fed" />
              <stop offset="100%" stopColor="#7aa7f7" />
            </linearGradient>
          </defs>
          <text x="65" y="61" textAnchor="middle" className="ring-pct">
            {pct.toFixed(1)}%
          </text>
          <text x="65" y="79" textAnchor="middle" className="ring-sub">
            已用
          </text>
        </svg>
      </div>

      <div className="cap-detail">
        <div className="cap-row">
          <span>总容量</span>
          <strong>{fmtCap(cap.total)}</strong>
        </div>
        <div className="cap-row">
          <span>已使用</span>
          <strong className="blue">{fmtCap(cap.used)}</strong>
        </div>
        <div className="cap-row">
          <span>剩余</span>
          <strong className="green">{fmtCap(cap.total - cap.used)}</strong>
        </div>
        {cap.expiresAt && (
          <div className="cap-row">
            <span>会员到期</span>
            <strong>{cap.expiresAt}</strong>
          </div>
        )}
        {cap.composition.length > 0 && (
          <div className="cap-extra">
            <span className="hint">额外容量</span>
            {cap.composition.map((c) => (
              <span key={c.label} className="tag">
                {c.label} {fmtCap(c.size)}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [registerMode, setRegisterMode] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [cookie, setCookie] = useState("");
  const [qr, setQr] = useState("");
  // 百度直接给图片地址，夸克/UC 给 SVG 字符串
  const [qrImg, setQrImg] = useState("");
  const [scanPlatform, setScanPlatform] = useState<Platform>("quark");
  const [scanHint, setScanHint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [path, setPath] = useState<{ fid: string; name: string }[]>([
    { fid: "0", name: "根目录" },
  ]);
  const pdir = path.at(-1)!.fid;
  const [items, setItems] = useState<FileItem[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [shares, setShares] = useState<Share[]>([]);
  const [groups, setGroups] = useState<ShareGroup[]>([]);
  const [cap, setCap] = useState<Capacity | null>(null);
  // 目录大小：key 是 fid，后台算，算好再填
  const [sizes, setSizes] = useState<Record<string, DirSize>>({});
  const [tab, setTab] = useState<"files" | "resources">("files");
  const [resources, setResources] = useState<Resource[]>([]);

  const refreshSession = useCallback(async () => {
    setSession(await api.get<Session>("/api/session"));
  }, []);

  const refreshFiles = useCallback(async (dir: string) => {
    const page = await api.get<{ items: FileItem[] }>(`/api/files?pdir=${encodeURIComponent(dir)}`);
    setItems(page.items);
    setChecked(new Set());
    // 目录大小后台算，不阻塞列表渲染
    for (const item of page.items) {
      if (item.isDir) void pollSize(item.fid);
    }
  }, []);

  const pollSize = useCallback(async (fid: string) => {
    try {
      const s = await api.get<DirSize>(`/api/folder-size?fid=${encodeURIComponent(fid)}`);
      setSizes((prev) => ({ ...prev, [fid]: s }));
      if (s.status === "running") setTimeout(() => void pollSize(fid), 2500);
    } catch {
      // 算不出来就保持空，不打扰用户
    }
  }, []);

  const refreshShares = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([
        api.get<Share[]>("/api/shares"),
        api.get<ShareGroup[]>("/api/groups"),
      ]);
      setShares(s);
      setGroups(g);
    } catch {
      setShares([]);
      setGroups([]);
    }
  }, []);

  const refreshCap = useCallback(async () => {
    try {
      setCap(await api.get<Capacity>("/api/capacity"));
    } catch {
      setCap(null);
    }
  }, []);

  const refreshResources = useCallback(async () => {
    try {
      setResources(await api.get<Resource[]>("/api/resources"));
    } catch {
      setResources([]);
    }
  }, []);

  useEffect(() => {
    api
      .get<AuthState>("/api/auth")
      .then(setAuth)
      .catch((e: Error) => setError(e.message));
  }, []);

  // 先确认口令再拉数据，否则未登录时 401 会被当成业务错误弹红条
  useEffect(() => {
    if (!auth?.ok) return;
    refreshSession().catch((e: Error) => setError(e.message));
  }, [auth?.ok, refreshSession]);

  const activeId = session?.activeId ?? null;

  useEffect(() => {
    if (!activeId) return;
    setPath([{ fid: "0", name: "根目录" }]);
    refreshFiles("0").catch((e: Error) => setError(e.message));
    refreshShares().catch(() => {});
    refreshCap().catch(() => {});
    refreshResources().catch(() => {});
  }, [activeId, refreshFiles, refreshShares, refreshCap, refreshResources]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const loginWithPassword = () =>
    run(async () => {
      await api.post(registerMode ? "/api/register" : "/api/login", { username, password });
      setPassword("");
      setAuth(await api.get<AuthState>("/api/auth"));
      await refreshSession();
    });

  const logoutUser = () =>
    run(async () => {
      await api.post("/api/logout");
      setSession(null);
      setAuth(await api.get<AuthState>("/api/auth"));
    });

  const login = () =>
    run(async () => {
      await api.post("/api/accounts", { cookie, platform: scanPlatform });
      setCookie("");
      await refreshSession();
    });

  // 扫码：拿二维码后每 2 秒问一次，done 时后端已把账号存好
  const scanTimer = useRef<number | null>(null);
  const stopScan = () => {
    if (scanTimer.current) window.clearInterval(scanTimer.current);
    scanTimer.current = null;
  };

  useEffect(() => stopScan, []);

  const startScan = () =>
    run(async () => {
      stopScan();
      setScanHint("正在生成二维码…");
      setQr("");
      setQrImg("");
      const r = await api.post<{ scanId: string; qr?: string; img?: string }>("/api/scan/start", {
        platform: scanPlatform,
      });
      if (r.img) setQrImg(r.img);
      else setQr(r.qr ?? "");
      setScanHint(
        scanPlatform === "baidu"
          ? "用百度 App 扫码登录"
          : scanPlatform === "uc"
            ? "用 UC 浏览器扫码并在手机上确认"
            : "用夸克 App 扫码并在手机上确认",
      );

      scanTimer.current = window.setInterval(() => {
        api
          .get<{ state: string }>(`/api/scan/poll/${r.scanId}?platform=${scanPlatform}`)
          .then(async (res) => {
            if (res.state === "waiting") return;
            if (res.state === "scanned") {
              setScanHint("已扫码，请在手机上确认登录");
              return;
            }
            stopScan();
            if (res.state === "done") {
              setQr("");
              setQrImg("");
              setScanHint("");
              await refreshSession();
              return;
            }
            setScanHint(res.state === "expired" ? "二维码已过期，请刷新" : "登录失败，请重试");
          })
          .catch((e: Error) => {
            stopScan();
            setError(e.message);
          });
        // 百度是 30 秒长轮询，问太快会堆积请求
      }, scanPlatform === "baidu" ? 3000 : 2000);
    });

  const logout = (id: string) =>
    run(async () => {
      await api.del(`/api/accounts/${id}`);
      await refreshSession();
    });

  const switchTo = (id: string) =>
    run(async () => {
      await api.post(`/api/accounts/${id}/active`);
      await refreshSession();
    });

  const enter = (item: FileItem) => {
    if (!item.isDir) return;
    setPath((p) => [...p, { fid: item.fid, name: item.name }]);
    run(() => refreshFiles(item.fid));
  };

  const goBack = (index: number) => {
    const next = path.slice(0, index + 1);
    setPath(next);
    run(() => refreshFiles(next.at(-1)!.fid));
  };

  const newFolder = () =>
    run(async () => {
      const name = window.prompt("新建文件夹名称");
      if (!name?.trim()) return;
      await api.post("/api/folder", { pdir, name });
      await refreshFiles(pdir);
    });

  const rename = (item: FileItem) =>
    run(async () => {
      const name = window.prompt("新名称", item.name);
      if (!name?.trim() || name === item.name) return;
      await api.post("/api/rename", { fid: item.fid, name });
      await refreshFiles(pdir);
    });

  const remove = (list: string[]) =>
    run(async () => {
      if (!window.confirm(`确认删除选中的 ${list.length} 项？`)) return;
      await api.post("/api/delete", { fids: list });
      await refreshFiles(pdir);
    });

  const share = (list: string[]) =>
    run(async () => {
      const title = window.prompt("分享标题", "我的分享") ?? "我的分享";
      await api.post("/api/shares", { fids: list, title });
      await refreshShares();
      window.alert("已创建分享，见右侧列表");
    });

  const copy = async (text: string) => {
    const ok = await copyText(text);
    if (!ok) window.prompt("复制失败，请手动复制：", text);
  };

  // 拿直链。百度/UC 的直链必须带特定 UA 才能下，浏览器直接开会 403，
  // 所以优先复制给下载器，同时提供直接打开。
  const download = (item: FileItem) =>
    run(async () => {
      const { url } = await api.post<{ url: string }>("/api/download", { fid: item.fid });
      // 只复制直链本身，带上文件名会让下载器把整串当成 URL
      await copy(url);
      window.alert(
        `直链已复制（${item.name}）\n\n粘到 IDM / 迅雷 / Motrix 等下载器使用。\n浏览器直接打开会 403，因为登录 cookie 在服务端。`,
      );
    });

  // 走服务端代理：cookie 由后端补上，浏览器能直接下，代价是占服务器带宽
  const streamDownload = (item: FileItem) => {
    const q = new URLSearchParams({ fid: item.fid, name: item.name });
    window.location.href = `/api/download/stream?${q}`;
  };

  const shareLink = async (s: Share) => {
    const text = `${s.url} 提取码 ${s.passcode}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: s.title, text, url: s.url });
        return;
      } catch {
        return; // 用户取消，不报错
      }
    }
    await copy(text);
  };

  const newGroup = () =>
    run(async () => {
      const name = window.prompt("分组名称");
      if (!name?.trim()) return;
      await api.post("/api/groups", { name });
      await refreshShares();
    });

  const assignGroup = (shareId: string, groupId: string | null) =>
    run(async () => {
      await api.post(`/api/shares/${shareId}/group`, { groupId });
      await refreshShares();
    });

  const removeShare = (id: string) =>
    run(async () => {
      await api.del(`/api/shares/${id}`);
      await refreshShares();
    });

  const toggle = (fid: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(fid) ? next.delete(fid) : next.add(fid);
      return next;
    });

  const addResource = () =>
    run(async () => {
      const sourceUrl = window.prompt("粘贴别人的分享链接（如 https://pan.quark.cn/s/xxx）");
      if (!sourceUrl?.trim()) return;
      const title = window.prompt("资源标题", "未命名资源") || "未命名资源";
      const sourcePasscode = window.prompt("提取码（没有就留空）", "") || "";
      await api.post("/api/resources", { title, sourceUrl, sourcePasscode });
      await refreshResources();
    });

  // 点「获取」：第一次会触发转存+建分享，可能要等几秒
  const claimResource = (r: Resource) =>
    run(async () => {
      const res = await api.post<{ url: string; passcode: string }>(`/api/resources/${r.id}/claim`);
      await refreshResources();
      await copy(`${res.url}${res.passcode ? ` 提取码 ${res.passcode}` : ""}`);
      window.alert(`已生成你的分享链接并复制：\n${res.url}`);
    });

  const removeResource = (id: string) =>
    run(async () => {
      if (!window.confirm("删除这条资源？已生成的分享链接不会失效。")) return;
      await api.del(`/api/resources/${id}`);
      await refreshResources();
    });

  const selected = [...checked];

  if (!auth) return <div className="app" />;

  if (auth.required && !auth.ok) {
    return (
      <div className="app">
        <div className="gate">
          <div className="logo">夸</div>
          <h1>网盘推广聚合</h1>
          <p className="hint">{registerMode ? "注册新账号" : "请登录后使用"}</p>
          {error && (
            <div className="error" onClick={() => setError("")}>
              {error}
            </div>
          )}
          <form
            className="login"
            onSubmit={(e) => {
              e.preventDefault();
              loginWithPassword();
            }}
          >
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="用户名"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={registerMode ? "密码（至少 6 位）" : "密码"}
              autoComplete={registerMode ? "new-password" : "current-password"}
            />
            <button
              type="submit"
              className="primary"
              disabled={busy || !username || !password}
            >
              {registerMode ? "注册并登录" : "登录"}
            </button>
          </form>
          {auth.canRegister && (
            <button
              className="link"
              onClick={() => {
                setRegisterMode(!registerMode);
                setError("");
              }}
            >
              {registerMode ? "已有账号？去登录" : "没有账号？注册一个"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <span className="brand-dot" />
        <h1>网盘推广聚合</h1>
        <span className={activeId ? "pill" : "pill off"}>
          {busy ? "处理中…" : activeId ? "已连接" : "未登录"}
        </span>
        {session?.user && (
          <span className="who">
            {session.user.username}
            <button className="link" onClick={logoutUser} disabled={busy}>
              退出
            </button>
          </span>
        )}
      </header>

      {error && (
        <div className="error" onClick={() => setError("")}>
          {error}
        </div>
      )}

      <section className="scan">
        {!activeId && !qr && !qrImg && (
          <p className="hint" style={{ margin: "0 0 10px" }}>
            还没有连接网盘账号，选择平台后扫码即可浏览和管理网盘资源
          </p>
        )}
        {!qr && !qrImg ? (
          <>
            <div className="platforms">
              {(Object.keys(PLATFORM_NAMES) as Platform[]).map((p) => (
                <button
                  key={p}
                  className={scanPlatform === p ? "on" : ""}
                  onClick={() => setScanPlatform(p)}
                  disabled={busy}
                >
                  {PLATFORM_NAMES[p]}
                </button>
              ))}
            </div>
            <button className={activeId ? "" : "primary"} onClick={startScan} disabled={busy}>
              {activeId ? `添加另一个${PLATFORM_NAMES[scanPlatform]}账号` : `扫码登录${PLATFORM_NAMES[scanPlatform]}`}
            </button>
          </>
        ) : (
          <div className="qr-box">
            {qrImg ? (
              <img className="qr-img" src={qrImg} alt="登录二维码" />
            ) : (
              <div className="qr-img" dangerouslySetInnerHTML={{ __html: qr }} />
            )}
            <p className="hint">{scanHint}</p>
            <button onClick={startScan} disabled={busy}>
              刷新二维码
            </button>
          </div>
        )}
        <details className="manual">
          <summary>或用 Cookie 登录</summary>
          <div className="login">
            <input
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder={`粘贴 ${PLATFORM_NAMES[scanPlatform]} 的 Cookie`}
            />
            <button onClick={login} disabled={busy || !cookie.trim()}>
              登录
            </button>
          </div>
        </details>
      </section>

      {session && session.accounts.length > 0 && (
        <ul className="accounts">
          {session.accounts.map((a: Account) => (
            <li key={a.id} className={a.id === activeId ? "on" : ""}>
              <button className="link" onClick={() => switchTo(a.id)}>
                {a.nickname}
              </button>
              <span className="tag">{PLATFORM_NAMES[a.platform] ?? a.platform}</span>
              <small>{a.cookieHint}</small>
              <button className="del" onClick={() => logout(a.id)}>
                移除
              </button>
            </li>
          ))}
        </ul>
      )}

      {cap && cap.total > 0 && <CapacityCard cap={cap} />}

      {activeId && (
        <div className="tabs">
          <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
            网盘
          </button>
          <button className={tab === "resources" ? "on" : ""} onClick={() => setTab("resources")}>
            资源站 {resources.length > 0 && <span className="count">{resources.length}</span>}
          </button>
        </div>
      )}

      {activeId && tab === "resources" && (
        <main>
          <div className="files">
            <div className="toolbar">
              <button className="primary" onClick={addResource} disabled={busy}>
                添加资源
              </button>
              <span className="hint">
                用户点「获取」时，后端自动转存到你网盘并生成你的分享链接
              </span>
            </div>
            {resources.length === 0 && (
              <p className="hint">还没有资源。点「添加资源」粘贴别人的分享链接。</p>
            )}
            <ul className="resources">
              {resources.map((r) => (
                <li key={r.id}>
                  <div className="res-head">
                    <strong>{r.title}</strong>
                    <span className={r.ownUrl ? "tag ok" : "tag"}>
                      {r.status === "ready" ? "已就绪" : r.status === "failed" ? "失败" : "未转存"}
                    </span>
                  </div>
                  {r.description && <p className="res-desc">{r.description}</p>}
                  <small className="res-src">来源：{r.sourceUrl}</small>
                  {r.ownUrl && (
                    <small className="res-own">
                      你的链接：<a href={r.ownUrl} target="_blank" rel="noreferrer">{r.ownUrl}</a>
                      {r.ownPasscode && ` 提取码 ${r.ownPasscode}`}
                      {` · 被获取 ${r.hits} 次`}
                    </small>
                  )}
                  {r.error && <small className="res-err">{r.error}</small>}
                  <div className="ops">
                    <button onClick={() => claimResource(r)} disabled={busy}>
                      {r.ownUrl ? "复制链接" : "转存并生成链接"}
                    </button>
                    <button className="danger" onClick={() => removeResource(r.id)} disabled={busy}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </main>
      )}

      {activeId && tab === "files" ? (
        <main>
        <div className="files">
          <nav>
            {path.map((p, i) => (
              <button key={p.fid + i} onClick={() => goBack(i)} disabled={i === path.length - 1}>
                {p.name}
              </button>
            ))}
          </nav>

          <div className="toolbar">
            <button onClick={newFolder} disabled={!activeId || busy}>
              新建文件夹
            </button>
            <button onClick={() => share(selected)} disabled={!selected.length || busy}>
              分享选中
            </button>
            <button onClick={() => remove(selected)} disabled={!selected.length || busy}>
              删除选中
            </button>
            <span className="hint">{items.length} 项</span>
          </div>

          <ul className="list">
            {items.map((item) => (
              <li key={item.fid} className={checked.has(item.fid) ? "on" : ""}>
                <input
                  type="checkbox"
                  checked={checked.has(item.fid)}
                  onChange={() => toggle(item.fid)}
                  aria-label={`选择 ${item.name}`}
                />
                <button
                  className={item.isDir ? "name" : "name static"}
                  onClick={() => enter(item)}
                  title={item.name}
                >
                  <span className="ico">{item.isDir ? "📁" : "📄"}</span>
                  <span className="txt">{item.name}</span>
                  <small>
                    {item.isDir ? dirSizeText(sizes[item.fid]) : fmtSize(item.size)}
                    {!item.isDir && item.size > 0 && " · "}
                    {!item.isDir && fmtTime(item.updatedAt)}
                  </small>
                </button>
                <div className="ops">
                  {!item.isDir && <button onClick={() => download(item)}>直链</button>}
                  {!item.isDir && <button onClick={() => streamDownload(item)}>下载</button>}
                  <button onClick={() => share([item.fid])}>分享</button>
                  <button onClick={() => rename(item)}>改名</button>
                  <button className="danger" onClick={() => remove([item.fid])}>
                    删除
                  </button>
                </div>
                <details className="more">
                  <summary aria-label="更多操作">⋯</summary>
                  <div>
                    {!item.isDir && <button onClick={() => download(item)}>获取直链</button>}
                    {!item.isDir && <button onClick={() => streamDownload(item)}>浏览器下载</button>}
                    <button onClick={() => share([item.fid])}>分享</button>
                    <button onClick={() => rename(item)}>改名</button>
                    <button className="danger" onClick={() => remove([item.fid])}>
                      删除
                    </button>
                  </div>
                </details>
              </li>
            ))}
          </ul>
          {items.length === 0 && activeId && <p className="hint">这个目录是空的</p>}
        </div>

        <aside className="shares">
          <div className="shares-head">
            <h2>分享链接</h2>
            <button onClick={newGroup} disabled={busy}>
              新建分组
            </button>
          </div>
          {shares.length === 0 && <p className="hint">还没有分享</p>}
          {groups.map((g) => {
            const inGroup = shares.filter((s) => s.groupId === g.id);
            return (
              <div key={g.id} className="group">
                <div className="group-head">
                  <strong>{g.name}</strong>
                  <span className="hint">{inGroup.length}</span>
                  <button
                    className="danger"
                    onClick={() =>
                      run(async () => {
                        if (!window.confirm(`删除分组「${g.name}」？组内分享会退回未分组`)) return;
                        await api.del(`/api/groups/${g.id}`);
                        await refreshShares();
                      })
                    }
                  >
                    删组
                  </button>
                </div>
                {inGroup.length === 0 && <p className="hint">空</p>}
                <ul>
                  {inGroup.map((s) => (
                    <ShareRow key={s.id} share={s} groups={groups} onGroup={assignGroup} onRemove={removeShare} onShare={shareLink} onCopy={copy} />
                  ))}
                </ul>
              </div>
            );
          })}
          <ul>
            {shares.filter((s) => !s.groupId).map((s) => (
              <ShareRow key={s.id} share={s} groups={groups} onGroup={assignGroup} onRemove={removeShare} onShare={shareLink} onCopy={copy} />
            ))}
          </ul>
        </aside>
        </main>
      ) : (
        !activeId && <p className="empty">扫码登录后在这里浏览网盘资源</p>
      )}
    </div>
  );
}
