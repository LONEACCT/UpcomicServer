const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireUser, requireVip } = require('../middleware/auth');
const { pagesDir } = require('../upload');
const AdmZip = require('adm-zip');

// A chapter with a future publish_at is scheduled, not live to readers yet
const VISIBLE_CHAPTER_SQL = "(publish_at IS NULL OR datetime(publish_at) <= datetime('now'))";

const router = express.Router();

// ---------- Age gate ----------

router.get('/enter', (req, res) => {
  res.render('age-gate');
});

router.post('/enter', (req, res) => {
  res.cookie('upcomic_age_ok', '1', {
    maxAge: 1000 * 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: 'lax',
  });
  res.redirect('/');
});

// ---------- Protected page-image serving ----------
// Page images live outside the public/static folder. This is the only way
// to fetch one — so a direct/shared image link can't skip the VIP check.
// Placed before the age-gate check below since this is its own access
// control (VIP/admin), not a page a browser navigates to directly.

router.get('/media/page/:pageId', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.pageId);
  if (!page) return res.status(404).end();

  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(page.chapter_id);
  if (!chapter) return res.status(404).end();

  if (chapter.is_premium && !req.session.isAdmin) {
    const isVip =
      req.currentUser &&
      req.currentUser.vip_expires_at &&
      new Date(req.currentUser.vip_expires_at) > new Date();
    if (!isVip) return res.status(403).end();
  }

  const filePath = path.join(__dirname, '..', 'private-uploads', 'pages', page.image_path);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Everything below this line requires the age gate to have been passed
router.use((req, res, next) => {
  if (req.cookies && req.cookies.upcomic_age_ok === '1') return next();
  return res.redirect('/enter');
});

// Shared SQL fragment: chapter count + comma-joined category names for a comic
const COMIC_EXTRAS_SQL = `
  (SELECT COUNT(*) FROM chapters WHERE chapters.comic_id = comics.id AND ${VISIBLE_CHAPTER_SQL}) AS chapter_count,
  (SELECT COUNT(*) FROM chapters WHERE chapters.comic_id = comics.id AND chapters.is_premium = 1 AND ${VISIBLE_CHAPTER_SQL}) AS premium_chapter_count,
  (SELECT GROUP_CONCAT(categories.name, ', ') FROM comic_categories
     JOIN categories ON categories.id = comic_categories.category_id
     WHERE comic_categories.comic_id = comics.id) AS category_names
`;

// ---------- Homepage ----------

router.get('/', (req, res) => {
  const sort = ['popular', 'trending', 'latest'].includes(req.query.sort) ? req.query.sort : 'latest';
  const categorySlug = (req.query.category || '').trim();
  const search = (req.query.q || '').trim();

  // Step 1: figure out which comic IDs match the filters (category + search)
  let idQuery = 'SELECT DISTINCT comics.id FROM comics';
  const idParams = [];
  const wheres = [];

  if (categorySlug) {
    idQuery += ' JOIN comic_categories cc ON cc.comic_id = comics.id JOIN categories cat ON cat.id = cc.category_id';
    wheres.push('cat.slug = ?');
    idParams.push(categorySlug);
  }
  if (search) {
    wheres.push('comics.title LIKE ?');
    idParams.push(`%${search}%`);
  }
  if (wheres.length) idQuery += ' WHERE ' + wheres.join(' AND ');

  const matchingIds = db.prepare(idQuery).all(...idParams).map((r) => r.id);

  let comics = [];
  if (matchingIds.length) {
    const placeholders = matchingIds.map(() => '?').join(',');
    let orderBy = 'comics.created_at DESC';
    if (sort === 'popular') orderBy = 'comics.rating DESC, comics.created_at DESC';
    if (sort === 'trending') orderBy = 'comics.is_trending DESC, comics.rating DESC, comics.created_at DESC';

    comics = db
      .prepare(
        `SELECT comics.*, ${COMIC_EXTRAS_SQL}
         FROM comics WHERE comics.id IN (${placeholders})
         ORDER BY ${orderBy}`
      )
      .all(...matchingIds);
  }

  const featuredComics = db
    .prepare(
      `SELECT comics.*, ${COMIC_EXTRAS_SQL}
       FROM comics WHERE is_featured = 1
       ORDER BY comics.created_at DESC LIMIT 6`
    )
    .all();

  const trendingComics = db
    .prepare(
      `SELECT comics.*, ${COMIC_EXTRAS_SQL}
       FROM comics WHERE is_trending = 1
       ORDER BY comics.rating DESC, comics.created_at DESC LIMIT 6`
    )
    .all();

  const latestChapters = db
    .prepare(
      `SELECT chapters.id AS chapter_id, chapters.title AS chapter_title,
              chapters.chapter_number, chapters.is_premium, chapters.created_at,
              comics.title AS comic_title, comics.slug AS comic_slug, comics.cover_image
       FROM chapters
       JOIN comics ON comics.id = chapters.comic_id
       WHERE ${VISIBLE_CHAPTER_SQL}
       ORDER BY chapters.created_at DESC
       LIMIT 6`
    )
    .all();

  const categories = db.prepare('SELECT * FROM categories ORDER BY name ASC').all();

  res.render('index', {
    comics,
    featuredComics,
    trendingComics,
    latestChapters,
    categories,
    sort,
    categorySlug,
    search,
  });
});

