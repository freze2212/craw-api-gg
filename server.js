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
import { enrichFixture, groupFixturesByDate, flagUrlForTeam, displayTeamName, isTbdTeam, teamsMatch } from './src/team-flags.js';
import { compareFixturesByKickoff, inferRound } from './src/tournament-rounds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const SCHEDULE_HTML = path.join(__dirname, 'worldcup-schedule-mm.html');
const SCHEDULE2_HTML = path.join(__dirname, 'worldcup-schedule-rr.html');
const SCHEDULE2_LEGACY = path.join(__dirname, 'worldcup-schedule-2.html');
const BOARD_LOADER_JS = path.join(__dirname, 'wc-board-loader.js');
const IFRAME_PARENT_JS = path.join(__dirname, 'wc-iframe-parent.js');
const TEST_HTML = path.join(__dirname, 'test.html');

const CONFIG = {
  port: Number(process.env.PORT || 5290),
  cron: process.env.CRON_SCHEDULE || '*/5 * * * *',
  googleUrls: process.env.GOOGLE_SEARCH_URL
    ? [process.env.GOOGLE_SEARCH_URL]
    : [
      'https://www.google.com/search?q=s%C6%A1+%C4%91%E1%BB%93+thi+%C4%91%E1%BA%A5u+world+cup&hl=vi&gl=vn',
      'https://www.google.com/search?q=l%E1%BB%8Bch+thi+%C4%91%E1%BA%A5u+world+cup+2026&hl=vi&gl=vn',
    ],
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

function vietnamDateParts(ref = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: 'numeric',
    month: 'numeric',
  }).formatToParts(ref);
  const d = Number(parts.find((p) => p.type === 'day')?.value || 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value || 0);
  return { d, m };
}

function formatDateSlash({ d, m }) {
  return `${d}/${m}`;
}

