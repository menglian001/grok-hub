// 适配层：概览/设置的数据契约。账号本体不落地（注册即上传 grok2api，本地只留计数），
// 这里只剩：注册统计（store.register_runs）+ 设置项。探活已按需求砍掉。
import * as store from "./store.mjs";

/** 前端把账号 id 当数字用——号池概念已移除，保留空实现以防旧前端调用。 */
const idMap = new Map();
let idSeq = 0;
export function numericId(stringId) {
  for (const [n, s] of idMap) if (s === stringId) return n;
  idSeq += 1;
  idMap.set(idSeq, stringId);
  return idSeq;
}
export function stringId(numeric) {
  return idMap.get(Number(numeric)) || null;
}

/** GET /api/stats —— 概览 KPI：只讲注册这件事。 */
export function stats() {
  const r = store.registerStats();
  return {
    registeredTotal: r.registeredTotal,
    registeredToday: r.registeredToday,
    uploadedTotal: r.uploadedTotal,
    pendingUpload: Math.max(0, r.registeredTotal - r.uploadedTotal),
    runs: r.runs,
    estimatedCost: 0,
  };
}

// ---------- 设置项 ----------
export const settingDefs = [
  { key: "grok2api_base_url", label: "grok2api 地址", description: "grok2api 的管理面地址（只调用其现成 API，不改 grok2api）", type: "text", default: "" },
  { key: "grok2api_username", label: "grok2api 管理员用户名", description: "管理面登录用户名", type: "text", default: "admin" },
  { key: "grok2api_password", label: "grok2api 管理员密码", description: "管理面登录密码，仅存本机 SQLite", type: "text", default: "" },
  { key: "grok2api_auto_derive", label: "上传后自动派生三格式", description: "导入 Web 账号后自动 sync-to-console + convert-to-build（grok2api 不会自动做这一步）", type: "bool", default: "true" },
  { key: "grok2api_auto_nsfw", label: "自动开启 NSFW", description: "派生后对 Web 账号执行：接受条款 → 设成人生日 → 开启 NSFW（grok2api 全局「允许 NSFW 图片」需为开）", type: "bool", default: "true" },
  { key: "register_default_target", label: "注册机默认数量", description: "注册页每次默认注册的账号数", type: "int", default: "1" },
  { key: "register_proxy", label: "注册代理", description: "注册机走代理（须能访问 x.ai），如 http://127.0.0.1:7890；留空则用注册机 .env 里的值", type: "text", default: "" },
  { key: "register_email_mode", label: "邮箱模式", description: "tempmail=免费临时邮箱 / custom=自建域名邮箱；留空用 .env 默认", type: "text", default: "" },
  { key: "register_yyds_keys", label: "YYDS 邮箱令牌", description: "填了优先用 YYDS 邮箱（多个用逗号分隔）；留空沿用注册机 .env 里的令牌", type: "text", default: "" },
  { key: "register_yyds_base", label: "YYDS API 地址", description: "YYDS 邮箱服务地址", type: "text", default: "" },
  { key: "register_yyds_domain", label: "YYDS 指定域名", description: "留空自动分配", type: "text", default: "" },
  { key: "register_email_domain", label: "自建邮箱域名", description: "custom 模式专用", type: "text", default: "" },
  { key: "register_email_api", label: "自建邮箱 API", description: "custom 模式专用，收信服务地址", type: "text", default: "" },
  { key: "register_physical_cap", label: "注册并发上限", description: "同时进行的注册单数（浏览器物理并发）。2核4G 建议 2-3。注意：实际并发 = max(本项, 下面的 token 池目标)", type: "int", default: "2" },
  { key: "register_t_target", label: "token 池缓冲目标", description: "注册机为吸收失败率预留的在飞单数（原 T_TARGET，默认 4）。想严格按上面的并发上限跑，把它设成与并发上限相同", type: "int", default: "2" },
  { key: "register_c_workers", label: "注册 worker 数", description: "C 阶段并发 worker 数（原 C_WORKERS）。留空自动 = 并发上限+2；想硬压并发就设成与并发上限相同", type: "int", default: "" },
  { key: "register_q_pending_cap", label: "邮箱预取上限", description: "同时在途的临时邮箱/验证码请求数（原 Q_PENDING_CAP，默认 12）。默认会预申请远多于所需的邮箱，用付费邮箱令牌时建议压到 3-4 省额度", type: "int", default: "4" },
  { key: "register_q_target", label: "验证码缓冲目标", description: "就绪验证码的缓冲水位（原 Q_TARGET，默认 4）。与上面配合控制邮箱申请量", type: "int", default: "2" },
  { key: "register_strict_overhead", label: "严格模式预取余量", description: "严格模式下额外预备的邮箱/Turnstile 数量。1=留一个备用（默认，失败可立即补位）；0=零浪费但失败要从头重试，耗时翻倍", type: "int", default: "1" },
];

/** 注册机 spawn 时的环境变量覆盖（空值跳过=回退 .env）。 */
export function registerEnvOverrides(values) {
  const v = values || settingsWithDefaults();
  const o = {};
  const put = (k, val) => { if (String(val ?? "").trim() !== "") o[k] = String(val).trim(); };
  put("HTTP_PROXY", v.register_proxy);
  put("HTTPS_PROXY", v.register_proxy);
  put("EMAIL_MODE", v.register_email_mode);
  put("YYDS_API_KEYS", v.register_yyds_keys);
  put("YYDS_API_BASE", v.register_yyds_base);
  put("YYDS_DOMAIN", v.register_yyds_domain);
  put("EMAIL_DOMAIN", v.register_email_domain);
  put("EMAIL_API", v.register_email_api);
  put("PHYSICAL_CAP", v.register_physical_cap);
  put("T_TARGET", v.register_t_target);
  put("C_WORKERS", v.register_c_workers);
  put("Q_PENDING_CAP", v.register_q_pending_cap);
  put("Q_TARGET", v.register_q_target);
  put("STRICT_OVERHEAD", v.register_strict_overhead);
  o.GROK2API_AUTO_IMPORT = "0"; // 上传由 hub 统一做，注册机自带导入必须关
  return o;
}

export function settingsWithDefaults() {
  const saved = store.allSettings();
  const out = {};
  for (const d of settingDefs) out[d.key] = saved[d.key] ?? d.default;
  return out;
}
