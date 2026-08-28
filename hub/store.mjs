// SQLite 存储 + 埋点 + 本地令牌。用 Node 内置 node:sqlite，仍然零 npm 依赖。
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.GROK_HUB_DIR || join(homedir(), ".grok-hub", "hub");
mkdirSync(DIR, { recursive: true, mode: 0o700 });

const db = new DatabaseSync(join(DIR, "hub.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    hash       TEXT NOT NULL UNIQUE,
    preview    TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used  INTEGER
  );
  CREATE TABLE IF NOT EXISTS calls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    account_id    TEXT,
    token_id      INTEGER,
    model         TEXT,
    path          TEXT,
    status        INTEGER,
    stream        INTEGER NOT NULL DEFAULT 0,
    ttfb_ms       INTEGER,
    total_ms      INTEGER,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens  INTEGER NOT NULL DEFAULT 0,
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
  CREATE INDEX IF NOT EXISTS idx_calls_acct ON calls(account_id);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS register_runs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    target    INTEGER NOT NULL DEFAULT 0,
    success   INTEGER NOT NULL DEFAULT 0,
    uploaded  INTEGER NOT NULL DEFAULT 0,
    note      TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    level       TEXT NOT NULL,
    title       TEXT NOT NULL,
    message     TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'system',
    source_id   TEXT,
    alert_type  TEXT NOT NULL DEFAULT 'system',
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
`);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---------- 本地令牌 ----------
// 这是 Hub 自己发的访问凭证，用于限制谁能用你的号池。
// 与 Grok/grok2api 账号体系无关，纯本地凭证。

export function createToken(name) {
  const secret = `sk-grokhub-${randomBytes(24).toString("hex")}`;
  db.prepare("INSERT INTO tokens (name, hash, preview, created_at) VALUES (?,?,?,?)")
    .run(name || "未命名", sha256(secret), `${secret.slice(0, 16)}…${secret.slice(-4)}`, Date.now());
  return secret; // 明文只在创建时返回一次
}

export function listTokens() {
  return db.prepare(`
    SELECT t.id, t.name, t.preview, t.enabled, t.created_at, t.last_used,
           (SELECT COUNT(*) FROM calls c WHERE c.token_id = t.id) AS calls,
           (SELECT COALESCE(SUM(c.total_tokens),0) FROM calls c WHERE c.token_id = t.id) AS tokens
    FROM tokens t ORDER BY t.id DESC
  `).all();
}

export function verifyToken(secret) {
  if (!secret) return null;
  const row = db.prepare("SELECT id, enabled FROM tokens WHERE hash = ?").get(sha256(secret));
  if (!row || !row.enabled) return null;
  db.prepare("UPDATE tokens SET last_used = ? WHERE id = ?").run(Date.now(), row.id);
  return row.id;
}

export function tokenCount() {
  return db.prepare("SELECT COUNT(*) c FROM tokens WHERE enabled = 1").get().c;
}

export function setTokenEnabled(id, enabled) {
  db.prepare("UPDATE tokens SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function deleteToken(id) {
  db.prepare("DELETE FROM tokens WHERE id = ?").run(id);
}

/** 面板自己要用一个令牌来打 /v1/*（前端的连通性测试）。没有就造一个。 */
export function ensurePanelToken() {
  let v = getSetting("panel_token");
  if (v && verifyToken(v)) return v;
  v = createToken("控制台自用");
  setSetting("panel_token", v);
  return v;
}

// ---------- 设置 ----------
export function getSetting(key, dflt = "") {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return r ? r.value : dflt;
}

export function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}

export function allSettings() {
  const out = {};
  for (const r of db.prepare("SELECT key, value FROM settings").all()) out[r.key] = r.value;
  return out;
}

// ---------- 注册统计（只记数量，不存账号本身） ----------
export function recordRegisterRun({ target = 0, success = 0, uploaded = 0, note = "" }) {
  db.prepare("INSERT INTO register_runs (ts, target, success, uploaded, note) VALUES (?,?,?,?,?)")
    .run(Date.now(), target, success, uploaded, note.slice(0, 300));
}

/** 累计注册 / 今日注册 / 累计上传 / 上传失败次数 */
export function registerStats() {
  const total = db.prepare("SELECT COALESCE(SUM(success),0) AS n FROM register_runs").get().n;
  const uploaded = db.prepare("SELECT COALESCE(SUM(uploaded),0) AS n FROM register_runs").get().n;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = db.prepare("SELECT COALESCE(SUM(success),0) AS n FROM register_runs WHERE ts >= ?").get(midnight.getTime()).n;
  const runs = db.prepare("SELECT ts, target, success, uploaded, note FROM register_runs ORDER BY id DESC LIMIT 20").all();
  return { registeredTotal: total, registeredToday: today, uploadedTotal: uploaded, runs };
}

// ---------- 告警 ----------
export function addAlert(a) {
  // 同一来源的同类未处理告警不重复插入，避免刷屏
  const dup = db.prepare(`SELECT id FROM alerts WHERE status='open' AND alert_type=? AND COALESCE(source_id,'')=?`)
    .get(a.alertType, a.sourceId ?? "");
  if (dup) return dup.id;
  const r = db.prepare(`INSERT INTO alerts
    (level,title,message,source_type,source_id,alert_type,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    a.level || "warning", a.title, a.message || "",
    a.sourceType || "system", a.sourceId ?? null,
    a.alertType || "system", Date.now());
  return r.lastInsertRowid;
}

