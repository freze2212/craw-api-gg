/**
 * World Cup Sync API — single-file service
 * Scrape Google Sports widget → normalize → REST API + test UI
 *
 *   npm start
 *   http://localhost:5290
 */
import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import fs from 'fs/promises';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { enrichFixture, groupFixturesByDate, flagUrlForTeam, displayTeamName } from './src/team-flags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const SCHEDULE_HTML = path.join(__dirname, 'worldcup-schedule-mm.html');
const SCHEDULE2_HTML = path.join(__dirname, 'worldcup-schedule-rr.html');
const SCHEDULE2_LEGACY = path.join(__dirname, 'worldcup-schedule-2.html');
const BOARD_LOADER_JS = path.join(__dirname, 'wc-board-loader.js');
const TEST_HTML = path.join(__dirname, 'test.html');

const CONFIG = {
  port: Number(process.env.PORT || 5290),
  cron: process.env.CRON_SCHEDULE || '*/5 * * * *',
  googleUrl:
    process.env.GOOGLE_SEARCH_URL ||
    'https://www.google.com/search?q=s%C6%A1+%C4%91%E1%BB%93+thi+%C4%91%E1%BA%A5u+world+cup&hl=vi&gl=vn',
  headless: process.env.HEADLESS !== 'false',
  timeoutMs: Number(process.env.SCRAPE_TIMEOUT_MS || 45000),
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function dedupeLabel(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length % 2 === 0 && t.slice(0, t.length / 2) === t.slice(t.length / 2)) {
    return t.slice(0, t.length / 2);
  }
  return t;
}

function parseTeamsBlob(blob) {
  const s = blob.replace(/(Thứ \d+|CN),?\s*\d{1,2}\/\d{1,2}$/i, '').trim();
  const m = s.match(/^(.+?)\1(.+?)\2$/);
  if (m) return { home: dedupeLabel(m[1]), away: dedupeLabel(m[2]) };
  if (/chưa xác định/i.test(s)) {
    const parts = s.split(/(Chưa xác định)/i).filter(Boolean);
    const teams = parts.map(dedupeLabel).filter(Boolean);
    return { home: teams[0] || 'Chưa xác định', away: teams[1] || 'Chưa xác định' };
  }
  return { home: dedupeLabel(s), away: null };
}

function parseFixtureSnippet(text) {
  const m = text.match(/^(Thứ \d+|CN),?\s*(\d{1,2}\/\d{1,2}),?\s*(\d{2}:\d{2})(.+)$/i);
  if (!m) return null;
  const teams = parseTeamsBlob(m[4]);
  if (!teams.home) return null;
  return {
    kickoffLabel: `${m[1]}, ${m[2]}, ${m[3]}`,
    date: m[2],
    time: m[3],
    home: teams.home,
    away: teams.away || 'Chưa xác định',
    status: teams.home === 'Chưa xác định' && teams.away === 'Chưa xác định' ? 'placeholder' : 'scheduled',
  };
}

function normalizeKnockoutTables(groups) {
  return groups
    .filter((g) => g.rows?.length === 2 && g.rows.every((r) => r.length >= 1))
    .map((g, i) => ({
      id: `ko-${i + 1}`,
      home: dedupeLabel(g.rows[0][0]),
      away: dedupeLabel(g.rows[1][0]),
      homeScore: g.rows[0][1] || null,
      awayScore: g.rows[1][1] || null,
    }))
    .filter((m) => m.home || m.away);
}

function fixtureKey(fx) {
  return [fx.date, fx.time, fx.home, fx.away].join('|').toLowerCase();
}

