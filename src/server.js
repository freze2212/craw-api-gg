import express from 'express';
import { readCache } from './cache.js';
import { getSchedulerState, runScrapeJob } from './scheduler.js';
import { config } from './config.js';

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'worldcup-sync-api' });
  });

  app.get('/api/worldcup', async (_req, res) => {
    const cache = await readCache();
    res.json(cache);
  });

  app.get('/api/worldcup/status', async (_req, res) => {
    const cache = await readCache();
    res.json({
      updatedAt: cache.updatedAt,
      status: cache.status,
      meta: cache.meta,
      scheduler: getSchedulerState(),
      sourceUrl: config.googleSearchUrl,
    });
  });

  app.post('/api/worldcup/refresh', async (_req, res) => {
    const result = await runScrapeJob('api');
    const cache = await readCache();
    res.json({ result, cache });
  });

  return app;
}