export function listAlerts(status, limit = 200) {
  const sql = status
    ? "SELECT * FROM alerts WHERE status = ? ORDER BY id DESC LIMIT ?"
    : "SELECT * FROM alerts ORDER BY id DESC LIMIT ?";
  const rows = status
    ? db.prepare(sql).all(status, Math.min(limit, 500))
    : db.prepare(sql).all(Math.min(limit, 500));
  return rows.map((r) => ({
    id: r.id, level: r.level, title: r.title, message: r.message,
    sourceType: r.source_type, sourceId: r.source_id,
    alertType: r.alert_type, status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  }));
}

export function alertSummary() {
  const g = db.prepare(`SELECT
      SUM(CASE WHEN level='severe'  AND status='open' THEN 1 ELSE 0 END) severe,
      SUM(CASE WHEN level='warning' AND status='open' THEN 1 ELSE 0 END) warning,
      SUM(CASE WHEN level='info'    AND status='open' THEN 1 ELSE 0 END) info,
      SUM(CASE WHEN status='open'     THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved,
      AVG(CASE WHEN resolved_at IS NOT NULL THEN (resolved_at - created_at) END) mttr
    FROM alerts`).get();
  return {
    severe: g.severe || 0, warning: g.warning || 0, info: g.info || 0,
    open: g.open || 0, resolved: g.resolved || 0,
    mttrMin: g.mttr ? g.mttr / 60000 : 0,
  };
}

export function resolveAlert(id) {
  db.prepare("UPDATE alerts SET status='resolved', resolved_at=? WHERE id=? AND status='open'")
    .run(Date.now(), id);
}

export function resolveAllAlerts() {
  const r = db.prepare("UPDATE alerts SET status='resolved', resolved_at=? WHERE status='open'")
    .run(Date.now());
  return r.changes;
}

