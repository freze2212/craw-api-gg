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

**Đừng `git pull` trong thư mục sai.** Nhiều VPS có **2 process `wc-api`** chạy song song:

| pm2 id | exec cwd (ví dụ) |
|--------|------------------|
| 6 | `/root/craw-api-gg` |
| 7 | `/root/craw-api-gg/craw-api-gg` ← **thường là bản cũ nginx đang trỏ tới** |

Pull ở `~/craw-api-gg` nhưng nginx/proxy vào process ở folder lồng → **banner không lên**.

### Cách nhanh — dùng script (khuyên dùng)

```bash
ssh root@160.22.161.170
bash ~/craw-api-gg/deploy/restart-wc-api.sh
```

Script sẽ pull **cả 2 folder** (nếu có), restart, rồi `grep wc-top-banner`.

### Fix triệt để — chỉ giữ 1 wc-api

```bash
pm2 delete wc-api
cd /root/craw-api-gg
git pull origin main
grep patchSchedule2Html server.js   # phải có dòng này
pm2 start server.js --name wc-api
pm2 save
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
# Phải thấy header X-WC-Build: wc-rr-banner-v6
curl -sI https://hacksexy.online/schedule2 | grep -i x-wc

# Phải thấy banner RR88
curl -s https://hacksexy.online/schedule2 | grep wc-top-banner

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

## 6. Gắn vào CMS (bắt buộc dán HTML)

**File dán vào CMS:**
- RR88 → `worldcup-schedule-rr.html`
- MM88 → `worldcup-schedule-mm.html`

**Cách dán:**
1. Mở file → Copy **toàn bộ**
2. CMS → chế độ **HTML / Source** (không dùng WYSIWYG)
3. Paste → Save

**Cấu trúc file CMS (không có inline script):**
```html
<style>...</style>
<div>... header + tab ...</div>
<div id="wc-fixture-board" data-wc-api="https://hacksexy.online" data-bet-url="/sports">
  <div class="wc-board-empty">Đang tải lịch thi đấu...</div>
</div>
<script src="https://hacksexy.online/wc-board-loader.js"></script>
```

Loader gọi API `https://hacksexy.online/api/v1/worldcup` — hoạt động trên **mọi domain CMS**.

**Nếu CMS xóa thẻ `<script src=...>`:** liên hệ admin CMS whitelist domain `hacksexy.online`.

**Verify sau deploy:**
```bash
curl -s https://hacksexy.online/wc-board-loader.js | head -c 80
curl -s https://hacksexy.online/schedule2 | grep wc-board-loader
```

## 7. Dev local

`npm start` → mở `http://localhost:5290/schedule2`
