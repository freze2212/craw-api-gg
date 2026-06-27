# World Cup Sync API

**Một file duy nhất:** `server.js` — scrape Google → API + trang test.

```bash
cd worldcup-sync-api
npm install
npx playwright install chromium
npm start
```

## Test

| URL | Mô tả |
|-----|--------|
| http://localhost:5290/ | UI test (bảng trận + JSON) |
| GET /api/v1/worldcup | Data chuẩn hóa |
| GET /api/v1/worldcup/fixtures | Lịch thi đấu |
| GET /api/v1/worldcup/knockout | Cặp knockout |
| POST /api/v1/worldcup/refresh | Cập nhật ngay |

Cron mặc định 5 phút — chỉnh `CRON_SCHEDULE` trong `.env`.
