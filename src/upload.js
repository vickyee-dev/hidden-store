import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { UPLOAD_DIR } from './config.js';
import { flash } from './middleware.js';

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif', 'image/gif': '.gif' };

const uploader = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // Random server-side names: never trust the client's filename.
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => (EXT[file.mimetype] ? cb(null, true) : cb(new Error('Only JPG, PNG, WebP, AVIF or GIF images are allowed.'))),
}).fields([{ name: 'image1', maxCount: 1 }, { name: 'image2', maxCount: 1 }, { name: 'image3', maxCount: 1 }]);

export const uploadImages = (req, res, next) => uploader(req, res, (err) => {
  if (!err) return next();
  flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 3 MB or smaller.' : err.message);
  res.redirect(req.get('referer') || '/admin/products');
});

/** Remove a previously uploaded file (seed images under /img are left alone). */
export function removeUpload(urlPath) {
  if (urlPath?.startsWith('/uploads/')) fs.rm(path.join(UPLOAD_DIR, path.basename(urlPath)), { force: true }, () => {});
}
export const uploadUrl = (file) => (file ? '/uploads/' + file.filename : '');
