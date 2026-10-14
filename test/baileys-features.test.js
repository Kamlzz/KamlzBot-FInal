import assert from 'node:assert/strict';
import { BAILEYS_FEATURE_COMMANDS, splitPipe, phoneJid, handleBaileysFeature } from '../lib/baileys-features.js';
async function main() {
  assert.ok(BAILEYS_FEATURE_COMMANDS.has('poll'));
  assert.ok(BAILEYS_FEATURE_COMMANDS.has('gparticipants'));
  assert.ok(BAILEYS_FEATURE_COMMANDS.has('history'));
  assert.ok(BAILEYS_FEATURE_COMMANDS.has('presencecheck'));
  assert.ok(BAILEYS_FEATURE_COMMANDS.has('storytext'));
  assert.ok(BAILEYS_FEATURE_COMMANDS.has('sendgif'));
  assert.deepEqual(splitPipe('Question | A | B'), ['Question', 'A', 'B']);
  assert.equal(phoneJid('+62 812-3456-7890'), '6281234567890@s.whatsapp.net');
  assert.throws(() => phoneJid('123'), /Nomor tidak valid/);

  const sent = [];
  const sock = {
    sendMessage: async (jid, content, options) => { sent.push({ jid, content, options }); return {}; }
  };
  const message = { key: { remoteJid: '6281234567890@s.whatsapp.net' }, message: {} };
  await handleBaileysFeature(sock, message, 'poll', 'Mau makan apa? | Nasi | Mie', { PREFIX: ',' });
  assert.equal(sent[0].jid, '6281234567890@s.whatsapp.net');
  assert.deepEqual(sent[0].content.poll.values, ['Nasi', 'Mie']);
  assert.equal(sent[0].content.poll.selectableCount, 1);

  sent.length = 0;
  await handleBaileysFeature(sock, message, 'loc', '-6.2,106.8 | Jakarta', { PREFIX: ',' });
  assert.equal(sent[0].content.location.degreesLatitude, -6.2);
  assert.equal(sent[0].content.location.degreesLongitude, 106.8);

  sent.length = 0;
  await assert.rejects(
    handleBaileysFeature(sock, message, 'loc', '120,400', { PREFIX: ',' }),
    /di luar rentang/
  );

  sent.length = 0;
  await handleBaileysFeature(sock, message, 'storytext', 'CONFIRM | 6281234567890,6289876543210 | Tes status', { PREFIX: ',' });
  assert.equal(sent[0].jid, 'status@broadcast');
  assert.equal(sent[0].options.broadcast, true);
  assert.equal(sent[0].options.statusJidList.length, 2);
  assert.equal(sent[1].jid, message.key.remoteJid);

  sent.length = 0;
  await handleBaileysFeature(sock, message, 'presencecheck', '6281234567890', { PREFIX: ',', queryPresence: async jid => ({ jid, entries: [{ jid, presence: 'available' }] }) });
  assert.match(sent[0].content.text, /available/);

  sent.length = 0;
  let historyRequest;
  sock.fetchMessageHistory = async (...args) => { historyRequest = args; };
  await handleBaileysFeature(sock, message, 'history', '15', { PREFIX: ',', getOldestMessageInChat: () => ({ key: { id: 'OLD', remoteJid: message.key.remoteJid }, messageTimestamp: 123 }) });
  assert.equal(historyRequest[0], 15);
  assert.equal(historyRequest[2], 123);
  assert.match(sent[0].content.text, /cache dalam memori/);

  console.log('baileys-features.test.js: OK');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
