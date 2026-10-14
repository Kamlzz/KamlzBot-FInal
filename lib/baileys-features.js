import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

const BAILEYS_FEATURE_COMMANDS = new Set([
  'react', 'pinmsg', 'unpinmsg', 'edit', 'deleteeveryone', 'star', 'unstar', 'poll', 'pollresults', 'loc', 'contact', 'mention', 'forward',
  'sendmedia', 'sendgif', 'viewonce', 'markread', 'markunread', 'archivechat', 'deletechat', 'deleteforme', 'ephemeral', 'presence', 'presencecheck', 'history', 'mute', 'pinchat', 'unpinchat',
  'waexists', 'pp', 'wastatus', 'business', 'setname', 'setstatus', 'setpp', 'removepp',
  'ginfo', 'gparticipants', 'glist', 'gcreate', 'gsubject', 'gdesc', 'gsetting', 'gadd', 'gremove', 'gjoinmsg', 'gpp', 'setgpp', 'removegpp',
  'gpromote', 'gdemote', 'ginvite', 'grevoke', 'gjoin', 'ginfo-code', 'grequests',
  'gapprove', 'greject', 'gmembermode', 'gephemeral', 'gleave',
  'privacy', 'blocklist', 'block', 'unblock', 'privacyset', 'autoreject', 'broadcastinfo', 'storytext', 'storymedia'
]);

const FEATURE_HELP = `*KamlzBot — Fitur Baileys*

*Pesan & media*
,react 😀 — reply pesan untuk memberi reaksi
,pinmsg [24h|7d|30d] — pin pesan yang di-reply
,unpinmsg — lepas pin pesan yang di-reply
,edit Teks Baru — reply pesan yang dikirim bot untuk mengeditnya
,deleteeveryone — reply pesan bot yang ingin dihapus untuk semua orang
,star / ,unstar — beri/batal bintang pada pesan yang di-reply
,poll Pertanyaan | Opsi 1 | Opsi 2 — polling (maks. 12 opsi)
,pollresults — reply ke polling untuk melihat agregat vote yang diterima bot sejak proses berjalan
,loc latitude,longitude | keterangan — kirim lokasi
,contact Nama | 628xxxxxxxxxx — kirim kontak
,mention 628xxxxxxxxxx | pesan — mention nomor
,forward 628xxxxxxxxxx — teruskan pesan yang di-reply ke nomor tujuan
,sendmedia nama-file — kirim media dari data/files
,sendgif file.mp4 — kirim video MP4 sebagai GIF
,viewonce nama-file — kirim foto/video/audio sebagai View Once
,storytext CONFIRM | 628nomor1,628nomor2 | teks — buat status untuk penerima eksplisit (maks. 50)
,storymedia file | 628nomor1,628nomor2 | CONFIRM | caption — status foto/video untuk penerima eksplisit
,broadcastinfo timestamp@broadcast — lihat nama dan penerima daftar siaran
,markread — tandai pesan yang di-reply dibaca
,presence available|unavailable|composing|recording|paused
,presencecheck 628xxxxxxxxxx — minta pembaruan status online/mengetik (jika tersedia)
,history [1-50] — minta riwayat lebih lama untuk chat aktif; hasil masuk ke cache selama proses berjalan

*Chat*
,mute 8h|7d|off — mute chat saat ini
,pinchat / ,unpinchat — pin/lepas pin chat saat ini
,archivechat on|off — arsip/unarsip chat saat ini
,markunread — tandai chat belum dibaca
,deletechat CONFIRM — hapus chat dari daftar akun bot
,deleteforme — reply pesan untuk menghapusnya hanya dari akun bot
,ephemeral off|24h|7d|90d — timer pesan sementara di chat saat ini

*Profil & pencarian*
,waexists 628xxxxxxxxxx — periksa keberadaan nomor
,pp 628xxxxxxxxxx — URL foto profil bila terlihat
,wastatus 628xxxxxxxxxx — status teks jika tersedia
,business 628xxxxxxxxxx — profil bisnis
,setname Nama Baru — ubah nama profil bot
,setstatus Teks status — ubah status profil
,setpp — reply gambar untuk mengubah foto profil bot
,removepp — hapus foto profil bot
,gpp — lihat foto profil grup aktif
,setgpp — reply gambar di grup untuk mengubah foto grup (admin)
,removegpp — hapus foto profil grup (admin)

*Grup (jalankan di grup tujuan; izin admin mungkin diperlukan)*
,ginfo — ringkasan grup
,gparticipants — daftar anggota
,glist — daftar grup akun
,gcreate Nama Grup | 628nomor1,628nomor2 — buat grup baru (maks. 10 peserta)
,gsubject Nama — ubah nama grup
,gdesc Deskripsi — ubah deskripsi
,gsetting announcement|not_announcement|locked|unlocked
,gadd nomor / ,gremove nomor / ,gpromote nomor / ,gdemote nomor
,ginvite — link undangan grup
,grevoke — ganti kode undangan
,gjoin KODE — gabung grup dari kode undangan (jalankan di chat pribadi)
,gjoinmsg CONFIRM — reply pesan undangan grup untuk bergabung
,ginfo-code KODE — baca info undangan
,grequests — daftar permintaan bergabung
,gapprove nomor / ,greject nomor
,gmembermode all|admin — aturan penambahan anggota
,gephemeral off|24h|7d|90d — timer pesan sementara
,gleave CONFIRM — keluar grup (butuh konfirmasi)

*Privasi*
,privacy — lihat pengaturan privasi
,autoreject on|off — aktif/nonaktif tolak panggilan otomatis
,blocklist — daftar blokir
,block nomor / ,unblock nomor
,privacyset lastseen|online|picture|status|readreceipts|groups|disappearing NILAI

Semua perintah dibatasi untuk owner. Operasi grup memerlukan hak yang sesuai. Lakukan perubahan grup/privasi dengan hati-hati.`;