// ---------- 调用埋点 ----------
export function recordCall(r) {
  db.prepare(`INSERT INTO calls
    (ts, account_id, token_id, model, path, status, stream, ttfb_ms, total_ms,
     prompt_tokens, output_tokens, total_tokens, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r.ts ?? Date.now(), r.accountId ?? null, r.tokenId ?? null, r.model ?? null,
    r.path ?? null, r.status ?? null, r.stream ? 1 : 0,
    r.ttfbMs ?? null, r.totalMs ?? null,
    r.promptTokens ?? 0, r.outputTokens ?? 0, r.totalTokens ?? 0, r.error ?? null);
}

const WINDOWS = { day: 24 * 3600e3, week: 7 * 24 * 3600e3, all: null };

/** 一天 / 一周 / 全部三个口径。avg 与 TTFB 只统计成功请求。 */
export function stats() {
  const out = {};
  for (const [key, span] of Object.entries(WINDOWS)) {
    const since = span === null ? 0 : Date.now() - span;
    const agg = db.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(total_tokens),0)  AS total_tokens,
             COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
             COALESCE(SUM(output_tokens),0) AS output_tokens,
             SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
             AVG(CASE WHEN status >= 200 AND status < 300 THEN total_ms END) AS avg_ms,
             AVG(CASE WHEN status >= 200 AND status < 300 THEN ttfb_ms  END) AS avg_ttfb_ms
      FROM calls WHERE ts >= ?
    `).get(since);
    const byModel = db.prepare(`
      SELECT model, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
             AVG(CASE WHEN status >= 200 AND status < 300 THEN total_ms END) AS avg_ms,
             AVG(CASE WHEN status >= 200 AND status < 300 THEN ttfb_ms  END) AS avg_ttfb_ms
      FROM calls WHERE ts >= ? AND model IS NOT NULL
      GROUP BY model ORDER BY calls DESC
    `).all(since);
    const byAccount = db.prepare(`
      SELECT account_id, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens
      FROM calls WHERE ts >= ? AND account_id IS NOT NULL
      GROUP BY account_id ORDER BY calls DESC
    `).all(since);
    out[key] = {
      calls: agg.calls, ok: agg.ok ?? 0,
      totalTokens: agg.total_tokens,
      promptTokens: agg.prompt_tokens,
      outputTokens: agg.output_tokens,
      avgMs: agg.avg_ms, avgTtfbMs: agg.avg_ttfb_ms,
      byModel, byAccount,
    };
  }
  return out;
}

export function recentCalls(limit = 50) {
  return db.prepare(`
    SELECT c.id, c.ts, c.account_id, c.model, c.path, c.status, c.stream,
           c.ttfb_ms, c.total_ms, c.prompt_tokens, c.output_tokens, c.total_tokens,
           c.error, t.name AS token_name
    FROM calls c LEFT JOIN tokens t ON t.id = c.token_id
    ORDER BY c.id DESC LIMIT ?
  `).all(Math.min(limit, 500));
}

// ═══════════ 以下为仪表盘（postman2api 前端）所需的聚合口径 ═══════════

