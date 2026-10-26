import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as quark from "./quark.ts";
import * as uc from "./uc.ts";
import * as baidu from "./baidu.ts";
import type { Platform } from "../shared/types.ts";

// 目录大小要递归几千次请求，同步算会把请求挂死。
// 这里放后台跑，结果缓存 30 分钟并落盘，服务重启后不用重算。
export type DirSizeState = {
  status: "idle" | "running" | "done" | "error";
  size: number;
  files: number;
  dirs: number;
  error?: string;
  updatedAt: number;
};

const TTL = 30 * 60_000;
const FILE = join(import.meta.dirname, "..", "data", "dirsizes.json");

const cache = new Map<string, DirSizeState>();
const running = new Set<string>();
let loaded = false;

const key = (accountId: string, fid: string) => `${accountId}:${fid}`;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const rows = JSON.parse(await readFile(FILE, "utf8")) as Record<string, DirSizeState>;
    for (const [k, v] of Object.entries(rows)) if (v.status === "done") cache.set(k, v);
  } catch {
    // 没有缓存文件就从空开始
  }
}

let saving = false;
async function save(): Promise<void> {
  if (saving) return;
  saving = true;
  try {
    await mkdir(dirname(FILE), { recursive: true });
    const done = Object.fromEntries([...cache].filter(([, v]) => v.status === "done"));
    const tmp = `${FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(done));
    await rename(tmp, FILE);
  } catch {
    // 落盘失败不影响内存缓存
  } finally {
    saving = false;
  }
}

export async function peek(accountId: string, fid: string): Promise<DirSizeState | null> {
  await load();
  const hit = cache.get(key(accountId, fid));
  if (!hit) return null;
  if (hit.status === "running") return hit;
  // 失败结果不留缓存，下次访问重新算
  if (hit.status === "error") return null;
  if (Date.now() - hit.updatedAt > TTL) return null;
  return hit;
}

export async function start(
  accountId: string,
  fid: string,
  cookie: string,
  platform: Platform = "quark",
): Promise<DirSizeState> {
  await load();
  const k = key(accountId, fid);
  const hit = await peek(accountId, fid);
  if (hit) return hit;
  if (running.has(k)) return cache.get(k)!;

  const state: DirSizeState = { status: "running", size: 0, files: 0, dirs: 0, updatedAt: Date.now() };
  cache.set(k, state);
  running.add(k);

  const mod = platform === "uc" ? uc : platform === "baidu" ? baidu : quark;
  mod
    .folderSize(cookie, fid, (dirs) => {
      state.dirs = dirs;
    })
    .then(async (r) => {
      Object.assign(state, r, { status: "done", updatedAt: Date.now() });
      await save();
    })
    .catch((e: unknown) => {
      Object.assign(state, { status: "error", error: e instanceof Error ? e.message : "计算失败", updatedAt: Date.now() });
    })
    .finally(() => running.delete(k));

  return state;
}