function dedupeFixtures(fixtures) {
  const seen = new Set();
  return fixtures.filter((fx) => {
    const key = fixtureKey(fx);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildApiPayload(raw) {
  const rawFixtures = [];
  for (const sn of raw.rawSnippets || []) {
    if (sn.tag !== 'DIV') continue;
    const fx = parseFixtureSnippet(sn.text);
    if (fx) rawFixtures.push({ id: `fx-${rawFixtures.length + 1}`, ...fx });
  }
  const uniqueFixtures = dedupeFixtures(rawFixtures).map((f, i) => ({ ...f, id: `fx-${i + 1}` }));
  const flagOpts = { tbdFlagUrl: raw.tbdFlagUrl || '' };
  const fixtures = uniqueFixtures.map((f, i) => enrichFixture(f, i, flagOpts));
  const fixtureDays = groupFixturesByDate(uniqueFixtures, flagOpts);

  const knockout = normalizeKnockoutTables(raw.groups || []).map((k, i) => ({
    ...k,
    home: displayTeamName(k.home),
    away: displayTeamName(k.away),
    homeFlag: flagUrlForTeam(k.home, flagOpts.tbdFlagUrl),
    awayFlag: flagUrlForTeam(k.away, flagOpts.tbdFlagUrl),
    group: `Vòng ${Math.floor(i / 8) + 1}`,
  }));
  const liveScores = (raw.matches || []).map((m, i) => ({
    id: `live-${i + 1}`,
    summary: m.summary,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
  }));

  const titleSnippet = (raw.rawSnippets || []).find((s) => s.tag === 'title');
  const tournament = titleSnippet?.text || 'FIFA World Cup';

  return {
    schemaVersion: 8,
    tournament,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    source: {
      provider: 'google-search',
      url: raw.finalUrl || CONFIG.googleUrl,
      scrapeStatus: raw.status,
      durationMs: raw.durationMs,
    },
    summary: {
      fixtureCount: fixtures.length,
      knockoutCount: knockout.length,
      liveScoreCount: liveScores.length,
    },
    fixtures,
    fixtureDays,
    knockout,
    liveScores,
  };
}

// ─── Scraper ───────────────────────────────────────────────────────────────

async function extractFromPage(page) {
  return page.evaluate(() => {
    const rawSnippets = [];
    const groups = [];
    const matches = [];

    document.querySelectorAll('[data-attrid="title"], .imso-hov, [data-sport]').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 3) rawSnippets.push({ tag: el.getAttribute('data-attrid') || 'DIV', text: t.slice(0, 800) });
    });

    document.querySelectorAll('div').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(Thứ \d+|CN),?\s*\d{1,2}\/\d{1,2},?\s*\d{2}:\d{2}/.test(t) && t.length < 220) {
        rawSnippets.push({ tag: 'DIV', text: t });
      }
    });

    document.querySelectorAll('table').forEach((table, i) => {
      const rows = [...table.querySelectorAll('tr')].map((tr) =>
        [...tr.querySelectorAll('th,td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
      );
      if (rows.length) groups.push({ tableIndex: i, rows });
    });

    document.querySelectorAll('[role="row"]').forEach((row) => {
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      const score = text.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (score && text.length < 200) {
        matches.push({ summary: text, homeScore: score[1], awayScore: score[2] });
      }
    });

    let tbdFlagUrl = '';
    document.querySelectorAll('img').forEach((img) => {
      if (tbdFlagUrl || !img.src) return;
      const alt = (img.alt || '').toLowerCase();
      const near = (img.closest('div, span, td')?.textContent || '').toLowerCase();
      if (
        alt.includes('tbd') ||
        alt.includes('chưa xác định') ||
        (near.includes('chưa xác định') && near.length < 80)
      ) {
        tbdFlagUrl = img.src;
      }
    });

    return { rawSnippets, groups, matches, pageTitle: document.title, tbdFlagUrl };
  });
}

async function scrapeGoogle() {
  const started = Date.now();
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      locale: 'vi-VN',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1400, height: 960 },
    });
    const page = await context.newPage();
    await page.goto(CONFIG.googleUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs });
    await page.waitForTimeout(3500);
    try {
      await page.waitForSelector('table, .imso-hov, [data-sport]', { timeout: 15000 });
    } catch {
      /* partial */
    }
    const dom = await extractFromPage(page);
    const finalUrl = page.url();
    const status = dom.groups.length || dom.rawSnippets.length ? 'ok' : 'empty';

    return {
      status,
      durationMs: Date.now() - started,
      pageTitle: dom.pageTitle,
      finalUrl,
      ...dom,
      meta: {
        snippetCount: dom.rawSnippets.length,
        tableCount: dom.groups.length,
        matchCount: dom.matches.length,
      },
    };
  } finally {
    await browser.close();
  }
}

// ─── Cache & jobs ──────────────────────────────────────────────────────────

let cache = null;
let jobRunning = false;
let lastError = null;

async function loadCache() {
  try {
    const raw = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    cache = raw;
    return raw;
  } catch {
    cache = { status: 'empty', api: buildApiPayload({}) };
    return cache;
  }
}

async function saveCache(raw) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const api = buildApiPayload({ ...raw, updatedAt: new Date().toISOString() });
  const payload = {
    ...raw,
    updatedAt: api.updatedAt,
    api,
  };
  await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  cache = payload;
  return payload;
}

