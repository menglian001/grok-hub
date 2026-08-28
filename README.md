# Grok Hub

Grok 账号注册控制台。按一次「开始注册」，剩下全自动：批量注册 → 上传 [grok2api](https://github.com/chenyme/grok2api) → 派生 Web / Console / Build 三种格式 → 开启 NSFW → 清空本地留存。

基于 [hechuyi/grok-free-register](https://github.com/hechuyi/grok-free-register) 二次修改。

仅供学习研究，请遵守目标站点服务条款与当地法律，风险自负。

---

## 为什么要有它

注册机产出的只有一样东西：**Web SSO cookie**。但 grok2api 有三个账号池（Web / Console / Build），
后两种要在后台逐个点转换；NSFW 也要逐个账号点三次（接受条款、填生日、开偏好）。

一个号手点大概一分钟，十个号就是十分钟的重复劳动，还容易漏。Grok Hub 把这条链子接起来：

```
你点「开始注册」
   ↓
注册机批量注册 Grok 账号 ──────────────→ 产出 Web SSO
   ↓
上传 grok2api                          → grok_web 账号
   ↓ sync-to-console                   → grok_console 账号
   ↓ convert-to-build                   → grok_build 账号
   ↓ accept-terms → birth-date → nsfw   → NSFW 开启
   ↓
keys/ 清空，本地只留一个计数
```

## 它不做什么

- **不是 API 网关**：不代理 `/v1/*`，聊天流量该走 grok2api 就走 grok2api
- **不是号池管理器**：账号本体不落地，注册即上传，本地只记「注册了多少个」
- **不含注册机和 grok2api**：两者都是独立项目，本项目只驱动与调用，不改它们一行代码

## 依赖

| 组件 | 说明 |
|---|---|
| Node ≥ 22 | 用了内置 `node:sqlite`，**零 npm 依赖**，不用 `npm install` |
| [grok2api](https://github.com/chenyme/grok2api) | 已部署、管理面可访问。三格式派生与 NSFW 都靠它的管理 API |
| [grok-free-register](https://github.com/hechuyi/grok-free-register) | 注册机，需能独立跑通（Python + Playwright） |
| 代理 | 注册机要能访问 x.ai / grok.com |

## 快速开始

```bash
git clone https://github.com/menglian001/grok-hub.git && cd grok-hub

# 首次启动：写入面板密码（scrypt 哈希存 SQLite，只需一次）
GROK_HUB_PASSWORD='你的面板密码' GROK_REGISTER_DIR=/opt/grok-free-register \
  node hub/server.mjs 8790

# 之后直接启动
GROK_REGISTER_DIR=/opt/grok-free-register node hub/server.mjs 8790
```

打开 <http://127.0.0.1:8790/> 登录，进 **系统设置 → 运行配置** 填三项：

| 设置 | 说明 |
|---|---|
| grok2api 地址 | 如 `http://1.2.3.4:8000` |
| grok2api 管理员用户名 / 密码 | 管理面登录凭据，存本机 SQLite |
| 注册代理 | 如 `http://127.0.0.1:7890`，留空则用注册机 `.env` 里的值 |

点「测试连接（登录一次）」确认能通，再去**注册机**页开跑。

**开跑前先在 grok2api 里打开「允许 NSFW 图片」**（设置 → Web，即 `providerWeb.allowNSFW`）。
这是服务端全局开关，hub 管不到；不开的话账号层开了也不生效。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GROK_REGISTER_DIR` | 开发机路径 | **必填**。注册机目录，hub 调用其 `.venv/bin/python -m grok_register.register` |
| `GROK_HUB_PASSWORD` | — | 面板密码，只在首次或改密码时需要 |
| `GROK_HUB_HOST` | `127.0.0.1` | 监听地址。**绑非本地且未设密码会拒绝启动** |
| `GROK_HUB_PORT` | `8790` | 端口（也可用第一个命令行参数） |
| `GROK_HUB_DIR` | `~/.grok-hub/hub` | SQLite 存放目录（0700 权限） |
| `GROK_HUB_TLS` | `0` | 设 `1` 表示前面有 HTTPS 反代，cookie 加 `Secure` |

### systemd

`deploy/grok-hub.service` 可直接用：

```bash
sudo cp -r . /opt/grok-hub
sudo cp deploy/grok-hub.service /etc/systemd/system/
sudo vim /etc/systemd/system/grok-hub.service   # 改 GROK_REGISTER_DIR、首次填密码
sudo systemctl enable --now grok-hub
journalctl -u grok-hub -f
```

## 界面

| 页面 | 内容 |
|---|---|
| 概览 | 今日注册 / 累计注册 / 已上传 / 本地滞留（正常为 0） |
| 注册机 | 设数量、严格模式、实时日志、启停 |
| 告警中心 | 上传失败、注册异常、面板被暴力登录 |
| 系统设置 | grok2api 连接、注册代理、邮箱令牌、并发、自动化开关 |

注册机页的「严格精确模式」（`STRICT_TARGET=1`）表示恰好注册 N 个；关掉则允许为吸收失败率而超发。
代理、邮箱令牌、并发都在设置页改，启动时注入注册机进程，**覆盖它的 `.env`，留空则沿用**。
每次启动日志会回显生效的覆盖项（令牌自动脱敏），方便核对。

## 自动化怎么实现的

### 三种格式

上传的只有 Web SSO，另外两种是调 grok2api 现成端点换来的：

| 步骤 | 端点 | 产出 |
|---|---|---|
| 上传 | `POST /api/admin/v1/accounts/web/import` | `grok_web` |
| 转 Console | `POST /api/admin/v1/accounts/web/sync-to-console` | `grok_console` |
| 转 Build | `POST /api/admin/v1/accounts/web/convert-to-build` | `grok_build` |

三者同一个 `userId`，靠 `linkedAccountId` 关联，是同一个 Grok 账号的三种调用方式。

**坑**：上传的文件名必须是 `grok-web-sso-tokens.txt`。grok2api 靠文件名识别 token 类型，
换个名字会报 `Cannot read properties of undefined (reading 'trim')`。

### NSFW 分两层

| 层 | 在哪 | 谁来开 |
|---|---|---|
| 全局 | grok2api 设置 `providerWeb.allowNSFW` | **你自己开**，一次性 |
| 账号 | 每个 Grok 账号在 grok.com 上的设置 | hub 自动开，每个新号都做 |

账号层是三个 POST，**顺序不能换**：

```
POST /api/admin/v1/accounts/web/{id}/accept-terms   接受条款
POST /api/admin/v1/accounts/web/{id}/birth-date     写成人生日
POST /api/admin/v1/accounts/web/{id}/nsfw           开成人偏好
```

不接受条款、没成年生日，grok.com 不会让你开 NSFW。成功后账号带 `nsfwEnabledAt` 时间戳，
grok2api 账号列表里会显示一个黄色标记。两层都开才真正生效，账号层可在设置里关掉。

### 注册机会卡住，hub 会替它收尾

注册机达到目标数量后，有时会卡在验证码轮询超时里十几分钟不退出，把上传流程一起堵死。
hub 盯着日志里的「全部注册完成 / 已达目标」，20 秒后进程还活着就发 `SIGTERM` 进收尾。

### 上传失败不会丢号也不会重复计数

失败的号写进 `keys/accounts.retry.txt`，下一轮收尾时**先补传**，且不计入注册数。
补传成功即删除，同时发严重告警提示查看。

## 数据与隐私

- **账号本体不落地**：SSO 只在内存里过一遍，上传成功后 `keys/` 立即清空
- SQLite 里只有：设置项、注册计数（`register_runs`）、告警、面板密码哈希
- 面板密码 scrypt 哈希，不存明文；grok2api 凭据明文存本机 SQLite（0700 目录）
- 日志里的邮箱令牌与密码自动脱敏

## 安全

- 所有 `/api/*` 都要面板会话（HttpOnly + SameSite=Strict cookie，12 小时）
- 登录限流：同 IP 连续 6 次错误锁 15 分钟并产生告警
- 绑定非 `127.0.0.1` 时必须先设密码，否则拒绝启动
- 公网暴露请套 HTTPS 反代并设 `GROK_HUB_TLS=1`，否则登录密码走明文

## 项目结构

```
hub/
├── server.mjs      HTTP：静态资源 + /api/*
├── auth.mjs        面板密码 + 会话 + 限流
├── store.mjs       SQLite：设置 / 计数 / 告警
├── grok2api.mjs    grok2api 管理面客户端（登录 / 上传 / 派生 / NSFW）
├── register.mjs    驱动注册机 + 日志环 + 滞留收尾 + 自动上传清理
├── compat.mjs      前端数据契约 + 设置定义 + 注册机环境注入
└── public/         仪表盘前端（原生 JS + Tailwind CDN，fragment 组装）
```

## 已知限制

- hub 重启时若注册正在跑，该轮无人收尾，账号留在 `keys/`（下轮会补传）
- 面板会话存内存，hub 重启需重新登录
- 概览的「注册趋势」图暂无数据源
- `GROK_REGISTER_DIR` 默认值是开发机路径，部署必须覆盖

## License

GPL-3.0，见 [LICENSE](LICENSE)。
