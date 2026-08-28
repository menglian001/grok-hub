// 注册机桥：spawn deploy/grok-register-main 的 grok_register，日志回显。
// 跑完后：keys/ 的账号 → 立即上传 grok2api（自动派生三格式）→ 成功即清除本地留存。
// 本地只保留"注册了多少个"的计数（store.register_runs），不存账号。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as store from "./store.mjs";
import * as grok2api from "./grok2api.mjs";
import * as compat from "./compat.mjs";

const REGISTER_DIR = process.env.GROK_REGISTER_DIR || "/run/csi/mount-root/nas/4079184d856ecc166ed19d4887083405/workspaces/default/deploy/grok-register-main";
const PY = join(REGISTER_DIR, ".venv/bin/python");
const RING_MAX = 800;

let child = null;
let exited = true; // 信号杀掉的子进程 exitCode 恒为 null，不能拿它判断存活
let startedAt = null;
let target = 0;
let strict = true;
let lastResult = null;
let completionAt = null;   // 日志出现"全部完成/已达目标"的时刻
let lingerTimer = null;
let phase = "idle";        // idle | registering | finalize | done —— 前端据此显示"当前在做什么"
const ring = [];

/** 邮箱脱敏：oc19***@cmuk.edu.kg，日志可读又不泄露完整账号。 */
function mail(e) {
  const [u, d] = String(e).split("@");
  if (!d) return e;
  return `${u.slice(0, 4)}***@${d}`;
}

// ───────── 日志整理层 ─────────
// 注册机原始输出把流水线内部噪音（每个预取邮箱 3 行、worker 编号、重复的完成宣告）
// 和真正的进展混在一起，1 个号能刷出 30+ 行。这里折叠噪音、保留动作与全部失败信息。
let prep = { turnstile: 0, mailbox: 0, code: 0, dirty: false };
let prepShown = false;   // 只在首次开单前汇总一次；之后的预取是后台补货，不再打扰
let appliedEnv = "";     // 本轮生效的完整环境覆盖（供 status 排障，不刷日志）

function resetTidy() {
  prep = { turnstile: 0, mailbox: 0, code: 0, dirty: false };
  prepShown = false;
}

function flushPrep() {
  if (!prep.dirty || prepShown) return [];
  const p = [];
  if (prep.turnstile) p.push(`Turnstile ${prep.turnstile}`);
  if (prep.mailbox) p.push(`邮箱 ${prep.mailbox}`);
  if (prep.code) p.push(`验证码 ${prep.code}`);
  prepShown = true;
  return p.length ? [`  资源准备完成 · ${p.join(" · ")}`] : [];
}

