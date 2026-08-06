const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { uploadCover, uploadPages, uploadBulkZips, uploadChapterMedia, pagesDir, coversDir } = require('../upload');
const { generateCode, slugify } = require('../utils');
const { extractZipImages, chapterNumberFromFilename } = require('../lib/zip-utils');
const { notifyNewChapter, sendTestTelegramMessage } = require('../lib/notify');
const { getSetting, setSetting, getBoolSetting } = require('../lib/settings');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional */ }

// Covers get converted to .jpg server-side — some platforms (Telegram, etc.)
// fail to preview .webp, so we normalize on upload rather than at send-time.
async function convertCoverToJpg(file, coversDir) {
  if (!sharp || !file) return file.filename;
  const jpgName = file.filename.replace(/\.[^.]+$/, '.jpg');
  if (jpgName !== file.filename) {
    await sharp(file.path).jpeg({ quality: 88 }).toFile(path.join(coversDir, jpgName));
    fs.unlink(file.path, () => {});
  }
  return jpgName;
}

// A publish_at in the future means the chapter is scheduled, not live yet.
function isFuture(publishAt) {
  return !!publishAt && new Date(publishAt) > new Date();
}

const router = express.Router();

// ---------- Admin login ----------

router.get('/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Incorrect username or password.' });
});

router.post('/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

// Everything below requires an authenticated admin session
router.use(requireAdmin);

// Helper: get the comma-joined category names for a comic (used to prefill the edit form)
function getCategoryNamesForComic(comicId) {
  return db
    .prepare(
      `SELECT categories.name FROM comic_categories
       JOIN categories ON categories.id = comic_categories.category_id
       WHERE comic_categories.comic_id = ? ORDER BY categories.name ASC`
    )
    .all(comicId)
    .map((r) => r.name)
    .join(', ');
}

// Takes a free-text "Fantasy, Yaoi, Office" string, finds or creates each
// category, links them to the comic, and drops any categories that were
// removed. This is what lets the admin type categories directly instead of
// picking from a fixed checklist.
function setCategoriesFromText(comicId, rawText) {
  const names = (rawText || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const categoryIds = names.map((name) => {
    let existing = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) return existing.id;
    let slug = slugify(name);
    // Guard against a slug collision from a differently-cased/punctuated name
    let suffix = 1;
    let finalSlug = slug;
    while (db.prepare('SELECT id FROM categories WHERE slug = ?').get(finalSlug)) {
      suffix += 1;
      finalSlug = `${slug}-${suffix}`;
    }
    const result = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, finalSlug);
    return result.lastInsertRowid;
  });

  db.prepare('DELETE FROM comic_categories WHERE comic_id = ?').run(comicId);
  const insert = db.prepare('INSERT INTO comic_categories (comic_id, category_id) VALUES (?, ?)');
  categoryIds.forEach((catId) => insert.run(comicId, catId));
}

// ---------- Dashboard ----------

router.get('/', (req, res) => {
  db.prepare(
    "UPDATE codes SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')"
  ).run();
  const comicCount = db.prepare('SELECT COUNT(*) AS n FROM comics').get().n;
  const chapterCount = db.prepare('SELECT COUNT(*) AS n FROM chapters').get().n;
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const activeVipCount = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE vip_expires_at > datetime('now')")
    .get().n;
  const unusedCodes = db.prepare("SELECT COUNT(*) AS n FROM codes WHERE status = 'unused'").get().n;
  const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;

  res.render('admin/dashboard', {
    comicCount,
    chapterCount,
    userCount,
    activeVipCount,
    unusedCodes,
    categoryCount,
  });
});

// ---------- Analytics ----------

router.get('/analytics', (req, res) => {
  const totalComics = db.prepare('SELECT COUNT(*) AS n FROM comics').get().n;
  const totalChapters = db.prepare('SELECT COUNT(*) AS n FROM chapters').get().n;
  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const totalViews = db.prepare('SELECT COALESCE(SUM(views), 0) AS v FROM comics').get().v;
  const totalComments = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
  const reportedComments = db
    .prepare('SELECT COUNT(DISTINCT comment_id) AS n FROM comment_reports')
    .get().n;

  const activeVip = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE vip_expires_at > datetime('now')")
    .get().n;
  const codesGenerated = db.prepare('SELECT COUNT(*) AS n FROM codes').get().n;
  const codesRedeemed = db
    .prepare("SELECT COUNT(*) AS n FROM codes WHERE status IN ('active', 'expired')")
    .get().n;

  const topComics = db
    .prepare('SELECT title, slug, views, rating FROM comics ORDER BY views DESC LIMIT 5')
    .all();

  const expiringSoon = db
    .prepare(
      `SELECT username, vip_expires_at FROM users
       WHERE vip_expires_at IS NOT NULL
         AND vip_expires_at > datetime('now')
         AND vip_expires_at <= datetime('now', '+3 days')
       ORDER BY vip_expires_at ASC`
    )
    .all();

  const newSignupsThisWeek = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now', '-7 days')")
    .get().n;

  res.render('admin/analytics', {
    totalComics,
    totalChapters,
    totalUsers,
    totalViews,
    totalComments,
    reportedComments,
    activeVip,
    codesGenerated,
    codesRedeemed,
    topComics,
    expiringSoon,
    newSignupsThisWeek,
  });
});