// ---------- VIP / pricing page ----------

router.get('/vip', (req, res) => {
  res.render('vip');
});

// ---------- Signup ----------

router.get('/signup', (req, res) => {
  res.render('signup', { error: null, next: req.query.next || '/' });
});

router.post('/signup', (req, res) => {
  const { username, password, confirm } = req.body;
  const nextUrl = req.body.next || '/';

  if (!username || !password || username.trim().length < 3 || password.length < 6) {
    return res.render('signup', {
      error: 'Username must be at least 3 characters and password at least 6 characters.',
      next: nextUrl,
    });
  }
  if (password !== confirm) {
    return res.render('signup', { error: 'Passwords do not match.', next: nextUrl });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    return res.render('signup', { error: 'That username is already taken.', next: nextUrl });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username.trim(), hash);

  req.session.userId = result.lastInsertRowid;
  res.redirect(nextUrl);
});

// ---------- Login / logout ----------

router.get('/login', (req, res) => {
  res.render('login', { error: null, next: req.query.next || '/' });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const nextUrl = req.body.next || '/';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'Incorrect username or password.', next: nextUrl });
  }

  req.session.userId = user.id;
  res.redirect(nextUrl);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Redeem VIP code ----------

router.get('/redeem', requireUser, (req, res) => {
  res.render('redeem', { error: null, success: null });
});

router.post('/redeem', requireUser, (req, res) => {
  const rawCode = (req.body.code || '').trim().toUpperCase();
  if (!rawCode) {
    return res.render('redeem', { error: 'Enter a code.', success: null });
  }

  const code = db.prepare('SELECT * FROM codes WHERE code = ?').get(rawCode);
  if (!code) {
    return res.render('redeem', { error: 'That code was not recognized.', success: null });
  }
  if (code.status !== 'unused') {
    return res.render('redeem', {
      error: 'That code has already been used or has expired.',
      success: null,
    });
  }

  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  db.prepare(
    `UPDATE codes SET status = 'active', redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE id = ?`
  ).run(req.currentUser.id, now.toISOString(), expires.toISOString(), code.id);

  db.prepare('UPDATE users SET vip_expires_at = ? WHERE id = ?').run(
    expires.toISOString(),
    req.currentUser.id
  );

  res.render('redeem', { error: null, success: expires });
});

// ---------- Comic detail (chapter list) ----------

