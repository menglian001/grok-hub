// 面板鉴权：密码登录 + HttpOnly 会话 cookie + 登录限流。
// 公网暴露必需 —— 没有这一层，任何人都能读 /api/settings 拿到令牌明文。
import { randomBytes, createHash, timingSafeEqual, scryptSync } from "node:crypto";
import * as store from "./store.mjs";

const SESSION_TTL = 12 * 3600e3;        // 会话 12 小时
const LOCK_THRESHOLD = 6;               // 连续失败次数上限
const LOCK_WINDOW = 15 * 60e3;          // 锁定窗口 15 分钟

const sessions = new Map();             // sid -> { createdAt, ip }
const attempts = new Map();             // ip  -> { count, first, lockedUntil }

/** 密码存 scrypt 哈希，不存明文。首次启动从 GROK_HUB_PASSWORD 初始化。 */
export function initPassword(plain) {
  if (!plain) return;
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 64).toString("hex");
  store.setSetting("panel_pw_salt", salt);
  store.setSetting("panel_pw_hash", hash);
}

export function hasPassword() {
  return !!store.getSetting("panel_pw_hash");
}

function verifyPassword(plain) {
  const salt = store.getSetting("panel_pw_salt");
  const want = store.getSetting("panel_pw_hash");
  if (!salt || !want || !plain) return false;
  const got = scryptSync(plain, salt, 64).toString("hex");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function throttle(ip) {
  const a = attempts.get(ip);
  if (!a) return { locked: false };
  if (a.lockedUntil && Date.now() < a.lockedUntil) {
    return { locked: true, retryAfter: Math.ceil((a.lockedUntil - Date.now()) / 1000) };
  }
  if (a.lockedUntil && Date.now() >= a.lockedUntil) attempts.delete(ip);
  return { locked: false };
}

function noteFailure(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.first > LOCK_WINDOW) a = { count: 0, first: now, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= LOCK_THRESHOLD) {
    a.lockedUntil = now + LOCK_WINDOW;
    store.addAlert({ level: "severe", alertType: "auth_bruteforce",
      title: "面板登录被暴力尝试", message: `${ip} 连续 ${a.count} 次密码错误，已锁定 15 分钟`,
      sourceType: "system", sourceId: ip });
  }
  attempts.set(ip, a);
  return a;
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 会话是否有效。过期的顺手清掉。 */
export function isAuthed(req) {
  const sid = parseCookies(req).grok_hub_sid;
  if (!sid) return false;
  const s = sessions.get(sid);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(sid); return false; }
  return true;
}

/** 登录。成功返回 Set-Cookie 值，失败返回 null 并计入限流。 */
export function login(req, password, secure) {
  const ip = clientIp(req);
  const t = throttle(ip);
  if (t.locked) return { ok: false, locked: true, retryAfter: t.retryAfter };
  if (!verifyPassword(password)) {
    const a = noteFailure(ip);
    return { ok: false, remaining: Math.max(0, LOCK_THRESHOLD - a.count) };
  }
  attempts.delete(ip);
  const sid = randomBytes(32).toString("hex");
  sessions.set(sid, { createdAt: Date.now(), ip });
  const flags = [
    `grok_hub_sid=${sid}`, "Path=/", "HttpOnly", "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  ];
  if (secure) flags.push("Secure");
  return { ok: true, cookie: flags.join("; ") };
}

export function logout(req) {
  const sid = parseCookies(req).grok_hub_sid;
  if (sid) sessions.delete(sid);
  return "grok_hub_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}

export function sessionCount() {
  for (const [sid, s] of sessions) if (Date.now() - s.createdAt > SESSION_TTL) sessions.delete(sid);
  return sessions.size;
}
