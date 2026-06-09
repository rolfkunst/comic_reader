'use strict';

const path      = require('path');
const fs        = require('fs');
const { getDB, getConfig, setConfig } = require('./db');
const { createClient }                = require('./smb-client');
const { extractCover, isCBR, isCBZ } = require('./extractor');

const COMIC_EXTS = new Set(['.cbr', '.cbz', '.rar', '.zip']);

let scanStatus = { running: false, progress: '', error: null, lastRun: null };

function getScanStatus() { return { ...scanStatus }; }

function isComic(name) { return COMIC_EXTS.has(path.extname(name).toLowerCase()); }

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function getLibConfig() {
  const raw = getConfig('library_config');
  return raw ? JSON.parse(raw) : null;
}

function getCacheDir() {
  return getConfig('cache_dir') || require('path').join(require('os').tmpdir(), 'comic-reader-cache');
}

async function collectComics(client, seriesPath) {
  const comics = [];
  let entries;
  try { entries = await client.listDir(seriesPath); }
  catch { return comics; }

  for (const entry of entries) {
    const fullPath = seriesPath ? `${seriesPath}/${entry}` : entry;
    if (isComic(entry)) {
      comics.push({ path: fullPath, volume: null, title: path.basename(entry, path.extname(entry)) });
    } else {
      try {
        const sub = await client.listDir(fullPath);
        for (const subEntry of sub) {
          if (isComic(subEntry)) {
            comics.push({ path: `${fullPath}/${subEntry}`, volume: entry,
              title: path.basename(subEntry, path.extname(subEntry)) });
          }
        }
      } catch { /* not a directory */ }
    }
  }
  return comics;
}

async function scanLibrary() {
  if (scanStatus.running) return;

  const libConfig = getLibConfig();
  if (!libConfig) { scanStatus.error = 'Library not configured.'; return; }

  const cacheDir  = getCacheDir();
  const coversDir = path.join(cacheDir, 'covers');
  fs.mkdirSync(coversDir, { recursive: true });

  scanStatus = { running: true, progress: 'Connecting…', error: null, lastRun: null };

  const client = createClient(libConfig);
  const db     = getDB();

  try {
    scanStatus.progress = 'Listing series…';
    const rootEntries = await client.listDir('');

    for (const seriesName of rootEntries.sort(naturalSort)) {
      scanStatus.progress = `Scanning: ${seriesName}`;

      const existing = db.get('SELECT id FROM series WHERE smb_path=?', [seriesName]);
      let seriesId;
      if (existing) {
        seriesId = existing.id;
      } else {
        const info = db.run('INSERT OR IGNORE INTO series (name, smb_path) VALUES(?,?)', [seriesName, seriesName]);
        seriesId = info.lastInsertRowid || db.get('SELECT id FROM series WHERE smb_path=?', [seriesName])?.id;
      }
      if (!seriesId) continue;

      const comics = await collectComics(client, seriesName);
      comics.sort((a, b) => {
        const v = naturalSort(a.volume || '', b.volume || '');
        return v !== 0 ? v : naturalSort(a.title, b.title);
      });

      let seriesCoverPath = null;

      for (let i = 0; i < comics.length; i++) {
        const comic     = comics[i];
        const coverName = `comic_${Buffer.from(comic.path).toString('base64url').slice(0, 64)}.jpg`;
        const coverPath = path.join(coversDir, coverName);

        const existingComic = db.get('SELECT id FROM comics WHERE smb_path=?', [comic.path]);
        let comicId;
        if (existingComic) {
          comicId = existingComic.id;
          db.run('UPDATE comics SET series_id=?,title=?,volume=?,sort_key=?,cover_cache=? WHERE id=?',
            [seriesId, comic.title, comic.volume, `${comic.volume || ''}__${comic.title}`, coverPath, comicId]);
        } else {
          const info = db.run(
            'INSERT INTO comics (series_id,title,smb_path,volume,sort_key,cover_cache) VALUES(?,?,?,?,?,?)',
            [seriesId, comic.title, comic.path, comic.volume, `${comic.volume || ''}__${comic.title}`, coverPath]);
          comicId = info.lastInsertRowid;
        }

        if (!fs.existsSync(coverPath)) {
          try {
            const buffer = await client.readFile(comic.path);
            await extractCover(comic.path, buffer, coverPath);
          } catch (e) {
            console.warn(`Cover failed: ${comic.path}: ${e.message}`);
          }
        }

        if (i === 0) seriesCoverPath = coverPath;
      }

      db.run('UPDATE series SET comic_count=?,cover_cache=?,last_scanned=datetime("now") WHERE id=?',
        [comics.length, seriesCoverPath, seriesId]);
    }

    scanStatus = { running: false, progress: 'Complete', error: null, lastRun: new Date().toISOString() };
    setConfig('last_scan', new Date().toISOString());
  } catch (err) {
    console.error('Scan error:', err);
    scanStatus = { running: false, progress: '', error: err.message, lastRun: null };
  } finally {
    client.disconnect();
  }
}

module.exports = { scanLibrary, getScanStatus, getLibConfig, getCacheDir };
