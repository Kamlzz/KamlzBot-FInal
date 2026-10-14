import fs from 'node:fs/promises';
import { resolveInside, resolveFileSelector } from './file-store.js';

/** Permanently delete one regular file selected by the same order/name as ,ls and ,dlfile. */
export async function deleteStoredFile(dir, selector) {
  const name = await resolveFileSelector(dir, selector);
  const fullPath = resolveInside(dir, name);
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`File “${name}” tidak ditemukan. Ketik ,ls untuk melihat file yang tersedia.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Yang bisa dihapus hanya file biasa di folder penyimpanan bot.');
  await fs.unlink(fullPath);
  return { name, size: stat.size };
}
