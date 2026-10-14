import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteStoredFile } from '../lib/file-manager.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kamlz-file-manager-test-'));
try {
  await fs.writeFile(path.join(temp, 'alpha.txt'), 'alpha');
  await fs.writeFile(path.join(temp, 'bravo.pdf'), 'bravo-pdf');

  // Numeric selector uses exactly the same sorted order as ,ls and ,dlfile.
  const deleted = await deleteStoredFile(temp, '2');
  assert.equal(deleted.name, 'bravo.pdf');
  assert.equal(deleted.size, 9);
  await assert.rejects(fs.access(path.join(temp, 'bravo.pdf')));
  assert.equal(await fs.readFile(path.join(temp, 'alpha.txt'), 'utf8'), 'alpha');

  const deletedByName = await deleteStoredFile(temp, 'alpha.txt');
  assert.equal(deletedByName.name, 'alpha.txt');
  await assert.rejects(fs.access(path.join(temp, 'alpha.txt')));
  await assert.rejects(deleteStoredFile(temp, '1'), /tidak tersedia|tidak ditemukan/);
  await assert.rejects(deleteStoredFile(temp, '../outside'), /Nama file tidak valid|Path folder tidak diizinkan/);

  console.log('PASS: file manager numeric/name deletion, listing selector, and path validation');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