async function runSync(reason = 'manual') {
  if (jobRunning) return { ok: false, skipped: true, reason: 'busy' };
  jobRunning = true;
  lastError = null;
  try {
    console.log(`[wc-api] sync (${reason})...`);
    const raw = await scrapeGoogle();
    const saved = await saveCache({ ...raw, scrapeReason: reason });
    console.log(
      `[wc-api] ok fixtures=${saved.api.summary.fixtureCount} knockout=${saved.api.summary.knockoutCount}`,
    );
    return { ok: true, updatedAt: saved.updatedAt, summary: saved.api.summary };
  } catch (err) {
    lastError = String(err?.message || err);
    console.error('[wc-api] error:', lastError);
    return { ok: false, error: lastError };
  } finally {
    jobRunning = false;
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'worldcup-sync-api', version: '1.0.0' });
});

app.get('/api/v1/worldcup', async (_req, res) => {
  const c = cache || (await loadCache());
  res.json({ success: true, data: c.api });
});

app.get('/api/v1/worldcup/fixtures', async (_req, res) => {
  const c = cache || (await loadCache());
  res.json({ success: true, data: c.api?.fixtures || [] });
});

app.get('/api/v1/worldcup/knockout', async (_req, res) => {
  const c = cache || (await loadCache());
  res.json({ success: true, data: c.api?.knockout || [] });
});

app.get('/api/v1/worldcup/status', async (_req, res) => {
  const c = cache || (await loadCache());
  res.json({
    success: true,
    data: {
      updatedAt: c.updatedAt,
      status: c.status,
      summary: c.api?.summary,
      cron: CONFIG.cron,
      jobRunning,
      lastError,
      sourceUrl: CONFIG.googleUrl,
    },
  });
});

app.post('/api/v1/worldcup/refresh', async (_req, res) => {
  const result = await runSync('api');
  const c = cache || (await loadCache());
  res.json({ success: result.ok !== false, result, data: c.api });
});

const BUILD_TAG = 'wc-cms-loader-v1';

function resolvePublicApiBase(req) {
  const host = req.get('host') || '';
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  if (host.includes('localhost') || host.startsWith('127.0.0.1')) {
    return `http://localhost:${CONFIG.port}`;
  }
  return `${proto}://${host}`.replace(/\/$/, '');
}