/** 把注册机的一行原始输出，转成 0~N 行给人看的日志。 */
function tidy(l) {
  const s = l.trim();

  // 流水线预取噪音：只累计，不逐条刷屏
  if (/已申请临时邮箱/.test(s)) { prep.mailbox++; prep.dirty = true; return []; }
  if (/已向 .* 发送验证码/.test(s)) return [];
  if (/已收到验证码/.test(s)) { prep.code++; prep.dirty = true; return []; }
  if (/打开 x\.ai 注册页/.test(s)) return [];
  if (/Turnstile 已通过/.test(s)) { prep.turnstile++; prep.dirty = true; return []; }

  // 预取阶段的失败必须可见
  if (/Turnstile 破解超时/.test(s)) return ["  ⚠ Turnstile 破解超时，重试"];
  if (/等验证码超时/.test(s)) {
    const m = s.match(/\[P\]\s+(\S+)\s+等验证码超时/);
    return [`  ⚠ ${m ? m[1] : "邮箱"} 等验证码超时，换一个`];
  }

  // 启动阶段
  if (/正在获取站点配置/.test(s)) return ["  读取 x.ai 站点配置"];
  if (/正在启动浏览器/.test(s)) return ["  启动隐身浏览器"];
  if (/注册服务已启动/.test(s)) return [];

  // 单个账号的进展
  let m = s.match(/^\[→\] 开始注册 #(\d+)/);
  if (m) return [...flushPrep(), "", `#${m[1]} 开始注册`];
  m = s.match(/└ #(\d+) (.+?)\.{0,3}$/);
  if (m) return [`   · ${m[2]}`];
  m = s.match(/^\[✓\] 注册成功 #(\d+) \| 用时 (\S+)/);
  if (m) return [`#${m[1]} ✓ 注册成功（${m[2]}）`];
  if (/^\[✗\]|注册失败/.test(s)) return [`  ✗ ${s.replace(/^\[[^\]]*\]\s*/, "")}`];

  // 冗余的"完成"宣告与进度心跳（收尾会给最终结论）
  if (/全部注册完成|已达目标|运行中 \| 累计/.test(s)) return [];
  // hub 内部实现细节：正常路径不展示（滞留收尾属于已知行为）
  if (/注册已达标但进程滞留|注册进程退出 code=/.test(s)) return [];

  return [s];
}

function push(line) {
  const t = line.toString();
  for (const l of t.split(/\r?\n/)) {
    if (!l.trim()) continue;
    // 注册机达标后常滞留在验证码轮询超时里（可滞留 10+ 分钟），记下达标时刻供 watcher 收尾
    if (/全部注册完成|已达目标/.test(l)) completionAt = Date.now();
    for (const out of tidy(l)) {
      ring.push(out);
      if (ring.length > RING_MAX) ring.shift();
    }
  }
}

/** hub 自己的日志不经整理层，直接进环。滞留收尾属正常行为，静音。 */
function pushRaw(line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (/注册已达标但进程滞留|注册进程退出 code=/.test(l)) continue;
    ring.push(l);
    if (ring.length > RING_MAX) ring.shift();
  }
}

/** 解析 keys/ 下指定文件：email:password:sso。不落任何存储。 */
function parseKeysFile(name) {
  const f = join(REGISTER_DIR, "keys", name);
  if (!existsSync(f)) return [];
  const out = [];
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const email = parts[0].trim();
    const password = parts[1].trim();
    const sso = parts.slice(2).join(":").trim();
    if (email.includes("@") && sso.length >= 32) out.push({ email, password, sso, line });
  }
  return out;
}
const parseKeys = () => parseKeysFile("accounts.txt");

// ───────── 即时上传：注册出一个就传一个，不等整批结束 ─────────
const uploadedEmails = new Set();  // 本轮已处理（成功或失败）的邮箱，避免重复
let liveTimer = null;
let liveBusy = false;
let liveUploaded = 0;
const liveFailures = [];

/** 单个账号完整接入：上传 → 派生三格式 → 开 NSFW。每步播报。 */
async function ingestOne(a, label) {
  const doDerive = store.getSetting("grok2api_auto_derive", "true") !== "false";
  const doNsfw = store.getSetting("grok2api_auto_nsfw", "true") !== "false";
  const tag = `${label} ${mail(a.email)}`;
  const done = [];
  const warn = [];

  const r = await grok2api.importSso(a.sso);
  if (!r.ok) throw new Error(r.message);
  done.push("web");

  if (doDerive) {
    const acc = await grok2api.findAccountByEmail(a.email);
    if (!acc) {
      warn.push("派生跳过（grok2api 查不到该账号）");
    } else {
      if (await grok2api.syncToConsole([acc.id]).then(() => true).catch((e) => { warn.push(`console 派生失败：${e.message}`); return false; })) done.push("console");
      if (await grok2api.convertToBuild([acc.id]).then(() => true).catch((e) => { warn.push(`build 派生失败：${e.message}`); return false; })) done.push("build");
    }
  }
  if (doNsfw) {
    const web = await grok2api.findWebAccountByEmail(a.email);
    if (!web) {
      warn.push("NSFW 跳过（查不到 Web 账号）");
    } else {
      const res = await grok2api.accountSetup(web.id).catch((e) => ({ ok: false, done: [], failed: [e.message] }));
      if (res.ok) done.push("NSFW");
      else warn.push(`NSFW 未完成：${res.failed.join("；")}`);
    }
  }
  pushRaw(`  ${tag} → 已接入（${done.join(" + ")}）`);
  for (const w of warn) pushRaw(`    ⚠ ${w}`);
}

/** 扫一遍 accounts.txt，把没处理过的新号立刻接入。注册仍在跑时并行进行。 */
async function drainNewAccounts() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    for (const a of parseKeysFile("accounts.txt")) {
      if (uploadedEmails.has(a.email)) continue;
      uploadedEmails.add(a.email);
      try {
        await ingestOne(a, "[即时]");
        liveUploaded += 1;
      } catch (e) {
        pushRaw(`  [即时] ${mail(a.email)} ✗ 上传失败：${e.message}（留到收尾重试）`);
        liveFailures.push(a.email);
        uploadedEmails.delete(a.email); // 允许收尾阶段重试
      }
    }
  } finally {
    liveBusy = false;
  }
}

