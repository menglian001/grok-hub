# Grok Hub + 注册机 一体镜像
# 在仓库根目录构建：docker compose build
# 镜像自带 Python 3.11 与新 glibc，宿主装不了 Node 22 / 现代 Python wheel 也能跑
# （例如 Ubuntu 18.04 的 glibc 2.27）。
FROM node:22-bookworm-slim

# 构建期代理（compose 从 .env 的 REGISTER_PROXY 传入）。
# 注意：只给 git clone / pip / chromium 下载用，不给 apt——apt 走代理反而容易断流。
# 宿主代理需写 172.17.0.1。
ARG BUILD_PROXY=
ARG NO_PROXY=127.0.0.1,localhost

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Python 3.11（bookworm 自带）+ Chromium 运行所需系统库 + git（拉注册机）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-dev \
      ca-certificates curl git tzdata \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
      libx11-6 libxcb1 libxext6 libxi6 libxtst6 \
      fonts-liberation fonts-noto-cjk xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# ---- 注册机（上游独立项目，构建时拉取） ----
# 想用本地副本或改过的版本：把源码放到 ./register/ 并把下面的 git clone 换成 COPY
ARG REGISTER_REPO=https://github.com/hechuyi/grok-free-register.git
ARG REGISTER_REF=main
RUN HTTPS_PROXY="$BUILD_PROXY" HTTP_PROXY="$BUILD_PROXY" \
    git clone --depth 1 --branch "$REGISTER_REF" "$REGISTER_REPO" /app/register \
    && rm -rf /app/register/.git

WORKDIR /app/register
RUN python3 -m venv .venv \
    && HTTPS_PROXY="$BUILD_PROXY" HTTP_PROXY="$BUILD_PROXY" \
       sh -c '.venv/bin/pip install --no-cache-dir -U pip \
              && .venv/bin/pip install --no-cache-dir -r requirements.txt' 

# 预下载 cloakbrowser 的 stealth chromium（注册机从 ~/.cloakbrowser/chromium-*/chrome 找）
RUN HTTPS_PROXY="$BUILD_PROXY" HTTP_PROXY="$BUILD_PROXY" \
    .venv/bin/python -c "import cloakbrowser as cb; print('cloakbrowser', cb.CHROMIUM_VERSION); cb.ensure_binary()" \
    && ls -d /root/.cloakbrowser/chromium-*

# ---- Grok Hub（零 npm 依赖） ----
COPY hub/ /app/hub/

ENV GROK_REGISTER_DIR=/app/register \
    GROK_HUB_DIR=/data/hub \
    GROK_HUB_HOST=0.0.0.0 \
    GROK_HUB_PORT=8790

EXPOSE 8790
VOLUME ["/data"]

WORKDIR /app/hub
CMD ["node", "server.mjs"]
