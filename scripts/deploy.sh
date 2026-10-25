#!/usr/bin/env bash
# 服务器上一键部署：拉代码 → 装依赖 → 构建前端 → 重启服务
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/quark-promo-hub}
NODE_BIN=${NODE_BIN:-/usr/local/node22/bin}

cd "$APP_DIR"
export PATH="$NODE_BIN:$PATH"

echo "==> node $(node -v) / npm $(npm -v)"
npm install --no-audit --no-fund --omit=dev --include=dev
npm run build
npm prune --omit=dev

systemctl restart quark-promo-hub
sleep 2
systemctl is-active quark-promo-hub
curl -sf -m 5 "http://127.0.0.1:${PORT:-5180}/api/auth" && echo
echo "==> 部署完成"
