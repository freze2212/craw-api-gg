import { config } from './config.js';
import { createServer } from './server.js';
import { startScheduler, runScrapeJob } from './scheduler.js';
import { ensureDataDir } from './cache.js';

await ensureDataDir();
startScheduler();

const app = createServer();
app.listen(config.port, () => {
  console.log(`[wc-sync] API http://localhost:${config.port}`);
  console.log(`[wc-sync] GET  /api/worldcup`);
  console.log(`[wc-sync] GET  /api/worldcup/status`);
  console.log(`[wc-sync] POST /api/worldcup/refresh`);
});

runScrapeJob('boot').catch((e) => console.error('[wc-sync] boot scrape failed', e));
