import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function prepareImage(input, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (input && typeof input === 'object' && input.dataUrl) {
    return { ...input, bytes: input.bytes || 0 };
  }
  const absolute = path.resolve(String(input));
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error(`not a file: ${absolute}`);
  if (stat.size > maxBytes) throw new Error(`image too large: ${stat.size} bytes`);
  const mimeType = MIME[path.extname(absolute).toLowerCase()];
  if (!mimeType) throw new Error(`unsupported image extension: ${absolute}`);
  const data = await fs.readFile(absolute);
  return {
    path: absolute,
    fileName: path.basename(absolute),
    mimeType,
    bytes: stat.size,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    dataUrl: `data:${mimeType};base64,${data.toString('base64')}`,
  };
}

export function imagePart(image) {
  return { type: 'image_url', image_url: { url: image.dataUrl } };
}