// ---------- Settings ----------

router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    telegramBotToken: getSetting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN'),
    telegramChannelId: getSetting('telegram_channel_id', 'TELEGRAM_CHANNEL_ID', process.env.TELEGRAM_CHANNEL || ''),
    autopostEnabled: getBoolSetting('telegram_autopost_enabled', null, true),
    saved: req.query.saved || null,
    testResult: null,
  });
});

router.post('/settings', (req, res) => {
  const { telegram_bot_token, telegram_channel_id, telegram_autopost_enabled } = req.body;
  setSetting('telegram_bot_token', (telegram_bot_token || '').trim());
  setSetting('telegram_channel_id', (telegram_channel_id || '').trim());
  setSetting('telegram_autopost_enabled', telegram_autopost_enabled ? '1' : '0');
  res.redirect('/admin/settings?saved=1');
});

router.post('/settings/test-telegram', async (req, res) => {
  const testResult = await sendTestTelegramMessage();
  res.render('admin/settings', {
    telegramBotToken: getSetting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN'),
    telegramChannelId: getSetting('telegram_channel_id', 'TELEGRAM_CHANNEL_ID', process.env.TELEGRAM_CHANNEL || ''),
    autopostEnabled: getBoolSetting('telegram_autopost_enabled', null, true),
    saved: null,
    testResult,
  });
});

// ---------- Categories ----------

router.get('/categories', (req, res) => {
  const categories = db
    .prepare(
      `SELECT categories.*, COUNT(comic_categories.comic_id) AS comic_count
       FROM categories
       LEFT JOIN comic_categories ON comic_categories.category_id = categories.id
       GROUP BY categories.id
       ORDER BY categories.name ASC`
    )
    .all();
  res.render('admin/categories', { categories, error: null });
});

router.post('/categories/new', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/categories');

  let slug = slugify(name);
  const existing = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
  if (existing) {
    // Already exists — nothing to do, just go back
    return res.redirect('/admin/categories');
  }
  db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id); // cascades comic_categories
  res.redirect('/admin/categories');
});

// ---------- Comics ----------

router.get('/comics', (req, res) => {
  const comics = db.prepare('SELECT * FROM comics ORDER BY created_at DESC').all();
  res.render('admin/comics', { comics });
});

router.get('/comics/new', (req, res) => {
  const existingCategoryNames = db.prepare('SELECT name FROM categories ORDER BY name ASC').all().map((c) => c.name);
  res.render('admin/comic-form', { comic: null, existingCategoryNames, categoryText: '', error: null });
});

