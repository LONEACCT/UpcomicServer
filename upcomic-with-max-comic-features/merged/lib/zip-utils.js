const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

// "page10.jpg" should sort after "page9.jpg", not before — natural/numeric sort
function naturalCompare(a, b) {
  const ax = a.match(/(\d+|\D+)/g) || [];
  const bx = b.match(/(\d+|\D+)/g) || [];
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const av = ax[i] || '';
    const bv = bx[i] || '';
    const an = parseInt(av, 10);
    const bn = parseInt(bv, 10);
    if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function safeFilename(originalExt) {
  const random = crypto.randomBytes(8).toString('hex');
  return `${Date.now()}-${random}${originalExt.toLowerCase()}`;
}

// Extracts every image inside a ZIP (ignoring folders/junk files) into destDir,
// naming each file safely, and returns the new filenames in natural reading order.
function extractZipImages(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => IMAGE_EXT.includes(path.extname(e.entryName).toLowerCase()))
    .filter((e) => !path.basename(e.entryName).startsWith('.')) // skip __MACOSX / hidden junk
    .sort((a, b) => naturalCompare(a.entryName, b.entryName));

  const savedFilenames = [];
  entries.forEach((entry) => {
    const ext = path.extname(entry.entryName).toLowerCase();
    const filename = safeFilename(ext);
    fs.writeFileSync(path.join(destDir, filename), entry.getData());
    savedFilenames.push(filename);
  });

  return savedFilenames;
}

// Pulls a chapter number out of a zip's filename, e.g. "12.zip", "chapter-12.zip",
// "Ch 12 - Title.zip" all resolve to 12. Returns null if nothing numeric is found.
function chapterNumberFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const match = base.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

module.exports = { extractZipImages, chapterNumberFromFilename, naturalCompare };
