'use strict';

const express      = require('express');
const session      = require('express-session');
const FileStore    = require('session-file-store')(session);
const bcrypt       = require('bcryptjs');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');

const { initDB, getDB, getConfig, setConfig, getOrCreateSessionSecret } = require('./db');
const { createClient }          = require('./smb-client');
const { extractAllPages }       = require('./extractor');
const { scanLibrary, getScanStatus, getLibConfig, getCacheDir } = require('./scanner');

// ── Init ──────────────────────────────────────────────────────────────────────

const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, 'data');
const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'comic-reader-cache');

fs.mkdirSync(DATA_DIR,  { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, 'covers'), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, 'pages'),  { recursive: true });

const db = initDB(DATA_DIR);
setConfig('cache_dir', CACHE_DIR);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionSecret = getOrCreateSessionSecret();
app.use(session({
  store:             new FileStore({ path: path.join(DATA_DIR, 'sessions'), ttl: 30 * 24 * 3600, retries: 0, logFn: () => {} }),
  secret:            sessionSecret,
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

const requireAuth  = (req, res, next) => req.session.userId  ? next() : res.status(401).json({ error: 'Unauthorized' });
const requireAdmin = (req, res, next) => req.session.isAdmin ? next() : res.status(403).json({ error: 'Forbidden' });

// ── Setup ─────────────────────────────────────────────────────────────────────

app.get('/api/setup/status', (req, res) => {
  const configured = !!getConfig('library_config');
  const hasAdmin   = !!db.get('SELECT 1 as x FROM users WHERE is_admin=1');
  res.json({ configured, hasAdmin, needsSetup: !configured || !hasAdmin });
});

app.post('/api/setup/library', (req, res) => {
  const hasAdmin = !!db.get('SELECT 1 as x FROM users WHERE is_admin=1');
  if (hasAdmin && !req.session.isAdmin) return res.status(403).json({ error: 'Forbidden' });

  const { type, host, share, domain, username, password, localPath } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });

  const config = type === 'smb'
    ? { type, host, share, domain, username, password }
    : { type: 'local', path: localPath };

  setConfig('library_config', JSON.stringify(config));
  res.json({ ok: true });
});

app.post('/api/setup/admin', async (req, res) => {
  const hasAdmin = !!db.get('SELECT 1 as x FROM users WHERE is_admin=1');
  if (hasAdmin) return res.status(400).json({ error: 'Admin already exists' });

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const hash = await bcrypt.hash(password, 12);
  const info = db.run('INSERT INTO users (username, password_hash, is_admin) VALUES (?,?,1)', [username, hash]);

  req.session.userId   = info.lastInsertRowid;
  req.session.isAdmin  = true;
  req.session.username = username;
  res.json({ ok: true, userId: info.lastInsertRowid });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.get('SELECT * FROM users WHERE username=?', [username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.userId   = user.id;
  req.session.isAdmin  = !!user.is_admin;
  req.session.username = user.username;
  res.json({ ok: true, userId: user.id, isAdmin: !!user.is_admin, username: user.username });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ userId: req.session.userId, isAdmin: req.session.isAdmin, username: req.session.username });
});

// ── Library ───────────────────────────────────────────────────────────────────

app.get('/api/library/series', requireAuth, (req, res) => {
  const series = db.all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM progress p
       JOIN comics c ON c.id = p.comic_id
       WHERE c.series_id = s.id AND p.user_id = ? AND p.completed = 1
      ) AS completed_count
    FROM series s ORDER BY s.name COLLATE NOCASE
  `, [req.session.userId]);
  res.json(series);
});

app.get('/api/library/series/:id', requireAuth, (req, res) => {
  const series = db.get('SELECT * FROM series WHERE id=?', [req.params.id]);
  if (!series) return res.status(404).json({ error: 'Not found' });

  const comics = db.all(`
    SELECT c.*, p.current_page, p.completed, p.last_read
    FROM comics c
    LEFT JOIN progress p ON p.comic_id = c.id AND p.user_id = ?
    WHERE c.series_id = ?
    ORDER BY c.sort_key COLLATE NOCASE
  `, [req.session.userId, series.id]);

  res.json({ series, comics });
});

// ── Scan ──────────────────────────────────────────────────────────────────────

app.post('/api/library/scan', requireAdmin, (req, res) => {
  scanLibrary();
  res.json({ ok: true, message: 'Scan started' });
});

app.get('/api/library/scan/status', requireAuth, (req, res) => {
  res.json(getScanStatus());
});

// ── Comic open / pages ────────────────────────────────────────────────────────

app.post('/api/comics/:id/open', requireAuth, async (req, res) => {
  const comic = db.get('SELECT * FROM comics WHERE id=?', [req.params.id]);
  if (!comic) return res.status(404).json({ error: 'Not found' });

  const pageDir = path.join(CACHE_DIR, 'pages', String(comic.id));
  let pageCount = comic.page_count;

  const cachedPages = fs.existsSync(pageDir)
    ? fs.readdirSync(pageDir).filter(f => f.endsWith('.jpg')).length
    : 0;

  if (cachedPages === 0) {
    try {
      const libConfig = getLibConfig();
      const client    = createClient(libConfig);
      const buffer    = await client.readFile(comic.smb_path);
      client.disconnect();

      pageCount = await extractAllPages(comic.smb_path, buffer, pageDir);
      db.run('UPDATE comics SET page_count=? WHERE id=?', [pageCount, comic.id]);
    } catch (err) {
      return res.status(500).json({ error: `Failed to open comic: ${err.message}` });
    }
  } else {
    pageCount = cachedPages;
  }

  let progress = db.get('SELECT * FROM progress WHERE user_id=? AND comic_id=?', [req.session.userId, comic.id]);
  if (!progress) {
    db.run('INSERT INTO progress (user_id, comic_id, current_page, total_pages) VALUES(?,?,0,?)', [req.session.userId, comic.id, pageCount]);
    progress = { current_page: 0, total_pages: pageCount, completed: 0 };
  } else {
    db.run('UPDATE progress SET total_pages=? WHERE user_id=? AND comic_id=?', [pageCount, req.session.userId, comic.id]);
  }

  res.json({ ...comic, page_count: pageCount, progress });
});

app.get('/api/comics/:id/page/:page', requireAuth, (req, res) => {
  const pagePath = path.join(CACHE_DIR, 'pages', req.params.id,
    `${String(req.params.page).padStart(4, '0')}.jpg`);
  if (!fs.existsSync(pagePath)) return res.status(404).json({ error: 'Page not found' });
  res.sendFile(pagePath);
});

// ── Progress ──────────────────────────────────────────────────────────────────

app.put('/api/progress/:comicId', requireAuth, (req, res) => {
  const { currentPage, completed } = req.body;
  db.run(`
    INSERT INTO progress (user_id, comic_id, current_page, completed, last_read)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(user_id, comic_id) DO UPDATE SET
      current_page=excluded.current_page,
      completed=excluded.completed,
      last_read=excluded.last_read
  `, [req.session.userId, req.params.comicId, currentPage, completed ? 1 : 0]);
  res.json({ ok: true });
});

app.get('/api/progress/recent', requireAuth, (req, res) => {
  const rows = db.all(`
    SELECT p.*, c.title, c.cover_cache, c.id as comic_id,
           s.name as series_name, s.id as series_id
    FROM progress p
    JOIN comics c ON c.id = p.comic_id
    JOIN series s ON s.id = c.series_id
    WHERE p.user_id=? AND p.completed=0 AND p.current_page>0
    ORDER BY p.last_read DESC LIMIT 20
  `, [req.session.userId]);
  res.json(rows);
});

// ── Cover images ──────────────────────────────────────────────────────────────

app.get('/api/covers/series/:id', requireAuth, (req, res) => {
  const series = db.get('SELECT cover_cache FROM series WHERE id=?', [req.params.id]);
  if (!series?.cover_cache || !fs.existsSync(series.cover_cache))
    return res.sendFile(path.join(__dirname, 'public', 'no-cover.svg'));
  res.sendFile(series.cover_cache);
});

app.get('/api/covers/comic/:id', requireAuth, (req, res) => {
  const comic = db.get('SELECT cover_cache FROM comics WHERE id=?', [req.params.id]);
  if (!comic?.cover_cache || !fs.existsSync(comic.cover_cache))
    return res.sendFile(path.join(__dirname, 'public', 'no-cover.svg'));
  res.sendFile(comic.cover_cache);
});

// ── Users (admin) ─────────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.all('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at'));
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, isAdmin } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const info = db.run('INSERT INTO users (username, password_hash, is_admin) VALUES(?,?,?)',
      [username, hash, isAdmin ? 1 : 0]);
    res.json({ id: info.lastInsertRowid, username, is_admin: isAdmin ? 1 : 0 });
  } catch {
    res.status(409).json({ error: 'Username already exists' });
  }
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const hash = await bcrypt.hash(password, 12);
  db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.userId)
    return res.status(400).json({ error: 'Cannot delete yourself' });
  db.run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n📚 Panels — Comic Reader`);
  console.log(`   Running at http://localhost:${PORT}`);
  console.log(`   Data:  ${DATA_DIR}`);
  console.log(`   Cache: ${CACHE_DIR}\n`);
});
