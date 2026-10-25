import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as store from "./store.ts";

// 多用户注册制。密码用 scrypt 加盐存哈希，会话是签名 cookie（uid.exp.sig），
// 服务端不保存会话表，重启后仍然有效。
//
// 迁移：老部署用 APP_USER + APP_PASSWORD_HASH 单口令。启动时若还没有任何用户，
// 就用这对值建出第一个用户，之后一律走用户表。

const SECRET = process.env.APP_SECRET ?? randomBytes(32).toString("hex");

export const COOKIE = "qph";
const MAX_AGE = 30 * 24 * 60 * 60;

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

export function makeToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** 校验会话 cookie，返回 userId。签名不对或过期都返回 null。 */
export function userIdFrom(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie ?? "";
  const hit = cookie.match(/(?:^|;\s*)qph=([^;]+)/);
  if (!hit) return null;
  const parts = decodeURIComponent(hit[1]).split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expect = sign(`${uid}.${exp}`);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expect, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  return uid;
}

export function cookieHeader(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function login(username: string, password: string): Promise<string | null> {
  const user = await store.findUserByName(username);
  if (!user) return null;
  // 从旧单口令部署迁过来的账号：库里存的是 sha256(密码)，不是 scrypt
  const a =
    user.salt === "legacy"
      ? Buffer.from(createHash("sha256").update(password).digest("hex"), "hex")
      : Buffer.from(hashPassword(password, user.salt), "hex");
  const b = Buffer.from(user.hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return makeToken(user.id);
}

/**
 * 把旧部署的单口令账号迁成第一个用户。
 * 旧配置只存了 sha256(密码)，无法反推明文，所以直接把旧哈希存进去并标记 salt=legacy，
 * 登录时按 sha256 比对。老用户继续用原密码登录，新注册用户走正常 scrypt。
 */
export async function migrateLegacyUser(): Promise<void> {
  const user = process.env.APP_USER;
  const hash = process.env.APP_PASSWORD_HASH;
  if (!user || !hash) return;
  if (await store.findUserByName(user)) return;
  await store.createUser(user, "legacy", hash);
}
