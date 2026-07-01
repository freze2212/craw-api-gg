#!/bin/bash
# Chạy trên VPS — pull TẤT CẢ thư mục pm2 wc-api (tránh lồng craw-api-gg/craw-api-gg) rồi restart
set -euo pipefail

APP_NAME="${1:-wc-api}"

mapfile -t PM2_CWDS < <(pm2 jlist 2>/dev/null | node -e "
  const list = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const cwds = [...new Set(
    list.filter(x => x.name === process.argv[1] && x.pm2_env && x.pm2_env.pm_cwd)
      .map(x => x.pm2_env.pm_cwd)
  )];
  cwds.forEach(c => console.log(c));
" "$APP_NAME")

if [ "${#PM2_CWDS[@]}" -eq 0 ]; then
  echo "Không tìm thấy pm2 app: $APP_NAME"
  pm2 list
  exit 1
fi

echo "==> Tìm thấy ${#PM2_CWDS[@]} thư mục wc-api:"
printf '    %s\n' "${PM2_CWDS[@]}"

for PM2_CWD in "${PM2_CWDS[@]}"; do
  echo ""
  echo "==> git pull trong: $PM2_CWD"
  cd "$PM2_CWD"
  git pull origin main || echo "WARN: pull failed in $PM2_CWD"
  if grep -q 'patchSchedule2Html' server.js 2>/dev/null; then
    echo "OK: server.js có patchSchedule2Html (banner RR88)"
  else
    echo "WARN: server.js CHƯA có banner — kiểm tra git log -1"
  fi
done

echo ""
echo "==> pm2 restart $APP_NAME"
pm2 restart "$APP_NAME"

sleep 2
echo ""
echo "==> Port 5290 đang listen:"
ss -tlnp 2>/dev/null | grep 5290 || netstat -tlnp 2>/dev/null | grep 5290 || true

echo ""
echo "==> Verify production:"
curl -sI "https://hacksexy.online/schedule2" | grep -iE 'x-wc|http' || true
echo ""
curl -s "https://hacksexy.online/schedule2" | grep -m1 '<div class="wc-top-banner">' && echo "OK: RR88 có banner div" || echo "FAIL: RR88 chưa có banner div"
curl -s "https://hacksexy.online/schedule" | grep -m1 '<div class="wc-top-banner">' && echo "OK: MM88 có banner div" || echo "FAIL: MM88 chưa có banner div"
curl -s "https://hacksexy.online/_wc/meta" || true
echo ""

if curl -s "https://hacksexy.online/schedule2" | grep -q '<div class="wc-top-banner">'; then
  exit 0
fi

echo ""
echo "!!! Vẫn chưa có banner. Thử gom 1 process wc-api duy nhất:"
echo "    pm2 delete wc-api"
echo "    cd /root/craw-api-gg && git pull origin main && pm2 start server.js --name wc-api && pm2 save"
exit 1
