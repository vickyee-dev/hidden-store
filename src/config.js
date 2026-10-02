import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads');
