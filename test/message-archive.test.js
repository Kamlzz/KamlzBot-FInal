import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MessageArchive, hasPrivacyWrapper } from '../lib/message-archive.js';

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kamlzbot-archive-test-'));
  try {
    const archive = new MessageArchive(root, { retentionDays: 7 });
    await archive.init();
    const jid = '628111111111@s.whatsapp.net';
    const message = {
      key: { remoteJid: jid, id: 'test-message-1', fromMe: false },
      pushName: 'Test contact',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'Text to archive' }
    };

    assert.equal(archive.status(jid), 'off');
    assert.equal(await archive.archiveIncoming({ sock: {}, message, body: 'Text to archive', media: null }), false);
    assert.equal(await archive.requestConsent(jid), 'created');
    assert.equal(archive.status(jid), 'pending');
    assert.equal(await archive.requestConsent(jid), 'pending');
    assert.equal(await archive.archiveIncoming({ sock: {}, message, body: 'Text to archive', media: null }), false);
    assert.equal(await archive.approve(jid), true);
    assert.equal(archive.status(jid), 'enabled');
    assert.equal(await archive.archiveIncoming({ sock: {}, message, body: 'Text to archive', media: null }), true);

    const outgoing = [];
    const handled = await archive.handleRevoked({
      async sendMessage(target, content) { outgoing.push({ target, content }); }
    }, message.key, '6285351262753@s.whatsapp.net');
    assert.equal(handled, true);
    assert.equal(outgoing.length, 1);
    assert.match(outgoing[0].content.text, /Text to archive/);
    const deletedFiles = (await fs.readdir(path.join(root, 'data', 'deleted'))).filter(name => name.endsWith('.json'));
    assert.equal(deletedFiles.length, 1);

    assert.equal(hasPrivacyWrapper({ viewOnceMessageV2: { message: { imageMessage: {} } } }), true);
    assert.equal(hasPrivacyWrapper({ ephemeralMessage: { message: { conversation: 'temp' } } }), true);
    assert.equal(hasPrivacyWrapper({ conversation: 'normal' }), false);

    const viewOnce = {
      key: { remoteJid: jid, id: 'view-once-1', fromMe: false },
      message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } }
    };
    assert.equal(await archive.archiveIncoming({ sock: {}, message: viewOnce, body: '', media: null }), false);

    const mediaMessage = {
      key: { remoteJid: jid, id: 'media-message-1', fromMe: false },
      pushName: 'Test contact', messageTimestamp: Math.floor(Date.now() / 1000),
      message: { imageMessage: { caption: 'ordinary photo' } }
    };
    assert.equal(await archive.archiveIncoming({
      sock: { async updateMediaMessage() {} }, message: mediaMessage, body: 'ordinary photo',
      media: { type: 'imageMessage', node: { fileName: 'photo.jpg', mimetype: 'image/jpeg', fileLength: 3 } },
      downloadMediaMessage: async () => Buffer.from('jpg'), maxMediaBytes: 1024
    }), true);
    const mediaNotices = [];
    assert.equal(await archive.handleRevoked({ async sendMessage(target, content) { mediaNotices.push({ target, content }); } }, mediaMessage.key, 'owner@s.whatsapp.net'), true);
    assert.equal(mediaNotices.length, 2, 'notification plus retained media should be delivered');

    console.log('PASS: message archive consent, retention, revoke handling, media retention and View Once exclusion');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
