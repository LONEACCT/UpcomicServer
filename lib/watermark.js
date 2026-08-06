const fs = require('fs');
const path = require('path');
const { getSetting, getBoolSetting } = require('./settings');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional — watermarking just no-ops without it */ }

// Stamps a semi-transparent site-name watermark near the bottom of a page
// image, in place. Silently does nothing if sharp isn't installed, so a
// missing dependency never blocks an upload — it just skips the watermark.
async function watermarkImage(filePath, text) {
  if (!sharp || !fs.existsSync(filePath)) return;

  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 1200;
    const fontSize = Math.max(18, Math.round(width * 0.04));
    const label = (text || 'UPCOMIC').replace(/[<>&]/g, '');

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <text x="50%" y="${height - fontSize}" text-anchor="middle"
          font-family="sans-serif" font-weight="700" font-size="${fontSize}"
          fill="#ffffff" fill-opacity="0.35" stroke="#000000" stroke-opacity="0.25" stroke-width="1">
          ${label}
        </text>
      </svg>`;

    const outputBuffer = await image
      .composite([{ input: Buffer.from(svg), gravity: 'south' }])
      .toBuffer();

    const tmpPath = filePath + '.wm.tmp';
    await sharp(outputBuffer).toFile(tmpPath);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.log('Watermark failed for', path.basename(filePath), e.message);
  }
}

// Watermarks a whole batch of page filenames (already saved in pagesDir) —
// used right after a ZIP is extracted, for both single-chapter and bulk
// uploads. Reads the on/off toggle and text from the admin Settings page
// (DB-backed, .env as fallback) so it can be turned off without a redeploy.
async function watermarkPages(pagesDir, filenames) {
  const enabled = getBoolSetting('watermark_enabled', null, true);
  if (!enabled) return;

  const text = getSetting('watermark_text', 'SITE_NAME', 'UPCOMIC');
  for (const filename of filenames) {
    await watermarkImage(path.join(pagesDir, filename), text);
  }
}

module.exports = { watermarkImage, watermarkPages };
