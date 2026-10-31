import { useState } from "react";

type Channel = {
  id: string;
  name: string;
  cat: string;
  status: string;
  link: string;
  note: string;
};

const CATS = ["短视频", "图文", "社群", "电商", "工具", "其他"];
const STATUSES = ["已上线", "测试中", "待启动", "已搁置"];
const KEY = "trafficExplore.v1";

// 网盘推广只是其中一条：已部署的聚合工具
const SEED: Channel[] = [
  { id: "seed-1", name: "网盘转存聚合工具", cat: "工具", status: "已上线", link: "", note: "本项目：夸克/UC/百度转存+分享聚合，作为资源承接与分发入口" },
  { id: "seed-2", name: "小红书", cat: "图文", status: "测试中", link: "", note: "资源合集笔记 + 关键词布局，评论区/群聊引流" },
  { id: "seed-3", name: "抖音", cat: "短视频", status: "待启动", link: "", note: "" },
  { id: "seed-4", name: "B站", cat: "短视频", status: "待启动", link: "", note: "资源合集视频 + 置顶评论挂链接" },
  { id: "seed-5", name: "知乎", cat: "图文", status: "待启动", link: "", note: "回答「XX资源哪里找」类问题" },
  { id: "seed-6", name: "微信公众号", cat: "图文", status: "待启动", link: "", note: "" },
  { id: "seed-7", name: "QQ/微信社群", cat: "社群", status: "待启动", link: "", note: "" },
  { id: "seed-8", name: "百度贴吧", cat: "社群", status: "待启动", link: "", note: "" },
  { id: "seed-9", name: "闲鱼", cat: "电商", status: "待启动", link: "", note: "虚拟资源链接挂闲鱼" },
  { id: "seed-10", name: "网盘搜索引擎收录", cat: "工具", status: "待启动", link: "", note: "" },
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const load = (): Channel[] => {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? "");
    if (Array.isArray(arr)) return arr.filter((x) => x && typeof x.name === "string");
  } catch {
    // 没存过或坏了就用种子
  }
  return SEED;
};

// 引流渠道管理：本地存储，导入导出 JSON
export default function Channels({ toast }: { toast: (text: string, tone?: "ok" | "err") => void }) {
  const [list, setList] = useState<Channel[]>(load);
  const [cat, setCat] = useState("全部");
  const [kw, setKw] = useState("");
  const [editing, setEditing] = useState<Channel | null>(null);
  const [showForm, setShowForm] = useState(false);

  const save = (next: Channel[]) => {
    setList(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  };

  const openForm = (c: Channel | null) => {
    setEditing(c);
    setShowForm(true);
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    if (!name) return;
    const data = {
      name,
      cat: String(f.get("cat")),
      status: String(f.get("status")),
      link: String(f.get("link") ?? "").trim(),
      note: String(f.get("note") ?? "").trim(),
    };
    if (editing) save(list.map((x) => (x.id === editing.id ? { ...x, ...data } : x)));
    else save([...list, { id: "c" + Date.now().toString(36), ...data }]);
    setShowForm(false);
    toast("已保存");
  };

  const remove = (c: Channel) => {
    if (!confirm(`删除「${c.name}」？`)) return;
    save(list.filter((x) => x.id !== c.id));
    toast("已删除");
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "引流渠道.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = (file: File) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const arr = JSON.parse(String(r.result));
        if (!Array.isArray(arr) || !arr.every((x) => x && typeof x.name === "string")) throw 0;
        save(
          arr.map((x) => ({
            id: String(x.id ?? "c" + Math.random().toString(36).slice(2)),
            name: String(x.name),
            cat: String(x.cat ?? "其他"),
            status: String(x.status ?? "待启动"),
            link: String(x.link ?? ""),
            note: String(x.note ?? ""),
          })),
        );
        toast(`已导入 ${arr.length} 条`);
      } catch {
        toast("导入失败：不是合法的渠道 JSON", "err");
      }
    };
    r.readAsText(file, "utf-8");
  };

  const rows = list
    .filter((x) => cat === "全部" || x.cat === cat)
    .filter((x) => !kw || (x.name + " " + x.note).toLowerCase().includes(kw.toLowerCase()));
  const st = (s: string) => list.filter((x) => x.status === s).length;

  return (
    <div className="channels">
      <div className="stats">
        <div className="stat"><b>{list.length}</b><span>渠道总数</span></div>
        <div className="stat"><b className="green">{st("已上线")}</b><span>已上线</span></div>
        <div className="stat"><b className="blue">{st("测试中")}</b><span>测试中</span></div>
        <div className="stat"><b className="muted">{st("待启动")}</b><span>待启动</span></div>
      </div>

      <div className="panel">
        <div className="ch-toolbar">
          <div className="cats">
            {["全部", ...CATS].map((c) => (
              <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>
                {c}
              </button>
            ))}
          </div>
          <input type="search" placeholder="搜索渠道 / 备注…" value={kw} onChange={(e) => setKw(e.target.value)} />
          <button onClick={exportJson}>导出</button>
          <label className="btn-file">
            导入
            <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && (importJson(e.target.files[0]), (e.target.value = ""))} />
          </label>
          <button className="primary" onClick={() => openForm(null)}>
            ＋ 新增渠道
          </button>
        </div>

        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>渠道</th>
              <th className="cat-col">分类</th>
              <th>状态</th>
              <th>链接 / 打法</th>
              <th className="ops-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={c.id}>
                <td className="num">{i + 1}</td>
                <td>
                  <div className="name">{c.name}</div>
                  {c.note && <div className="note">{c.note}</div>}
                </td>
                <td className="cat-col"><span className="tag">{c.cat}</span></td>
                <td>
                  <span className={`badge st-${STATUSES.indexOf(c.status) >= 0 ? STATUSES.indexOf(c.status) : 3}`}>
                    {c.status}
                  </span>
                </td>
                <td>
                  {c.link ? (
                    <a href={esc(c.link)} target="_blank" rel="noreferrer">{c.link}</a>
                  ) : (
                    <span className="note">{c.note || "-"}</span>
                  )}
                </td>
                <td className="ops-col">
                  <button onClick={() => openForm(c)}>编辑</button>
                  <button className="danger" onClick={() => remove(c)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">没有匹配的渠道，点「新增渠道」添加。</p>}
      </div>

      {showForm && (
        <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && setShowForm(false)}>
          <form className="modal" onSubmit={submit}>
            <h3>{editing ? "编辑渠道" : "新增渠道"}</h3>
            <label className="modal-field">
              <span>渠道名称 *</span>
              <input name="name" defaultValue={editing?.name} required maxLength={40} autoFocus />
            </label>
            <div className="ch-pair">
              <label className="modal-field">
                <span>分类</span>
                <select name="cat" defaultValue={editing?.cat ?? "短视频"}>
                  {CATS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="modal-field">
                <span>状态</span>
                <select name="status" defaultValue={editing?.status ?? "待启动"}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <label className="modal-field">
              <span>链接</span>
              <input name="link" defaultValue={editing?.link} placeholder="https://…" />
            </label>
            <label className="modal-field">
              <span>打法 / 备注</span>
              <textarea name="note" defaultValue={editing?.note} maxLength={300} />
            </label>
            <div className="modal-ops">
              <button type="button" onClick={() => setShowForm(false)}>取消</button>
              <button type="submit" className="primary">保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
