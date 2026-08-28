# Grok Hub

Grok 账号注册控制台。批量注册 → 自动上传 [grok2api](https://github.com/chenyme/grok2api) → 自动派生三种账号格式 → 自动开启 NSFW，本地不留账号。

仅供学习研究，请遵守目标站点服务条款与当地法律，风险自负。

---

## 这是什么

Grok 账号有三种调用形态（Web / Console / Build），grok2api 用三个池子分别管理。
但注册机产出的只有 **Web SSO cookie** 一种，剩下两种要在 grok2api 后台手点转换，
NSFW 也要逐个账号手动开。号一多就没法手工干了。

Grok Hub 把这条链子接起来：**你只按一次「开始注册」，剩下全自动。**

```
你点开始注册
   ↓
grok_register 批量注册 Grok 账号（产出 Web SSO）
   ↓
hub 逐个上传 grok2api            → grok_web 账号
   ↓ sync-to-console             → grok_console 账号
   ↓ convert-to-build            → grok_build 账号
   ↓ accept-terms→birth-date→nsfw → NSFW 开启
   ↓
本地 keys/ 清空，只留一个计数
```

**设计原则：grok2api 是别人的项目，本项目只调用它公开的管理 API，不改它一行代码。**

## 不是什么

- 不是 API 网关——不代理 `/v1/*` 请求，聊天流量走 grok2api
- 不是号池管理器——账号本体不落地，注册即上传，本地只存「注册了多少个」
- 不含注册机本体——注册机是独立项目，本项目通过子进程驱动它

## 依赖

| 组件 | 说明 |
|---|---|
| Node ≥ 22 | 用了内置 `node:sqlite`，**零 npm 依赖**，不用 `npm install` |
| [grok2api](https://github.com/chenyme/grok2api) | 已部署并能访问管理面（本项目只调它的 API） |
| [grok-free-register](https://github.com/hechuyi/grok-free-register) | Grok 注册机，需能独立跑通（Python + Playwright） |
| 代理 | 注册机要能访问 x.ai / grok.com |

## 快速开始

```bash
git clone <this-repo> && cd grok-hub

# 首次启动：用环境变量写入面板密码（scrypt 哈希存 SQLite，只需一次）
GROK_HUB_PASSWORD='你的面板密码' node hub/server.mjs 8790

# 之后直接启动
node hub/server.mjs 8790

# 后台常驻
(setsid node hub/server.mjs 8790 >hub.log 2>&1 </dev/null &)
```

打开 <http://127.0.0.1:8790/>，用面板密码登录。

然后进 **系统设置 → 运行配置**，至少填三项：

| 设置 | 说明 |
|---|---|
| grok2api 地址 | 如 `http://1.2.3.4:8000` |
| grok2api 管理员用户名 / 密码 | 管理面登录凭据，存本机 SQLite |
| 注册代理 | 如 `http://127.0.0.1:7890`，留空则用注册机 `.env` 的值 |

填完点「测试连接（登录一次）」确认能通，再去**注册机**页开跑。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GROK_HUB_PASSWORD` | — | 面板密码，只在首次或改密码时需要 |
| `GROK_HUB_HOST` | `127.0.0.1` | 监听地址。**绑非本地且未设密码会拒绝启动** |
| `GROK_HUB_PORT` | `8790` | 端口（也可用第一个命令行参数） |
| `GROK_HUB_DIR` | `~/.grok-hub/hub` | SQLite 存放目录（0700 权限） |
| `GROK_HUB_TLS` | `0` | 设 `1` 表示前面有 HTTPS 反代，cookie 加 `Secure` |
| `GROK_REGISTER_DIR` | 见下 | 注册机项目目录，必须指向你本地路径 |

`GROK_REGISTER_DIR` 目前在 `hub/register.mjs` 顶部有一个硬编码默认值，**部署时请用环境变量覆盖**：

```bash
GROK_REGISTER_DIR=/opt/grok-register node hub/server.mjs 8790
```

hub 会调用该目录下的 `.venv/bin/python -m grok_register.register`。

### systemd 部署

`deploy/grok-hub.service` 是可直接用的示例：

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
| 注册机 | 设数量、严格模式开关、实时日志、启停 |
| 告警中心 | 上传失败、注册异常、面板被暴力登录等 |
| 系统设置 | grok2api 连接、注册代理、邮箱令牌、并发、自动化开关 |

## 自动化细节

### 三种账号格式怎么来的

上传的只有 Web SSO，另外两种是 hub 调 grok2api 现成端点换来的：

| 步骤 | 端点 | 产出 |
|---|---|---|
| 1 上传 | `POST /api/admin/v1/accounts/web/import` | `grok_web` |
| 2 转 Console | `POST /api/admin/v1/accounts/web/sync-to-console` | `grok_console` |
| 3 转 Build | `POST /api/admin/v1/accounts/web/convert-to-build` | `grok_build` |

三者同一个 `userId`，通过 `linkedAccountId` 关联，是同一个 Grok 账号的三种调用方式。

**坑**：上传的文件名必须是 `grok-web-sso-tokens.txt` —— grok2api 靠文件名识别 token 类型，
换个名字会报 `Cannot read properties of undefined (reading 'trim')`。

### NSFW 怎么开的（两层）

- **全局层**：grok2api 设置里的 `providerWeb.allowNSFW`（界面上叫「允许 NSFW 图片」），
  控制图片请求是否带成人内容偏好。**这一层要你在 grok2api 里自己开。**
- **账号层**：每个 Grok 账号在 grok.com 上的设置。hub 自动做，顺序不能换：

  ```
  POST /api/admin/v1/accounts/web/{id}/accept-terms   接受条款
  POST /api/admin/v1/accounts/web/{id}/birth-date     写成人生日
  POST /api/admin/v1/accounts/web/{id}/nsfw           开成人偏好
  ```

  不接受条款、没成年生日，grok.com 不会让你开 NSFW。成功后账号有 `nsfwEnabledAt` 时间戳。

两层都开，NSFW 才真正生效。账号层可在设置里关掉。

### 注册机滞留处理

注册机达标后有时会卡在验证码轮询超时里 10 分钟以上不退出，导致收尾被阻塞。
hub 监听日志里的「全部注册完成 / 已达目标」，20 秒后进程还活着就发 `SIGTERM` 进入收尾。

### 上传失败怎么办

失败的号写进 `keys/accounts.retry.txt`，下一轮注册收尾时**先补传**，且不计入注册数
（避免重复计数）。补传成功即删除，同时发严重告警提示你查看。

## 数据与隐私

- **账号本体不落地**：SSO 只在内存里过一遍，上传成功后 `keys/` 立即清空
- SQLite 里只有：设置项、注册计数（`register_runs`）、告警、面板密码哈希
- 面板密码走 scrypt，不存明文；grok2api 凭据明文存本机 SQLite（0700 目录）
- 日志里的邮箱令牌/密码自动脱敏

## 安全

- 所有 `/api/*` 都要面板会话（HttpOnly + SameSite=Strict cookie，12 小时）
- 登录限流：同 IP 连续 6 次错误锁 15 分钟，并产生告警
- 绑定非 `127.0.0.1` 时**必须**先设密码，否则拒绝启动
- 公网暴露请套 HTTPS 反代并设 `GROK_HUB_TLS=1`，否则密码走明文

## 项目结构

```
hub/
├── server.mjs      HTTP：静态资源 + /api/*
├── auth.mjs        面板密码 + 会话 + 限流
├── store.mjs       SQLite：设置 / 计数 / 告警
├── grok2api.mjs    grok2api 管理面客户端（登录/上传/派生/NSFW）
├── register.mjs    驱动注册机 + 日志环 + 滞留收尾 + 自动上传清理
├── compat.mjs      前端数据契约 + 设置定义 + 注册机环境注入
└── public/         仪表盘前端（原生 JS + Tailwind CDN，fragment 组装）
```

## 已知限制

- hub 重启时若注册正在跑，该轮无人收尾，账号留在 `keys/`（下轮会补传）
- 面板会话存内存，hub 重启需重新登录
- 概览的「注册趋势」图暂无数据源
- `GROK_REGISTER_DIR` 默认值是开发机路径，部署必须覆盖

## 致谢 / 上游项目

本项目是**二次开发**成果，自身不实现注册与 API 网关能力，全部账号能力来自以下上游项目。
请优先给原作者点 Star：

| 项目 | 作者 | 在本项目中的角色 |
|---|---|---|
| [grok2api](https://github.com/chenyme/grok2api) | [@chenyme](https://github.com/chenyme) | **核心依赖**。Grok Build/Web/Console 多账号 API 网关。三格式派生（`sync-to-console` / `convert-to-build`）与 NSFW 开启（`accept-terms` / `birth-date` / `nsfw`）全部是它提供的管理 API，本项目只是按顺序调用，**未修改其任何代码** |
| [grok-free-register](https://github.com/hechuyi/grok-free-register) | [@hechuyi](https://github.com/hechuyi) | **注册引擎原作者**（MIT）。批量注册 Grok 账号、风控检测、SSO→Device Flow 转换。本项目通过子进程驱动它，不含其代码 |

前端布局脱胎于 u1s12api 的 dashboard（其视觉结构又源自 postman2api dashboard），
数据层为本项目重写。

本项目自身只做一件事：**把上面这些能力串成一条无人值守的流水线。**

## License

GPL-3.0，见 [LICENSE](LICENSE)。上游项目各自遵循其原许可证。