router.post('/comics/new', uploadCover.single('cover_image'), async (req, res) => {
  const { title, description, rating, status, is_featured, is_trending, categories: categoryText } = req.body;
  const existingCategoryNames = db.prepare('SELECT name FROM categories ORDER BY name ASC').all().map((c) => c.name);

  if (!title || !title.trim()) {
    return res.render('admin/comic-form', {
      comic: null,
      existingCategoryNames,
      categoryText,
      error: 'Title is required.',
    });
  }

  let slug = slugify(title);
  const existing = db.prepare('SELECT id FROM comics WHERE slug = ?').get(slug);
  if (existing) slug = `${slug}-${Date.now().toString().slice(-5)}`;

  const coverFilename = req.file ? await convertCoverToJpg(req.file, coversDir) : null;
  const coverPath = coverFilename ? `/uploads/covers/${coverFilename}` : null;
  const ratingValue = Math.max(0, Math.min(5, parseFloat(rating) || 0));
  const statusValue = status === 'Completed' ? 'Completed' : 'Ongoing';

  const result = db
    .prepare(
      `INSERT INTO comics (title, slug, description, cover_image, rating, status, is_featured, is_trending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title.trim(),
      slug,
      (description || '').trim(),
      coverPath,
      ratingValue,
      statusValue,
      is_featured ? 1 : 0,
      is_trending ? 1 : 0
    );

  setCategoriesFromText(result.lastInsertRowid, categoryText);

  res.redirect('/admin/comics');
});

router.get('/comics/:id/edit', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.id);
  if (!comic) return res.redirect('/admin/comics');
  const existingCategoryNames = db.prepare('SELECT name FROM categories ORDER BY name ASC').all().map((c) => c.name);
  const categoryText = getCategoryNamesForComic(comic.id);
  res.render('admin/comic-form', { comic, existingCategoryNames, categoryText, error: null });
});

router.post('/comics/:id/edit', uploadCover.single('cover_image'), async (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.id);
  if (!comic) return res.redirect('/admin/comics');

  const { title, description, rating, status, is_featured, is_trending, categories: categoryText } = req.body;
  const existingCategoryNames = db.prepare('SELECT name FROM categories ORDER BY name ASC').all().map((c) => c.name);

  if (!title || !title.trim()) {
    return res.render('admin/comic-form', {
      comic,
      existingCategoryNames,
      categoryText,
      error: 'Title is required.',
    });
  }

  let coverPath = comic.cover_image;
  if (req.file) {
    const coverFilename = await convertCoverToJpg(req.file, coversDir);
    coverPath = `/uploads/covers/${coverFilename}`;
    if (comic.cover_image) {
      const oldPath = path.join(__dirname, '..', 'public', comic.cover_image);
      fs.unlink(oldPath, () => {});
    }
  }

  const ratingValue = Math.max(0, Math.min(5, parseFloat(rating) || 0));
  const statusValue = status === 'Completed' ? 'Completed' : 'Ongoing';

  db.prepare(
    `UPDATE comics SET title = ?, description = ?, cover_image = ?, rating = ?, status = ?,
     is_featured = ?, is_trending = ? WHERE id = ?`
  ).run(
    title.trim(),
    (description || '').trim(),
    coverPath,
    ratingValue,
    statusValue,
    is_featured ? 1 : 0,
    is_trending ? 1 : 0,
    comic.id
  );

  setCategoriesFromText(comic.id, categoryText);

  res.redirect('/admin/comics');
});

router.post('/comics/:id/delete', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.id);
  if (comic) {
    // Clean up page images and cover from disk before removing the DB rows
    const chapters = db.prepare('SELECT id FROM chapters WHERE comic_id = ?').all(comic.id);
    chapters.forEach((ch) => {
      const pages = db.prepare('SELECT image_path FROM pages WHERE chapter_id = ?').all(ch.id);
      pages.forEach((p) =>
        fs.unlink(path.join(__dirname, '..', 'private-uploads', 'pages', p.image_path), () => {})
      );
    });
    if (comic.cover_image) {
      fs.unlink(path.join(__dirname, '..', 'public', comic.cover_image), () => {});
    }
    db.prepare('DELETE FROM comics WHERE id = ?').run(comic.id); // cascades chapters + pages + categories
  }
  res.redirect('/admin/comics');
});

// ---------- Chapters ----------

router.get('/comics/:comicId/chapters/new', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  if (!comic) return res.redirect('/admin/comics');
  res.render('admin/chapter-form', { comic, chapter: null, error: null });
});

router.post('/comics/:comicId/chapters/new', uploadChapterMedia, async (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  if (!comic) return res.redirect('/admin/comics');

  const { title, chapter_number, is_premium, publish_at } = req.body;
  if (!title || !title.trim() || !chapter_number) {
    return res.render('admin/chapter-form', {
      comic,
      chapter: null,
      error: 'Chapter title and number are required.',
    });
  }

  const scheduled = isFuture(publish_at);
  const result = db
    .prepare(
      `INSERT INTO chapters (comic_id, title, chapter_number, is_premium, publish_at, notified)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      comic.id,
      title.trim(),
      parseInt(chapter_number, 10),
      is_premium ? 1 : 0,
      publish_at ? new Date(publish_at).toISOString() : null,
      scheduled ? 0 : 1 // if not scheduled, we notify right below, so mark as already-notified
    );

  const chapterId = result.lastInsertRowid;
  const insertPage = db.prepare('INSERT INTO pages (chapter_id, image_path, page_order) VALUES (?, ?, ?)');

  // Manual multi-image select
  const manualFiles = (req.files && req.files.pages) || [];
  manualFiles.forEach((file, i) => insertPage.run(chapterId, file.filename, i + 1));

  // OR a ZIP of images — extracted, natural-sorted, then the zip itself removed
  const zipFile = req.files && req.files.zip && req.files.zip[0];
  if (zipFile) {
    try {
      const filenames = extractZipImages(zipFile.path, pagesDir);
      filenames.forEach((filename, i) => insertPage.run(chapterId, filename, manualFiles.length + i + 1));
    } finally {
      fs.unlink(zipFile.path, () => {});
    }
  }

  if (!scheduled) {
    const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
    notifyNewChapter(comic, chapter).catch((e) => console.log('Notify failed:', e.message));
  }

  res.redirect(`/admin/comics/${comic.id}/chapters`);
});

