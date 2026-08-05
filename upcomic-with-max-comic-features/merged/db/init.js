const fs = require('fs');
const path = require('path');
const db = require('./index');

// Make sure the folder that holds the sqlite file exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    vip_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    cover_image TEXT,
    rating REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Ongoing', -- Ongoing | Completed
    views INTEGER NOT NULL DEFAULT 0,
    is_featured INTEGER NOT NULL DEFAULT 0,
    is_trending INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comic_categories (
    comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (comic_id, category_id)
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    chapter_number INTEGER NOT NULL,
    is_premium INTEGER NOT NULL DEFAULT 0,
    publish_at TEXT,
    notified INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comment_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(comment_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    image_path TEXT NOT NULL,
    page_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'unused', -- unused | active | expired
    redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    redeemed_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, comic_id)
  );

  CREATE INDEX IF NOT EXISTS idx_chapters_comic ON chapters(comic_id);
  CREATE INDEX IF NOT EXISTS idx_pages_chapter ON pages(chapter_id);
  CREATE INDEX IF NOT EXISTS idx_codes_status ON codes(status);
  CREATE INDEX IF NOT EXISTS idx_comic_categories_comic ON comic_categories(comic_id);
  CREATE INDEX IF NOT EXISTS idx_comic_categories_category ON comic_categories(category_id);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
  CREATE INDEX IF NOT EXISTS idx_comments_chapter ON comments(chapter_id);
  CREATE INDEX IF NOT EXISTS idx_comment_reports_comment ON comment_reports(comment_id);
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_chapters_publish_at ON chapters(publish_at);
`);

// Seed a starter category/genre list on first run only (admin can add/remove anytime after)
const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
if (categoryCount === 0) {
  const starterCategories = [
    'Fantasy', 'Romance', 'Yaoi', 'Yuri', 'Futanari', 'MILF',
    'Schoolgirl', 'Comedy', 'Drama', 'Office', 'Supernatural', 'Harem', '3D',
    'Mature', 'Slice of Life',
  ];
  const insertCategory = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)');
  const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  starterCategories.forEach((name) => insertCategory.run(name, slugify(name)));
  console.log(`Seeded ${starterCategories.length} starter categories.`);
}

console.log('Database ready at', path.join(dataDir, 'upcomic.db'));
