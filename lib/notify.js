const db = require('../db');
const { getSetting, getBoolSetting } = require('./settings');

let webpush = null;
let nodemailer = null;
try { webpush = require('web-push'); } catch (e) { /* optional */ }
try { nodemailer = require('nodemailer'); } catch (e) { /* optional */ }

if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_CONTACT_EMAIL || 'admin@example.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function siteUrl() {
  return (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

// ---------- Telegram channel post ----------
// Credentials + the on/off toggle are admin-editable (Settings page in the
// admin site) and stored in the DB; .env values are only the fallback for a
// fresh deploy that hasn't configured them there yet.
async function postToTelegram(comic, chapter) {
  const autopostEnabled = getBoolSetting('telegram_autopost_enabled', null, true);
  if (!autopostEnabled) return;

  const token = getSetting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN');
  const chatId = getSetting('telegram_channel_id', 'TELEGRAM_CHANNEL_ID', process.env.TELEGRAM_CHANNEL || '');
  if (!token || !chatId) return;

  const link = `${siteUrl()}/comic/${comic.slug}/chapter/${chapter.id}`;
  const caption =
    `📖 *${comic.title}*\n` +
    `New chapter: Chapter ${chapter.chapter_number} — ${chapter.title}` +
    (chapter.is_premium ? '\n⭐ VIP chapter' : '') +
    `\n\n${link}`;

  const replyMarkup = {
    inline_keyboard: [[{ text: 'Read now', url: link }]],
  };

  try {
    const coverUrl = comic.cover_image
      ? (comic.cover_image.startsWith('http') ? comic.cover_image : siteUrl() + comic.cover_image)
      : null;

    const endpoint = coverUrl ? 'sendPhoto' : 'sendMessage';
    const body = coverUrl
      ? { chat_id: chatId, photo: coverUrl, caption, parse_mode: 'Markdown', reply_markup: replyMarkup }
      : { chat_id: chatId, text: caption, parse_mode: 'Markdown', reply_markup: replyMarkup };

    await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log('Telegram notify failed:', e.message);
  }
}

// Sends a plain test message so the admin can verify bot token + channel ID
// are correct without needing to publish a real chapter. Returns
// { ok, error } instead of throwing, so the Settings page can show a
// friendly result either way.
async function sendTestTelegramMessage() {
  const token = getSetting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN');
  const chatId = getSetting('telegram_channel_id', 'TELEGRAM_CHANNEL_ID', process.env.TELEGRAM_CHANNEL || '');
  if (!token || !chatId) {
    return { ok: false, error: 'Bot token and channel ID are both required.' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ Test message from your admin panel — Telegram autopost is set up correctly.',
      }),
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'Telegram rejected the request.' };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- Web Push, to everyone who bookmarked the comic ----------
async function sendWebPush(comic, chapter) {
  if (!webpush || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  const subs = db
    .prepare(
      `SELECT push_subscriptions.* FROM push_subscriptions
       JOIN bookmarks ON bookmarks.user_id = push_subscriptions.user_id
       WHERE bookmarks.comic_id = ?`
    )
    .all(comic.id);

  const payload = JSON.stringify({
    title: comic.title,
    body: `Chapter ${chapter.chapter_number}: ${chapter.title} is out now`,
    url: `/comic/${comic.slug}/chapter/${chapter.id}`,
  });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (e) {
      // Dead/expired subscription — clean it up
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }
}

// ---------- Email, to bookmarked users who have an email on file ----------
async function sendEmail(comic, chapter) {
  if (!nodemailer || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const users = db
    .prepare(
      `SELECT users.* FROM users
       JOIN bookmarks ON bookmarks.user_id = users.id
       WHERE bookmarks.comic_id = ? AND users.email IS NOT NULL AND users.email != ''`
    )
    .all(comic.id);
  if (!users.length) return;

  const transporter = nodemailer.createTransport({
    service: process.env.SMTP_SERVICE || 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const link = `${siteUrl()}/comic/${comic.slug}/chapter/${chapter.id}`;
  const subject = `New chapter: ${comic.title} — Chapter ${chapter.chapter_number}`;
  const html = `<p><strong>${comic.title}</strong> just got a new chapter: Chapter ${chapter.chapter_number} — ${chapter.title}.</p><p><a href="${link}">Read it now</a></p>`;

  for (const user of users) {
    try {
      await transporter.sendMail({ from: process.env.SMTP_USER, to: user.email, subject, html });
    } catch (e) {
      console.log('Email notify failed for', user.email, e.message);
    }
  }
}

// Fires all three channels for a chapter that is going (or has just gone) live.
// Safe to call for a chapter with no bookmarks / no channels configured — each
// piece silently no-ops if it isn't set up.
async function notifyNewChapter(comic, chapter) {
  await Promise.all([postToTelegram(comic, chapter), sendWebPush(comic, chapter), sendEmail(comic, chapter)]);
}

module.exports = { notifyNewChapter, postToTelegram, sendWebPush, sendEmail, sendTestTelegramMessage };