/** 清掉注册机本地留存（账号/SSO/会话 cookie/风控标记文件）。 */
function clearKeys() {
  const dir = join(REGISTER_DIR, "keys");
  for (const f of ["accounts.txt", "grok.txt", "auth-sessions.jsonl"]) {
    try { rmSync(join(dir, f)); } catch { /* 本就不存在 */ }
  }
  try {
    for (const f of readdirSync(dir)) if (f.includes("risk") || f.endsWith(".txt")) rmSync(join(dir, f));
  } catch { /* 目录不存在 */ }
}

/** 跑完后的固定动作：
    1. accounts.retry.txt（上轮上传失败残留）先补传——不让计数膨胀
    2. accounts.txt（本轮新号）逐个上传（派生 + NSFW）——registeredTotal 只计这些
    3. 失败行统一挪进 retry.txt 下轮补传；全部成功才清 keys/
    4. 记录计数 */
async function finalizeRun() {
  clearInterval(liveTimer);
  liveTimer = null;
  await drainNewAccounts();          // 最后再兜一次，捞走末班车的号
  const fresh = parseKeysFile("accounts.txt");
  const retry = parseKeysFile("accounts.retry.txt");
  const success = fresh.length;      // 计数口径：只算本轮新注册（含已即时上传的）
  let uploaded = liveUploaded;       // 即时上传的算数
  const failures = [];
  const retryFailedLines = [];
  const freshFailedLines = [];
  // 已经即时接入成功的不再重复上传
  const pending = [...retry, ...fresh].filter((a) => !uploadedEmails.has(a.email));
  const total = pending.length;

  phase = "finalize";
  pushRaw("")
  pushRaw("──── 收尾 ────");
  pushRaw(`  产物：本轮新号 ${fresh.length} 个${liveUploaded ? `（${liveUploaded} 个已在注册中即时接入）` : ""}${retry.length ? `，上轮待补传 ${retry.length} 个` : ""}`);
  if (total === 0) {
    pushRaw(fresh.length > 0
      ? "  全部已在注册过程中即时接入，无需补传"
      : "  ⚠ 没有可上传的账号（可能全部被风控拒绝）");
  } else {
    const doDerive = store.getSetting("grok2api_auto_derive", "true") !== "false";
    const doNsfw = store.getSetting("grok2api_auto_nsfw", "true") !== "false";
    pushRaw(`  补传剩余 ${total} 个 → grok2api${doDerive ? " + 派生三格式" : "（派生已关）"}${doNsfw ? " + 开启 NSFW" : "（NSFW 已关）"}`);

    let idx = 0;
    for (const a of pending) {
      idx += 1;
      try {
        await ingestOne(a, `(${idx}/${total})`);
        uploaded += 1;
      } catch (e) {
        pushRaw(`  (${idx}/${total}) ${mail(a.email)} ✗ 失败：${e.message}`);
        failures.push(`${a.email}: ${e.message}`);
        if (fresh.includes(a)) freshFailedLines.push(a.line);
        else retryFailedLines.push(a.line);
      }
    }
    pushRaw(`  补传完成：成功 ${uploaded}/${fresh.length + retry.length}${failures.length ? `，失败 ${failures.length}` : ""}`);
  }
  const kdir = join(REGISTER_DIR, "keys");
  const keep = [...retryFailedLines, ...freshFailedLines];
  try {
    if (keep.length > 0) writeFileSync(join(kdir, "accounts.retry.txt"), keep.join("\n") + "\n");
    else rmSync(join(kdir, "accounts.retry.txt"), { force: true });
    rmSync(join(kdir, "accounts.txt"), { force: true }); // 成功的不留，失败的已进 retry
  } catch { /* 尽力而为 */ }
  if (keep.length === 0) clearKeys(); // 连会话 cookie/风控标记一起清
  pushRaw(keep.length === 0
    ? "  本地留存已清除"
    : `  ⚠ ${keep.length} 个失败账号留待下轮自动补传`);
  if (success > 0 && keep.length === 0) {
    store.addAlert({ level: "info", alertType: "register_run", title: "注册批次完成",
      message: `成功 ${success} 个，全部已上传 grok2api（派生+NSFW 完毕），本地留存已清除`,
      sourceType: "system", sourceId: "" });
  } else if (failures.length > 0) {
    store.addAlert({ level: "severe", alertType: "register_run", title: "注册批次上传部分失败",
      message: `本轮新号 ${success} 个、上传成功 ${uploaded} 个；失败 ${keep.length} 个留在 retry 待补传：${failures.join("；").slice(0, 200)}`,
      sourceType: "system", sourceId: "" });
  }
  store.recordRegisterRun({ target, success, uploaded, note: failures.join("; ") });
  
  phase = "done";
  return { success, uploaded, failures };
}

