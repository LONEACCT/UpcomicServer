const crypto = require('crypto');

// Generates a code like UP-7X9K-QP2M — easy to read aloud/type, hard to guess.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion

function randomBlock(length) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function generateCode() {
  return `UP-${randomBlock(4)}-${randomBlock(4)}`;
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// "2 hours ago", "Yesterday", "3 days ago", falling back to a short date
function formatRelativeTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return formatDate(isoString);
}

// 128600 -> "128.6K", 950 -> "950"
function formatCompactNumber(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  if (num < 1000000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

module.exports = { generateCode, slugify, addDays, formatDate, formatRelativeTime, formatCompactNumber };
