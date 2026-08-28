// grok2api 管理面调用 + grok.com 额度探活。
// 原则：只调用 grok2api 现成的管理 API（与 grok-register 同一套端点），绝不修改 grok2api 本身。
// 探活走 grok.com/rest/rate-limits，需要出口代理时由启动脚本用 NODE_USE_ENV_PROXY/HTTPS_PROXY 注入。
import * as store from "./store.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// ---------------- grok.com 每日额度探活 ----------------
/** 返回 { remaining, total, windowSeconds }。失败抛异常。 */
export async function probeRateLimit(sso) {
  const r = await fetch("https://grok.com/rest/rate-limits", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cookie": `sso=${sso}; sso_rw=${sso}`,
      "user-agent": UA,
      "accept": "application/json",
    },
    body: JSON.stringify({ requestKind: "DEFAULT", modelName: "grok-4" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return {
    remaining: Number(d.remainingQueries ?? 0),
    total: Number(d.totalQueries ?? 0),
    windowSeconds: Number(d.windowSizeSeconds ?? 86400),
  };
}

// ---------------- grok2api 管理面 ----------------
let _token = null;
let _tokenExp = 0;

function cfg() {
  return {
    baseUrl: (store.getSetting("grok2api_base_url", process.env.GROK2API_BASE_URL || "") || "").replace(/\/+$/, ""),
    username: store.getSetting("grok2api_username", process.env.GROK2API_USERNAME || "admin"),
    password: store.getSetting("grok2api_password", process.env.GROK2API_PASSWORD || ""),
  };
}

export function configStatus() {
  const c = cfg();
  return { configured: !!(c.baseUrl && c.username && c.password), baseUrl: c.baseUrl || "(未配置)", username: c.username || "(未配置)" };
}

async function login(force = false) {
  const c = cfg();
  if (!c.baseUrl || !c.username || !c.password) throw new Error("grok2api 连接未配置（设置页填地址/账号/密码）");
  if (!force && _token && Date.now() < _tokenExp) return _token;
  const r = await fetch(`${c.baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: c.username, password: c.password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`grok2api 登录失败 HTTP ${r.status}`);
  const d = await r.json();
  _token = d?.data?.tokens?.accessToken || d?.accessToken || d?.access_token || "";
  if (!_token) throw new Error("grok2api 登录响应中没有 accessToken");
  _tokenExp = Date.now() + 9 * 60_000; // 10 分钟有效期，留 1 分钟缓冲
  return _token;
}

/** 上传单个 SSO 到 grok2api（multipart 纯文本，每行一个 token）。
    关键：文件名必须是 grok-web-sso-tokens.txt —— grok2api 靠文件名识别 token 类型，
    其他名字会报 "Cannot read properties of undefined (reading 'trim')"。
    成功特征：SSE complete 事件里 '"created":1'。 */
export async function importSso(sso) {
  const t = await login();
  const form = new FormData();
  form.append("file", new Blob([sso.trim() + "\n"], { type: "text/plain" }), "grok-web-sso-tokens.txt");
  const r = await fetch(`${cfg().baseUrl}/api/admin/v1/accounts/web/import`, {
    method: "POST",
    headers: { "authorization": `Bearer ${t}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  // 重复上传 grok2api 返回 created:0, updated:1 —— 也算成功（幂等）
  const ok = text.includes('"created":1') || text.includes('"updated":1')
    || (/"skipped":[1-9]/.test(text) && text.includes('"failed":0'));
  if (r.status === 200 && ok) return { ok: true, message: "created/updated" };
  // 常见：token 已存在 / 上游拒绝。原文截断带回给前端显示。
  const brief = text.replace(/\s+/g, " ").slice(0, 180);
  return { ok: false, status: r.status, message: brief || `HTTP ${r.status}` };
}

/** 在 grok2api 里按邮箱找账号（导入后用它拿 grok2api 侧的数字 id）。 */
export async function findAccountByEmail(email) {
  const t = await login();
  const r = await fetch(`${cfg().baseUrl}/api/admin/v1/accounts?search=${encodeURIComponent(email)}&pageSize=10`, {
    headers: { authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`查询账号失败 HTTP ${r.status}`);
  const items = (await r.json())?.data?.items || [];
  return items.find((i) => (i.email || "") === email) || null;
}

/** 按邮箱找 Web 账号（provider=grok_web）——账号级动作（条款/生日/NSFW）只对它有效。 */
export async function findWebAccountByEmail(email) {
  const t = await login();
  const r = await fetch(`${cfg().baseUrl}/api/admin/v1/accounts?search=${encodeURIComponent(email)}&pageSize=10`, {
    headers: { authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`查询账号失败 HTTP ${r.status}`);
  const items = (await r.json())?.data?.items || [];
  return items.find((i) => (i.email || "") === email && i.provider === "grok_web") || null;
}

/** Web 账号一键设置：接受条款 → 设成人生日 → 开启 NSFW（都是 grok2api 现成端点，无 body）。
    返回 { ok, done: [...], failed: [...] }。已做过的事 grok2api 幂等处理。 */
export async function accountSetup(webId, { nsfw = true } = {}) {
  const t = await login();
  const post = async (path) => {
    const r = await fetch(`${cfg().baseUrl}/api/admin/v1/accounts/web/${webId}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
    return true;
  };
  const done = [], failed = [];
  for (const step of nsfw ? [["accept-terms", true], ["birth-date", true], ["nsfw", true]] : [["accept-terms", true]]) {
    const [name] = step;
    try { await post(name); done.push(name); } catch (e) { failed.push(`${name}: ${e.message}`); }
  }
  return { ok: failed.length === 0, done, failed };
}

/** 从 SSE 文本里抠最后一个 data: JSON（complete 事件）。 */
function lastSseData(text) {
  let out = null;
  for (const m of text.matchAll(/^data:\s*(\{.*\})\s*$/gm)) { try { out = JSON.parse(m[1]); } catch { /* 跳过 */ } }
  return out;
}

/** Web → Console 派生（strategy: all|missing，缺省 all）。SSE 返回 created/updated 计数。 */
export async function syncToConsole(ids, strategy = "all") {
  const t = await login();
  const r = await fetch(`${cfg().baseUrl}/api/admin/v1/accounts/web/sync-to-console`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: ids.map(String), strategy }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  const done = lastSseData(text) || {};
  return { ok: r.status === 200 && !done.failed, raw: done, message: text.replace(/\s+/g, " ").slice(0, 180) };
}

/** Web → Build 派生（strategy: all|missing，缺省 missing —— 已有 Build 的不重转，幂等）。 */
export async function convertToBuild(ids, strategy = "missing") {
  const t = await login();
  const r = await fetch(`${cfg().baseUrl}/api/admin/v1/accounts/web/convert-to-build`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: ids.map(String), strategy }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  const done = lastSseData(text) || {};
  return { ok: r.status === 200 && !done.failed, raw: done, message: text.replace(/\s+/g, " ").slice(0, 180) };
}

/** 设置页「测试连接」：强制重新登录一次。 */
export async function testConnection() {
  await login(true);
  return { ok: true };
}