export function start({ target: t = 1, strict: s = true } = {}) {
  if (child && !exited) return { ok: false, message: "注册已在运行中" };
  if (!existsSync(PY)) return { ok: false, message: `找不到注册机解释器: ${PY}` };
  target = Math.max(0, Number(t) || 0);
  strict = !!s;
  ring.length = 0;
  startedAt = Date.now();
  lastResult = null;
  const ov = compat.registerEnvOverrides();
  const mask = (k, v) => /KEYS|PASSWORD/.test(k) ? String(v).slice(0, 5) + "…" : v;
  appliedEnv = Object.entries(ov)
    .filter(([k]) => k !== "GROK2API_AUTO_IMPORT")
    .map(([k, v]) => `${k}=${mask(k, v)}`)
    .concat([`STRICT_TARGET=${strict ? "1" : "0"}`])
    .join(" ") || "（无覆盖，用注册机 .env）";
  child = spawn(PY, ["-m", "grok_register.register", "--target", String(target || 0)], {
    cwd: REGISTER_DIR,
    env: { ...process.env, ...ov, STRICT_TARGET: strict ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pushRaw(`▶ 开始注册 ${target || "不限量"} 个账号${strict ? "（严格精确模式）" : ""}`);
  pushRaw(`  代理 ${ov.HTTPS_PROXY || "用注册机 .env"} · 并发 ${ov.PHYSICAL_CAP || "自动"} · 邮箱 ${(compat.settingsWithDefaults().register_email_mode || "tempmail")}`);
  resetTidy();
  phase = "registering";
  exited = false;
  // 即时上传：每 5 秒扫一次产物，注册出一个就立刻接入，不等整批结束
  uploadedEmails.clear();
  liveUploaded = 0;
  liveFailures.length = 0;
  clearInterval(liveTimer);
  liveTimer = setInterval(() => { drainNewAccounts().catch(() => {}); }, 5_000);
  completionAt = null;
  clearInterval(lingerTimer);
  lingerTimer = setInterval(() => {
    if (!child || exited || !completionAt) return;
    if (Date.now() - completionAt > 20_000) {
      pushRaw("[hub] 注册已达标但进程滞留（验证码轮询超时中），发送 SIGTERM 进入收尾");
      child.kill("SIGTERM");
    }
  }, 5_000);
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("exit", (code, signal) => {
    exited = true;
    clearInterval(lingerTimer);
    pushRaw(`[hub] 注册进程退出 code=${code}${signal ? ` signal=${signal}` : ""}`);
    lastResult = { code, signal, finishedAt: Date.now(), uploading: true };
    // 异步收尾：上传 + 清 keys + 记账；完成后刷新 lastResult
    finalizeRun()
      .then((fin) => {
        lastResult = { code, signal, finishedAt: Date.now(), ...fin };
        pushRaw(fin.failures.length
          ? `──────── 全部结束：注册 ${fin.success}，上传 ${fin.uploaded}，失败 ${fin.failures.length}（已存 retry 待补传）────────`
          : `──────── 全部结束：注册 ${fin.success} 个，已全部接入 grok2api ────────`);
      })
      .catch((e) => {
        lastResult = { code, signal, finishedAt: Date.now(), error: e.message };
        phase = "done";
        pushRaw(`[hub] 收尾出错: ${e.message}`);
      });
  });
  child.on("error", (e) => pushRaw(`[hub] 进程错误: ${e.message}`));
  return { ok: true, target, strict };
}

export function stop() {
  if (!child || exited) return { ok: false, message: "没有在跑的注册进程" };
  child.kill("SIGTERM");
  pushRaw("[hub] 已发送 SIGTERM");
  return { ok: true };
}

export function status() {
  const PHASE_TEXT = {
    idle: "空闲",
    registering: "阶段 1/2 · 注册机正在注册账号",
    finalize: "阶段 2/2 · 上传 grok2api（派生三格式 + 开 NSFW）",
    done: "已完成",
  };
  return {
    running: !!(child && !exited),
    phase,
    phaseText: PHASE_TEXT[phase] || phase,
    envApplied: appliedEnv,   // 完整生效配置：供排障查看，不刷进日志
    startedAt,
    target,
    strict,
    lastResult,
    lines: ring.slice(-120),
    registerDir: REGISTER_DIR,
  };
}