/** 累计 + 今日 + P95 + 错误率。前端 /api/stats 直接吃这个。 */
export function dashboardStats() {
  const g = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END) ok,
           SUM(CASE WHEN status IS NULL OR status<200 OR status>=300 THEN 1 ELSE 0 END) err,
           COALESCE(SUM(total_tokens),0) tokens,
           AVG(CASE WHEN status>=200 AND status<300 THEN total_ms END) avg_ms,
           AVG(CASE WHEN status>=200 AND status<300 THEN ttfb_ms END) avg_ttfb
    FROM calls`).get();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const today = db.prepare("SELECT COUNT(*) c FROM calls WHERE ts >= ?").get(startOfDay.getTime()).c;
  // P95：取成功请求 total_ms 的 95 分位
  const durs = db.prepare(`SELECT total_ms FROM calls
    WHERE status>=200 AND status<300 AND total_ms IS NOT NULL ORDER BY total_ms`).all()
    .map((r) => r.total_ms);
  const p95 = durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.95))] : 0;
  return {
    totalRequests: g.total || 0,
    successRequests: g.ok || 0,
    errorRequests: g.err || 0,
    totalTokens: g.tokens || 0,
    avgLatencyMs: g.avg_ms || 0,
    avgTtfbMs: g.avg_ttfb || 0,
    p95LatencyMs: p95,
    errorRate: g.total ? (g.err || 0) / g.total : 0,
    todayRequests: today,
  };
}

/** 按日聚合，label 形如 YYYY-MM-DD（前端会 slice(5) 取月日）。 */
export function dailySeries(days = 14) {
  const rows = db.prepare(`
    SELECT date(ts/1000,'unixepoch','localtime') d, COUNT(*) total,
           SUM(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END) success,
           SUM(CASE WHEN status IS NULL OR status<200 OR status>=300 THEN 1 ELSE 0 END) error,
           COALESCE(SUM(total_tokens),0) tokens
    FROM calls WHERE ts >= ? GROUP BY d`).all(Date.now() - days * 86400e3);
  const map = new Map(rows.map((r) => [r.d, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400e3);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const r = map.get(key);
    out.push({ label: key, total: r?.total || 0, success: r?.success || 0, error: r?.error || 0, tokens: r?.tokens || 0 });
  }
  return out;
}

/** 按小时聚合，label 形如 "YYYY-MM-DD HH:MM"（前端 split(' ')[1].slice(0,5)）。 */
export function hourlySeries(hours = 24) {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d %H',ts/1000,'unixepoch','localtime') h, COUNT(*) total,
           SUM(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END) success,
           SUM(CASE WHEN status IS NULL OR status<200 OR status>=300 THEN 1 ELSE 0 END) error
    FROM calls WHERE ts >= ? GROUP BY h`).all(Date.now() - hours * 3600e3);
  const map = new Map(rows.map((r) => [r.h, r]));
  const out = [];
  for (let i = hours - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 3600e3);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}`;
    const r = map.get(key);
    out.push({ label: `${key}:00`, total: r?.total || 0, success: r?.success || 0, error: r?.error || 0 });
  }
  return out;
}

export function modelDistribution(days = 14) {
  return db.prepare(`
    SELECT model, COUNT(*) count, COALESCE(SUM(total_tokens),0) tokens
    FROM calls WHERE ts >= ? AND model IS NOT NULL AND model <> ''
    GROUP BY model ORDER BY count DESC`).all(Date.now() - days * 86400e3);
}

/** 账号维度聚合，供 Top 账号效能表 + 号池今日调用。 */
export function accountAggregates(days = 14, limit = 20) {
  return db.prepare(`
    SELECT account_id, COUNT(*) calls,
           SUM(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END) success,
           SUM(CASE WHEN status IS NULL OR status<200 OR status>=300 THEN 1 ELSE 0 END) error,
           COALESCE(SUM(total_tokens),0) tokens,
           AVG(CASE WHEN status>=200 AND status<300 THEN total_ms END) avg_ms
    FROM calls WHERE ts >= ? AND account_id IS NOT NULL
    GROUP BY account_id ORDER BY calls DESC LIMIT ?`).all(Date.now() - days * 86400e3, limit);
}

export function todayCallsByAccount() {
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const out = {};
  for (const r of db.prepare(`SELECT account_id, COUNT(*) c FROM calls
      WHERE ts >= ? AND account_id IS NOT NULL GROUP BY account_id`).all(s.getTime())) {
    out[r.account_id] = r.c;
  }
  return out;
}

/** 渠道 = 模型（单上游，按模型区分才有信息量）。 */
export function channelComparison(days = 14) {
  return db.prepare(`
    SELECT model channel, COUNT(*) calls,
           SUM(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END) success,
           SUM(CASE WHEN status IS NULL OR status<200 OR status>=300 THEN 1 ELSE 0 END) error,
           COALESCE(SUM(total_tokens),0) tokens,
           AVG(CASE WHEN status>=200 AND status<300 THEN total_ms END) avg_ms,
           AVG(CASE WHEN status>=200 AND status<300 THEN ttfb_ms END) avg_ttfb
    FROM calls WHERE ts >= ? AND model IS NOT NULL AND model <> ''
    GROUP BY model ORDER BY calls DESC`).all(Date.now() - days * 86400e3);
}

/** 活跃热力：weekday 0=周日，hour 0-23。 */
export function heatmap(days = 14) {
  return db.prepare(`
    SELECT CAST(strftime('%w',ts/1000,'unixepoch','localtime') AS INTEGER) weekday,
           CAST(strftime('%H',ts/1000,'unixepoch','localtime') AS INTEGER) hour,
           COUNT(*) count
    FROM calls WHERE ts >= ? GROUP BY weekday, hour`).all(Date.now() - days * 86400e3);
}
