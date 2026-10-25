import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Account, Platform, Share, ShareGroup, PublicUser } from "../shared/types.ts";

export type UserRow = {
  id: string;
  username: string;
  salt: string;
  hash: string;
  createdAt: string;
  /** 每个用户各自记住当前选中的网盘账号 */
  activeId: string | null;
};

type Row = { account: Account; cookie: string };

type Db = {
  users: UserRow[];
  accounts: Row[];
  shares: Share[];
  groups: ShareGroup[];
  /** 旧版单用户时代的 activeId，第一个用户注册时继承 */
  legacyActiveId: string | null;
};

const FILE = join(import.meta.dirname, "..", "data", "db.json");

let cache: Db | null = null;

async function load(): Promise<Db> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<Db> & { activeId?: string | null };
    cache = {
      users: raw.users ?? [],
      accounts: raw.accounts ?? [],
      shares: (raw.shares ?? []).map((s) => ({ ...s, groupId: s.groupId ?? null })),
      groups: raw.groups ?? [],
      // 老库的 activeId 是全局的，留给第一个注册的用户
      legacyActiveId: raw.activeId ?? null,
    };
    // 老账号都是夸克的，没有 platform 字段
    cache.accounts = cache.accounts.map((r) => ({
      ...r,
      account: { ...r.account, platform: r.account.platform ?? "quark" },
    }));
  } catch {
    cache = { users: [], accounts: [], shares: [], groups: [], legacyActiveId: null };
  }
  return cache;
}

async function save(db: Db): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  await rename(tmp, FILE);
}

// ---- 用户 ----

export const publicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  username: u.username,
  createdAt: u.createdAt,
});

export async function findUserByName(username: string): Promise<UserRow | null> {
  return (await load()).users.find((u) => u.username === username) ?? null;
}

export async function getUser(id: string): Promise<UserRow | null> {
  return (await load()).users.find((u) => u.id === id) ?? null;
}

export async function countUsers(): Promise<number> {
  return (await load()).users.length;
}

export async function createUser(username: string, salt: string, hash: string): Promise<UserRow> {
  const db = await load();
  if (db.users.some((u) => u.username === username)) throw new Error("用户名已被占用");
  const user: UserRow = {
    id: randomUUID(),
    username,
    salt,
    hash,
    createdAt: new Date().toISOString(),
    activeId: null,
  };
  db.users.push(user);
  await save(db);
  return user;
}

/**
 * 第一个用户继承旧版单用户时代的数据（那时没有 userId）。
 * 只对无主数据生效，之后注册的用户拿不到。
 */
export async function claimLegacy(userId: string): Promise<void> {
  const db = await load();
  let changed = false;
  for (const r of db.accounts) {
    if (!r.account.userId) {
      r.account.userId = userId;
      changed = true;
    }
  }
  for (const s of db.shares) {
    if (!s.userId) {
      s.userId = userId;
      changed = true;
    }
  }
  for (const g of db.groups) {
    if (!g.userId) {
      g.userId = userId;
      changed = true;
    }
  }
  const u = db.users.find((x) => x.id === userId);
  if (u && !u.activeId && db.legacyActiveId) {
    u.activeId = db.legacyActiveId;
    changed = true;
  }
  if (db.legacyActiveId) {
    db.legacyActiveId = null;
    changed = true;
  }
  if (changed) await save(db);
}

// ---- 网盘账号（按用户隔离）----

export async function listAccounts(userId: string): Promise<Account[]> {
  return (await load()).accounts.filter((r) => r.account.userId === userId).map((r) => r.account);
}

export async function getActive(userId: string): Promise<Row | null> {
  const db = await load();
  const mine = db.accounts.filter((r) => r.account.userId === userId);
  const user = db.users.find((u) => u.id === userId);
  return mine.find((r) => r.account.id === user?.activeId) ?? mine[0] ?? null;
}

/** MCP 是本地单机工具，直接取任意一个账号；网页端一律用 getActive(userId)。 */
export async function getActiveAny(): Promise<Row | null> {
  const db = await load();
  return db.accounts[0] ?? null;
}

export async function addAccount(
  userId: string,
  nickname: string,
  cookie: string,
  platform: Platform = "quark",
): Promise<Account> {
  const db = await load();
  const account: Account = {
    id: randomUUID(),
    userId,
    platform,
    nickname,
    cookieHint: `…${cookie.slice(-6)}`,
    addedAt: new Date().toISOString(),
  };
  db.accounts.push({ account, cookie });
  const user = db.users.find((u) => u.id === userId);
  if (user) user.activeId = account.id;
  await save(db);
  return account;
}

export async function removeAccount(userId: string, id: string): Promise<boolean> {
  const db = await load();
  const before = db.accounts.length;
  db.accounts = db.accounts.filter((r) => !(r.account.id === id && r.account.userId === userId));
  if (db.accounts.length === before) return false;
  db.shares = db.shares.filter((s) => !(s.accountId === id && s.userId === userId));
  const user = db.users.find((u) => u.id === userId);
  if (user?.activeId === id) {
    user.activeId = db.accounts.find((r) => r.account.userId === userId)?.account.id ?? null;
  }
  await save(db);
  return true;
}

export async function setActive(userId: string, id: string): Promise<boolean> {
  const db = await load();
  if (!db.accounts.some((r) => r.account.id === id && r.account.userId === userId)) return false;
  const user = db.users.find((u) => u.id === userId);
  if (!user) return false;
  user.activeId = id;
  await save(db);
  return true;
}

export async function getCookie(userId: string, accountId: string): Promise<string | null> {
  return (
    (await load()).accounts.find((r) => r.account.id === accountId && r.account.userId === userId)?.cookie ??
    null
  );
}

// ---- 分享（按用户隔离）----

export async function listShares(userId: string): Promise<Share[]> {
  return (await load()).shares.filter((s) => s.userId === userId);
}

export async function addShare(share: Share): Promise<void> {
  const db = await load();
  db.shares.unshift(share);
  await save(db);
}

export async function removeShare(userId: string, id: string): Promise<boolean> {
  const db = await load();
  const before = db.shares.length;
  db.shares = db.shares.filter((s) => !(s.id === id && s.userId === userId));
  if (db.shares.length === before) return false;
  await save(db);
  return true;
}

export async function listGroups(userId: string): Promise<ShareGroup[]> {
  return (await load()).groups.filter((g) => g.userId === userId);
}

export async function addGroup(userId: string, name: string): Promise<ShareGroup> {
  const db = await load();
  const group: ShareGroup = { id: randomUUID(), userId, name, createdAt: new Date().toISOString() };
  db.groups.push(group);
  await save(db);
  return group;
}

export async function removeGroup(userId: string, id: string): Promise<boolean> {
  const db = await load();
  const before = db.groups.length;
  db.groups = db.groups.filter((g) => !(g.id === id && g.userId === userId));
  if (db.groups.length === before) return false;
  // 组删了，组内分享退回未分组，不连带删除分享记录
  db.shares = db.shares.map((s) => (s.groupId === id && s.userId === userId ? { ...s, groupId: null } : s));
  await save(db);
  return true;
}

export async function assignShareGroup(
  userId: string,
  shareId: string,
  groupId: string | null,
): Promise<boolean> {
  const db = await load();
  const share = db.shares.find((s) => s.id === shareId && s.userId === userId);
  if (!share) return false;
  if (groupId && !db.groups.some((g) => g.id === groupId && g.userId === userId)) return false;
  share.groupId = groupId;
  await save(db);
  return true;
}