function addDaysVN({ d, m }, days) {
  const base = new Date(Date.UTC(2026, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return { d: base.getUTCDate(), m: base.getUTCMonth() + 1 };
}

function resolveRelativeDate(label, referenceDate = new Date()) {
  const norm = String(label || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const today = vietnamDateParts(referenceDate);
  if (norm.includes('hom nay')) return formatDateSlash(today);
  if (norm.includes('ngay mai')) return formatDateSlash(addDaysVN(today, 1));
  return null;
}

function parseTeamsBlob(blob) {
  const s = blob
    .replace(/(Thứ \d+|CN),?\s*\d{1,2}\/\d{1,2}$/i, '')
    .replace(/(Ngày mai|Hôm nay)$/i, '')
    .trim();
  const m = s.match(/^(.+?)\1(.+?)\2$/);
  if (m) return { home: dedupeLabel(m[1]), away: dedupeLabel(m[2]) };
  if (/chưa xác định/i.test(s)) {
    const parts = s.split(/(Chưa xác định)/i).filter(Boolean);
    const teams = parts.map(dedupeLabel).filter(Boolean);
    return { home: teams[0] || 'Chưa xác định', away: teams[1] || 'Chưa xác định' };
  }
  return { home: dedupeLabel(s), away: null };
}

function parseFixtureSnippet(text, referenceDate = new Date()) {
  let m = text.match(/^(Thứ \d+|CN),?\s*(\d{1,2}\/\d{1,2}),?\s*(\d{2}:\d{2})(.+)$/i);
  if (m) {
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

  m = text.match(/^(Hôm nay|Ngày mai),?\s*(\d{2}:\d{2})(.+)$/i);
  if (m) {
    const date = resolveRelativeDate(m[1], referenceDate);
    if (!date) return null;
    const teams = parseTeamsBlob(m[3]);
    if (!teams.home) return null;
    const dayLabel = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return {
      kickoffLabel: `${dayLabel}, ${date}, ${m[2]}`,
      date,
      time: m[2],
      home: teams.home,
      away: teams.away || 'Chưa xác định',
      status: teams.home === 'Chưa xác định' && teams.away === 'Chưa xác định' ? 'placeholder' : 'scheduled',
    };
  }

  return null;
}

function normalizeKnockoutTables(groups) {
  return groups
    .filter((g) => g.rows?.length === 2 && g.rows.every((r) => r.length >= 1))
    .map((g, i) => {
      const home = dedupeLabel(g.rows[0][0]);
      const away = dedupeLabel(g.rows[1][0]);
      const parsed = scoresFromKnockoutCells(g.rows[0][1], g.rows[1][1]);
      const base = {
        id: `ko-${i + 1}`,
        home,
        away,
        homeScore: parsed?.homeScore || g.rows[0][1] || null,
        awayScore: parsed?.awayScore || g.rows[1][1] || null,
      };
      if (parsed?.wentToPenalties) {
        base.penHome = parsed.penHome;
        base.penAway = parsed.penAway;
        base.penDisplay = `(${parsed.penHome} - ${parsed.penAway} pen)`;
        base.wentToPenalties = true;
      }
      return base;
    })
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

function isPlaceholderFixture(fx) {
  return fx.status === 'placeholder' || (isTbdTeam(fx.home) && isTbdTeam(fx.away));
}

const ROUND_RANK = { group: 0, r32: 1, r16: 2, qf: 3, sf: 4, third: 5, final: 6 };

function roundRank(round) {
  return ROUND_RANK[round] ?? 0;
}

function normTeamKey(name) {
  return displayTeamName(name).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** Bỏ slot placeholder sơ đồ bracket (Vòng 16+) — không phải lịch thi đấu thật */
function shouldDropFixture(fx) {
  if (!isPlaceholderFixture(fx)) return false;
  return roundRank(inferRound(fx.date)) >= roundRank('r16');
}

/**
 * Chỉ hiển thị trận knock-out khi đủ 2 đội và không còn trận vòng trước chưa kết thúc.
 * Tránh Vòng 16 hiện Canada vs TBD / slot rỗng khi Đức–Paraguay (Vòng 32) chưa đá xong.
 */
function filterFixturesForDisplay(fixtures) {
  const visible = fixtures.filter((fx) => {
    if (isPlaceholderFixture(fx)) return false;
    const round = inferRound(fx.date);
    if (round !== 'group' && (isTbdTeam(fx.home) || isTbdTeam(fx.away))) return false;
    return true;
  });

  const blockedTeams = new Set();
  for (const fx of visible) {
    if (inferRound(fx.date) !== 'r32') continue;
    if (fx.status === 'finished' || (fx.homeScore != null && fx.awayScore != null)) continue;
    if (isTbdTeam(fx.home) || isTbdTeam(fx.away)) continue;
    blockedTeams.add(normTeamKey(fx.home));
    blockedTeams.add(normTeamKey(fx.away));
  }

  return visible.filter((fx) => {
    const round = inferRound(fx.date);
    if (roundRank(round) < roundRank('r16')) return true;
    const home = normTeamKey(fx.home);
    const away = normTeamKey(fx.away);
    return !blockedTeams.has(home) && !blockedTeams.has(away);
  });
}

const PEN_KEYWORD_RE = /pen|pens|pk|luân\s*lưu|luan\s*luu|sút\s*luân/i;

function parseTableScoreCell(cell) {
  const s = String(cell || '').trim();
  if (!s) return null;
  const penCell = s.match(/^(\d+)\s*\(\s*(\d+)\s*\)$/);
  if (penCell) return { ft: penCell[1], pen: penCell[2] };
  if (/^\d+$/.test(s)) return { ft: s };
  const parsed = parseMatchScores(s);
  if (!parsed?.homeScore || parsed.awayScore == null) return null;
  return {
    ft: parsed.homeScore,
    pen: parsed.penHome,
    awayFt: parsed.awayScore,
    awayPen: parsed.penAway,
  };
}

function scoresFromKnockoutCells(homeCell, awayCell) {
  const h = parseTableScoreCell(homeCell);
  const a = parseTableScoreCell(awayCell);
  if (!h?.ft || !a?.ft) return null;
  const out = { homeScore: h.ft, awayScore: a.ft };
  if (h.pen && a.pen) {
    out.penHome = h.pen;
    out.penAway = a.pen;
    out.wentToPenalties = true;
  }
  return out;
}

/** FT + optional penalty shootout từ text Google (vd. 1-1 (4-3 pen)) */
function parseMatchScores(text) {
  const raw = String(text || '');
  if (!raw) return null;

  const ftParenPen = raw.match(/(\d+)\s*[-–]\s*(\d+)\s*\(\s*(\d+)\s*[-–]\s*(\d+)\s*\)/);
  if (ftParenPen) {
    return {
      homeScore: ftParenPen[1],
      awayScore: ftParenPen[2],
      penHome: ftParenPen[3],
      penAway: ftParenPen[4],
      wentToPenalties: true,
    };
  }

  if (PEN_KEYWORD_RE.test(raw)) {
    const pairs = [...raw.matchAll(/(\d+)\s*[-–]\s*(\d+)/g)];
    if (pairs.length >= 2) {
      return {
        homeScore: pairs[0][1],
        awayScore: pairs[0][2],
        penHome: pairs[1][1],
        penAway: pairs[1][2],
        wentToPenalties: true,
      };
    }
  }

  const single = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (single) return { homeScore: single[1], awayScore: single[2] };
  return null;
}

function attachScoreFields(fx, scores) {
  if (!scores?.homeScore || scores.awayScore == null) return fx;
  const out = {
    ...fx,
    homeScore: String(scores.homeScore),
    awayScore: String(scores.awayScore),
    scoreDisplay: `${scores.homeScore} - ${scores.awayScore}`,
    status: 'finished',
  };
  if (scores.wentToPenalties && scores.penHome != null && scores.penAway != null) {
    out.penHome = String(scores.penHome);
    out.penAway = String(scores.penAway);
    out.penDisplay = `(${scores.penHome} - ${scores.penAway} pen)`;
    out.wentToPenalties = true;
  }
  return out;
}

function scoreLookupKey(home, away, date = '') {
  return [displayTeamName(home), displayTeamName(away), date || ''].join('|').toLowerCase();
}

function buildScoreMap(raw, fixtures) {
  const map = new Map();

  const put = (home, away, scores, date = '') => {
    if (!scores?.homeScore || scores.awayScore == null) return;
    const hs = String(scores.homeScore).trim();
    const as = String(scores.awayScore).trim();
    if (!/^\d+$/.test(hs) || !/^\d+$/.test(as)) return;
    const entry = {
      homeScore: hs,
      awayScore: as,
      scoreDisplay: `${hs} - ${as}`,
    };
    if (scores.wentToPenalties && scores.penHome != null && scores.penAway != null) {
      entry.penHome = String(scores.penHome);
      entry.penAway = String(scores.penAway);
      entry.penDisplay = `(${scores.penHome} - ${scores.penAway} pen)`;
      entry.wentToPenalties = true;
    }
    map.set(scoreLookupKey(home, away, date), entry);
    map.set(scoreLookupKey(home, away, ''), entry);
  };

  for (const g of raw.groups || []) {
    if (!g.rows || g.rows.length !== 2) continue;
    const home = dedupeLabel(g.rows[0][0]);
    const away = dedupeLabel(g.rows[1][0]);
    const hs = g.rows[0][1];
    const as = g.rows[1][1];
    if (!hs && !as) continue;
    const parsed = scoresFromKnockoutCells(hs, as) || parseMatchScores(`${hs} - ${as}`);
    if (!parsed) continue;
    const fx = fixtures.find((f) => teamsMatch(f.home, home) && teamsMatch(f.away, away));
    put(home, away, parsed, fx?.date || '');
  }

  for (const m of raw.matches || []) {
    const parsed = parseScoreSummary(m.summary || '');
    if (parsed) put(parsed.home, parsed.away, parsed, parsed.date || '');
  }

  for (const sn of raw.rawSnippets || []) {
    if (sn.tag !== 'DIV') continue;
    const parsed = parseScoredFixtureSnippet(sn.text);
    if (parsed) put(parsed.home, parsed.away, parsed, parsed.date || '');
  }

  return map;
}

function parseScoreSummary(text) {
  const raw = String(text || '');
  const scores = parseMatchScores(raw);
  if (!scores) return null;
  const dateM = raw.match(/(\d{1,2}\/\d{1,2})/);
  const date = dateM ? dateM[1] : '';
  const firstScore = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  const before = firstScore ? raw.split(firstScore[0])[0] || '' : raw;
  const teams = before.match(/([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ\s.'-]{1,40})/g);
  if (!teams || teams.length < 2) return null;
  const home = dedupeLabel(teams[teams.length - 2]);
  const away = dedupeLabel(teams[teams.length - 1]);
  if (!home || !away) return null;
  return { home, away, date, ...scores };
}

function parseScoredFixtureSnippet(text) {
  const m = String(text || '').match(
    /^(Thứ \d+|CN),?\s*(\d{1,2}\/\d{1,2}),?\s*(\d{2}:\d{2})(.+)$/i,
  );
  if (!m) return null;
  const scores = parseMatchScores(m[4]);
  if (!scores) return null;
  const firstScore = m[4].match(/(\d+)\s*[-–]\s*(\d+)/);
  const teamsPart = firstScore ? m[4].split(firstScore[0])[0] : m[4];
  const teams = parseTeamsBlob(teamsPart);
  if (!teams.home) return null;
  return {
    date: m[2],
    home: teams.home,
    away: teams.away || 'Chưa xác định',
    ...scores,
  };
}

function applyScores(fx, scoreMap) {
  const keys = [scoreLookupKey(fx.home, fx.away, fx.date), scoreLookupKey(fx.home, fx.away, '')];
  for (const k of keys) {
    const s = scoreMap.get(k);
    if (!s) continue;
    return attachScoreFields(fx, s);
  }
  return fx;
}

function kickoffMsVN(fx) {
  const [d, m] = String(fx.date || '').split('/').map(Number);
  const [hh, mm] = String(fx.time || '00:00').split(':').map(Number);
  if (!d || !m) return 0;
  return Date.UTC(2026, m - 1, d, (hh || 0) - 7, mm || 0);
}

function finalizeFixtureStatus(fx) {
  if (fx.homeScore != null && fx.awayScore != null) {
    const out = {
      ...fx,
      status: 'finished',
      scoreDisplay: fx.scoreDisplay || `${fx.homeScore} - ${fx.awayScore}`,
    };
    if (fx.wentToPenalties && fx.penHome != null && fx.penAway != null) {
      out.penDisplay = fx.penDisplay || `(${fx.penHome} - ${fx.penAway} pen)`;
    }
    return out;
  }
  const kickoff = kickoffMsVN(fx);
  const now = Date.now();
  if (kickoff && now > kickoff + 2.5 * 60 * 60 * 1000) {
    return { ...fx, status: fx.status === 'scheduled' ? 'finished' : (fx.status || 'finished') };
  }
  return { ...fx, status: fx.status || 'scheduled' };
}

function mergeFixtureScores(cur, prev) {
  if (cur.homeScore == null && prev.homeScore != null) {
    return attachScoreFields(cur, prev);
  }
  if (cur.homeScore != null && cur.penHome == null && prev.penHome != null) {
    return {
      ...cur,
      penHome: prev.penHome,
      penAway: prev.penAway,
      penDisplay: prev.penDisplay,
      wentToPenalties: true,
    };
  }
  return cur;
}

/** Google bỏ trận đã đá — giữ lại từ cache cũ + cập nhật tỉ số */
function mergeWithPreviousFixtures(current, previous, scoreMap) {
  const map = new Map();
  for (const fx of current) {
    const merged = finalizeFixtureStatus(applyScores({ ...fx }, scoreMap));
    map.set(fixtureKey(merged), merged);
  }
  for (const prev of previous) {
    const key = fixtureKey(prev);
    if (map.has(key)) {
      map.set(key, finalizeFixtureStatus(mergeFixtureScores(map.get(key), prev)));
      continue;
    }
    const kept = finalizeFixtureStatus(applyScores({ ...prev }, scoreMap));
    map.set(key, kept);
  }
  return [...map.values()].sort(compareFixturesByKickoff);
}

function buildApiPayload(raw, previousFixtures = []) {
  const refDate = raw.updatedAt ? new Date(raw.updatedAt) : new Date();
  const rawFixtures = [];
  for (const sn of raw.rawSnippets || []) {
    if (sn.tag !== 'DIV') continue;
    const fx = parseFixtureSnippet(sn.text, refDate);
    if (fx) rawFixtures.push({ id: `fx-${rawFixtures.length + 1}`, ...fx });
  }
  const uniqueFixtures = dedupeFixtures(rawFixtures)
    .filter((fx) => !shouldDropFixture(fx))
    .map((f, i) => ({ ...f, id: `fx-${i + 1}` }));
  const scoreMap = buildScoreMap(raw, uniqueFixtures);
  const mergedFixtures = mergeWithPreviousFixtures(uniqueFixtures, previousFixtures, scoreMap);
  const displayFixtures = filterFixturesForDisplay(mergedFixtures)
    .map((f, i) => ({ ...f, id: `fx-${i + 1}` }));
  const flagOpts = { tbdFlagUrl: raw.tbdFlagUrl || '' };
  const fixtures = displayFixtures.map((f, i) => enrichFixture(f, i, flagOpts));
  const fixtureDays = groupFixturesByDate(displayFixtures, flagOpts);

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
    schemaVersion: 14,
    tournament,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    source: {
      provider: 'google-search',
      url: raw.finalUrl || CONFIG.googleUrls[0],
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
      const isDated =
        /^(Thứ \d+|CN),?\s*\d{1,2}\/\d{1,2},?\s*\d{2}:\d{2}/.test(t) ||
        /^(Hôm nay|Ngày mai),?\s*\d{2}:\d{2}/i.test(t);
      const isScored =
        /^(Thứ \d+|CN),?\s*\d{1,2}\/\d{1,2},?\s*\d{2}:\d{2}/.test(t)
        && (/\d+\s*[-–]\s*\d+/.test(t) || /pen|pens|pk|luân\s*lưu|luan\s*luu|sút\s*luân/i.test(t));
      if ((isDated || isScored) && t.length < 320) {
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
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    const page = await context.newPage();
    const merged = {
      rawSnippets: [],
      groups: [],
      matches: [],
      tbdFlagUrl: '',
      pageTitle: '',
    };
    const snippetSeen = new Set();
    let finalUrl = CONFIG.googleUrls[0] || '';

    for (const url of CONFIG.googleUrls) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs });
      await page.waitForTimeout(3500);
      try {
        await page.waitForSelector('table, .imso-hov, [data-sport]', { timeout: 12000 });
      } catch {
        /* partial */
      }
      const dom = await extractFromPage(page);
      finalUrl = page.url();
      if (dom.pageTitle) merged.pageTitle = dom.pageTitle;
      if (dom.tbdFlagUrl && !merged.tbdFlagUrl) merged.tbdFlagUrl = dom.tbdFlagUrl;
      for (const sn of dom.rawSnippets || []) {
        if (!snippetSeen.has(sn.text)) {
          snippetSeen.add(sn.text);
          merged.rawSnippets.push(sn);
        }
      }
      merged.groups.push(...(dom.groups || []));
      merged.matches.push(...(dom.matches || []));
    }

    const status = merged.groups.length || merged.rawSnippets.length ? 'ok' : 'empty';

    return {
      status,
      durationMs: Date.now() - started,
      pageTitle: merged.pageTitle,
      finalUrl,
      ...merged,
      meta: {
        snippetCount: merged.rawSnippets.length,
        tableCount: merged.groups.length,
        matchCount: merged.matches.length,
        scrapeUrls: CONFIG.googleUrls.length,
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
  let previousFixtures = [];
  try {
    const prev = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    previousFixtures = prev?.api?.fixtures || [];
  } catch {
    /* no prior cache */
  }
  const api = buildApiPayload({ ...raw, updatedAt: new Date().toISOString() }, previousFixtures);
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
      sourceUrl: CONFIG.googleUrls[0],
    },
  });
});

app.post('/api/v1/worldcup/refresh', async (_req, res) => {
  const result = await runSync('api');
  const c = cache || (await loadCache());
  res.json({ success: result.ok !== false, result, data: c.api });
});

const BUILD_TAG = 'wc-noscript-embed-v20';
const MM_BANNER_PATH = '/assets/mm-banner.png';
const MM_GIFT_IMG = 'https://i.imgur.com/hixxXa9.gif';
const RR_TOP_BANNER = 'https://i.ibb.co/NgSHXjZd/l-ch-thi-u-WC-rr88-PC-4-1.jpg';
const EMBED_BASE = 'https://hacksexy.online';

/** Ước lượng chiều cao iframe (CMS không cho script → height phải đủ lớn) */
function estimateEmbedHeight(api) {
  const BANNER = 1320;
  const HEADER = 150;
  const TAB = 110;
  const PAD = 90;
  const DAY_HEAD = 54;
  const ROW = 136;

  let days = api?.fixtureDays || [];
  if (!days.length && api?.fixtures?.length) {
    const byDate = {};
    for (const f of api.fixtures) {
      const k = f.date || 'khac';
      if (!byDate[k]) byDate[k] = { matches: [] };
      byDate[k].matches.push(f);
    }
    days = Object.values(byDate);
  }

  let h = BANNER + HEADER + TAB + PAD;
  for (const day of days) {
    h += DAY_HEAD;
    h += Math.ceil((day.matches || []).length / 2) * ROW;
  }
  return Math.ceil(Math.max(h * 1.5, 2800));
}

function buildIframeSnippet(path, height, title) {
  const src = `${EMBED_BASE}${path}`;
  return `<iframe
  src="${src}"
  title="${title}"
  width="100%"
  height="${height}"
  scrolling="no"
  frameborder="0"
  style="border:0;display:block;width:100%;overflow:visible;vertical-align:top;"
  loading="lazy"
  referrerpolicy="no-referrer-when-downgrade"
></iframe>`;
}

async function getEmbedHeight() {
  const c = cache || (await loadCache());
  return estimateEmbedHeight(c.api);
}

function resolvePublicApiBase(req) {
  const host = req.get('host') || '';
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  if (host.includes('localhost') || host.startsWith('127.0.0.1')) {
    return `http://localhost:${CONFIG.port}`;
  }
  return `${proto}://${host}`.replace(/\/$/, '');
}

/** Fix legacy HTML — strip inline scripts + bet buttons */
function patchScheduleHtml(html, req) {
  const apiBase = resolvePublicApiBase(req);
  let out = html
    .replace(/window\.WC_API_BASE\s*=\s*[^;]+;/g, '')
    .replace(/https?:\/\/localhost:5290/g, apiBase)
    .replace(/return\s+'http:\/\/localhost:5290'/g, `return '${apiBase}'`)
    .replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>\s*/gi, '')
    .replace(/<a[^>]*class="[^"]*wc-bet-btn[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/\s*data-bet-url="[^"]*"/gi, '')
    .replace(/\.wc-bet-btn[^{]*\{[^}]*\}/gi, '')
    .replace(/\+ '<a class="wc-bet-btn[^']*' \+[^;]+;/g, '')
    .replace(/var BET_URL = [^;]+;/g, '');
  out = out.replace(
    /<\/style>/i,
    '</style>\n<style>.wc-bet-btn{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}</style>',
  );
  if (!out.includes('wc-board-loader.js')) {
    out = out.replace(
      /<\/div>\s*$/i,
      '</div>\n<script src="https://hacksexy.online/wc-board-loader.js?v=iframe15"></script>\n',
    );
  } else {
    out = out.replace(/wc-board-loader\.js(\?[^"']*)?/g, 'wc-board-loader.js?v=iframe15');
  }
  return out;
}

const BANNER_FIX_ID = 'wc-banner-fix-css';
const TOP_BANNER_CSS =
  'html,body{margin:0;padding:0;max-width:100%;overflow-x:hidden;box-sizing:border-box}'
  + '.content-html{width:100%;max-width:100%;margin:0;padding:0;box-sizing:border-box}'
  + '.wc-top-banner,.wc-top-banner--mm{width:100%;max-width:100%;margin:0;padding:0;line-height:0;box-sizing:border-box;overflow:hidden}'
  + '.wc-top-banner img,.wc-top-banner--mm img{display:block;width:100%;max-width:100%;height:auto;margin:0;padding:0;position:static;object-fit:unset;transform:none;aspect-ratio:unset}';

function hasTopBannerDiv(html) {
  return /<div[^>]*class="[^"]*wc-top-banner/i.test(html);
}

function applyBannerCssFix(html) {
  const block = `<style id="${BANNER_FIX_ID}">${TOP_BANNER_CSS}</style>`;
  const re = new RegExp(`<style id="${BANNER_FIX_ID}"[^>]*>[\\s\\S]*?<\\/style>`, 'i');
  if (re.test(html)) return html.replace(re, block);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}</head>`);
  return html.replace(/<\/style>/i, `</style>${block}`);
}

function sanitizeLegacyBanner(html) {
  return html.replace(/\swc-top-banner--mm/g, '');
}

function resolveBannerUrl(req, assetPath) {
  return `${resolvePublicApiBase(req)}${assetPath}`;
}

function injectTopBanner(html, bannerUrl, alt) {
  let out = sanitizeLegacyBanner(html);
  out = out.replace(/https:\/\/i\.ibb\.co\/(?:WWSnXKXM|vx21WzWT)[^"']*/g, bannerUrl);
  out = out.replace(/https:\/\/hacksexy\.online\/assets\/mm-banner\.(?:jpg|png)/g, bannerUrl);
  out = applyBannerCssFix(out);
  if (!hasTopBannerDiv(out)) {
    out = out.replace(
      '<div class="content-html">',
      `<div class="content-html"><div class="wc-top-banner"><img src="${bannerUrl}" alt="${alt}" loading="eager" decoding="async" /></div>`,
    );
  } else {
    out = out.replace(
      /(<div[^>]*class="[^"]*wc-top-banner[^"]*"[^>]*>\s*<img[^>]*\ssrc=")[^"]+/i,
      `$1${bannerUrl}`,
    );
  }
  return out;
}

function injectGiftFall(html) {
  if (html.includes('gift-fall-container')) return html;
  const giftCss =
    '.gift-fall-container{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:9999}'
    + '.gift{position:absolute;top:-100px;width:70px;height:70px;opacity:.9;animation:giftFall 7s linear infinite}'
    + '.gift-1{left:1%;animation-delay:0s}.gift-2{left:32%;animation-delay:1s}.gift-3{left:48%;animation-delay:2s}'
    + '.gift-4{left:64%;animation-delay:3s}.gift-5{left:80%;animation-delay:4s}'
    + '@keyframes giftFall{0%{transform:translateY(-120px) rotate(0deg);opacity:1}70%{opacity:1}100%{transform:translateY(100vh) rotate(360deg);opacity:0}}'
    + '@media(max-width:640px){.gift{width:50px;height:50px}}'
    + '.wc-card-left{justify-content:center!important}.wc-group{display:none!important}';
  let out = html.replace(/<\/style>/i, '</style>\n<style type="text/css">' + giftCss + '</style>');
  const giftHtml =
    '<div class="gift-fall-container" aria-hidden="true">'
    + `<img class="gift gift-1" src="${MM_GIFT_IMG}" alt="" loading="lazy" />`
    + `<img class="gift gift-2" src="${MM_GIFT_IMG}" alt="" loading="lazy" />`
    + `<img class="gift gift-3" src="${MM_GIFT_IMG}" alt="" loading="lazy" />`
    + `<img class="gift gift-4" src="${MM_GIFT_IMG}" alt="" loading="lazy" />`
    + `<img class="gift gift-5" src="${MM_GIFT_IMG}" alt="" loading="lazy" />`
    + '</div>';
  if (/<body[^>]*>/i.test(out)) {
    out = out.replace(/<body([^>]*)>/i, '<body$1>' + giftHtml);
  } else {
    out = giftHtml + out;
  }
  return out;
}

/** MM88 /schedule — banner + hiệu ứng quà rơi */
function patchSchedule1Html(html, req) {
  let out = patchScheduleHtml(html, req);
  out = injectTopBanner(out, resolveBannerUrl(req, MM_BANNER_PATH), 'Lịch thi đấu World Cup MM88');
  return injectGiftFall(out);
}

/** RR88 /schedule2 — luôn chèn banner trên cùng (kể cả file HTML trên VPS cũ) */
function patchSchedule2Html(html, req) {
  let out = patchScheduleHtml(html, req);
  return injectTopBanner(out, RR_TOP_BANNER, 'Lịch thi đấu World Cup RR88');
}

app.get('/_wc/meta', async (_req, res) => {
  const embedHeight = await getEmbedHeight();
  res.json({
    build: BUILD_TAG,
    patchScheduleHtml: true,
    schedule2: '/schedule2',
    embedHeight,
    embedSnippetRr: '/embed/snippet/rr.txt',
    embedSnippetMm: '/embed/snippet/mm.txt',
  });
});

app.get('/embed/snippet/rr.txt', async (_req, res) => {
  const h = await getEmbedHeight();
  res.type('text/plain; charset=utf-8')
    .setHeader('Cache-Control', 'no-cache')
    .setHeader('X-WC-Embed-Height', String(h))
    .send(buildIframeSnippet('/schedule2', h, 'Lịch thi đấu World Cup RR88'));
});

app.get('/embed/snippet/mm.txt', async (_req, res) => {
  const h = await getEmbedHeight();
  res.type('text/plain; charset=utf-8')
    .setHeader('Cache-Control', 'no-cache')
    .setHeader('X-WC-Embed-Height', String(h))
    .send(buildIframeSnippet('/schedule', h, 'Lịch thi đấu World Cup MM88'));
});

app.get('/embed/snippet/rr', async (_req, res) => {
  const h = await getEmbedHeight();
  const snippet = buildIframeSnippet('/schedule2', h, 'Lịch thi đấu World Cup RR88');
  const esc = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.type('html').setHeader('Cache-Control', 'no-cache').send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"/><title>RR88 iframe snippet</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}
textarea{width:100%;height:220px;font-family:monospace;font-size:13px;padding:12px;border:1px solid #ccc;border-radius:8px}
p{color:#444;line-height:1.5}</style></head><body>
<h1>RR88 — dán iframe vào CMS (không cần script)</h1>
<p>Chiều cao tự tính: <strong>${h}px</strong> — copy toàn bộ ô dưới:</p>
<textarea readonly onclick="this.select()">${esc}</textarea>
<p>Cập nhật khi thêm trận: mở lại trang này.</p>
</body></html>`);
});

app.get('/embed/snippet/mm', async (_req, res) => {
  const h = await getEmbedHeight();
  const snippet = buildIframeSnippet('/schedule', h, 'Lịch thi đấu World Cup MM88');
  const esc = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.type('html').setHeader('Cache-Control', 'no-cache').send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"/><title>MM88 iframe snippet</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}
textarea{width:100%;height:220px;font-family:monospace;font-size:13px;padding:12px;border:1px solid #ccc;border-radius:8px}
p{color:#444;line-height:1.5}</style></head><body>
<h1>MM88 — dán iframe vào CMS (không cần script)</h1>
<p>Chiều cao tự tính: <strong>${h}px</strong> — copy toàn bộ ô dưới:</p>
<textarea readonly onclick="this.select()">${esc}</textarea>
</body></html>`);
});

app.get('/assets/mm-banner.png', async (_req, res) => {
  try {
    const file = path.join(__dirname, 'assets', 'mm-banner.png');
    const buf = await readFile(file);
    res.type('image/png')
      .setHeader('Cache-Control', 'public, max-age=604800')
      .send(buf);
  } catch {
    res.status(404).send('mm-banner.png not found');
  }
});

app.get('/assets/mm-banner.jpg', async (_req, res) => {
  res.redirect(301, '/assets/mm-banner.png');
});

app.get('/wc-board-loader.js', async (_req, res) => {
  try {
    const js = await readFile(BOARD_LOADER_JS, 'utf8');
    res.type('application/javascript')
      .setHeader('Cache-Control', 'no-cache')
      .setHeader('X-WC-Loader', '15-banner-fullwidth')
      .send(js);
  } catch {
    res.status(404).send('// wc-board-loader.js not found');
  }
});

app.get('/wc-iframe-parent.js', async (_req, res) => {
  try {
    const js = await readFile(IFRAME_PARENT_JS, 'utf8');
    res.type('application/javascript')
      .setHeader('Cache-Control', 'no-cache')
      .setHeader('Access-Control-Allow-Origin', '*')
      .send(js);
  } catch {
    res.status(404).send('// wc-iframe-parent.js not found');
  }
});

function allowIframeEmbed(res) {
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.removeHeader('X-Frame-Options');
}

app.get('/schedule', async (req, res) => {
  try {
    const apiBase = resolvePublicApiBase(req);
    const embedHeight = await getEmbedHeight();
    const html = patchSchedule1Html(await readFile(SCHEDULE_HTML, 'utf8'), req);
    allowIframeEmbed(res);
    res.type('html')
      .setHeader('Cache-Control', 'no-cache')
      .setHeader('X-WC-Build', BUILD_TAG)
      .setHeader('X-WC-Api-Base', apiBase)
      .setHeader('X-WC-Embed-Height', String(embedHeight))
      .send(html);
  } catch {
    res.status(404).send('worldcup-schedule-mm.html not found');
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
    const embedHeight = await getEmbedHeight();
    const html = patchSchedule2Html(await readSchedule2Html(), req);
    allowIframeEmbed(res);
    res.type('html')
      .setHeader('Cache-Control', 'no-cache')
      .setHeader('X-WC-Build', BUILD_TAG)
      .setHeader('X-WC-Api-Base', apiBase)
      .setHeader('X-WC-Embed-Height', String(embedHeight))
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
  cache.api.schemaVersion !== 14 ||
  !cache.api.fixtureDays?.length ||
  !cache.api.fixtures?.[0]?.homeFlag;
if (needsApiRebuild) {
  await saveCache(cache);
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

if (!cache?.api?.fixtures?.length) {
  runSync('boot').catch((err) => console.error('[wc-api] boot sync:', err?.message || err));
}
