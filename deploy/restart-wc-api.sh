#!/bin/bash
# Chạy trên VPS — tự tìm thư mục pm2 đang dùng rồi pull + restart
set -euo pipefail

APP_NAME="${1:-wc-api}"

PM2_CWD=$(pm2 jlist 2>/dev/null | node -e "
  const list = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const p = list.find(x => x.name === process.argv[1]);
  if (!p) process.exit(2);
  process.stdout.write(p.pm2_env.pm_cwd || '');
" "$APP_NAME") || true

if [ -z "$PM2_CWD" ]; then
  echo "Không tìm thấy pm2 app: $APP_NAME"
  echo "Chạy: pm2 list"
  exit 1
fi

echo "==> PM2 đang chạy từ: $PM2_CWD"
cd "$PM2_CWD"

echo "==> git pull"
git pull origin main

echo "==> pm2 restart $APP_NAME"
pm2 restart "$APP_NAME"

sleep 2
echo ""
echo "==> Kiểm tra bản mới (phải có X-WC-Build và hacksexy.online):"
curl -sI "https://hacksexy.online/schedule2" | grep -iE 'x-wc|http'
echo ""
curl -s "https://hacksexy.online/schedule2" | grep -m1 WC_API_BASE || true
curl -s "https://hacksexy.online/_wc/meta" || true
echo ""
