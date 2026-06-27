import cron from 'node-cron';
import { config } from './config.js';
import { scrapeGoogleWorldCup } from './scraper.js';
import { writeCache } from './cache.js';

let running = false;
let lastRun = null;
let lastError = null;

export function getSchedulerState() {
  return {
    running,
    lastRun,
    lastError,
    cronSchedule: config.cronSchedule,
  };
}

export async function runScrapeJob(reason = 'manual') {
  if (running) {
    return { skipped: true, reason: 'already-running' };
  }
  running = true;
  lastError = null;
  try {
    console.log(`[wc-sync] scrape start (${reason})`);
    const data = await scrapeGoogleWorldCup();
    const saved = await writeCache({ ...data, status: data.status, scrapeReason: reason });
    lastRun = saved.updatedAt;
    console.log(
      `[wc-sync] scrape done status=${data.status} matches=${data.meta?.matchCount ?? 0} tables=${data.meta?.groupTableCount ?? 0}`,
    );
    return { ok: true, updatedAt: saved.updatedAt, meta: data.meta };
  } catch (err) {
    lastError = String(err?.message || err);
    console.error('[wc-sync] scrape error:', lastError);
    await writeCache({
      status: 'error',
      error: lastError,
      matches: [],
      groups: [],
      rawSnippets: [],
      meta: {},
    });
    return { ok: false, error: lastError };
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (!cron.validate(config.cronSchedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: ${config.cronSchedule}`);
  }
  cron.schedule(config.cronSchedule, () => {
    runScrapeJob('cron').catch((e) => console.error(e));
  });
  console.log(`[wc-sync] cron scheduled: ${config.cronSchedule}`);
}