// ---------- Chapter edit-in-place (rename/renumber/toggle VIP/reschedule — pages untouched) ----------

router.get('/comics/:comicId/chapters/:chapterId/edit', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  const chapter = db
    .prepare('SELECT * FROM chapters WHERE id = ? AND comic_id = ?')
    .get(req.params.chapterId, req.params.comicId);
  if (!comic || !chapter) return res.redirect('/admin/comics');
  res.render('admin/chapter-form', { comic, chapter, error: null });
});

router.post('/comics/:comicId/chapters/:chapterId/edit', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  const chapter = db
    .prepare('SELECT * FROM chapters WHERE id = ? AND comic_id = ?')
    .get(req.params.chapterId, req.params.comicId);
  if (!comic || !chapter) return res.redirect('/admin/comics');

  const { title, chapter_number, is_premium, publish_at } = req.body;
  if (!title || !title.trim() || !chapter_number) {
    return res.render('admin/chapter-form', { comic, chapter, error: 'Chapter title and number are required.' });
  }

  const scheduled = isFuture(publish_at);
  db.prepare(
    `UPDATE chapters SET title = ?, chapter_number = ?, is_premium = ?, publish_at = ?, notified = ?
     WHERE id = ?`
  ).run(
    title.trim(),
    parseInt(chapter_number, 10),
    is_premium ? 1 : 0,
    publish_at ? new Date(publish_at).toISOString() : null,
    scheduled ? 0 : chapter.notified, // only reset notified if newly (re)scheduled into the future
    chapter.id
  );

  res.redirect(`/admin/comics/${comic.id}/chapters`);
});

// ---------- Bulk ZIP upload (one ZIP per chapter, several chapters at once) ----------

router.get('/comics/:comicId/chapters/bulk-zip', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  if (!comic) return res.redirect('/admin/comics');
  res.render('admin/bulk-zip', { comic, error: null });
});

