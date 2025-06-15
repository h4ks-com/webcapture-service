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
const DATA_DIR = process.env.DATA_DIR || path.join(CACHE_DIR, 'data');
const CACHE_TTL = 3600 * 24 * (Number(process.env.CACHE_TTL) || 0);  // Default infinity
const MAX_CONCURRENT = 5; // max concurrent captures

const captureLimit = pLimit(MAX_CONCURRENT);
const app = express();

let browser: Browser;
let ready = false;

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

  // Clean expired entries if TTL is set
  if (CACHE_TTL > 0) {
    const expireTime = Date.now() - CACHE_TTL * 1000;
    db.run('DELETE FROM cache WHERE created_at < ?', expireTime);
  }
  return db;
}

function cacheSet(key: string, filename: string) {
  const now = Date.now();
  db.run('INSERT OR REPLACE INTO cache (key, filename, created_at) VALUES (?, ?, ?)', [key, filename, now], (err) => {
    if (err) {
      console.error('Database error:', err);
    }
  });
}

function cacheGet(key: string): string | undefined {
  const row = db.prepare('SELECT filename FROM cache WHERE key = ?').get(key);
  // @ts-ignore
  return row ? row.filename : undefined;
}

const db = initDatabase();

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
    // on macOS M1, override if needed:
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
  if (ready) return res.sendStatus(200);
  res.sendStatus(503);
});

app.get('/capture', authenticateToken, async (req, res) => {
  if (!ready) return res.status(503).json({ error: 'Service unavailable.' });
  await captureLimit(() => (async () => {
    let { url, format, length, nocache } = req.query;
    format = format || 'png';
    length = length || '4';

    // Validate query
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

    let normalized: string;
    try {
      normalized = normalizeUrl(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL.' });
    }

    const key = makeKey(normalized, fmt, lenNum);
    let outPath = cacheGet(key);
    if (nocache === undefined && outPath) {
      // Serve from cache
      return res.sendFile(path.resolve(CACHE_DIR, outPath));
    }

    // Otherwise generate anew
    const page = await browser.newPage();
    try {

      await page.goto(normalized, { waitUntil: 'networkidle2', timeout: 60000 });
      if (fmt === 'png') {
        const filename = `${key}.png`;
        const full = path.join(CACHE_DIR, filename);
        await page.screenshot({ path: full, fullPage: true });
        cacheSet(key, filename);
        return res.sendFile(full);
      } else {
        // webp recording via ffmpeg + screenshots
        const frameDir = path.join(CACHE_DIR, `frames-${key}`);
        await fs.mkdir(frameDir, { recursive: true });
        const fps = 4; // 4fps → length*4 frames
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
            .on('end', () => {
              // ignore FFmpeg’s stdout/stderr args
              resolve();
            })
            .on('error', (err: Error) => {
              // apture the error
              reject(err);
            })
            .run();
        });
        // cleanup frames
        await fs.rm(frameDir, { recursive: true, force: true });
        cacheSet(key, outFile);
        return res.sendFile(outFull);
      }
    } catch (err) {
      console.error('Capture error:', err);
      return res.status(500).json({ error: 'Failed to capture.' });
    } finally {
      await page.close();
    }
  })());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`▶️  Listening on :${PORT}`);
});