/** Fix legacy HTML that still points fetch() at localhost:5290 */
function patchScheduleHtml(html, req) {
  const apiBase = resolvePublicApiBase(req);
  let out = html
    .replace(/window\.WC_API_BASE\s*=\s*[^;]+;/g, '')
    .replace(/https?:\/\/localhost:5290/g, apiBase)
    .replace(/return\s+'http:\/\/localhost:5290'/g, `return '${apiBase}'`)
    .replace(/<script>\s*\(function\(\)\s*\{[\s\S]*?__WC_BOARD_BOOTED[\s\S]*?<\/script>\s*/gi, '');
  if (!out.includes('wc-board-loader.js')) {
    out = out.replace(/<\/div>\s*$/i, '</div>\n<script src="https://hacksexy.online/wc-board-loader.js"></script>\n');
  }
  return out;
}

app.get('/_wc/meta', (_req, res) => {
  res.json({ build: BUILD_TAG, patchScheduleHtml: true, schedule2: '/schedule2' });
});

app.get('/wc-board-loader.js', async (_req, res) => {
  try {
    const js = await readFile(BOARD_LOADER_JS, 'utf8');
    res.type('application/javascript').setHeader('Cache-Control', 'public, max-age=300').send(js);
  } catch {
    res.status(404).send('// wc-board-loader.js not found');
  }
});

function allowIframeEmbed(res) {
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.removeHeader('X-Frame-Options');
}

app.get('/schedule', async (req, res) => {
  try {
    const apiBase = resolvePublicApiBase(req);
    const html = patchScheduleHtml(await readFile(SCHEDULE_HTML, 'utf8'), req);
    allowIframeEmbed(res);
    res.type('html')
      .setHeader('Cache-Control', 'no-cache')
      .setHeader('X-WC-Build', BUILD_TAG)
      .setHeader('X-WC-Api-Base', apiBase)
      .send(html);
  } catch {
    res.status(404).send('worldcup-schedule.html not found');
  }
});

async function readSchedule2Html() {
  try {
    return await readFile(SCHEDULE2_HTML, 'utf8');
  } catch {
    return await readFile(SCHEDULE2_LEGACY, 'utf8');
  }
}

app.get('/schedule2', async (req, res) => {
  try {
    const apiBase = resolvePublicApiBase(req);
    const html = patchScheduleHtml(await readSchedule2Html(), req);
    allowIframeEmbed(res);
    res.type('html')
      .setHeader('Cache-Control', 'no-cache')
      .setHeader('X-WC-Build', BUILD_TAG)
      .setHeader('X-WC-Api-Base', apiBase)
      .send(html);
  } catch {
    res.status(404).send('worldcup-schedule-2.html not found');
  }
});

app.get('/test', async (_req, res) => {
  try {
    const html = await readFile(TEST_HTML, 'utf8');
    res.type('html').send(html);
  } catch {
    res.status(404).send('test.html not found');
  }
});

app.get('/', async (_req, res) => {
  const c = cache || (await loadCache());
  const api = c.api || buildApiPayload({});
  res.type('html').send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>World Cup API — Test</title>
  <style>
    *{box-sizing:border-box}body{font-family:system-ui,Segoe UI,sans-serif;margin:0;background:#0b1220;color:#e8eef7}
    .wrap{max-width:1100px;margin:0 auto;padding:24px}
    h1{font-size:1.4rem;margin:0 0 8px}
    .meta{color:#8fa3bf;font-size:.9rem;margin-bottom:20px}
    .btns{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
    button,a.btn{padding:10px 16px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;text-decoration:none;font-size:.9rem}
    button.secondary{background:#1e293b}
    pre{background:#111827;border:1px solid #243044;border-radius:10px;padding:16px;overflow:auto;font-size:12px;max-height:420px}
    table{width:100%;border-collapse:collapse;margin-top:16px;font-size:.85rem}
    th,td{border-bottom:1px solid #243044;padding:8px;text-align:left}
    th{color:#94a3b8}
    .pill{display:inline-block;padding:2px 8px;border-radius:99px;background:#1e3a5f;font-size:.75rem}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>⚽ World Cup Sync API</h1>
    <p class="meta">${api.tournament} · cập nhật <strong>${api.updatedAt || '—'}</strong> · ${api.summary?.fixtureCount || 0} trận</p>
    <div class="btns">
      <button onclick="refresh()">↻ Refresh ngay</button>
      <a class="btn secondary" href="/api/v1/worldcup" target="_blank">JSON đầy đủ</a>
      <a class="btn secondary" href="/api/v1/worldcup/fixtures" target="_blank">Fixtures</a>
      <a class="btn secondary" href="/api/v1/worldcup/status" target="_blank">Status</a>
    </div>
    <table>
      <thead><tr><th>#</th><th>Thời gian</th><th>Chủ</th><th>Khách</th><th>TT</th></tr></thead>
      <tbody id="fx"></tbody>
    </table>
    <h3 style="margin-top:28px">Response mẫu</h3>
    <pre id="out">Đang tải...</pre>
  </div>
  <script>
    const fixtures = ${JSON.stringify(api.fixtures || [])};
    document.getElementById('fx').innerHTML = fixtures.slice(0,30).map((f,i)=>
      '<tr><td>'+(i+1)+'</td><td>'+f.kickoffLabel+'</td><td>'+f.home+'</td><td>'+f.away+'</td><td><span class="pill">'+f.status+'</span></td></tr>'
    ).join('') || '<tr><td colspan="5">Chưa có data — bấm Refresh</td></tr>';
    async function load(){
      const r=await fetch('/api/v1/worldcup'); const j=await r.json();
      document.getElementById('out').textContent=JSON.stringify(j,null,2);
    }
    async function refresh(){
      document.getElementById('out').textContent='Đang scrape Google...';
      const r=await fetch('/api/v1/worldcup/refresh',{method:'POST'});
      const j=await r.json();
      document.getElementById('out').textContent=JSON.stringify(j,null,2);
      location.reload();
    }
    load();
  </script>
</body>
</html>`);
});

// ─── Boot ───────────────────────────────────────────────────────────────────

await loadCache();
const needsApiRebuild =
  !cache?.api ||
  cache.api.schemaVersion !== 8 ||
  !cache.api.fixtureDays?.length ||
  !cache.api.fixtures?.[0]?.homeFlag;
if (needsApiRebuild) {
  await saveCache(cache);
}
if (!cache?.api?.fixtures?.length) {
  await runSync('boot');
}

if (cron.validate(CONFIG.cron)) {
  cron.schedule(CONFIG.cron, () => runSync('cron'));
  console.log(`[wc-api] cron: ${CONFIG.cron}`);
}

app.listen(CONFIG.port, () => {
  console.log('');
  console.log('  World Cup Sync API');
  console.log('  ─────────────────────────────────────');
  console.log(`  Test UI   http://localhost:${CONFIG.port}/`);
  console.log(`  Schedule  http://localhost:${CONFIG.port}/schedule`);
  console.log(`  Schedule2 http://localhost:${CONFIG.port}/schedule2`);
  console.log(`  API       http://localhost:${CONFIG.port}/api/v1/worldcup`);
  console.log(`  Refresh   POST http://localhost:${CONFIG.port}/api/v1/worldcup/refresh`);
  console.log('');
});
