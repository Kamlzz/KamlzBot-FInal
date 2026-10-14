import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function createBotBackup(root, filesDir) {
  await fs.mkdir(filesDir, { recursive: true });

  const stamp = new Date().toISOString()
    .replace(/[:.]/g, '-');

  const output = path.join(filesDir, `KamlzBot-backup-${stamp}.zip`);

  const script = String.raw`
import os, sys, zipfile

root = os.path.realpath(sys.argv[1])
output = os.path.realpath(sys.argv[2])
excluded_dirs = {'node_modules', '.git'}
total = 0

with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED,
                     compresslevel=6, allowZip64=True) as z:
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [
            d for d in dirs
            if d not in excluded_dirs
            and not os.path.islink(os.path.join(current, d))
        ]

        for name in files:
            full = os.path.join(current, name)

            if os.path.islink(full) or os.path.realpath(full) == output:
                continue

            # Jangan masukkan ZIP backup lama ke dalam backup baru.
            if name.startswith('KamlzBot-backup-') and name.endswith('.zip'):
                continue

            if not os.path.isfile(full):
                continue

            relative = os.path.relpath(full, root)
            z.write(full, relative)
            total += 1

print(total)
`;

  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', script, root, output],
      { timeout: 600000, maxBuffer: 1024 * 1024 }
    );

    const stat = await fs.stat(output);

    if (stat.size === 0) {
      throw new Error('ZIP backup kosong.');
    }

    return {
      path: output,
      size: stat.size,
      files: Number(stdout.trim()) || 0
    };
  } catch (error) {
    await fs.rm(output, { force: true }).catch(() => {});
    throw new Error(`Backup gagal: ${error.message}`);
  }
}
