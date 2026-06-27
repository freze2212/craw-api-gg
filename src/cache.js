import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';

const defaultCache = () => ({
  updatedAt: null,
  sourceUrl: config.googleSearchUrl,
  status: 'empty',
  matches: [],
  groups: [],
  rawSnippets: [],
  meta: {},
});

export async function ensureDataDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

export async function readCache() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(config.cacheFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return defaultCache();
  }
}

export async function writeCache(payload) {
  await ensureDataDir();
  const next = {
    ...payload,
    updatedAt: new Date().toISOString(),
    sourceUrl: config.googleSearchUrl,
  };
  await fs.writeFile(config.cacheFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
