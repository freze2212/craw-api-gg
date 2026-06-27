import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const config = {
  port: Number(process.env.PORT || 5290),
  cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *',
  googleSearchUrl:
    process.env.GOOGLE_SEARCH_URL ||
    'https://www.google.com/search?q=s%C6%A1+%C4%91%E1%BB%93+thi+%C4%91%E1%BA%A5u+world+cup&hl=vi&gl=vn',
  headless: process.env.HEADLESS !== 'false',
  scrapeTimeoutMs: Number(process.env.SCRAPE_TIMEOUT_MS || 45000),
  dataDir: path.join(ROOT, 'data'),
  cacheFile: path.join(ROOT, 'data', 'cache.json'),
};