router.get('/comic/:slug', (req, res) => {
  const comic = db
    .prepare(`SELECT comics.*, ${COMIC_EXTRAS_SQL} FROM comics WHERE slug = ?`)
    .get(req.params.slug);
  if (!comic) return res.status(404).render('404');

  // Simple view counter — increments once per page load
  db.prepare('UPDATE comics SET views = views + 1 WHERE id = ?').run(comic.id);
  comic.views += 1;

  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const chapters = db
    .prepare(`SELECT * FROM chapters WHERE comic_id = ? AND ${VISIBLE_CHAPTER_SQL} ORDER BY chapter_number ${order}`)
    .all(comic.id);

  const firstChapter = db
    .prepare(`SELECT * FROM chapters WHERE comic_id = ? AND ${VISIBLE_CHAPTER_SQL} ORDER BY chapter_number ASC LIMIT 1`)
    .get(comic.id);
  const latestChapter = db
    .prepare(`SELECT * FROM chapters WHERE comic_id = ? AND ${VISIBLE_CHAPTER_SQL} ORDER BY chapter_number DESC LIMIT 1`)
    .get(comic.id);

  let isBookmarked = false;
  if (req.currentUser) {
    isBookmarked = !!db
      .prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND comic_id = ?')
      .get(req.currentUser.id, comic.id);
  }

  res.render('comic', {
    comic,
    chapters,
    firstChapter,
    latestChapter,
    isBookmarked,
    order: req.query.order === 'asc' ? 'asc' : 'desc',
    pageTitle: comic.title,
    ogDescription: comic.description || `Read ${comic.title} — ${comic.chapter_count} chapters, ★${comic.rating.toFixed(1)}`,
    ogImage: comic.cover_image
      ? (comic.cover_image.startsWith('http') ? comic.cover_image : res.locals.siteUrl + comic.cover_image)
      : res.locals.ogImage,
  });
});

// ---------- Bookmark toggle ----------

router.post('/comic/:slug/bookmark', requireUser, (req, res) => {
  const comic = db.prepare('SELECT id FROM comics WHERE slug = ?').get(req.params.slug);
  if (!comic) return res.status(404).end();

  const existing = db
    .prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND comic_id = ?')
    .get(req.currentUser.id, comic.id);

  if (existing) {
    db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND comic_id = ?').run(
      req.currentUser.id,
      comic.id
    );
  } else {
    db.prepare('INSERT INTO bookmarks (user_id, comic_id) VALUES (?, ?)').run(
      req.currentUser.id,
      comic.id
    );
  }

  res.redirect(`/comic/${req.params.slug}`);
});

// ---------- Chapter reader ----------

router.get('/comic/:slug/chapter/:chapterId', (req, res, next) => {
  const comic = db.prepare('SELECT * FROM comics WHERE slug = ?').get(req.params.slug);
  if (!comic) return res.status(404).render('404');

  const chapter = db
    .prepare(`SELECT * FROM chapters WHERE id = ? AND comic_id = ? AND (${VISIBLE_CHAPTER_SQL} OR ?)`)
    .get(req.params.chapterId, comic.id, req.session.isAdmin ? 1 : 0);
  if (!chapter) return res.status(404).render('404');

  const firstChapterId = db
    .prepare(`SELECT id FROM chapters WHERE comic_id = ? AND ${VISIBLE_CHAPTER_SQL} ORDER BY chapter_number ASC LIMIT 1`)
    .get(comic.id)?.id;
  const isFirstChapter = chapter.id === firstChapterId;

  if (chapter.is_premium) {
    return requireVip(req, res, () => renderChapter());
  }
  // Chapter 1 is free to read without an account — anything past that
  // requires signing up, same as the VIP gate does for premium chapters.
  if (!isFirstChapter && !req.currentUser) {
    return requireUser(req, res, () => renderChapter());
  }
  return renderChapter();

  function renderChapter() {
    const pages = db
      .prepare('SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_order ASC')
      .all(chapter.id);
    const allChapters = db
      .prepare('SELECT * FROM chapters WHERE comic_id = ? ORDER BY chapter_number ASC')
      .all(comic.id);
    const idx = allChapters.findIndex((c) => c.id === chapter.id);
    const comments = db
      .prepare(
        `SELECT comments.*, users.username FROM comments
         JOIN users ON users.id = comments.user_id
         WHERE comments.chapter_id = ? ORDER BY comments.created_at DESC`
      )
      .all(chapter.id);
    let reportedCommentIds = [];
    if (req.currentUser) {
      reportedCommentIds = db
        .prepare(
          `SELECT comment_id FROM comment_reports WHERE user_id = ? AND comment_id IN
           (SELECT id FROM comments WHERE chapter_id = ?)`
        )
        .all(req.currentUser.id, chapter.id)
        .map((r) => r.comment_id);
    }
    res.render('chapter', {
      comic,
      chapter,
      pages,
      comments,
      reportedCommentIds,
      prevChapter: idx > 0 ? allChapters[idx - 1] : null,
      nextChapter: idx < allChapters.length - 1 ? allChapters[idx + 1] : null,
      pageTitle: `${comic.title} — Chapter ${chapter.chapter_number}`,
      ogDescription: `${chapter.title} — read it now on ${res.locals.siteName}`,
      ogImage: comic.cover_image
        ? (comic.cover_image.startsWith('http') ? comic.cover_image : res.locals.siteUrl + comic.cover_image)
        : res.locals.ogImage,
    });
  }
});

