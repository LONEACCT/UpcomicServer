const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Covers are not sensitive, so they live in the public/static folder.
const coversDir = path.join(__dirname, 'public', 'uploads', 'covers');
// Page images CAN be premium content, so they live outside the static
// folder entirely and are only ever served through the gated /media route.
const pagesDir = path.join(__dirname, 'private-uploads', 'pages');
[coversDir, pagesDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function safeFilename(originalname) {
  const ext = path.extname(originalname).toLowerCase();
  const random = crypto.randomBytes(8).toString('hex');
  return `${Date.now()}-${random}${ext}`;
}

const imageFileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) return cb(null, true);
  cb(new Error('Only image files (jpg, png, webp, gif) are allowed.'));
};

const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, coversDir),
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
});

const pageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, pagesDir),
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
});

const uploadCover = multer({
  storage: coverStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadPages = multer({
  storage: pageStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 15 * 1024 * 1024, files: 200 }, // 15MB per page, up to 200 pages at once
});

// ZIP uploads land in a temp folder, get extracted by the route handler
// (via lib/zip-utils), then are deleted — they never touch pagesDir directly.
const tmpDir = path.join(__dirname, 'private-uploads', 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const zipFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.zip') return cb(null, true);
  cb(new Error('Only .zip files are allowed.'));
};

const zipStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
});

// A single ZIP of images for one chapter
const uploadZip = multer({
  storage: zipStorage,
  fileFilter: zipFileFilter,
  limits: { fileSize: 300 * 1024 * 1024 },
});

// Several ZIPs at once, one chapter per ZIP (bulk upload)
const uploadBulkZips = multer({
  storage: zipStorage,
  fileFilter: zipFileFilter,
  limits: { fileSize: 300 * 1024 * 1024, files: 50 },
});

// Chapter form supports EITHER manual multi-image select OR a single ZIP,
// in the same submit — route destination by fieldname.
const chapterMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'zip' ? tmpDir : pagesDir),
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
});
const chapterMediaFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.fieldname === 'zip') {
    return ext === '.zip' ? cb(null, true) : cb(new Error('Only .zip files are allowed for the ZIP field.'));
  }
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  return allowed.includes(ext) ? cb(null, true) : cb(new Error('Only image files (jpg, png, webp, gif) are allowed.'));
};
const uploadChapterMedia = multer({
  storage: chapterMediaStorage,
  fileFilter: chapterMediaFilter,
  limits: { fileSize: 300 * 1024 * 1024, files: 201 },
}).fields([
  { name: 'pages', maxCount: 200 },
  { name: 'zip', maxCount: 1 },
]);

module.exports = { uploadCover, uploadPages, uploadZip, uploadBulkZips, uploadChapterMedia, pagesDir, tmpDir, coversDir };
