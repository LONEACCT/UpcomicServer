const db = require('../db');

// Reads an admin-editable setting from the DB. If it's never been set
// (or was cleared), falls back to the matching .env var, then to
// defaultValue. This lets a fresh deploy keep working off .env until the
// admin explicitly overrides something from the Settings page.
function getSetting(key, envVarName, defaultValue = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value !== null && row.value !== '') return row.value;
  if (envVarName && process.env[envVarName]) return process.env[envVarName];
  return defaultValue;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value == null ? '' : String(value));
}

function getBoolSetting(key, envVarName, defaultValue = false) {
  const raw = getSetting(key, envVarName, defaultValue ? '1' : '0');
  return raw === '1' || raw === 'true' || raw === true;
}

module.exports = { getSetting, setSetting, getBoolSetting };
