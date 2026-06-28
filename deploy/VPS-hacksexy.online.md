# Deploy lên VPS — hacksexy.online

| | |
|---|---|
| **IP** | `160.22.161.170` |
| **Domain** | `hacksexy.online` |
| **API** | `https://hacksexy.online` |

## 1. DNS

Trỏ A record `@` → `160.22.161.170`

## 2. Cài lần đầu

```bash
ssh root@160.22.161.170
apt update && apt install -y git nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

git clone https://github.com/freze2212/craw-api-gg.git
cd ~/craw-api-gg
npm install
npx playwright install chromium
npx playwright install-deps
cp .env.example .env

npm install -g pm2
pm2 start server.js --name wc-api
pm2 save && pm2 startup
```

## 3. Nginx + SSL

```bash
cp deploy/nginx-hacksexy.online.conf /etc/nginx/sites-available/hacksexy.online
ln -sf /etc/nginx/sites-available/hacksexy.online /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d hacksexy.online
```

## 4. Update code (QUAN TRỌNG)

**Đừng `git pull` trong thư mục sai.** Nhiều VPS bị lồng `~/craw-api-gg/craw-api-gg` nhưng pm2 chạy từ `~/craw-api-gg`.

### Cách nhanh — dùng script (khuyên dùng)

```bash
ssh root@160.22.161.170
bash ~/craw-api-gg/deploy/restart-wc-api.sh
```

### Cách thủ công — xem pm2 đang chạy ở đâu

```bash
pm2 show wc-api | grep -E "exec cwd|script path"
# Ví dụ: exec cwd → /root/craw-api-gg

cd /root/craw-api-gg          # cd ĐÚNG thư mục pm2 báo
git pull origin main
pm2 restart wc-api
```

## 5. Verify sau deploy

```bash
# Phải thấy header X-WC-Build (bản mới)
curl -sI https://hacksexy.online/schedule2 | grep -i x-wc

# Phải là https://hacksexy.online — KHÔNG localhost
curl -s https://hacksexy.online/schedule2 | grep WC_API_BASE

# Meta endpoint
curl -s https://hacksexy.online/_wc/meta

# API data
curl -s https://hacksexy.online/api/v1/worldcup | head -c 200
```

Kết quả đúng:

```
X-WC-Build: wc-patch-20260529
X-WC-Api-Base: https://hacksexy.online
<script>window.WC_API_BASE='https://hacksexy.online';</script>
```

Nếu vẫn thấy `localhost:5290` → pm2 **chưa restart** hoặc **pull sai folder**.

## 6. Gắn vào CMS

**Cách A — Iframe (ổn định nhất):**

```html
<iframe src="https://hacksexy.online/schedule2" width="100%" height="900" frameborder="0"></iframe>
```

**Cách B — Dán HTML:** copy `worldcup-schedule-rr.html`, paste chế độ HTML/source.

## 7. Dev local

`npm start` → mở `http://localhost:5290/schedule2`
