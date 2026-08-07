require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');

require('./db/init'); // creates tables on first run

const { loadCurrentUser } = require('./middleware/auth');
const { formatRelativeTime, formatCompactNumber } = require('./utils');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

// Site-wide values every view can use
app.use((req, res, next) => {
  res.locals.siteName = process.env.SITE_NAME || 'UPCOMIC';
  res.locals.siteMotto = process.env.SITE_MOTTO ||'Erotic Stories. Every Chapter.';
  res.locals.siteUrl = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.locals.telegramChannel = process.env.TELEGRAM_CHANNEL || '@upcomic';
  res.locals.telegramAdmin = process.env.TELEGRAM_ADMIN || '@upcomicadmin';
  res.locals.vipPrice = process.env.VIP_PRICE || '5,000';
  res.locals.vipPricePeriod = process.env.VIP_PRICE_PERIOD || 'month';
  res.locals.formatRelativeTime = formatRelativeTime;
  res.locals.formatCompactNumber = formatCompactNumber;
  res.locals.vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
  // Per-page Open Graph / Twitter Card overrides — a view can set
  // ogTitle/ogDescription/ogImage before rendering; these are the fallbacks.
  res.locals.ogTitle = res.locals.siteName;
  res.locals.ogDescription = res.locals.siteMotto;
  res.locals.ogImage = `${res.locals.siteUrl}/icons/icon-512.png`;
  next();
});

app.use(loadCurrentUser);

app.use('/admin', adminRoutes);
app.use('/', publicRoutes);

// 404 fallback
app.use((req, res) => {
  res.status(404).render('404');
});

// Basic error handler (e.g. multer file-type/size errors)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(
    `<pre style="font-family: monospace; padding: 2rem; background:#0a0a12; color:#f3f1ff;">Something went wrong: ${err.message}</pre>`
  );
});

// Every minute: fire notifications for any scheduled chapter whose publish
// time has arrived, then mark it as notified so it's not sent twice.
const db = require('./db');
const { notifyNewChapter } = require('./lib/notify');

setInterval(async () => {
  try {
    const due = db
      .prepare("SELECT * FROM chapters WHERE notified = 0 AND publish_at IS NOT NULL AND datetime(publish_at) <= datetime('now')")
      .all();
    for (const chapter of due) {
      const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(chapter.comic_id);
      if (comic) await notifyNewChapter(comic, chapter);
      db.prepare('UPDATE chapters SET notified = 1 WHERE id = ?').run(chapter.id);
    }
  } catch (e) {
    console.log('Scheduled publish check failed:', e.message);
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`UPCOMIC running at http://localhost:${PORT}`);
});
