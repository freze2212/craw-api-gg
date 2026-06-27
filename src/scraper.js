import { chromium } from 'playwright';
import { config } from './config.js';

/** Tìm JSON thể thao trong response Google (async / sports widget). */
function tryParseSportsJson(text) {
  if (!text || text.length < 80) return null;
  const markers = ['"Sportscast"', '"sports"', '"match"', '"fixture"', '"standings"'];
  if (!markers.some((m) => text.includes(m))) return null;

  const candidates = [];
  const re = /\{[\s\S]{80,80000}?\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      candidates.push(obj);
    } catch {
      /* skip */
    }
  }
  return candidates.length ? candidates : null;
}

function extractFromDom(page) {
  return page.evaluate(() => {
    const out = { matches: [], groups: [], rawSnippets: [] };

    const pushText = (el, tag) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length > 2) out.rawSnippets.push({ tag, text: t.slice(0, 500) });
    };

    document.querySelectorAll('[data-attrid], [data-sport], sports-block, .imso-hov').forEach((el) => {
      pushText(el, el.getAttribute('data-attrid') || el.tagName);
    });

    document.querySelectorAll('table').forEach((table, i) => {
      const rows = [...table.querySelectorAll('tr')].map((tr) =>
        [...tr.querySelectorAll('th,td')].map((c) => c.textContent.trim()),
      );
      if (rows.length) out.groups.push({ tableIndex: i, rows });
    });

    document.querySelectorAll('[role="row"], .S3ksU').forEach((row) => {
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      const score = text.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (score && text.length < 200) {
        out.matches.push({ summary: text, homeScore: score[1], awayScore: score[2] });
      }
    });

    return out;
  });
}

/**
 * Scrape Google Search sports widget.
 * Cách ổn định nhất: Playwright + bắt network JSON + fallback DOM.
 */
export async function scrapeGoogleWorldCup() {
  const started = Date.now();
  const networkPayloads = [];
  let domData = { matches: [], groups: [], rawSnippets: [] };
  let pageTitle = '';
  let finalUrl = '';

  const browser = await chromium.launch({
    headless: config.headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      locale: 'vi-VN',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!/google\.com/i.test(url)) return;
        if (!/async|call|sports|Sportscast|batchexecute/i.test(url)) return;
        const ct = res.headers()['content-type'] || '';
        if (!/json|text|javascript/i.test(ct)) return;
        const text = await res.text();
        const parsed = tryParseSportsJson(text);
        if (parsed) {
          networkPayloads.push({ url, chunks: parsed.length, sample: parsed[0] });
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto(config.googleSearchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.scrapeTimeoutMs,
    });

    await page.waitForTimeout(3000);
    try {
      await page.waitForSelector('table, [data-attrid], sports-block, .imso-hov', {
        timeout: 12000,
      });
    } catch {
      /* widget có thể không render ở IP/headless */
    }

    pageTitle = await page.title();
    finalUrl = page.url();
    domData = await extractFromDom(page);
  } finally {
    await browser.close();
  }

  const status = domData.matches.length || domData.groups.length || networkPayloads.length ? 'ok' : 'partial';

  return {
    status,
    durationMs: Date.now() - started,
    pageTitle,
    finalUrl,
    matches: domData.matches,
    groups: domData.groups,
    rawSnippets: domData.rawSnippets.slice(0, 50),
    networkPayloads: networkPayloads.slice(0, 10),
    meta: {
      matchCount: domData.matches.length,
      groupTableCount: domData.groups.length,
      networkHitCount: networkPayloads.length,
    },
  };
}
