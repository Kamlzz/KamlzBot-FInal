import fs from 'node:fs/promises';
import path from 'node:path';

function sanitizeStoredName(input) {
  let name = String(input ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();

  // Keep filenames reasonably portable and avoid invisible dotfiles in ,ls.
  name = name.replace(/^\.+/, '').replace(/^\.+$/, '').slice(0, 180);
  if (!name || name === '.' || name === '..') {
    throw new Error('Nama file kosong atau tidak valid.');
  }
  return name;
}

function validateRequestedName(input) {
  const name = String(input ?? '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || /[\x00-\x1f]/.test(name)) {
    throw new Error('Nama file tidak valid. Gunakan nama file saja, tanpa path folder.');
  }
  if (path.basename(name) !== name) {
    throw new Error('Path folder tidak diizinkan.');
  }
  return name;
}

function resolveInside(baseDir, name) {
  const fullPath = path.resolve(baseDir, name);
  const root = path.resolve(baseDir) + path.sep;
  if (!fullPath.startsWith(root)) {
    throw new Error('Akses file di luar folder penyimpanan ditolak.');
  }
  return fullPath;
}

async function chooseUniqueName(dir, preferredName) {
  const safeName = sanitizeStoredName(preferredName);
  const ext = path.extname(safeName);
  const stem = path.basename(safeName, ext);
  let candidate = safeName;
  let n = 1;
  while (true) {
    try {
      await fs.access(resolveInside(dir, candidate));
      candidate = `${stem} (${n++})${ext}`;
    } catch (error) {
      if (error && error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

async function listFiles(dir) {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const fullPath = resolveInside(dir, entry.name);
    const stat = await fs.stat(fullPath);
    files.push({ name: entry.name, size: stat.size, mtime: stat.mtime });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, 'id'));
}

async function resolveFileSelector(dir, input) {
  const requested = String(input ?? '').trim().replace(/^([\"'])(.*)\1$/, '$2');
  if (!requested) {
    throw new Error('Format: ,dlfile 1 atau ,dlfile nama-file.ext. Ketik ,ls untuk melihat daftar file.');
  }

  // A numeric selector refers to the 1-based order returned by listFiles(),
  // ensuring ,ls and ,dlfile use the same deterministic ordering.
  if (/^\d+$/.test(requested)) {
    const number = Number(requested);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error('Nomor urut harus berupa bilangan bulat mulai dari 1.');
    }
    const files = await listFiles(dir);
    if (number > files.length) {
      throw new Error(`Nomor file ${number} tidak tersedia. Saat ini ada ${files.length} file; ketik ,ls untuk melihat urutan terbaru.`);
    }
    return files[number - 1].name;
  }

  return validateRequestedName(requested);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'ukuran tidak diketahui';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

export { sanitizeStoredName, validateRequestedName, resolveInside, chooseUniqueName, listFiles, resolveFileSelector, formatBytes };
