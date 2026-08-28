# Grok Hub + grok-register 一体镜像
# 为什么要 Docker：目标机 Ubuntu 18.04 glibc 2.27，装不了 Python 3.11+ 与 Node 22。
# 镜像自带新 glibc，绕开系统限制。
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Python 3.11（bookworm 自带）+ Chromium 运行所需系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-dev \
      ca-certificates curl tzdata \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
      libx11-6 libxcb1 libxext6 libxi6 libxtst6 \
      fonts-liberation fonts-noto-cjk xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# ---- 注册机 ----
WORKDIR /app/register
COPY register/requirements.txt ./requirements.txt
RUN python3 -m venv .venv \
    && .venv/bin/pip install --no-cache-dir -U pip \
    && .venv/bin/pip install --no-cache-dir -r requirements.txt

# 预下载 cloakbrowser 的 stealth chromium（注册机从 ~/.cloakbrowser/chromium-*/chrome 找）
RUN .venv/bin/python -c "import cloakbrowser as cb; print('cloakbrowser', cb.CHROMIUM_VERSION); cb.ensure_binary()" \
    && echo "浏览器就位：" && ls -d /root/.cloakbrowser/chromium-*

COPY register/ /app/register/

# ---- Grok Hub（零 npm 依赖） ----
WORKDIR /app/hub
COPY hub/ /app/hub/

# hub 通过子进程调用注册机
ENV GROK_REGISTER_DIR=/app/register \
    GROK_HUB_DIR=/data/hub \
    GROK_HUB_HOST=0.0.0.0 \
    GROK_HUB_PORT=8790

EXPOSE 8790
VOLUME ["/data"]

WORKDIR /app/hub
CMD ["node", "server.mjs"]
