# Grok Hub — 注册控制台

前端布局取自 u1s12api 的 dashboard（Tailwind + Chart.js，奶油底 / 墨绿 / 焦橙），
数据层为 grok 场景极简重写。**职责只有一件事：驱动注册机批量注册 Grok 账号，
产物自动上传 grok2api，本地不留存。**

铁律：grok2api 是别人的项目，这里只调用它的管理 API，绝不修改它。

## 数据流（全自动）

```
注册机(grok_register) ──keys/accounts.txt──▶ hub 收尾：
  1. 补传 accounts.retry.txt（上轮失败残留，不计数）
  2. 解析本轮新号 email:password:sso，逐个上传 grok2api（管理面登录 → 上传 grok-web-sso-tokens.txt）
  3. 自动派生三格式（sync-to-console + convert-to-build，设置可关）
  4. 自动开启 NSFW（accept-terms → birth-date → nsfw，设置可关；grok2api 全局 allowNSFW 需为开）
  5. 全部成功 → 清除 keys/ 本地留存；有失败 → 失败行进 retry.txt 下轮补传 + 严重告警
  6. 只记数量（register_runs 表），账号本体不落地
```

注意：注册机达标后常滞留在验证码轮询超时里（10+ 分钟不退出），hub 的
linger watcher 会在达标 20 秒后 SIGTERM 收尾，不会卡住上传。

## 起

```bash
cd grok-hub/hub
GROK_HUB_PASSWORD=你的面板密码 node server.mjs 8790
```

打开 <http://127.0.0.1:8790/>，输入面板密码登录（scrypt 哈希存 SQLite，
会话 cookie HttpOnly）。零 npm 依赖，SQLite 用 Node 内置 `node:sqlite`（需 Node ≥ 22）。

首次启动必须用 `GROK_HUB_PASSWORD` 写入密码；绑定非 127.0.0.1 且无密码会拒绝启动。

## 页面

| 页面 | 说明 |
|---|---|
| 概览 | 累计注册 / 今日注册 / 已上传 / 本地滞留 + 注册趋势 + 最近活动 |
| 注册机 | 设目标数量跑 grok_register，实时日志；跑完自动上传+清理 |
| 告警中心 | 上传失败、注册机异常等真实告警，可单条/全部解决 |
| 系统设置 | grok2api 地址/凭据、自动派生开关、默认注册数量 |

## grok2api 侧（不改它）

- 管理面：`POST /manage/api/login`（用户名+密码）拿 JWT
- 上传：`POST /manage/api/sso-token/upload`，**文件名必须是 `grok-web-sso-tokens.txt`**（硬编码校验）
- 派生：`POST /manage/api/sso-token/sync-to-console`、`.../convert-to-build`（grok2api 不会自动做）
- 池子探活：`GET /manage/api/sso-token/list`

## 关键路径

| 文件 | 职责 |
|---|---|
| `hub/server.mjs` | HTTP：静态 + `/api/*`（登录、统计、注册机、告警、设置） |
| `hub/auth.mjs` | 面板密码 scrypt + 会话 cookie |
| `hub/store.mjs` | SQLite：settings / alerts / register_runs（只记数量） |
| `hub/grok2api.mjs` | grok2api 管理面客户端（登录/上传/派生/列表/连通性） |
| `hub/register.mjs` | spawn 注册机 + 日志环 + 达标滞留收尾 + 自动上传/清理 |
| `hub/compat.mjs` | 前端数据契约（数字 id 桥、stats、设置定义） |
| `hub/public/` | 仪表盘前端（fragment 组装，同源 cookie 鉴权） |

注册机本体见 [hechuyi/grok-free-register](https://github.com/hechuyi/grok-free-register)（不在本仓库内），`STRICT_TARGET=1`
时 `--target N` 恰好注册 N 个。