// ---------- Chapter download (ZIP of pages, built on the fly — requires an account) ----------

router.get('/comic/:slug/chapter/:chapterId/download', requireUser, (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE slug = ?').get(req.params.slug);
  if (!comic) return res.status(404).render('404');

  const chapter = db
    .prepare(`SELECT * FROM chapters WHERE id = ? AND comic_id = ? AND ${VISIBLE_CHAPTER_SQL}`)
    .get(req.params.chapterId, comic.id);
  if (!chapter) return res.status(404).render('404');
  if (chapter.is_premium && !(req.currentUser.vip_expires_at && new Date(req.currentUser.vip_expires_at) > new Date())) {
    return res.render('vip-expired', { everHadVip: !!req.currentUser.vip_expires_at });
  }

  const pages = db
    .prepare('SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_order ASC')
    .all(chapter.id);

  const zip = new AdmZip();
  pages.forEach((page, i) => {
    const filePath = path.join(pagesDir, page.image_path);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(page.image_path);
      zip.addLocalFile(filePath, '', String(i + 1).padStart(3, '0') + ext);
    }
  });

  const safeName = `${comic.slug}-chapter-${chapter.chapter_number}.zip`;
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${safeName}"`);
  res.send(zip.toBuffer());
});

// ---------- Comments ----------

router.post('/comic/:slug/chapter/:chapterId/comments', requireUser, (req, res) => {
  const body = (req.body.body || '').trim();
  if (body) {
    db.prepare('INSERT INTO comments (chapter_id, user_id, body) VALUES (?, ?, ?)').run(
      req.params.chapterId,
      req.currentUser.id,
      body.slice(0, 2000)
    );
  }
  res.redirect(`/comic/${req.params.slug}/chapter/${req.params.chapterId}`);
});

router.post('/comic/:slug/chapter/:chapterId/comments/:commentId/report', requireUser, (req, res) => {
  try {
    db.prepare('INSERT INTO comment_reports (comment_id, user_id) VALUES (?, ?)').run(
      req.params.commentId,
      req.currentUser.id
    );
  } catch (e) {
    // UNIQUE(comment_id, user_id) — already reported, ignore
  }
  res.redirect(`/comic/${req.params.slug}/chapter/${req.params.chapterId}`);
});

// ---------- Web Push subscription (for new-chapter notifications) ----------

router.post('/push/subscribe', requireUser, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).end();
  try {
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`
    ).run(req.currentUser.id, endpoint, keys.p256dh, keys.auth);
  } catch (e) {
    return res.status(500).end();
  }
  res.status(201).end();
});

module.exports = router;