router.post('/comics/:comicId/chapters/bulk-zip', uploadBulkZips.array('zips', 50), async (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  if (!comic) return res.redirect('/admin/comics');

  const { is_premium, publish_at } = req.body;
  const files = req.files || [];
  if (!files.length) {
    return res.render('admin/bulk-zip', { comic, error: 'Select at least one ZIP file.' });
  }

  const scheduled = isFuture(publish_at);
  const insertChapter = db.prepare(
    `INSERT INTO chapters (comic_id, title, chapter_number, is_premium, publish_at, notified)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertPage = db.prepare('INSERT INTO pages (chapter_id, image_path, page_order) VALUES (?, ?, ?)');
  const newChapters = [];

  for (const file of files) {
    const chapterNumber = chapterNumberFromFilename(file.originalname);
    try {
      const result = insertChapter.run(
        comic.id,
        chapterNumber ? `Chapter ${chapterNumber}` : file.originalname.replace(/\.zip$/i, ''),
        chapterNumber || 0,
        is_premium ? 1 : 0,
        publish_at ? new Date(publish_at).toISOString() : null,
        scheduled ? 0 : 1
      );
      const chapterId = result.lastInsertRowid;
      const filenames = extractZipImages(file.path, pagesDir);
      filenames.forEach((filename, i) => insertPage.run(chapterId, filename, i + 1));
      newChapters.push(chapterId);
    } finally {
      fs.unlink(file.path, () => {});
    }
  }

  if (!scheduled) {
    for (const chapterId of newChapters) {
      const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
      notifyNewChapter(comic, chapter).catch((e) => console.log('Notify failed:', e.message));
    }
  }

  res.redirect(`/admin/comics/${comic.id}/chapters`);
});

router.get('/comics/:comicId/chapters', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  if (!comic) return res.redirect('/admin/comics');
  const totalCount = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE comic_id = ?').get(comic.id).n;
  // Only the 6 most recently uploaded chapters, per standing preference — not the full list
  const chapters = db
    .prepare('SELECT * FROM chapters WHERE comic_id = ? ORDER BY created_at DESC LIMIT 6')
    .all(comic.id)
    .sort((a, b) => a.chapter_number - b.chapter_number);
  res.render('admin/chapters', { comic, chapters, totalCount });
});

router.get('/comics/:comicId/chapters/:chapterId/add-pages', (req, res) => {
  const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.comicId);
  const chapter = db
    .prepare('SELECT * FROM chapters WHERE id = ? AND comic_id = ?')
    .get(req.params.chapterId, req.params.comicId);
  if (!comic || !chapter) return res.redirect('/admin/comics');
  const pages = db
    .prepare('SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_order ASC')
    .all(chapter.id);
  res.render('admin/add-pages', { comic, chapter, pages });
});

router.post('/comics/:comicId/chapters/:chapterId/delete', (req, res) => {
  const chapter = db
    .prepare('SELECT * FROM chapters WHERE id = ? AND comic_id = ?')
    .get(req.params.chapterId, req.params.comicId);
  if (chapter) {
    const pages = db.prepare('SELECT image_path FROM pages WHERE chapter_id = ?').all(chapter.id);
    pages.forEach((p) =>
      fs.unlink(path.join(__dirname, '..', 'private-uploads', 'pages', p.image_path), () => {})
    );
    db.prepare('DELETE FROM chapters WHERE id = ?').run(chapter.id); // cascades pages
  }
  res.redirect(`/admin/comics/${req.params.comicId}/chapters`);
});

router.post(
  '/comics/:comicId/chapters/:chapterId/add-pages',
  uploadPages.array('pages', 200),
  (req, res) => {
    const chapter = db
      .prepare('SELECT * FROM chapters WHERE id = ? AND comic_id = ?')
      .get(req.params.chapterId, req.params.comicId);
    if (!chapter) return res.redirect(`/admin/comics/${req.params.comicId}/chapters`);

    const maxOrder =
      db.prepare('SELECT MAX(page_order) AS m FROM pages WHERE chapter_id = ?').get(chapter.id)
        .m || 0;
    const insertPage = db.prepare(
      'INSERT INTO pages (chapter_id, image_path, page_order) VALUES (?, ?, ?)'
    );
    (req.files || []).forEach((file, i) => {
      insertPage.run(chapter.id, file.filename, maxOrder + i + 1);
    });

    res.redirect(`/admin/comics/${req.params.comicId}/chapters`);
  }
);

// ---------- VIP codes ----------

router.get('/codes', (req, res) => {
  db.prepare(
    "UPDATE codes SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')"
  ).run();
  const codes = db
    .prepare(
      `SELECT codes.*, users.username AS redeemed_by_username
       FROM codes LEFT JOIN users ON codes.redeemed_by = users.id
       ORDER BY codes.created_at DESC`
    )
    .all();
  res.render('admin/codes', { codes, justGenerated: req.query.new || null });
});

router.post('/codes/generate', (req, res) => {
  let code = generateCode();
  // Extremely unlikely to collide, but guard anyway
  while (db.prepare('SELECT id FROM codes WHERE code = ?').get(code)) {
    code = generateCode();
  }
  db.prepare('INSERT INTO codes (code) VALUES (?)').run(code);
  res.redirect(`/admin/codes?new=${encodeURIComponent(code)}`);
});

// ---------- Reported comments ----------

router.get('/comments/reported', (req, res) => {
  const reported = db
    .prepare(
      `SELECT comments.*, users.username, COUNT(comment_reports.id) AS report_count,
              chapters.chapter_number, chapters.title AS chapter_title,
              comics.title AS comic_title, comics.slug AS comic_slug, comics.id AS comic_id
       FROM comment_reports
       JOIN comments ON comments.id = comment_reports.comment_id
       JOIN users ON users.id = comments.user_id
       JOIN chapters ON chapters.id = comments.chapter_id
       JOIN comics ON comics.id = chapters.comic_id
       GROUP BY comments.id
       ORDER BY report_count DESC, comments.created_at DESC`
    )
    .all();
  res.render('admin/reported-comments', { reported });
});

router.post('/comments/:id/dismiss', (req, res) => {
  db.prepare('DELETE FROM comment_reports WHERE comment_id = ?').run(req.params.id);
  res.redirect('/admin/comments/reported');
});

router.post('/comments/:id/delete', (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id); // cascades comment_reports
  res.redirect('/admin/comments/reported');
});

// ---------- Users ----------

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.render('admin/users', { users });
});

module.exports = router;
