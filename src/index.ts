import pLimit from 'p-limit';
import express from 'express';
import sqlite3 from 'sqlite3';
import puppeteer, { Browser } from 'puppeteer';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { normalizeUrl, makeKey } from './utils';
import { authenticateToken } from './auth';

const CACHE_DIR = process.env.CACHE_DIR || '/tmp/capture';
const DATA_DIR = path.join(CACHE_DIR, 'data');
const CACHE_TTL = 3600 * 24 * (Number(process.env.CACHE_TTL) || 0);  // Default infinite if 0
// Reduce max concurrent browsers to 2
const MAX_CONCURRENT = 2;

const browserLimit = pLimit(MAX_CONCURRENT);
const app = express();

let browser: Browser;
let ready = false;

console.log(`Using cache directory: ${CACHE_DIR}`);

function initDatabase() {
  fs.mkdir(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'cache.db');

  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  if (CACHE_TTL > 0) {
    const expireTime = Date.now() - CACHE_TTL * 1000;
    db.run('DELETE FROM cache WHERE created_at < ?', expireTime);
  }
  return db;
}

const db = initDatabase();

function cacheSet(key: string, filename: string) {
  const now = Date.now();
  console.log(`Caching: ${key} → ${filename}`);
  db.run(
    'INSERT OR REPLACE INTO cache (key, filename, created_at) VALUES (?, ?, ?)',
    [key, filename, now],
    (err) => err && console.error('Database error:', err)
  );
}

export const fetchFirst = async (db: sqlite3.Database, sql: string, params: any[] = []): Promise<any> => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
};

async function cacheGet(key: string): Promise<string | undefined> {
  const row = await fetchFirst(db, 'SELECT filename FROM cache WHERE key = ?', [key]);
  const filename = row ? row.filename : undefined;
  console.log(`Cache lookup for ${key}:`, filename || 'not found');
  return filename;
}

/** Launch Puppeteer once at startup */
async function boot() {
  browser = await puppeteer.launch({
    headless: 'new',
    dumpio: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '-enable-chrome-browser-cloud-management',
      '--enable-unsafe-swiftshader'
    ],
    executablePath: process.env.CHROME_PATH
  });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  ready = true;
}
boot().catch(err => {
  console.error('Failed to launch browser:', err);
  process.exit(1);
});

app.get('/healthz', (_req, res) => {
  return ready ? res.sendStatus(200) : res.sendStatus(503);
});

app.get('/health', (_req, res) => {
  return ready ? res.sendStatus(200) : res.sendStatus(503);
});

app.get('/capture', authenticateToken, async (req, res) => {
  if (!ready) {
    return res.status(503).json({ error: 'Service unavailable.' });
  }

  // Extract and validate params
  let { url, format, length, nocache } = req.query;
  format = format || 'png';
  length = length || '4';

  if (typeof url !== 'string' || typeof format !== 'string') {
    return res.status(400).json({ error: '`url` is required.' });
  }
  const fmt = format.toLowerCase();
  if (!['png', 'webp'].includes(fmt)) {
    return res.status(400).json({ error: '`format` must be "png" or "webp".' });
  }

  let lenNum: number | undefined;
  if (fmt === 'webp') {
    if (typeof length !== 'string') {
      return res.status(400).json({ error: '`length` is required for webp.' });
    }
    lenNum = Number(length);
    if (!Number.isInteger(lenNum) || lenNum < 1 || lenNum > 5) {
      return res.status(400).json({ error: '`length` must be integer 1–5.' });
    }
  }

  // Normalize and generate cache key
  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }
  const key = makeKey(normalized, fmt, lenNum);

  // Check cache first and serve immediately if found (unless nocache)
  if (nocache === undefined) {
    const cachedFile = await cacheGet(key);
    if (cachedFile) {
      const filePath = path.resolve(CACHE_DIR, cachedFile);
      console.log('Serving from cache:', filePath);
      return res.sendFile(filePath);
    }
  }

  // Not cached or nocache: perform capture under concurrency limit
  browserLimit(async () => {
    const page = await browser.newPage();
    try {
      await page.goto(normalized, { waitUntil: 'networkidle2', timeout: 60000 });

      if (fmt === 'png') {
        const filename = `${key}.png`;
        const full = path.join(CACHE_DIR, filename);
        await page.screenshot({ path: full, fullPage: true });
        cacheSet(key, filename);
        res.sendFile(full);
      } else {
        // Generate webp animated
        const frameDir = path.join(CACHE_DIR, `frames-${key}`);
        await fs.mkdir(frameDir, { recursive: true });
        const fps = 4;
        let count = 0;
        await new Promise<void>(resolve => {
          const interval = setInterval(async () => {
            const framePath = path.join(frameDir, `frame-${String(count).padStart(3, '0')}.png`);
            await page.screenshot({ path: framePath });
            count++;
            if (count >= fps * lenNum!) {
              clearInterval(interval);
              resolve();
            }
          }, 1000 / fps);
        });
        const outFile = `${key}.webp`;
        const outFull = path.join(CACHE_DIR, outFile);
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(path.join(frameDir, 'frame-%03d.png'))
            .inputFPS(fps)
            .outputOptions([
              '-vcodec libwebp',
              '-lossless 0',
              '-qscale 75',
              '-vf scale=640:480',
              '-loop 0'
            ])
            .output(outFull)
            .on('end', () => resolve())
            .on('error', err => reject(err))
            .run();
        });
        await fs.rm(frameDir, { recursive: true, force: true });
        cacheSet(key, outFile);
        res.sendFile(outFull);
      }
    } catch (err) {
      console.error('Capture error:', err);
      res.status(500).json({ error: 'Failed to capture.' });
    } finally {
      await page.close();
    }
  }).catch(err => {
    console.error('Error in capture limit:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`▶️  Listening on :${PORT}`);
});
