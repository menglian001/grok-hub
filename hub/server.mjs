#!/usr/bin/env node
// Grok Hub — Grok 注册控制台。
// 职责：① 驱动注册机批量注册  ② 注册产物自动上传 grok2api（自动派生三格式）并清除本地留存
//       ③ 只记录"一共注册了多少个"  ④ 告警。账号本体不落地。
// 铁律：grok2api 是别人的项目，这里只调用它的管理 API，绝不修改它。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import * as store from "./store.mjs";
import * as compat from "./compat.mjs";
import * as auth from "./auth.mjs";
import * as grok2api from "./grok2api.mjs";
import * as reg from "./register.mjs";

const PORT = Number(process.argv[2] || process.env.GROK_HUB_PORT || process.env.HUB_PORT || 8790);
const HOST = process.env.GROK_HUB_HOST || process.env.HUB_HOST || "127.0.0.1";
const PUBLIC = join(import.meta.dirname, "public");
const BEHIND_TLS = process.env.GROK_HUB_TLS === "1";

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const fail = (res, code, message, type = "invalid_request") =>
  json(res, code, { error: { message, type } });

const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return chunks.length ? Buffer.concat(chunks) : undefined;
};
const readJson = async (req) => {
  const b = await readBody(req);
  try { return b ? JSON.parse(b.toString()) : {}; } catch { return {}; }
};

// ---------------- 静态文件 ----------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

async function serveStatic(res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel === "/dashboard" || rel === "/dashboard/") rel = "/index.html"; // SPA 入口
  if (rel.startsWith("/dashboard/")) rel = rel.slice("/dashboard".length);
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return fail(res, 403, "forbidden");
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-cache" });
    res.end(data);
  } catch { fail(res, 404, "not found", "not_found"); }
}