function unwrapContent(content) {
  let current = content;
  for (let i = 0; i < 8 && current; i++) {
    const next = current.ephemeralMessage?.message
      || current.viewOnceMessage?.message
      || current.viewOnceMessageV2?.message
      || current.viewOnceMessageV2Extension?.message
      || current.documentWithCaptionMessage?.message;
    if (!next) break;
    current = next;
  }
  return current || {};
}

function contextInfoFor(message) {
  const content = unwrapContent(message?.message);
  for (const value of Object.values(content)) {
    if (value?.contextInfo) return value.contextInfo;
  }
  return null;
}

function quotedMessage(message, sock) {
  const context = contextInfoFor(message);
  if (!context?.quotedMessage || !context?.stanzaId) return null;
  const key = { remoteJid: message.key.remoteJid, id: context.stanzaId, fromMe: false };
  if (context.participant) key.participant = context.participant;
  const selfJid = String(sock.user?.id || '').replace(/:\d+@/, '@');
  if (context.participant && selfJid && context.participant === selfJid) key.fromMe = true;
  return { key, message: context.quotedMessage, messageTimestamp: context.quotedMessage.messageTimestamp };
}

function splitPipe(value) {
  return String(value || '').split('|').map(x => x.trim()).filter(Boolean);
}
function phoneJid(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw new Error('Nomor tidak valid. Gunakan kode negara, contoh 628123456789.');
  return `${digits}@s.whatsapp.net`;
}
function currentChat(message) {
  const jid = String(message.key?.remoteJid || '');
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) throw new Error('Perintah tidak berlaku di status/broadcast.');
  return jid;
}
function currentGroup(message) {
  const jid = currentChat(message);
  if (!jid.endsWith('@g.us')) throw new Error('Gunakan perintah ini di grup WhatsApp yang dituju.');
  return jid;
}
function mentions(message) {
  const context = contextInfoFor(message);
  return Array.isArray(context?.mentionedJid) ? context.mentionedJid : [];
}
function oneTarget(message, args) {
  const digits = String(args || '').match(/\d{8,15}/)?.[0];
  if (digits) return phoneJid(digits);
  const tagged = mentions(message);
  if (tagged.length) return tagged[0];
  throw new Error('Sertakan satu nomor dengan kode negara atau mention satu peserta.');
}
function cleanText(value, max = 500) {
  const result = String(value || '').trim();
  if (!result) throw new Error('Teks tidak boleh kosong.');
  if (result.length > max) throw new Error(`Teks terlalu panjang (maks. ${max} karakter).`);
  return result;
}
function pretty(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
async function send(sock, jid, text) {
  await sock.sendMessage(jid, { text: String(text).slice(0, 3800) });
}
async function requireQuoted(sock, message, options = {}) {
  const item = quotedMessage(message, sock);
  if (!item) throw new Error('Reply/balas pesan yang ingin dijadikan target, lalu kirim perintah.');
  const original = typeof options.getCachedWAMessage === 'function' ? options.getCachedWAMessage(item.key) : null;
  if (original?.key) item.key = original.key;
  if (original?.message) item.message = original.message;
  if (original?.messageTimestamp !== undefined) item.messageTimestamp = original.messageTimestamp;
  return item;
}

async function handleBaileysFeature(sock, message, command, args, options = {}) {
  const jid = currentChat(message);
  const PREFIX = options.PREFIX || ',';
  const ROOT = options.ROOT || process.cwd();
  const FILES_DIR = path.resolve(options.FILES_DIR || path.join(ROOT, 'data/files'));
  const MAX_BYTES = options.MAX_UPLOAD_BYTES || 100 * 1024 * 1024;
  const cmd = String(command || '').toLowerCase();
  const arg = String(args || '').trim();

  switch (cmd) {
    case 'react': {
      const quoted = await requireQuoted(sock, message, options);
      await sock.sendMessage(jid, { react: { text: cleanText(arg, 24), key: quoted.key } });
      return;
    }
    case 'pinmsg':
    case 'unpinmsg': {
      const quoted = await requireQuoted(sock, message, options);
      const durationMap = { '24h': 86400, '7d': 604800, '30d': 2592000 };
      const duration = durationMap[arg.toLowerCase()] || 86400;
      await sock.sendMessage(jid, { pin: { type: cmd === 'unpinmsg' ? 0 : 1, time: duration, key: quoted.key } });
      await send(sock, jid, cmd === 'unpinmsg' ? 'Permintaan melepas pin pesan dikirim.' : `Permintaan pin pesan dikirim (${arg || '24h'}).`);
      return;
    }
    case 'edit': {
      const quoted = await requireQuoted(sock, message, options);
      if (!quoted.key.fromMe) throw new Error('Demi keamanan, ,edit hanya dapat mengedit pesan yang dikenali sebagai pesan akun bot.');
      await sock.sendMessage(jid, { text: cleanText(arg, 4000), edit: quoted.key });
      return;
    }
    case 'deleteeveryone': {
      const quoted = await requireQuoted(sock, message, options);
      if (!quoted.key.fromMe) throw new Error('Demi keamanan, hanya pesan yang dikenali sebagai pesan akun bot yang dapat dihapus untuk semua orang.');
      await sock.sendMessage(jid, { delete: quoted.key });
      await send(sock, jid, 'Permintaan penghapusan pesan dikirim.');
      return;
    }
    case 'star':
    case 'unstar': {
      const quoted = await requireQuoted(sock, message, options);
      await sock.chatModify({ star: { messages: [{ id: quoted.key.id, fromMe: Boolean(quoted.key.fromMe) }], star: cmd === 'star' } }, jid);
      await send(sock, jid, cmd === 'star' ? 'Permintaan memberi bintang pada pesan dikirim.' : 'Permintaan menghapus bintang pesan dikirim.');
      return;
    }
    case 'pollresults': {
      const quoted = await requireQuoted(sock, message, options);
      const result = typeof options.getPollResults === 'function' ? options.getPollResults(quoted.key) : null;
      if (!result) throw new Error('Hasil polling belum tersedia. Bot hanya menyimpan polling yang diterima/dibuat selama proses berjalan; coba lagi setelah vote masuk.');
      const rows = Array.isArray(result) ? result : [];
      await send(sock, jid, `*Hasil polling*\n${rows.map((row, i) => `${i + 1}. ${row.name || '(opsi)'} — ${Array.isArray(row.voters) ? row.voters.length : Number(row.votes || 0)} suara`).join('\n') || pretty(result).slice(0, 2500)}`);
      return;
    }
    case 'poll': {
      const parts = splitPipe(arg);
      if (parts.length < 3) throw new Error(`Format: ${PREFIX}poll Pertanyaan | Opsi 1 | Opsi 2`);
      if (parts.length > 13) throw new Error('Maksimal 12 opsi polling.');
      const [name, ...values] = parts;
      if (name.length > 250 || values.some(x => x.length > 100)) throw new Error('Pertanyaan maks. 250 karakter; setiap opsi maks. 100 karakter.');
      await sock.sendMessage(jid, { poll: { name, values, selectableCount: 1 } });
      return;
    }
    case 'loc': {
      const parts = splitPipe(arg);
      const match = parts[0]?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!match) throw new Error(`Format: ${PREFIX}loc -6.2000,106.8166 | Jakarta`);
      const latitude = Number(match[1]);
      const longitude = Number(match[2]);
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Koordinat di luar rentang.');
      const location = { degreesLatitude: latitude, degreesLongitude: longitude };
      if (parts[1]) location.name = parts[1].slice(0, 100);
      await sock.sendMessage(jid, { location });
      return;
    }
    case 'contact': {
      const parts = splitPipe(arg);
      if (parts.length < 2) throw new Error(`Format: ${PREFIX}contact Nama | 628xxxxxxxxxx`);
      const name = cleanText(parts[0], 80).replace(/[\r\n]/g, ' ');
      const digits = parts[1].replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) throw new Error('Nomor kontak tidak valid. Gunakan kode negara.');
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
      await sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ vcard }] } });
      return;
    }
    case 'mention': {
      const parts = splitPipe(arg);
      if (parts.length < 2) throw new Error(`Format: ${PREFIX}mention 628xxxxxxxxxx | Pesan`);
      const target = phoneJid(parts[0]);
      await sock.sendMessage(jid, { text: `@${target.split('@')[0]} ${parts.slice(1).join(' | ')}`, mentions: [target] });
      return;
    }
    case 'forward': {
      const quoted = await requireQuoted(sock, message, options);
      const target = phoneJid(arg);
      await sock.sendMessage(target, { forward: quoted });
      await send(sock, jid, `Pesan diteruskan ke ${target.split('@')[0]}.`);
      return;
    }
    case 'sendmedia':
    case 'sendgif':
    case 'viewonce': {
      if (!arg) throw new Error(`Format: ${PREFIX}${cmd} nama-file-di-data/files`);
      const filePath = path.resolve(FILES_DIR, path.basename(arg));
      if (!filePath.startsWith(FILES_DIR + path.sep)) throw new Error('Nama file tidak valid.');
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw new Error('File tidak ditemukan pada data/files.');
      if (stat.size > MAX_BYTES) throw new Error('File melebihi batas ukuran konfigurasi.');
      const mimetype = mime.lookup(filePath) || 'application/octet-stream';
      const base = { url: filePath };
      let content;
      if (cmd === 'sendgif') {
        if (mimetype !== 'video/mp4') throw new Error('Kirim GIF harus berupa video MP4. Ubah GIF ke MP4 terlebih dahulu.');
        content = { video: base, mimetype: 'video/mp4', gifPlayback: true, caption: path.basename(filePath) };
      } else if (mimetype.startsWith('image/')) content = { image: base, mimetype, caption: path.basename(filePath) };
      else if (mimetype.startsWith('video/')) content = { video: base, mimetype, caption: path.basename(filePath) };
      else if (mimetype.startsWith('audio/')) content = { audio: base, mimetype, ptt: false };
      else if (cmd === 'viewonce') throw new Error('View Once hanya didukung untuk foto, video, atau audio.');
      else content = { document: base, mimetype, fileName: path.basename(filePath), caption: `File dari ${options.config?.botName || 'KamlzBot'}` };
      if (cmd === 'viewonce') content.viewOnce = true;
      await sock.sendMessage(jid, content);
      console.log(`[${cmd.toUpperCase()}] Sent ${path.basename(filePath)} (${stat.size} bytes)`);
      return;
    }
    case 'storytext': {
      const parts = splitPipe(arg);
      if (parts.length < 3 || parts[0] !== 'CONFIRM') throw new Error(`Format: ${PREFIX}storytext CONFIRM | 628nomor1,628nomor2 | teks status`);
      const recipients = [...new Set(parts[1].split(',').map(phoneJid))];
      if (recipients.length > 50) throw new Error('Maksimal 50 penerima per status.');
      const statusText = cleanText(parts.slice(2).join(' | '), 700);
      await sock.sendMessage('status@broadcast', { text: statusText }, { broadcast: true, statusJidList: recipients });
      await send(sock, jid, `Permintaan status teks dikirim ke ${recipients.length} penerima yang ditentukan.`);
      return;
    }
    case 'storymedia': {
      const parts = splitPipe(arg);
      if (parts.length < 4 || parts[2] !== 'CONFIRM') throw new Error(`Format: ${PREFIX}storymedia nama-file | 628nomor1,628nomor2 | CONFIRM | caption`);
      const filePath = path.resolve(FILES_DIR, path.basename(parts[0]));
      if (!filePath.startsWith(FILES_DIR + path.sep)) throw new Error('Nama file tidak valid.');
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw new Error('File tidak ditemukan pada data/files.');
      if (stat.size > MAX_BYTES) throw new Error('File melebihi batas ukuran konfigurasi.');
      const recipients = [...new Set(parts[1].split(',').map(phoneJid))];
      if (recipients.length > 50) throw new Error('Maksimal 50 penerima per status.');
      const mimetype = mime.lookup(filePath) || 'application/octet-stream';
      const caption = parts.slice(3).join(' | ').slice(0, 700);
      let content;
      if (mimetype.startsWith('image/')) content = { image: { url: filePath }, mimetype, caption };
      else if (mimetype.startsWith('video/')) content = { video: { url: filePath }, mimetype, caption };
      else throw new Error('Status media hanya mendukung gambar atau video.');
      await sock.sendMessage('status@broadcast', content, { broadcast: true, statusJidList: recipients });
      await send(sock, jid, `Permintaan status media dikirim ke ${recipients.length} penerima yang ditentukan.`);
      return;
    }
    case 'broadcastinfo': {
      const listJid = arg.trim();
      if (!/^\d+@broadcast$/.test(listJid)) throw new Error(`Format: ${PREFIX}broadcastinfo timestamp@broadcast`);
      if (typeof sock.getBroadcastListInfo !== 'function') throw new Error('API getBroadcastListInfo tidak tersedia pada versi Baileys ini.');
      const info = await sock.getBroadcastListInfo(listJid);
      const recipients = Array.isArray(info?.recipients) ? info.recipients : [];
      await send(sock, jid, `*Daftar siaran*\nNama: ${info?.name || '-'}\nID: ${listJid}\nPenerima: ${recipients.length}\n${recipients.slice(0, 100).map((x, i) => `${i + 1}. ${typeof x === 'string' ? x : (x.jid || x.id || pretty(x))}`).join('\n')}`);
      return;
    }
    case 'history': {
      const count = arg ? Number(arg) : 20;
      if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error(`Format: ${PREFIX}history [1-50]`);
      if (typeof options.getOldestMessageInChat !== 'function') throw new Error('Cache riwayat tidak tersedia.');
      const oldest = options.getOldestMessageInChat(jid);
      if (!oldest?.key || oldest.messageTimestamp === undefined || oldest.messageTimestamp === null) {
        throw new Error('Belum ada pesan cache pada chat ini. Kirim/terima beberapa pesan lalu coba lagi.');
      }
      if (typeof sock.fetchMessageHistory !== 'function') throw new Error('API fetchMessageHistory tidak tersedia pada versi Baileys ini.');
      await sock.fetchMessageHistory(count, oldest.key, oldest.messageTimestamp);
      await send(sock, jid, `Permintaan mengambil hingga ${count} pesan yang lebih lama dikirim. Pesan yang diterima akan masuk ke cache dalam memori; fitur ini tidak membuat arsip percakapan permanen.`);
      return;
    }
    case 'presencecheck': {
      const target = phoneJid(arg);
      if (typeof options.queryPresence !== 'function') throw new Error('Pemeriksaan presence tidak tersedia.');
      const result = await options.queryPresence(target);
      if (!result) {
        await send(sock, jid, 'Tidak menerima pembaruan presence dalam 8 detik. Pengguna mungkin offline, statusnya disembunyikan, atau WhatsApp tidak mengirim pembaruan.');
      } else {
        const rows = (result.entries || []).map(x => `${x.jid}: ${x.presence}`).join('\n');
        await send(sock, jid, `*Pembaruan presence*\nTarget: ${result.jid}\n${rows || 'Pembaruan diterima tanpa rincian status.'}`);
      }
      return;
    }
    case 'deleteforme': {
      const quoted = await requireQuoted(sock, message, options);
      const timestamp = quoted.messageTimestamp?.toString?.() ?? String(quoted.messageTimestamp || '');
      if (!timestamp) throw new Error('Timestamp pesan tidak tersedia di cache. Coba pesan yang lebih baru.');
      await sock.chatModify({ clear: { messages: [{ id: quoted.key.id, fromMe: Boolean(quoted.key.fromMe), timestamp }] } }, jid);
      await send(sock, jid, 'Permintaan menghapus pesan dari akun bot saja dikirim.');
      return;
    }
    case 'markunread': {
      const last = typeof options.getLastMessageInChat === 'function' ? options.getLastMessageInChat(jid) : null;
      if (!last?.key || last.messageTimestamp === undefined) throw new Error('Pesan terakhir tidak tersedia di cache. Tunggu pesan baru lalu coba lagi.');
      const ack = await sock.sendMessage(jid, { text: 'Permintaan menandai chat belum dibaca dikirim.' });
      const target = ack?.key ? ack : last;
      await sock.chatModify({ markRead: false, lastMessages: [{ key: target.key, messageTimestamp: target.messageTimestamp }] }, jid);
      return;
    }
    case 'archivechat': {
      const value = arg.toLowerCase();
      if (!['on', 'off'].includes(value)) throw new Error(`Format: ${PREFIX}archivechat on | off`);
      const last = typeof options.getLastMessageInChat === 'function' ? options.getLastMessageInChat(jid) : null;
      if (!last?.key || last.messageTimestamp === undefined) throw new Error('Pesan terakhir tidak tersedia di cache. Tunggu pesan baru lalu coba lagi.');
      const ack = await sock.sendMessage(jid, { text: value === 'on' ? 'Mengarsipkan chat…' : 'Mengeluarkan chat dari arsip…' });
      const target = ack?.key ? ack : last;
      await sock.chatModify({ archive: value === 'on', lastMessages: [{ key: target.key, messageTimestamp: target.messageTimestamp }] }, jid);
      return;
    }
    case 'deletechat': {
      if (arg !== 'CONFIRM') throw new Error(`Tindakan ini menghapus chat dari daftar akun bot. Ketik ${PREFIX}deletechat CONFIRM untuk melanjutkan.`);
      const last = typeof options.getLastMessageInChat === 'function' ? options.getLastMessageInChat(jid) : null;
      if (!last?.key || last.messageTimestamp === undefined) throw new Error('Pesan terakhir tidak tersedia di cache.');
      const ack = await sock.sendMessage(jid, { text: 'Menghapus chat dari daftar akun bot…' });
      const target = ack?.key ? ack : last;
      await sock.chatModify({ delete: true, lastMessages: [{ key: target.key, messageTimestamp: target.messageTimestamp }] }, jid);
      return;
    }
    case 'ephemeral': {
      const map = { off: 0, '24h': 86400, '7d': 604800, '90d': 7776000 };
      const value = arg.toLowerCase();
      if (!Object.hasOwn(map, value)) throw new Error(`Pilihan: off | 24h | 7d | 90d`);
      await sock.sendMessage(jid, { disappearingMessagesInChat: map[value] });
      await send(sock, jid, `Permintaan timer pesan sementara: ${value}.`);
      return;
    }
    case 'markread': {
      const quoted = await requireQuoted(sock, message, options);
      await sock.readMessages([quoted.key]);
      await send(sock, jid, 'Permintaan menandai pesan sebagai dibaca dikirim.');
      return;
    }
    case 'presence': {
      const allowed = ['available', 'unavailable', 'composing', 'recording', 'paused'];
      if (!allowed.includes(arg)) throw new Error(`Pilihan: ${allowed.join(' | ')}`);
      await sock.sendPresenceUpdate(arg, jid);
      await send(sock, jid, `Presence dikirim: ${arg}.`);
      return;
    }
    case 'mute': {
      const value = arg.toLowerCase();
      const mute = value === '8h' ? 28800000 : value === '7d' ? 604800000 : value === 'off' ? null : undefined;
      if (mute === undefined) throw new Error(`Format: ${PREFIX}mute 8h | 7d | off`);
      await sock.chatModify({ mute }, jid);
      await send(sock, jid, value === 'off' ? 'Mute chat dinonaktifkan.' : `Chat di-mute selama ${value}.`);
      return;
    }
    case 'pinchat':
    case 'unpinchat': {
      await sock.chatModify({ pin: cmd === 'pinchat' }, jid);
      await send(sock, jid, cmd === 'pinchat' ? 'Permintaan pin chat dikirim.' : 'Permintaan melepas pin chat dikirim.');
      return;
    }
    case 'waexists': {
      const target = phoneJid(arg);
      const result = await sock.onWhatsApp(target);
      const entry = Array.isArray(result) ? result[0] : result;
      await send(sock, jid, entry?.exists ? `Nomor terdaftar di WhatsApp: ${entry.jid || target}` : 'Nomor tidak ditemukan atau tidak dapat diverifikasi.');
      return;
    }
    case 'pp': {
      const target = phoneJid(arg);
      const url = await sock.profilePictureUrl(target, 'image').catch(() => null);
      await send(sock, jid, url ? `Foto profil tersedia:\n${url}` : 'Foto profil tidak tersedia atau disembunyikan oleh pengaturan privasi.');
      return;
    }
    case 'wastatus': {
      const target = phoneJid(arg);
      const status = await sock.fetchStatus(target);
      await send(sock, jid, `Hasil status WhatsApp:\n${pretty(status).slice(0, 2800)}`);
      return;
    }
    case 'business': {
      const target = phoneJid(arg);
      const profile = await sock.getBusinessProfile(target);
      await send(sock, jid, profile ? `*Profil bisnis*\nDeskripsi: ${profile.description || '-'}\nKategori: ${profile.category || '-'}\n${pretty(profile).slice(0, 1500)}` : 'Profil bisnis tidak ditemukan atau tidak tersedia.');
      return;
    }
    case 'setname':
      await sock.updateProfileName(cleanText(arg, 80));
      await send(sock, jid, 'Permintaan perubahan nama profil dikirim.');
      return;
    case 'setstatus':
      await sock.updateProfileStatus(cleanText(arg, 139));
      await send(sock, jid, 'Permintaan perubahan status profil dikirim.');
      return;
    case 'setpp':
    case 'setgpp': {
      const quoted = await requireQuoted(sock, message, options);
      if (!unwrapContent(quoted.message).imageMessage) throw new Error(`Reply pesan gambar dengan perintah ${PREFIX}${cmd}.`);
      const buffer = await downloadMediaMessage(quoted, 'buffer', {}, { logger: options.logger, reuploadRequest: m => sock.updateMediaMessage(m) });
      const tempPath = path.join(ROOT, `profile-${process.pid}-${Date.now()}.jpg`);
      try {
        await fs.writeFile(tempPath, Buffer.from(buffer), { mode: 0o600, flag: 'wx' });
        const ownJid = cmd === 'setgpp' ? currentGroup(message) : String(sock.user?.id || '').replace(/:\d+@/, '@');
        if (!ownJid) throw new Error('ID target belum tersedia.');
        await sock.updateProfilePicture(ownJid, { url: tempPath });
      } finally { await fs.rm(tempPath, { force: true }).catch(() => {}); }
      await send(sock, jid, cmd === 'setgpp' ? 'Permintaan perubahan foto profil grup dikirim.' : 'Permintaan perubahan foto profil dikirim.');
      return;
    }
    case 'removepp':
    case 'removegpp': {
      const ownJid = cmd === 'removegpp' ? currentGroup(message) : String(sock.user?.id || '').replace(/:\d+@/, '@');
      if (!ownJid) throw new Error('ID target belum tersedia.');
      await sock.removeProfilePicture(ownJid);
      await send(sock, jid, cmd === 'removegpp' ? 'Permintaan penghapusan foto grup dikirim.' : 'Permintaan penghapusan foto profil dikirim.');
      return;
    }
    case 'gpp': {
      const group = arg ? arg.trim() : currentGroup(message);
      if (!group.endsWith('@g.us')) throw new Error('Masukkan ID grup yang berakhiran @g.us atau gunakan ,gpp di grup.');
      const url = await sock.profilePictureUrl(group, 'image').catch(() => null);
      await send(sock, jid, url ? `Foto profil grup tersedia:\n${url}` : 'Foto profil grup tidak tersedia atau disembunyikan.');
      return;
    }
    case 'ginfo': {
      const group = currentGroup(message);
      const meta = await sock.groupMetadata(group);
      await send(sock, jid, `*${meta.subject || 'Grup'}*\nID: ${meta.id}\nAnggota: ${meta.participants?.length || 0}\nDeskripsi: ${meta.desc || '-'}\nDibuat: ${meta.creation ? new Date(Number(meta.creation) * 1000).toLocaleString('id-ID') : '-'}`);
      return;
    }
    case 'gparticipants': {
      const group = currentGroup(message);
      const meta = await sock.groupMetadata(group);
      const rows = (meta.participants || []).map((p, i) => `${i + 1}. ${p.id}${p.admin ? ` (${p.admin})` : ''}`);
      await send(sock, jid, `*Anggota ${meta.subject || group}* (${rows.length})\n${rows.join('\n') || '(kosong)'}`);
      return;
    }
    case 'glist': {
      const all = await sock.groupFetchAllParticipating();
      const rows = Object.entries(all || {}).map(([id, meta], i) => `${i + 1}. ${meta.subject || '(tanpa nama)'}\n   ${id} · ${meta.participants?.length || 0} anggota`);
      await send(sock, jid, `*Grup yang diikuti akun* (${rows.length})\n${rows.slice(0, 50).join('\n') || '(tidak ada grup)'}`);
      return;
    }
    case 'gcreate': {
      const parts = splitPipe(arg);
      if (parts.length < 2) throw new Error(`Format: ${PREFIX}gcreate Nama Grup | 628nomor1,628nomor2`);
      const title = cleanText(parts[0], 100);
      const participants = parts.slice(1).join('|').split(',').map(x => x.trim()).filter(Boolean).map(phoneJid);
      if (participants.length < 1 || participants.length > 10) throw new Error('Sertakan 1–10 peserta menggunakan nomor dengan kode negara.');
      const result = await sock.groupCreate(title, [...new Set(participants)]);
      const id = result?.id || result?.gid || '(ID tidak tersedia)';
      await send(sock, jid, `Grup dibuat atau permintaan pembuatan dikirim.\nNama: ${title}\nID: ${id}\n${pretty(result).slice(0, 1200)}`);
      return;
    }
    case 'gsubject': {
      await sock.groupUpdateSubject(currentGroup(message), cleanText(arg, 100));
      await send(sock, jid, 'Permintaan perubahan nama grup dikirim.');
      return;
    }
    case 'gdesc': {
      await sock.groupUpdateDescription(currentGroup(message), cleanText(arg, 2048));
      await send(sock, jid, 'Permintaan perubahan deskripsi grup dikirim.');
      return;
    }
    case 'gsetting': {
      const valid = ['announcement', 'not_announcement', 'locked', 'unlocked'];
      if (!valid.includes(arg)) throw new Error(`Pilihan: ${valid.join(' | ')}`);
      await sock.groupSettingUpdate(currentGroup(message), arg);
      await send(sock, jid, `Permintaan pengaturan grup dikirim: ${arg}.`);
      return;
    }
    case 'gadd': case 'gremove': case 'gpromote': case 'gdemote': {
      const target = oneTarget(message, arg);
      const action = ({ gadd: 'add', gremove: 'remove', gpromote: 'promote', gdemote: 'demote' })[cmd];
      const result = await sock.groupParticipantsUpdate(currentGroup(message), [target], action);
      await send(sock, jid, `Permintaan ${action} untuk ${target} dikirim.\n${pretty(result).slice(0, 800)}`);
      return;
    }
    case 'ginvite': {
      const code = await sock.groupInviteCode(currentGroup(message));
      await send(sock, jid, `Link undangan grup:\nhttps://chat.whatsapp.com/${code}`);
      return;
    }
    case 'grevoke': {
      const code = await sock.groupRevokeInvite(currentGroup(message));
      await send(sock, jid, `Kode undangan lama dicabut. Link baru:\nhttps://chat.whatsapp.com/${code}`);
      return;
    }
    case 'gjoin': {
      const code = arg.replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').split(/[?#\s]/)[0];
      if (!/^[A-Za-z0-9_-]{10,}$/.test(code)) throw new Error('Masukkan kode atau link undangan grup yang valid.');
      const response = await sock.groupAcceptInvite(code);
      await send(sock, jid, `Permintaan bergabung grup dikirim. ID: ${response}`);
      return;
    }
    case 'gjoinmsg': {
      if (arg !== 'CONFIRM') throw new Error(`Reply pesan undangan grup dan ketik ${PREFIX}gjoinmsg CONFIRM untuk melanjutkan.`);
      const quoted = await requireQuoted(sock, message, options);
      const invite = unwrapContent(quoted.message).groupInviteMessage;
      if (!invite) throw new Error('Pesan yang di-reply bukan undangan grup WhatsApp.');
      if (typeof sock.groupAcceptInviteV4 !== 'function') throw new Error('API groupAcceptInviteV4 tidak tersedia pada versi Baileys ini.');
      const result = await sock.groupAcceptInviteV4(quoted.key, invite);
      await send(sock, jid, `Permintaan bergabung menggunakan undangan pesan dikirim. ${result || ''}`);
      return;
    }
    case 'ginfo-code': {
      const code = arg.replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').split(/[?#\s]/)[0];
      if (!/^[A-Za-z0-9_-]{10,}$/.test(code)) throw new Error('Masukkan kode atau link undangan grup yang valid.');
      const result = await sock.groupGetInviteInfo(code);
      await send(sock, jid, `*Info undangan grup*\nNama: ${result.subject || '-'}\nID: ${result.id || '-'}\n${pretty(result).slice(0, 1500)}`);
      return;
    }
    case 'grequests': {
      const result = await sock.groupRequestParticipantsList(currentGroup(message));
      const rows = (result || []).map((x, i) => `${i + 1}. ${x.jid || x.id || pretty(x)}`);
      await send(sock, jid, `*Permintaan bergabung* (${rows.length})\n${rows.join('\n') || '(tidak ada)'}`);
      return;
    }
    case 'gapprove': case 'greject': {
      const target = oneTarget(message, arg);
      const action = cmd === 'gapprove' ? 'approve' : 'reject';
      const result = await sock.groupRequestParticipantsUpdate(currentGroup(message), [target], action);
      await send(sock, jid, `Permintaan ${action} untuk ${target} diproses.\n${pretty(result).slice(0, 800)}`);
      return;
    }
    case 'gmembermode': {
      const mode = arg === 'all' ? 'all_member_add' : arg === 'admin' ? 'admin_add' : null;
      if (!mode) throw new Error('Pilihan: all | admin');
      await sock.groupMemberAddMode(currentGroup(message), mode);
      await send(sock, jid, `Mode penambahan anggota: ${mode}.`);
      return;
    }
    case 'gephemeral': {
      const map = { off: 0, '24h': 86400, '7d': 604800, '90d': 7776000 };
      const key = arg.toLowerCase();
      if (!Object.hasOwn(map, key)) throw new Error('Pilihan: off | 24h | 7d | 90d');
      await sock.groupToggleEphemeral(currentGroup(message), map[key]);
      await send(sock, jid, `Permintaan timer pesan sementara: ${key}.`);
      return;
    }
    case 'gleave': {
      if (arg !== 'CONFIRM') throw new Error(`Bot akan keluar dari grup. Ketik ${PREFIX}gleave CONFIRM untuk melanjutkan.`);
      await sock.groupLeave(currentGroup(message));
      return;
    }
    case 'autoreject': {
      if (!['on', 'off'].includes(arg.toLowerCase())) throw new Error(`Format: ${PREFIX}autoreject on | off`);
      if (typeof options.setAutoRejectCalls !== 'function') throw new Error('Pengaturan penolakan panggilan tidak tersedia.');
      await options.setAutoRejectCalls(arg.toLowerCase() === 'on');
      await send(sock, jid, arg.toLowerCase() === 'on'
        ? 'Penolakan panggilan otomatis AKTIF. Panggilan masuk akan ditolak oleh bot.'
        : 'Penolakan panggilan otomatis NONAKTIF.');
      return;
    }
    case 'privacy': {
      const result = await sock.fetchPrivacySettings(true);
      await send(sock, jid, `*Pengaturan privasi*\n${pretty(result).slice(0, 3000)}`);
      return;
    }
    case 'blocklist': {
      const result = await sock.fetchBlocklist();
      const list = Array.isArray(result) ? result : (result?.blocklist || []);
      await send(sock, jid, `*Daftar blokir* (${list.length})\n${list.slice(0, 100).map((x, i) => `${i + 1}. ${typeof x === 'string' ? x : (x.jid || x.id || pretty(x))}`).join('\n') || '(kosong)'}`);
      return;
    }
    case 'block': case 'unblock': {
      const target = phoneJid(arg);
      await sock.updateBlockStatus(target, cmd === 'block' ? 'block' : 'unblock');
      await send(sock, jid, `Permintaan ${cmd === 'block' ? 'blokir' : 'buka blokir'} untuk ${target} dikirim.`);
      return;
    }
    case 'privacyset': {
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length < 2) throw new Error('Format: ,privacyset lastseen|online|picture|status|readreceipts|groups|disappearing NILAI');
      const [kind, value] = parts;
      const methods = {
        lastseen: { name: 'updateLastSeenPrivacy', values: ['all', 'contacts', 'contact_blacklist', 'none'] },
        online: { name: 'updateOnlinePrivacy', values: ['all', 'match_last_seen'] },
        picture: { name: 'updateProfilePicturePrivacy', values: ['all', 'contacts', 'contact_blacklist', 'none'] },
        status: { name: 'updateStatusPrivacy', values: ['all', 'contacts', 'contact_blacklist', 'none'] },
        readreceipts: { name: 'updateReadReceiptsPrivacy', values: ['all', 'none'] },
        groups: { name: 'updateGroupsAddPrivacy', values: ['all', 'contacts', 'contact_blacklist'] }
      };
      if (kind === 'disappearing') {
        const seconds = Number(value);
        if (![0, 86400, 604800, 7776000].includes(seconds)) throw new Error('Gunakan detik: 0, 86400, 604800, atau 7776000.');
        await sock.updateDefaultDisappearingMode(seconds);
      } else {
        const setting = methods[kind];
        if (!setting) throw new Error('Jenis pengaturan privasi tidak dikenal.');
        if (!setting.values.includes(value)) throw new Error(`Nilai valid: ${setting.values.join(' | ')}`);
        const method = sock[setting.name];
        if (typeof method !== 'function') throw new Error(`API ${setting.name} tidak tersedia di versi Baileys yang terpasang.`);
        await method.call(sock, value);
      }
      await send(sock, jid, `Permintaan pengaturan privasi '${kind}' dikirim.`);
      return;
    }
    default:
      throw new Error(`Perintah tidak dikenal. Gunakan ${PREFIX}help.`);
  }
}

export { BAILEYS_FEATURE_COMMANDS, FEATURE_HELP, handleBaileysFeature, splitPipe, phoneJid };
