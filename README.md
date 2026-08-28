# Grok Hub

批量注册 Grok 账号的控制台。点一次「开始注册」，剩下全自动：

**注册账号 → 上传 [grok2api](https://github.com/chenyme/grok2api) → 转成 Web/Console/Build 三种格式 → 开启 NSFW → 清空本地**

基于 [hechuyi/grok-free-register](https://github.com/hechuyi/grok-free-register) 二次修改。
仅供学习研究，请遵守目标站点服务条款与当地法律，风险自负。

---

## 需要准备

- **Node 22 以上**（零 npm 依赖，不用 `npm install`）
- **[grok2api](https://github.com/chenyme/grok2api)** 已部署，管理面能登录
- **[注册机](https://github.com/hechuyi/grok-free-register)** 能独立跑通
- **代理**，能访问 x.ai / grok.com

## 装起来

```bash
git clone https://github.com/menglian001/grok-hub.git && cd grok-hub

GROK_HUB_PASSWORD='你的密码' \
GROK_REGISTER_DIR=/opt/grok-free-register \
  node hub/server.mjs 8790
```

打开 <http://127.0.0.1:8790/> 登录（密码只需首次设置，之后直接启动）。

进 **系统设置 → 运行配置**，填三样：

| 填什么 | 例子 |
|---|---|
| grok2api 地址 | `http://1.2.3.4:8000` |
| grok2api 用户名 / 密码 | 管理面的登录凭据 |
| 注册代理 | `http://127.0.0.1:7890` |

点「测试连接」通了，再去 **注册机** 页填数量、点开始。

**还有一步**：去 grok2api 设置里打开「允许 NSFW 图片」。这是它的全局开关，
不开的话账号层开了也不生效。一次性操作。

## 跑起来是什么样

```
▶ 开始注册 1 个账号（严格精确模式）
  读取 x.ai 站点配置
  启动隐身浏览器
  资源准备完成 · Turnstile 1 · 邮箱 1 · 验证码 1

#1 开始注册
   · 校验邮箱验证码 oc7a***@cmuk.edu.kg
   · 验证码通过
   · 提交注册表单（邮箱+密码+姓名+Turnstile）
   · 已获取 SSO 凭证
#1 ✓ 注册成功（8s）
  [即时] oc7a***@cmuk.edu.kg → 已接入（web + console + build + NSFW）

──── 收尾 ────
  产物：本轮新号 1 个（1 个已在注册中即时接入）
  本地留存已清除
──────── 全部结束：注册 1 个，已全部接入 grok2api ────────
```

注册成功一个就立刻上传，不等整批结束。跑到一半崩了也不丢号。

## 四个页面

| 页面 | 干什么 |
|---|---|
| 概览 | 今日注册 / 累计注册 / 已上传 / 本地滞留（正常是 0） |
| 注册机 | 填数量、开始停止、看实时日志 |
| 告警中心 | 上传失败、注册异常、有人猜密码 |
| 系统设置 | grok2api 连接、代理、邮箱、并发 |

## 常用设置

**并发**：`注册并发上限` 设 2-3（2核4G）。注意 `token 池缓冲目标` 默认 4 会把并发顶到 4，
想压住就设成和并发上限一样。

**省邮箱额度**（用付费邮箱令牌时重要）：`严格模式预取余量` 设 `0`，
注册 1 个只申请 2 个邮箱；设 `1` 会多备一个，失败时能立刻补上。

**严格精确模式**：开着就恰好注册 N 个。日志里「开始注册 #N」可能多于 N 条，
那是失败后的补位重试，看成功数就行。

## 部署

### systemd

```bash
sudo cp -r . /opt/grok-hub
sudo cp deploy/grok-hub.service /etc/systemd/system/
sudo vim /etc/systemd/system/grok-hub.service   # 改 GROK_REGISTER_DIR、首次填密码
sudo systemctl enable --now grok-hub
```

### Docker（系统太旧装不了 Node 22 时用）

Ubuntu 18.04 这类老系统装不上 Node 22，用 Docker 绕开：

```bash
# deploy/ 下放好 hub/（本项目 hub/）和 register/（注册机源码）
cd deploy
cat > .env <<'EOF'
GROK_HUB_PASSWORD=你的密码
REGISTER_PROXY=http://172.17.0.1:7890
EOF
docker compose build && docker compose up -d
```

**代理地址要用 `172.17.0.1`**，不能写 `127.0.0.1`——那是容器自己。
如果代理只监听 `127.0.0.1`，得让它也监听 `172.17.0.1`。

拉不下镜像的话给 dockerd 也配代理：

```bash
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment="HTTPS_PROXY=http://127.0.0.1:7890"\n' \
  > /etc/systemd/system/docker.service.d/http-proxy.conf
systemctl daemon-reload && systemctl restart docker
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GROK_REGISTER_DIR` | — | **必填**，注册机目录 |
| `GROK_HUB_PASSWORD` | — | 面板密码，只首次需要 |
| `GROK_HUB_HOST` | `127.0.0.1` | 绑非本地时必须先设密码 |
| `GROK_HUB_PORT` | `8790` | 端口 |
| `GROK_HUB_DIR` | `~/.grok-hub/hub` | 数据目录 |
| `GROK_HUB_TLS` | `0` | 有 HTTPS 反代时设 `1` |

## 账号安全

**账号本体不存在本地**。SSO 只在内存里过一遍，上传成功后 `keys/` 立即清空，
数据库里只有设置项、注册计数和告警。

面板密码 scrypt 哈希存储，所有接口都要登录，同 IP 连错 6 次锁 15 分钟。
公网暴露记得套 HTTPS 反代并设 `GROK_HUB_TLS=1`，不然密码走明文。

## 三种格式和 NSFW 是怎么来的

注册机只产出 Web SSO 一种，另外两种是调 grok2api 现成接口换的：

| 步骤 | 接口 |
|---|---|
| 上传 | `accounts/web/import` → `grok_web` |
| 转 Console | `accounts/web/sync-to-console` → `grok_console` |
| 转 Build | `accounts/web/convert-to-build` → `grok_build` |

三者同一个 `userId`，是一个 Grok 账号的三种调用方式。

NSFW 分两层：grok2api 的全局开关要你自己开（一次性），每个账号的开关 hub 自动做
（`accept-terms` → `birth-date` → `nsfw`，顺序不能换）。两层都开才生效。

**踩过的坑**：上传的文件名必须是 `grok-web-sso-tokens.txt`，grok2api 靠文件名认类型，
换名字会报 `Cannot read properties of undefined`。

## 代码在哪

```
hub/
├── server.mjs      HTTP 接口
├── auth.mjs        登录鉴权
├── store.mjs       SQLite
├── grok2api.mjs    调 grok2api
├── register.mjs    驱动注册机 + 上传清理
├── compat.mjs      设置项定义
└── public/         前端
```

## 已知问题

- hub 重启时如果注册正在跑，那一轮的号会留在 `keys/`（下轮自动补传）
- 面板登录状态存内存，重启要重新登录
- 概览的趋势图还没数据

## License

GPL-3.0，见 [LICENSE](LICENSE)。上游项目各自遵循其原许可证。
