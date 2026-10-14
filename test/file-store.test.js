import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/file-store.js';
import { isSignalDecryptNoise, isInitQueryTimeoutNoise } from '../lib/log-filter.js';

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kamlzbot-test-'));
  try {
    assert.equal(store.sanitizeStoredName('report final.pdf'), 'report final.pdf');
    assert.equal(store.sanitizeStoredName('../etc/passwd'), '_etc_passwd');
    assert.equal(store.sanitizeStoredName('.hidden'), 'hidden');
    assert.throws(() => store.validateRequestedName('../secret'), /Nama file tidak valid/);
    assert.throws(() => store.resolveInside(temp, '../secret'), /Akses file di luar folder/);

    await fs.writeFile(path.join(temp, 'a.txt'), 'abc');
    assert.equal(await store.chooseUniqueName(temp, 'a.txt'), 'a (1).txt');
    const files = await store.listFiles(temp);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'a.txt');
    assert.equal(files[0].size, 3);
    assert.equal(await store.resolveFileSelector(temp, '1'), 'a.txt');
    await fs.writeFile(path.join(temp, 'b.txt'), 'defgh');
    assert.equal(await store.resolveFileSelector(temp, '2'), 'b.txt');
    assert.equal(await store.resolveFileSelector(temp, 'a.txt'), 'a.txt');
    await assert.rejects(store.resolveFileSelector(temp, '3'), /Nomor file 3 tidak tersedia/);
    await assert.rejects(store.resolveFileSelector(temp, '0'), /mulai dari 1/);
    await assert.rejects(store.resolveFileSelector(temp, '../secret'), /Nama file tidak valid/);
    assert.equal(store.formatBytes(1024), '1.00 KB');

    // Repetitive Baileys/libsignal decryption failures are filtered, normal app logs are not.
    assert.equal(isSignalDecryptNoise(['Failed to decrypt message with any known session...']), true);
    assert.equal(isSignalDecryptNoise([{
      msg: 'failed to decrypt message',
      err: { name: 'SessionError', message: 'No matching sessions found for message' }
    }]), true);
    assert.equal(isSignalDecryptNoise([
      'Session error:Error: Bad MAC Error: Bad MAC',
      { stack: 'at Object.verifyMAC (/opt/KamlzBot/node_modules/libsignal/src/crypto.js:87:15)\n at SessionCipher.doDecryptWhisperMessage (/opt/KamlzBot/node_modules/libsignal/src/session_cipher.js:250:16)' }
    ]), true);
    assert.equal(isSignalDecryptNoise(['[COMMAND dlfile] Permission denied']), false);
    const initTimeout = {
      err: { message: 'Timed Out', output: { statusCode: 408, payload: { message: 'Timed Out' } } },
      msg: "unexpected error in 'init queries'"
    };
    assert.equal(isInitQueryTimeoutNoise([initTimeout]), true);
    assert.equal(isInitQueryTimeoutNoise([{ msg: "unexpected error in 'init queries'", err: { message: 'bad-request', output: { statusCode: 400 } } }]), false);
    assert.equal(isInitQueryTimeoutNoise([{ msg: 'upload error', err: { message: 'Timed Out', output: { statusCode: 408 } } }]), false);
    console.log('PASS: KamlzBot file-store and log-filter tests');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