// ---------------- 路由 ----------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const M = req.method;
  try {
    // ── 登录 / 登出 / 会话状态（不需要已登录）──
    if (p === "/api/auth/login" && M === "POST") {
      const b = await readJson(req);
      const r = auth.login(req, b.password, BEHIND_TLS);
      if (r.locked) {
        res.writeHead(429, { "content-type": "application/json; charset=utf-8",
          "retry-after": String(r.retryAfter) });
        return res.end(JSON.stringify({ error: { message:
          `尝试过于频繁，请 ${Math.ceil(r.retryAfter / 60)} 分钟后再试`, type: "rate_limited" } }));
      }
      if (!r.ok) return fail(res, 401, `密码错误，还可尝试 ${r.remaining} 次`, "invalid_password");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": r.cookie });
      return res.end(JSON.stringify({ success: true }));
    }
    if (p === "/api/auth/logout" && M === "POST") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8",
        "set-cookie": auth.logout(req) });
      return res.end(JSON.stringify({ success: true }));
    }
    if (p === "/api/auth/status") {
      return json(res, 200, { authed: auth.isAuthed(req), hasPassword: auth.hasPassword() });
    }
    if (p === "/health") return json(res, 200, { status: "ok" });

    // ── 以下 /api/* 全部要求面板会话 ──
    if (p.startsWith("/api/")) {
      if (!auth.isAuthed(req)) return fail(res, 401, "请先登录管理面板", "unauthorized");
    }

    // ── 仪表盘数据（只讲注册）──
    if (p === "/api/stats") return json(res, 200, compat.stats());
    if (p === "/api/settings" && M === "GET") {
      return json(res, 200, {
        defs: compat.settingDefs,
        values: compat.settingsWithDefaults(),
        grok2api: grok2api.configStatus(),
      });
    }
    if (p === "/api/settings" && M === "PUT") {
      const b = await readJson(req);
      const src = (b && b.settings) ? b.settings : (b || {});
      for (const [k, v] of Object.entries(src)) {
        if (compat.settingDefs.some((d) => d.key === k)) store.setSetting(k, String(v ?? ""));
      }
      return json(res, 200, { success: true });
    }
    if (p === "/api/alerts" && M === "GET") {
      const status = url.searchParams.get("status") || "";
      return json(res, 200, { data: store.listAlerts(status, 200), summary: store.alertSummary() });
    }
    if (p.startsWith("/api/alerts/resolve/") && M === "POST") {
      store.resolveAlert(Number(p.split("/")[3]));
      return json(res, 200, { success: true });
    }
    if (p === "/api/alerts/resolve-all" && M === "POST") {
      return json(res, 200, { success: true, resolved: store.resolveAllAlerts() });
    }
    if (p === "/api/tokens" && M === "GET") return json(res, 200, { tokens: store.listTokens() });

    // ── grok2api 连接 ──
    if (p === "/api/grok2api/status") {
      return json(res, 200, grok2api.configStatus());
    }
    if (p === "/api/grok2api/test" && M === "POST") {
      try {
        await grok2api.testConnection();
        return json(res, 200, { ok: true, message: "登录成功" });
      } catch (e) {
        return json(res, 200, { ok: false, message: e.message });
      }
    }

    // ── 注册机 ──
    if (p === "/api/register/start" && M === "POST") {
      const b = await readJson(req);
      const dflt = Number(compat.settingsWithDefaults().register_default_target || 1);
      const r = reg.start({ target: b.target ?? dflt, strict: b.strict !== false });
      if (!r.ok) return fail(res, 409, r.message, "conflict");
      return json(res, 200, r);
    }
    if (p === "/api/register/stop" && M === "POST") {
      const r = reg.stop();
      if (!r.ok) return fail(res, 409, r.message, "conflict");
      return json(res, 200, r);
    }
    if (p === "/api/register/status") return json(res, 200, reg.status());
    // 旧接口兼容（前几版前端/脚本可能还在调）
    if (p === "/api/detect-logs") {
      const s = reg.status();
      const r = s.lastResult;
      return json(res, 200, { logs: s.lines, running: s.running,
        phase: s.phase, phaseText: s.phaseText,
        result: r ? { success: r.code === 0 || (r.uploaded !== undefined && r.failures && r.failures.length === 0),
          message: r.uploading ? "注册结束，正在上传 grok2api…"
            : r.uploaded !== undefined ? `注册 ${r.success} 个，上传 ${r.uploaded} 个${r.failures && r.failures.length ? `，失败 ${r.failures.length}` : ""}`
            : `注册进程退出（code ${r.code}）`,
          finished_at: r.finishedAt } : null });
    }
    if (p === "/api/detect-stop" && M === "POST") {
      const r = reg.stop();
      if (!r.ok) return fail(res, 409, r.message, "conflict");
      return json(res, 200, r);
    }
    if (p.startsWith("/api/detect") || p.startsWith("/api/accounts") || p.startsWith("/api/pool")) {
      return fail(res, 501, "号池/额度概念已移除：注册即自动上传 grok2api，本地不存账号", "not_implemented");
    }

    // 未登录只放行登录页与其静态依赖，其余一律跳登录
    if (!auth.isAuthed(req) && !["/login.html", "/dashboard.css", "/favicon.ico"].includes(p)) {
      res.writeHead(302, { location: "/login.html" });
      return res.end();
    }
    return await serveStatic(res, p);
  } catch (e) {
    if (res.headersSent) return void res.destroy(e);
    fail(res, 500, e.message, "internal_error");
  }
});

store.ensurePanelToken();

// 首次启动或显式指定时设置面板密码
const PW = process.env.GROK_HUB_PASSWORD;
if (PW) {
  auth.initPassword(PW);
  console.log("[hub] 面板密码已从环境变量写入（scrypt 哈希存储）");
}

if (HOST !== "127.0.0.1" && !auth.hasPassword()) {
  console.error("[hub] ✗ 拒绝启动：绑定到非本地地址但没有设置面板密码。");
  console.error("[hub]   请用 GROK_HUB_PASSWORD=... 启动一次以初始化密码。");
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "0.0.0.0（所有网卡）" : HOST;
  const st = compat.stats();
  console.log(`[hub] 控制台:     http://${shown}:${PORT}/`);
  console.log(`[hub] 累计注册:   ${st.registeredTotal} 个（今日 ${st.registeredToday}，已上传 grok2api ${st.uploadedTotal}）`);
  console.log(`[hub] 面板鉴权:   ${auth.hasPassword() ? "已启用（密码 + 会话 cookie）" : "⚠ 未设置密码"}`);
  if (HOST !== "127.0.0.1" && !BEHIND_TLS) {
    console.log("[hub] ⚠ 未启用 TLS：登录密码走明文 HTTP，建议前面套 HTTPS 反代。");
  }
});
