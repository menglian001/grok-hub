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
const ring = [];

function push(line) {
  const t = line.toString();
  for (const l of t.split(/\r?\n/)) {
    if (!l.trim()) continue;
    ring.push(l);
    if (ring.length > RING_MAX) ring.shift();
    // 注册机达标后常滞留在验证码轮询超时里（可滞留 10+ 分钟），记下达标时刻供 watcher 收尾
    if (/全部注册完成|已达目标/.test(l)) completionAt = Date.now();
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
  const fresh = parseKeysFile("accounts.txt");
  const retry = parseKeysFile("accounts.retry.txt");
  const success = fresh.length; // 计数口径：只算本轮新注册
  let uploaded = 0;
  const failures = [];
  const retryFailedLines = [];
  const freshFailedLines = [];
  const uploadOne = async (a) => {
    const r = await grok2api.importSso(a.sso);
    if (!r.ok) throw new Error(r.message);
    if (store.getSetting("grok2api_auto_derive", "true") !== "false") {
      const acc = await grok2api.findAccountByEmail(a.email);
      if (acc) {
        await grok2api.syncToConsole([acc.id]).catch(() => {});
        await grok2api.convertToBuild([acc.id]).catch(() => {});
      }
    }
    if (store.getSetting("grok2api_auto_nsfw", "true") !== "false") {
      const web = await grok2api.findWebAccountByEmail(a.email);
      if (web) await grok2api.accountSetup(web.id).catch(() => {});
    }
  };
  for (const a of [...retry, ...fresh]) {
    try {
      await uploadOne(a);
      uploaded += 1;
    } catch (e) {
      failures.push(`${a.email}: ${e.message}`);
      if (fresh.includes(a)) freshFailedLines.push(a.line);
      else retryFailedLines.push(a.line);
    }
  }
  const kdir = join(REGISTER_DIR, "keys");
  const keep = [...retryFailedLines, ...freshFailedLines];
  try {
    if (keep.length > 0) writeFileSync(join(kdir, "accounts.retry.txt"), keep.join("\n") + "\n");
    else rmSync(join(kdir, "accounts.retry.txt"), { force: true });
    rmSync(join(kdir, "accounts.txt"), { force: true }); // 成功的不留，失败的已进 retry
  } catch { /* 尽力而为 */ }
  if (keep.length === 0) clearKeys(); // 连会话 cookie/风控标记一起清
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
  const applied = Object.entries(ov)
    .filter(([k]) => k !== "GROK2API_AUTO_IMPORT")
    .map(([k, v]) => `${k}=${mask(k, v)}`)
    .join(" ") || "（无覆盖，用注册机 .env）";
  child = spawn(PY, ["-m", "grok_register.register", "--target", String(target || 0)], {
    cwd: REGISTER_DIR,
    env: { ...process.env, ...ov },
    stdio: ["ignore", "pipe", "pipe"],
  });
  push(`[hub] 启动注册: target=${target || "不限"} strict=${strict ? "on" : "off"}`);
  push(`[hub] 生效配置覆盖: ${applied}`);
  exited = false;
  completionAt = null;
  clearInterval(lingerTimer);
  lingerTimer = setInterval(() => {
    if (!child || exited || !completionAt) return;
    if (Date.now() - completionAt > 20_000) {
      push("[hub] 注册已达标但进程滞留（验证码轮询超时中），发送 SIGTERM 进入收尾");
      child.kill("SIGTERM");
    }
  }, 5_000);
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("exit", (code, signal) => {
    exited = true;
    clearInterval(lingerTimer);
    push(`[hub] 注册进程退出 code=${code}${signal ? ` signal=${signal}` : ""}`);
    lastResult = { code, signal, finishedAt: Date.now(), uploading: true };
    // 异步收尾：上传 + 清 keys + 记账；完成后刷新 lastResult
    finalizeRun()
      .then((fin) => {
        lastResult = { code, signal, finishedAt: Date.now(), ...fin };
        push(`[hub] 收尾完成: 成功 ${fin.success}，上传 ${fin.uploaded}${fin.failures.length ? `，失败 ${fin.failures.length}` : "，本地已清"}`);
      })
      .catch((e) => {
        lastResult = { code, signal, finishedAt: Date.now(), error: e.message };
        push(`[hub] 收尾出错: ${e.message}`);
      });
  });
  child.on("error", (e) => push(`[hub] 进程错误: ${e.message}`));
  return { ok: true, target, strict };
}

export function stop() {
  if (!child || exited) return { ok: false, message: "没有在跑的注册进程" };
  child.kill("SIGTERM");
  push("[hub] 已发送 SIGTERM");
  return { ok: true };
}

export function status() {
  return {
    running: !!(child && !exited),
    startedAt,
    target,
    strict,
    lastResult,
    lines: ring.slice(-120),
    registerDir: REGISTER_DIR,
  };
}
