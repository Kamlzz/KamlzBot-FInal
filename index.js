import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  getAggregateVotesInPollMessage,
  useMultiFileAuthState,
  WAMessageStubType
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import mime from 'mime-types';
import { MessageArchive, hasPrivacyWrapper } from './lib/message-archive.js';
import {
  sanitizeStoredName,
  resolveInside,
  chooseUniqueName,
  listFiles,
  resolveFileSelector,
  formatBytes
} from './lib/file-store.js';
import { BAILEYS_FEATURE_COMMANDS, FEATURE_HELP, handleBaileysFeature } from './lib/baileys-features.js';
import { downloadSocialMedia, editStoredVideo } from './lib/media-tools.js';
import { isSignalDecryptNoise, isInitQueryTimeoutNoise, isSignalSessionBookkeepingNoise, installConsoleNoiseFilter } from './lib/log-filter.js';
import { aiProviderReady, generateAiReply, clearAiHistory } from './lib/ai.js';
import { generateImage, generateVideo, createPdfBuffer } from './lib/ai-media.js';
import { createBotBackup } from './lib/bot-backup.js';
import { translateText, getTranslationEnabled, setTranslationEnabled } from './lib/translator.js';

import { extractOriginalFilename, resolveUploadFilename, hasExpectedSize } from './lib/upfile-fix.js';
import { deleteStoredFile } from './lib/file-manager.js';
import { startNewsScheduler } from './lib/news.js';

const BAILEYS_GROUP_COMMANDS = new Set([
  'react', 'pinmsg', 'unpinmsg', 'edit', 'deleteeveryone', 'star', 'unstar', 'poll', 'pollresults', 'loc', 'contact', 'mention', 'markread', 'markunread', 'deleteforme', 'ephemeral', 'history',
  'presence', 'mute', 'pinchat', 'unpinchat', 'gpp', 'setgpp', 'removegpp', 'ginfo', 'gparticipants', 'gsubject',
  'gdesc', 'gsetting', 'gadd', 'gremove', 'gpromote', 'gdemote', 'ginvite', 'grevoke',
  'grequests', 'gapprove', 'greject', 'gmembermode', 'gephemeral', 'gleave', 'ai', 'adduser', 'users'
]);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const AUTH_DIR = path.resolve(ROOT, config.authDir || './auth');
const FILES_DIR = path.resolve(ROOT, config.filesDir || './data/files');
const PREFIX = String(config.prefix || ',');
const MEDIA_COMMANDS = new Set(['ytvideo', 'ytaudio', 'dlvideo', 'dlaudio', 'trim', 'rotate', 'slow', 'fast', 'compress']);
const KNOWN_COMMANDS = new Set(['botbackup', 'upfile', 'ls', 'dlfile', 'delfile', 'help', 'menu', 'id', 'whoami', 'archive', 'ai', 'gambar', 'video', 'pdf', 'kuota', 'kuotagemini', 'adduser', 'users', 'translate', 'tr', ...BAILEYS_FEATURE_COMMANDS, ...MEDIA_COMMANDS]);
const OWNER_NUMBER = String(config.ownerNumber || '').replace(/\D/g, '');
const MAX_UPLOAD_BYTES = Math.max(1, Number(config.maxUploadSizeMB) || 100) * 1024 * 1024;
const MAX_ARCHIVE_MEDIA_BYTES = Math.max(1, Number(config.maxArchiveMediaMB) || 20) * 1024 * 1024;
const MAX_MEDIA_PROCESS_BYTES = Math.max(1, Number(config.maxMediaProcessMB) || 100) * 1024 * 1024;
const MAX_MEDIA_DURATION_SECONDS = Math.max(60, Number(config.maxMediaDurationMinutes) || 30) * 60;
const MEDIA_TEMP_DIR = path.resolve(ROOT, config.mediaTempDir || './data/tmp');
const YTDLP_COOKIES_FILE = String(config.ytDlpCookiesFile || process.env.KAMLZBOT_YTDLP_COOKIES_FILE || '').trim();
const QUERY_TIMEOUT_MS = Math.max(30000, Number(config.defaultQueryTimeoutMs) || 90000);
const MESSAGE_STORE_MAX = Math.min(10000, Math.max(500, Number(config.messageStoreMax) || 3000));
const messageStore = new Map();
const messageObjectStore = new Map();
const lastMessageByChat = new Map();
const pollResultsStore = new Map();
const groupMetadataCache = new Map();

function messageCacheKey(key) {
  return key?.remoteJid && key?.id ? `${key.remoteJid}:${key.id}` : '';
}
function rememberMessage(message) {
  const cacheKey = messageCacheKey(message?.key);
  if (!cacheKey || !message?.message) return;
  messageStore.set(cacheKey, message.message);
  messageObjectStore.set(cacheKey, message);
  if (message.key?.remoteJid) {
    const old = lastMessageByChat.get(message.key.remoteJid);
    const newTs = Number(message.messageTimestamp || 0);
    const oldTs = Number(old?.messageTimestamp || 0);
    // History sync can deliver older messages after recent messages; never let those overwrite the latest chat key.
    if (!old || newTs >= oldTs) lastMessageByChat.set(message.key.remoteJid, message);
  }
  while (messageStore.size > MESSAGE_STORE_MAX) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
    messageObjectStore.delete(firstKey);
  }
}
function getCachedWAMessage(key) {
  const cacheKey = messageCacheKey(key);
  return cacheKey ? messageObjectStore.get(cacheKey) : undefined;
}
function getLastMessageInChat(jid) { return lastMessageByChat.get(jid); }
function getOldestMessageInChat(jid) {
  return [...messageObjectStore.values()]
    .filter(message => message?.key?.remoteJid === jid && message.messageTimestamp !== undefined && message.messageTimestamp !== null)
    .sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp))[0];
}
function queryPresence(sock, jid) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.ev.off('presence.update', listener);
      fn(value);
    };
    const listener = event => {
      if (!event || (event.id !== jid && !Object.keys(event.presences || {}).some(key => key === jid))) return;
      const entries = Object.entries(event.presences || {}).map(([userJid, presence]) => ({
        jid: userJid,
        presence: presence?.lastKnownPresence || presence?.presence || 'unknown'
      }));
      finish(resolve, { jid: event.id || jid, entries });
    };
    const timer = setTimeout(() => finish(resolve, null), 8000);
    timer.unref?.();
    sock.ev.on('presence.update', listener);
    Promise.resolve(sock.presenceSubscribe(jid)).catch(error => finish(reject, error));
  });
}
function getCachedMessage(key) {
  const cacheKey = messageCacheKey(key);
  return cacheKey ? messageStore.get(cacheKey) : undefined;
}
function getCachedPollResults(key) {
  const cacheKey = messageCacheKey(key);
  return cacheKey ? pollResultsStore.get(cacheKey) : undefined;
}
let autoRejectCalls = config.autoRejectCalls === true;

async function setAutoRejectCalls(enabled) {
  autoRejectCalls = Boolean(enabled);
  config.autoRejectCalls = autoRejectCalls;
  await fs.writeFile(path.join(ROOT, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

async function saveConfig() {
  await fs.writeFile(path.join(ROOT, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(path.join(ROOT, 'config.json'), 0o600).catch(() => {});
}

const aiBusyChats = new Set();
const aiLastReplyAt = new Map();

async function handleAiCommand(sock, wamessage, args) {
  const jid = wamessage.key.remoteJid;
  const parts = String(args || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const action = parts[0] || 'status';
  if (action === 'on' || action === 'aktif') {
    if (!aiProviderReady(config)) {
      const provider = String(config.aiProvider || 'gemini').toLowerCase();
      const keyName = provider === 'gpt' || provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
      await sock.sendMessage(jid, { text: `⚠️ Mode AI belum bisa diaktifkan. Isi ${keyName} di file .env pada folder KamlzBot, lalu restart bot. Jangan kirim API key ke WhatsApp.` });
      return;
    }
    config.aiEnabled = true;
    await saveConfig();
    await sock.sendMessage(jid, { text: `🤖 *Mode AI AKTIF*\nProvider: ${String(config.aiProvider || 'gemini').toUpperCase()}\nBot membalas chat pribadi tanpa prefix. Di grup, hanya anggota yang ditambahkan owner dengan ${PREFIX}adduser yang mendapat balasan otomatis.\n\nMatikan dengan *${PREFIX}ai off*.` });
    return;
  }
  if (action === 'off' || action === 'mati' || action === 'nonaktif') {
    config.aiEnabled = false;
    await saveConfig();
    await sock.sendMessage(jid, { text: '🛑 *Mode AI NONAKTIF.* Bot hanya menjalankan perintah dengan prefix.' });
    return;
  }
  if (action === 'provider' || action === 'model') {
    const next = parts[1];
    if (!['gemini', 'gpt', 'openai'].includes(next || '')) {
      await sock.sendMessage(jid, { text: `Provider saat ini: ${String(config.aiProvider || 'gemini').toUpperCase()}\nUbah dengan: ${PREFIX}ai provider gemini atau ${PREFIX}ai provider gpt` });
      return;
    }
    config.aiProvider = next === 'openai' ? 'gpt' : next;
    await saveConfig();
    clearAiHistory(jid);
    const keyName = config.aiProvider === 'gpt' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
    await sock.sendMessage(jid, { text: `✅ Provider AI diubah ke *${config.aiProvider.toUpperCase()}*. ${keyName} harus tersedia di .env.\nStatus mode: ${config.aiEnabled ? 'AKTIF' : 'NONAKTIF'}.` });
    return;
  }
  if (action === 'reset') {
    clearAiHistory(jid);
    await sock.sendMessage(jid, { text: '🧹 Riwayat konteks AI di RAM untuk chat ini sudah dihapus.' });
    return;
  }
  await sock.sendMessage(jid, { text: `╭─「 🤖 *KAMLZBOT AI* 」\n│ Status: *${config.aiEnabled ? 'AKTIF' : 'NONAKTIF'}*\n│ Provider: *${String(config.aiProvider || 'gemini').toUpperCase()}*\n│ API siap: *${aiProviderReady(config) ? 'YA' : 'BELUM'}*\n╰────────────────\n\n• ${PREFIX}ai on — aktifkan balasan otomatis\n• ${PREFIX}ai off — matikan\n• ${PREFIX}ai provider gemini — gunakan Gemini\n• ${PREFIX}ai provider gpt — gunakan OpenAI GPT\n• ${PREFIX}ai reset — hapus konteks chat ini\n• ${PREFIX}ai status — lihat status\n\nMode otomatis membalas chat pribadi dan grup. Di grup, hanya owner serta anggota yang ditambahkan dengan ,adduser yang mendapat balasan AI. Simpan API key di file .env, jangan di config atau chat WhatsApp.` });
}

function groupSenderCandidates(wamessage) {
  const key = wamessage?.key || {};
  return [...new Set([
    key.participant,
    key.participantAlt,
    key.participantPn,
    key.senderPn,
    wamessage?.participant,
    wamessage?.participantAlt,
    wamessage?.senderPn
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().toLowerCase()))];
}

function groupJidForMessage(wamessage) {
  const jid = String(wamessage?.key?.remoteJid || '');
  return jid.endsWith('@g.us') ? jid : '';
}

function getMessageContextInfo(wamessage) {
  const content = unwrapContent(wamessage?.message || {});
  return content.extendedTextMessage?.contextInfo
    || content.imageMessage?.contextInfo
    || content.videoMessage?.contextInfo
    || content.documentMessage?.contextInfo
    || content.audioMessage?.contextInfo
    || content.stickerMessage?.contextInfo
    || {};
}

function targetJidsFromMessage(wamessage) {
  const context = getMessageContextInfo(wamessage);
  const targets = [
    ...(Array.isArray(context.mentionedJid) ? context.mentionedJid : []),
    context.participant,
    context.participantAlt,
    context.remoteJid
  ];
  return [...new Set(targets.filter(value => typeof value === 'string' && value.trim() && !value.endsWith('@g.us')).map(value => value.trim().toLowerCase()))];
}

function sameAiUser(candidate, allowed) {
  if (candidate === allowed) return true;
  // Only compare phone-number JIDs by number. LID identifiers are opaque and must
  // never be treated as phone numbers.
  if (candidate.endsWith('@s.whatsapp.net') && allowed.endsWith('@s.whatsapp.net')) {
    return jidNumber(candidate) === jidNumber(allowed);
  }
  return false;
}

async function handleAddAiGroupUser(sock, wamessage, action = 'add') {
  const jid = wamessage.key.remoteJid;
  if (!jid.endsWith('@g.us')) {
    await sock.sendMessage(jid, { text: `Gunakan perintah ini di grup: ${PREFIX}adduser dengan me-reply pesan orangnya atau mention orangnya.` });
    return;
  }
  const targets = targetJidsFromMessage(wamessage).filter(target => !sameAiUser(target, `${OWNER_NUMBER}@s.whatsapp.net`));
  if (!targets.length) {
    await sock.sendMessage(jid, { text: `Cara pakai: reply pesan orang yang ingin diizinkan lalu ketik *${PREFIX}adduser*, atau ketik *${PREFIX}adduser @mention*.` });
    return;
  }
  if (!config.aiGroupUsers || typeof config.aiGroupUsers !== 'object' || Array.isArray(config.aiGroupUsers)) config.aiGroupUsers = {};
  const current = Array.isArray(config.aiGroupUsers[jid]) ? config.aiGroupUsers[jid] : [];
  const normalized = [...new Set(current.filter(value => typeof value === 'string').map(value => value.toLowerCase()))];
  const changed = [];
  for (const target of targets) {
    if (action === 'remove') {
      const before = normalized.length;
      for (let i = normalized.length - 1; i >= 0; i--) {
        if (sameAiUser(normalized[i], target)) normalized.splice(i, 1);
      }
      if (normalized.length !== before) changed.push(target);
    } else if (!normalized.some(value => sameAiUser(value, target))) {
      normalized.push(target);
      changed.push(target);
    }
  }
  config.aiGroupUsers[jid] = normalized;
  await saveConfig();
  const mentionLines = (changed.length ? changed : targets).map(target => `• @${target.split('@')[0]}`).join('\n');
  const status = action === 'remove'
    ? (changed.length ? 'akses AI grup dicabut dari' : 'tidak ditemukan dalam daftar izin')
    : (changed.length ? 'diizinkan menggunakan AI otomatis di grup ini' : 'sudah ada dalam daftar izin');
  await sock.sendMessage(jid, {
    text: `👥 *Daftar akses AI grup*\n${mentionLines}\n\nStatus: ${status}.\n${config.aiEnabled ? 'Mode AI sedang aktif.' : `Mode AI masih nonaktif. Owner dapat mengaktifkannya dengan ${PREFIX}ai on.`}`,
    mentions: targets
  });
}

async function handleAiGroupUsers(sock, wamessage) {
  const jid = wamessage.key.remoteJid;
  if (!jid.endsWith('@g.us')) {
    await sock.sendMessage(jid, { text: 'Perintah ini hanya untuk grup.' });
    return;
  }
  const users = Array.isArray(config.aiGroupUsers?.[jid]) ? config.aiGroupUsers[jid] : [];
  await sock.sendMessage(jid, {
    text: users.length
      ? `👥 *Pengguna yang diizinkan memakai AI di grup ini*\n${users.map(value => `• @${value.split('@')[0]}`).join('\n')}`
      : 'Belum ada pengguna yang ditambahkan. Reply pesan anggota lalu ketik ,adduser.',
    mentions: users
  });
}

async function handleAutoAiReply(sock, wamessage, body) {
  if (!config.aiEnabled || wamessage?.key?.fromMe || !body || !String(body).trim()) return;
  if (wamessage.key?.remoteJid === 'status@broadcast') return;
  const jid = wamessage.key.remoteJid;
  const groupJid = groupJidForMessage(wamessage);
  if (!isPrivateChat(wamessage) && !groupJid) return;
  if (parseCommand(body)) return;
  if (groupJid) {
    const allowed = Array.isArray(config.aiGroupUsers?.[groupJid]) ? config.aiGroupUsers[groupJid] : [];
    const senderCandidates = groupSenderCandidates(wamessage);
    const permitted = senderCandidates.some(candidate => allowed.some(entry => sameAiUser(candidate, String(entry).toLowerCase())));
    if (!permitted && !(await isOwnerMessage(sock, wamessage))) return;
  }
  if (aiBusyChats.has(jid)) return;
  const now = Date.now();
  if (now - (aiLastReplyAt.get(jid) || 0) < 1200) return;
  aiBusyChats.add(jid);
  aiLastReplyAt.set(jid, now);
  try {
    const answer = await generateAiReply(jid, body, config);
    await sock.sendMessage(jid, { text: answer }, { quoted: wamessage });
  } catch (error) {
    const detail = String(error?.message || error);
    console.error(`[AI] ${detail.slice(0, 500)}`);
    const safeMessage = /API key .* belum diatur/.test(detail)
      ? '⚠️ Mode AI aktif tetapi API key belum tersedia. Hubungi owner untuk mengatur .env.'
      : /API (?:401|403)/.test(detail)
        ? '⚠️ API AI menolak akses. Owner perlu memeriksa API key dan akses/billing provider.'
        : /API 429/.test(detail)
          ? '⚠️ Kuota atau rate limit AI sedang tercapai. Coba lagi nanti.'
          : '⚠️ Maaf, layanan AI sedang gagal merespons. Coba lagi sebentar.';
    await sock.sendMessage(jid, { text: safeMessage }, { quoted: wamessage }).catch(() => {});
  } finally {
    aiBusyChats.delete(jid);
  }
}
const archiveStore = new MessageArchive(ROOT, {
  cacheDir: config.archiveCacheDir || './data/archive-cache',
  deletedDir: config.deletedDir || './data/deleted',
  settingsPath: config.archiveSettingsPath || './data/archive-chats.json',
  retentionDays: config.archiveRetentionDays || 7
});
// Filter only known repetitive/non-fatal protocol logs; preserve other errors.
const logger = pino({
  // Quiet by default: set BAILEYS_LOG_LEVEL=warn only when debugging Baileys internals.
  level: process.env.BAILEYS_LOG_LEVEL || 'silent',
  hooks: {
    logMethod(args, method) {
      if (isSignalDecryptNoise(args) || isInitQueryTimeoutNoise(args) || isSignalSessionBookkeepingNoise(args)) return;
      method.apply(this, args);
    }
  }
});
let reconnectTimer = null;
installConsoleNoiseFilter(console);

if (!OWNER_NUMBER) {
  throw new Error('ownerNumber belum diisi di config.json.');
}
if (!PREFIX || PREFIX.length > 3) {
  throw new Error('Prefix di config.json tidak valid.');
}

function unwrapContent(content) {
  let current = content;
  for (let i = 0; i < 6 && current; i++) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }
  return current || {};
}

function messageBody(wamessage) {
  const content = unwrapContent(wamessage.message);
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || content.audioMessage?.caption
    || '';
}

function getMediaNode(wamessage) {
  const content = unwrapContent(wamessage?.message);
  const mediaTypes = [
    'documentMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'
  ];
  for (const type of mediaTypes) {
    if (content[type]) return { type, node: content[type] };
  }
  return null;
}

function quotedWAMessage(commandMessage) {
  const content = unwrapContent(commandMessage?.message || {});
  const context = content.extendedTextMessage?.contextInfo
    || content.imageMessage?.contextInfo
    || content.videoMessage?.contextInfo
    || content.documentMessage?.contextInfo
    || content.audioMessage?.contextInfo
    || content.stickerMessage?.contextInfo
    || content.messageContextInfo
    || {};
  if (!context?.stanzaId && !context?.quotedMessage) return null;

  const remoteJid = String(commandMessage?.key?.remoteJid || '');
  // Original WAMessage is more complete than a quoted-message preview when it is in cache.
  if (context.stanzaId && remoteJid) {
    const cached = getCachedWAMessage({ remoteJid, id: context.stanzaId });
    if (cached?.message) return cached;
  }
  if (!context.quotedMessage) return null;

  const key = {
    remoteJid,
    id: context.stanzaId,
    fromMe: Boolean(context.fromMe)
  };
  if (context.participant) key.participant = context.participant;
  if (context.participantAlt) key.participantAlt = context.participantAlt;
  return { key, message: context.quotedMessage };
}

function jidNumber(jid) {
  if (!jid) return '';
  // Drop device suffixes used by some multi-device JIDs, then compare the phone digits.
  const userPart = String(jid).split('@')[0].split(':')[0];
  return userPart.replace(/\D/g, '');
}

function messageJidCandidates(wamessage) {
  const key = wamessage?.key || {};
  // Baileys versions differ in which alternate PN/LID fields they expose.
  return [...new Set([
    key.participant,
    key.participantAlt,
    key.participantPn,
    key.senderPn,
    key.remoteJid,
    key.remoteJidAlt,
    wamessage?.participant,
    wamessage?.participantAlt,
    wamessage?.senderPn
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

async function getPhoneForJid(sock, jid) {
  if (!jid) return '';
  // A LID is an opaque WhatsApp account ID; its digits are NOT a phone number.
  if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) {
    try {
      const mapping = sock.signalRepository?.lidMapping;
      const mapped = await mapping?.getPNForLID?.(jid);
      if (mapped) return String(mapped);
      // Some Baileys builds expose the plural getter but not the singular getter.
      const mappings = await mapping?.getPNsForLIDs?.([jid]);
      if (Array.isArray(mappings)) {
        const entry = mappings.find(item => item?.lid === jid);
        if (entry?.pn) return String(entry.pn);
      }
    } catch {
      // A mapping may not have been received/stored yet. ownerLids is the safe manual fallback.
    }
    return '';
  }
  return jid;
}

async function isOwnerMessage(sock, wamessage) {
  const candidates = messageJidCandidates(wamessage);
  const ownerLids = Array.isArray(config.ownerLids)
    ? config.ownerLids.map(value => String(value).trim().toLowerCase()).filter(Boolean)
    : [];

  // Explicit LID allow-list is useful when WhatsApp has not supplied a PN↔LID mapping.
  if (candidates.some(jid => ownerLids.includes(jid.toLowerCase()))) return true;

  for (const jid of candidates) {
    const phoneJid = await getPhoneForJid(sock, jid);
    if (phoneJid && !(phoneJid.endsWith('@lid') || phoneJid.endsWith('@hosted.lid'))
        && jidNumber(phoneJid) === OWNER_NUMBER) return true;
  }
  return false;
}

async function identityDiagnostic(sock, wamessage) {
  const key = wamessage?.key || {};
  const candidates = messageJidCandidates(wamessage);
  const mapped = [];
  for (const jid of candidates) {
    if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) {
      const phone = await getPhoneForJid(sock, jid);
      mapped.push(`${jid} → ${phone || '(belum ada mapping nomor)'}`);
    }
  }
  const fields = [
    '*Diagnostik identitas KamlzBot*',
    `remoteJid: ${key.remoteJid || '-'}`,
    `remoteJidAlt: ${key.remoteJidAlt || '-'}`,
    `participant: ${key.participant || '-'}`,
    `participantAlt: ${key.participantAlt || '-'}`,
    `participantPn/senderPn: ${key.participantPn || key.senderPn || '-'}`,
    `fromMe: ${String(key.fromMe ?? '-')}`,
    `Owner config: ${OWNER_NUMBER}`,
    `Mapping LID: ${mapped.length ? mapped.join('; ') : '(tidak ada LID pada pesan ini)'}`,
    '',
    'Kirim hasil ini hanya kepada admin bot. Jika remoteJid adalah ...@lid dan mapping belum ada, tambahkan LID tersebut ke ownerLids pada config.json.'
  ];
  return fields.join('\n');
}

function isPrivateChat(wamessage) {
  const jid = String(wamessage.key?.remoteJid || '');
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function mediaSize(mediaNode) {
  const raw = mediaNode?.node?.fileLength;
  if (raw === undefined || raw === null) return 0;
  try {
    if (typeof raw === 'number') return raw;
    if (typeof raw.toNumber === 'function') return raw.toNumber();
    return Number(raw) || 0;
  } catch {
    return 0;
  }
}

function fallbackFilename(mediaType, mediaNode) {
  const declaredName = mediaNode?.node?.fileName;
  if (declaredName && String(declaredName).trim()) return String(declaredName).trim();

  const mimetype = mediaNode?.node?.mimetype || (mediaType === 'stickerMessage' ? 'image/webp' : 'application/octet-stream');
  const extension = mime.extension(mimetype) || ({
    documentMessage: 'bin', imageMessage: 'jpg', videoMessage: 'mp4',
    audioMessage: 'ogg', stickerMessage: 'webp'
  }[mediaType] || 'bin');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = mediaType.replace('Message', '').toLowerCase();
  return `${label}-${stamp}.${extension}`;
}

function parseCommand(body) {
  const text = String(body || '').trim();
  if (!text.startsWith(PREFIX)) return null;
  const afterPrefix = text.slice(PREFIX.length).trimStart();
  if (!afterPrefix) return null;
  const match = afterPrefix.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

async function sendLongText(sock, jid, content) {
  const maxLength = 3200;
  const text = String(content);
  for (let offset = 0; offset < text.length; offset += maxLength) {
    await sock.sendMessage(jid, { text: text.slice(offset, offset + maxLength) });
  }
}

async function handleUpfile(sock, wamessage, args) {
  const quoted = quotedWAMessage(wamessage);
  const mediaMessage = quoted || (getMediaNode(wamessage) ? wamessage : null);
  const jid = String(wamessage?.key?.remoteJid || '');
  if (!mediaMessage) {
    await sock.sendMessage(jid, {
      text: `Balas/reply file, foto, video, audio, atau stiker dengan perintah ${PREFIX}upfile.\nOpsional: ${PREFIX}upfile nama-baru.pdf`
    });
    return;
  }

  const media = getMediaNode(mediaMessage);
  if (!media) {
    await sock.sendMessage(jid, { text: 'Pesan yang dipilih tidak berisi file/media yang didukung.' });
    return;
  }

  // Search the full WAMessage first (including cached original message), then quote preview.
  const originalFilename = extractOriginalFilename(mediaMessage)
    || extractOriginalFilename(wamessage)
    || extractOriginalFilename(media);
  const announcedSize = mediaSize(media);
  if (announcedSize > MAX_UPLOAD_BYTES) {
    await sock.sendMessage(jid, {
      text: `File terlalu besar (${formatBytes(announcedSize)}). Batas upload saat ini ${formatBytes(MAX_UPLOAD_BYTES)}.`
    });
    return;
  }

  await sock.sendMessage(jid, { text: 'Sedang menyimpan file ke VPS…' });
  let buffer = null;
  let downloadError = null;
  let lastDownloadedSize = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const downloaded = await downloadMediaMessage(mediaMessage, 'buffer', {}, {
        logger,
        reuploadRequest: (message) => sock.updateMediaMessage(message)
      });
      const candidate = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded || []);
      lastDownloadedSize = candidate.length;
      if (candidate.length === 0) throw new Error('Unduhan menghasilkan file kosong.');
      if (!hasExpectedSize(candidate, announcedSize)) {
        throw new Error(`Ukuran unduhan tidak cocok: diharapkan ${announcedSize} byte, diterima ${candidate.length} byte.`);
      }
      buffer = candidate;
      break;
    } catch (error) {
      downloadError = error;
      if (attempt < 2) {
        console.warn(`[UPFILE] Percobaan ${attempt} gagal/ukuran tidak cocok; mencoba ulang:`, error?.message || error);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  }

  if (!buffer) {
    console.error('[UPFILE] File tidak disimpan karena unduhan gagal/tidak utuh:', downloadError?.message || downloadError);
    const sizeInfo = announcedSize > 0
      ? `Ukuran WhatsApp: ${formatBytes(announcedSize)}; hasil terakhir: ${formatBytes(lastDownloadedSize)}.`
      : 'Ukuran file dari WhatsApp tidak tersedia.';
    await sock.sendMessage(jid, {
      text: `❌ File tidak disimpan karena unduhan gagal atau belum utuh. ${sizeInfo}\nCoba kirim ulang file ke chat, lalu reply file itu dengan ${PREFIX}upfile.`
    });
    return;
  }

  if (buffer.length > MAX_UPLOAD_BYTES) {
    await sock.sendMessage(jid, { text: `File berukuran ${formatBytes(buffer.length)} melewati batas ${formatBytes(MAX_UPLOAD_BYTES)}.` });
    return;
  }

  let desiredName = resolveUploadFilename({
    requestedName: args,
    originalFilename,
    media,
    mediaType: media.type,
    buffer,
    mimeType: media.node?.mimetype,
    timestamp: new Date()
  });
  desiredName = sanitizeStoredName(desiredName);
  await fs.mkdir(FILES_DIR, { recursive: true });
  const finalName = await chooseUniqueName(FILES_DIR, desiredName);
  const finalPath = resolveInside(FILES_DIR, finalName);
  const temporaryPath = `${finalPath}.uploading-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  const filenameSource = args ? 'nama kustom dari perintah' : originalFilename ? 'metadata file WhatsApp' : 'fallback otomatis; metadata nama tidak ditemukan';
  console.log(`[UPFILE] Saved ${finalName} (${buffer.length} bytes; filename source: ${filenameSource})`);
  const nameNote = !args && !originalFilename
    ? '\n⚠️ Nama asli tidak tersedia pada metadata pesan yang diterima bot; cek log [UPFILE] untuk diagnosis.'
    : '';
  await sock.sendMessage(jid, {
    text: `✅ File berhasil disimpan ke VPS.\nNama: ${finalName}\nUkuran: ${formatBytes(buffer.length)}\nLokasi: ${path.relative(ROOT, finalPath)}${nameNote}\nGunakan ${PREFIX}ls untuk melihat daftar file.`
  });
}

async function handleList(sock, jid) {
  const files = await listFiles(FILES_DIR);
  if (files.length === 0) {
    await sock.sendMessage(jid, { text: `Folder file masih kosong. Reply sebuah file dengan ${PREFIX}upfile untuk menyimpannya.` });
    return;
  }
  const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  const lines = files.map((item, i) => `${i + 1}. ${item.name} — ${formatBytes(item.size)}`);
  const header = `📁 *${config.botName} — Daftar File*\nJumlah: ${files.length} file | Total: ${formatBytes(totalBytes)}\nFolder: ${path.relative(ROOT, FILES_DIR)}\n\n`;
  await sendLongText(sock, jid, header + lines.join('\n') + `\n\nDownload nomor: ${PREFIX}dlfile 1\nDownload nama: ${PREFIX}dlfile nama-file.ext\nHapus nomor: ${PREFIX}delfile 1\nHapus nama: ${PREFIX}delfile nama-file.ext`);
}

async function handleDownload(sock, jid, requestedName) {
  if (!requestedName) {
    await sock.sendMessage(jid, { text: `Format: ${PREFIX}dlfile 1 atau ${PREFIX}dlfile nama-file.ext\nNomor mengacu pada urutan terbaru dari ${PREFIX}ls. Untuk nama file yang mengandung spasi, tulis nama lengkapnya.` });
    return;
  }

  let name;
  try {
    name = await resolveFileSelector(FILES_DIR, requestedName);
  } catch (error) {
    await sock.sendMessage(jid, { text: error.message });
    return;
  }

  const filePath = resolveInside(FILES_DIR, name);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await sock.sendMessage(jid, { text: `File “${name}” tidak ditemukan. Ketik ${PREFIX}ls untuk melihat nama file yang tersedia.` });
      return;
    }
    throw error;
  }
  if (!stat.isFile()) {
    await sock.sendMessage(jid, { text: 'Objek yang diminta bukan file biasa.' });
    return;
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    await sock.sendMessage(jid, {
      text: `File berukuran ${formatBytes(stat.size)} melebihi batas pengiriman ${formatBytes(MAX_UPLOAD_BYTES)}. Ubah maxUploadSizeMB di config.json bila RAM/koneksi VPS memadai.`
    });
    return;
  }

  await sock.sendMessage(jid, { text: `Mengirim ${name} (${formatBytes(stat.size)})…` });
  const mimetype = mime.lookup(name) || 'application/octet-stream';
  await sock.sendMessage(jid, {
    document: { url: filePath },
    mimetype,
    fileName: name,
    caption: `File dari ${config.botName}: ${name}`
  });
  console.log(`[DLFILE] Sent ${name} (${stat.size} bytes)`);
}

async function handleDeleteFile(sock, jid, selector) {
  if (!selector) {
    await sock.sendMessage(jid, {
      text: `Format: ${PREFIX}delfile 3 atau ${PREFIX}delfile nama-file.ext\nNomor mengacu pada urutan di ${PREFIX}ls. Penghapusan bersifat permanen.`
    });
    return;
  }
  try {
    const deleted = await deleteStoredFile(FILES_DIR, selector);
    console.log(`[DELFILE] Deleted ${deleted.name} (${deleted.size} bytes)`);
    await sock.sendMessage(jid, {
      text: `✅ File berhasil dihapus permanen.\nNama: ${deleted.name}\nUkuran: ${formatBytes(deleted.size)}\nKetik ${PREFIX}ls untuk melihat daftar terbaru.`
    });
  } catch (error) {
    await sock.sendMessage(jid, { text: `❌ Gagal menghapus file: ${String(error?.message || error)}` });
  }
}

async function handleArchiveCommand(sock, wamessage, args) {
  const jid = String(wamessage.key?.remoteJid || '');
  const action = String(args || '').trim().toLowerCase();
  if (!isPrivateChat(wamessage)) {
    await sock.sendMessage(jid, { text: 'Arsip pesan hanya tersedia di chat pribadi, bukan grup.' });
    return;
  }

  // This command is intentionally separated from file-owner authorization:
  // `fromMe` is used only for an owner-issued archive request/disable in that chat.
  if (wamessage.key?.fromMe === true) {
    if (action === 'on') {
      const requestState = await archiveStore.requestConsent(jid);
      if (requestState === 'enabled') {
        await sock.sendMessage(jid, { text: 'Arsip pesan sudah aktif di chat ini. Ketik ,archive off untuk mematikannya.' });
        return;
      }
      if (requestState === 'pending') {
        await sock.sendMessage(jid, { text: 'Permintaan persetujuan arsip sudah menunggu balasan. Arsip belum aktif sampai lawan chat membalas ,archive approve.' });
        return;
      }
      await sock.sendMessage(jid, {
        text: '🔐 *Permintaan persetujuan arsip KamlzBot*\n\n' +
          'Jika Anda setuju, pesan teks dan media biasa yang Anda kirim di chat ini dapat disimpan sementara di VPS pemilik akun agar isi pesan tetap tersedia bila pesan dihapus. Media View Once dan pesan sementara tidak disimpan.\n\n' +
          'Untuk menyetujui, balas pesan ini dengan: `,archive approve`\n' +
          'Arsip tidak aktif sebelum Anda menyetujui. Kirim `,archive off` kapan saja untuk menonaktifkannya.'
      });
      return;
    }
    if (action === 'off') {
      await archiveStore.disable(jid);
      await sock.sendMessage(jid, { text: '🛑 Arsip KamlzBot dimatikan untuk chat ini. Pesan baru tidak akan diarsipkan.' });
      return;
    }
    if (action === 'status') {
      const status = archiveStore.status(jid);
      await sock.sendMessage(jid, { text: `Status arsip chat ini: ${status}. Gunakan ,archive on untuk meminta persetujuan atau ,archive off untuk mematikan.` });
      return;
    }
    await sock.sendMessage(jid, { text: 'Format: ,archive on | ,archive status | ,archive off. Perintah on/off harus dikirim oleh pemilik akun di chat yang ingin diatur.' });
    return;
  }

  // A chat partner must explicitly agree before any message cache is created.
  if (action === 'off' || action === 'withdraw') {
    await archiveStore.disable(jid);
    await sock.sendMessage(jid, { text: '🛑 Persetujuan arsip dicabut. Arsip dimatikan dan cache pesan biasa yang belum dihapus telah dibersihkan.' });
    return;
  }
  if (action === 'approve') {
    const approved = await archiveStore.approve(jid);
    await sock.sendMessage(jid, {
      text: approved
        ? '✅ Persetujuan diterima. Arsip pesan biasa aktif untuk chat ini. Media View Once dan pesan sementara tetap dikecualikan. Pemilik akun dapat mematikannya dengan ,archive off.'
        : 'Tidak ada permintaan persetujuan arsip yang menunggu di chat ini. Arsip tetap tidak aktif.'
    });
    return;
  }
  await sock.sendMessage(jid, { text: 'Untuk menyetujui, balas ,archive approve. Untuk mencabut persetujuan, kirim ,archive withdraw atau ,archive off. Arsip tidak aktif tanpa persetujuan.' });
}

async function sendGeneratedMedia(sock, jid, filePath, name, size, mode, caption = '') {
  const stat = await fs.stat(filePath);
  const fileName = name || path.basename(filePath);
  const mimeType = mime.lookup(fileName) || 'application/octet-stream';
  const inlineLimit = 60 * 1024 * 1024;
  if (size <= inlineLimit && mode === 'video') {
    await sock.sendMessage(jid, { video: { url: filePath }, mimetype: mimeType === 'application/octet-stream' ? 'video/mp4' : mimeType, fileName, caption: caption || fileName });
  } else if (size <= inlineLimit && mode === 'audio') {
    await sock.sendMessage(jid, { audio: { url: filePath }, mimetype: 'audio/mpeg', fileName, ptt: false, caption: caption || fileName });
  } else {
    await sock.sendMessage(jid, {
      document: { url: filePath },
      mimetype: mimeType,
      fileName,
      caption: caption || `${config.botName}: ${fileName}`
    });
  }
}

async function handleSocialDownload(sock, jid, expression, mode) {
  const url = String(expression || '').trim();
  if (!url) throw new Error(`Format: ${PREFIX}${mode === 'video' ? 'ytvideo' : 'ytaudio'} https://tautan-publik`);
  await fs.mkdir(MEDIA_TEMP_DIR, { recursive: true, mode: 0o700 });
  await sock.sendMessage(jid, { text: `⏬ Mulai mengunduh ${mode === 'video' ? 'video' : 'audio MP3'}. Proses bisa memerlukan beberapa menit…` });
  let downloaded;
  try {
    downloaded = await downloadSocialMedia(url, mode, {
      tempRoot: MEDIA_TEMP_DIR,
      maxBytes: MAX_MEDIA_PROCESS_BYTES,
      timeoutMs: Math.max(1, Number(config.mediaDownloadTimeoutMinutes) || 15) * 60_000,
      cookiesFile: YTDLP_COOKIES_FILE ? path.resolve(ROOT, YTDLP_COOKIES_FILE) : ''
    });
    let preferred = downloaded.suggestedName || `media-${Date.now()}${mode === 'audio' ? '.mp3' : '.mp4'}`;
    preferred = sanitizeStoredName(preferred);
    const finalName = await chooseUniqueName(FILES_DIR, preferred);
    const finalPath = resolveInside(FILES_DIR, finalName);
    await fs.copyFile(downloaded.filePath, finalPath, 1).catch((error) => {
      if (error.code === 'EEXIST') throw new Error('Nama file hasil sudah digunakan. Coba jalankan perintah lagi.');
      throw error;
    });
    const stat = await fs.stat(finalPath);
    console.log(`[MEDIA] Downloaded ${finalName} (${stat.size} bytes)`);
    await sendGeneratedMedia(sock, jid, finalPath, finalName, stat.size, mode,
      `${mode === 'video' ? 'Video' : 'Audio MP3'} berhasil diproses dan disimpan di VPS: ${finalName}`);
  } finally {
    if (downloaded?.tempDir) await fs.rm(downloaded.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleVideoEdit(sock, jid, expression, operation) {
  if (!String(expression || '').trim()) {
    const usage = {
      trim: ',trim nama-video.mp4 | 00:00:05 | 00:00:15',
      rotate: ',rotate nama-video.mp4 | 90',
      slow: ',slow nama-video.mp4 | 0.5',
      fast: ',fast nama-video.mp4 | 1.5',
      compress: ',compress nama-video.mp4 | 28'
    }[operation];
    throw new Error(`Format: ${usage}. Simpan video terlebih dahulu dengan ,upfile; pisahkan argumen memakai tanda |.`);
  }
  await sock.sendMessage(jid, { text: `🎬 Memproses video (${operation}). Tunggu sampai selesai…` });
  const result = await editStoredVideo(FILES_DIR, expression, operation, {
    maxInputBytes: MAX_MEDIA_PROCESS_BYTES,
    maxOutputBytes: MAX_MEDIA_PROCESS_BYTES,
    maxDurationSeconds: MAX_MEDIA_DURATION_SECONDS
  });
  console.log(`[VIDEO] ${operation}: ${result.name} (${result.size} bytes)`);
  await sendGeneratedMedia(sock, jid, result.filePath, result.name, result.size, 'video', `✅ Hasil ${operation}: ${result.name}\nUkuran: ${formatBytes(result.size)}`);
}



async function updatePdfUsage(event) {
  try {
    const file = path.join(ROOT, 'data', 'ai-usage.json');
    await fs.mkdir(path.dirname(file), { recursive: true });

    let stats = {};
    try {
      stats = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {}

    stats.pdfAiRequests = Number(stats.pdfAiRequests || 0);
    stats.pdfSuccess = Number(stats.pdfSuccess || 0);
    stats.pdfFailed = Number(stats.pdfFailed || 0);

    if (event === 'request') stats.pdfAiRequests++;
    if (event === 'success') stats.pdfSuccess++;
    if (event === 'failed') stats.pdfFailed++;

    stats.lastPdfAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(stats, null, 2) + '\n');
  } catch (error) {
    console.error('[PDF USAGE] Gagal menyimpan statistik:', error.message);
  }
}

async function readPdfUsage() {
  try {
    const file = path.join(ROOT, 'data', 'ai-usage.json');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { pdfAiRequests: 0, pdfSuccess: 0, pdfFailed: 0 };
  }
}

async function handleAiMediaCommand(sock, wamessage, command, args) {
  let pdfRequestCounted = false;
  const jid = wamessage.key.remoteJid;
  const prompt = String(args || '').trim();

  if (!prompt) {
    await sock.sendMessage(jid, {
      text: `Cara pakai:\n${PREFIX}gambar deskripsi gambar\n${PREFIX}video deskripsi video\n${PREFIX}pdf topik materi`
    }, { quoted: wamessage });
    return;
  }

  if (prompt.length > 1500) {
    await sock.sendMessage(jid, {
      text: 'Prompt terlalu panjang. Maksimal 1.500 karakter.'
    }, { quoted: wamessage });
    return;
  }

  try {
    if (command === 'gambar') {
      await sock.sendMessage(jid, {
        text: '🎨 Sedang membuat gambar AI. Mohon tunggu...'
      }, { quoted: wamessage });

      const result = await generateImage(prompt);
      const imageBuffer = Buffer.isBuffer(result) ? result : result?.buffer;
      const imageMimeType = Buffer.isBuffer(result)
        ? 'image/png'
        : (result?.mimeType || 'image/png');

      if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('Hasil Pollinations bukan Buffer gambar yang valid.');
      }

      await sock.sendMessage(jid, {
        image: imageBuffer,
        mimetype: imageMimeType,
        caption: `✅ Gambar selesai dibuat.\nPrompt: ${prompt.slice(0, 500)}`
      }, { quoted: wamessage });
      return;
    }

    if (command === 'video') {
      await sock.sendMessage(jid, {
        text: '🎬 Sedang membuat video AI. Proses dapat memerlukan beberapa menit...'
      }, { quoted: wamessage });

      const buffer = await generateVideo(prompt);
      await sock.sendMessage(jid, {
        video: buffer,
        mimetype: 'video/mp4',
        caption: `✅ Video AI selesai dibuat.\nPrompt: ${prompt.slice(0, 500)}`
      }, { quoted: wamessage });
      return;
    }

    if (command === 'pdf') {
      await sock.sendMessage(jid, {
        text: '📄 Sedang menyusun materi dan membuat PDF...'
      }, { quoted: wamessage });

      const title = `Materi: ${prompt.slice(0, 100)}`;
      const instruction =
        'Buat materi terstruktur dan mudah dipahami untuk PDF. ' +
        'Gunakan bahasa yang sama dengan pengguna. Sertakan judul, pengantar, ' +
        'subjudul, penjelasan, contoh yang relevan, dan kesimpulan. Topik: ' + prompt;

      await updatePdfUsage('request');
      pdfRequestCounted = true;
      const content = await generateAiReply(jid, instruction, config);
      const pdfBuffer = await createPdfBuffer(title, content);

      const slug = prompt.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 45) || 'materi-ai';

      await sock.sendMessage(jid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `KamlzBot-${slug}.pdf`,
        caption: `✅ PDF selesai dibuat.\nTopik: ${prompt.slice(0, 300)}`
      }, { quoted: wamessage });
      await updatePdfUsage('success');
    }
  } catch (error) {
    if (command === 'pdf' && pdfRequestCounted) {
      await updatePdfUsage('failed');
    }
    const detail = String(error?.message || error);
    console.error(`[AI MEDIA ${command}] ${detail.slice(0, 700)}`);

    let message = `❌ Fitur ${command} gagal diproses.`;
    if (/GEMINI_API_KEY belum diatur/i.test(detail)) {
      message += '\nPeriksa GEMINI_API_KEY di .env.';
    } else if (/API 401|API 403|API 404/i.test(detail)) {
      message += '\nPeriksa API key, akses model, dan billing provider.';
    } else if (/API 429|quota|rate limit/i.test(detail)) {
      message += '\nKuota atau rate limit tercapai. Coba lagi nanti.';
    } else {
      message += `\nDetail: ${detail.slice(0, 800)}`;
    }

    await sock.sendMessage(jid, { text: message }, { quoted: wamessage })
      .catch(() => {});
  }
}

async function handleMessage(sock, wamessage) {
  if (!wamessage.message || wamessage.key?.remoteJid === 'status@broadcast') return;
  const parsed = parseCommand(messageBody(wamessage));
  if (!parsed) return;
  if (!KNOWN_COMMANDS.has(parsed.command)) return;

  // Intentionally log only recognized prefixed commands; never log ordinary chat text.
  console.log(`[COMMAND] ${PREFIX}${parsed.command}`);
  const jid = wamessage.key.remoteJid;
  if (parsed.command === 'archive') {
    await handleArchiveCommand(sock, wamessage, parsed.args);
    return;
  }
  // Identity diagnostics are available in private chats before owner authorization,
  // because they are needed to fix an owner-number/LID mismatch. It reveals only the
  // sender identifiers of the message that invoked it, not stored files or bot secrets.
  if (parsed.command === 'id' || parsed.command === 'whoami') {
    if (!isPrivateChat(wamessage)) {
      await sock.sendMessage(jid, { text: 'Gunakan ,id melalui chat pribadi dengan bot.' });
      return;
    }
    await sock.sendMessage(jid, { text: await identityDiagnostic(sock, wamessage) });
    return;
  }

  if (!(await isOwnerMessage(sock, wamessage))) {
    console.warn(`[OWNER DENIED] ${PREFIX}${parsed.command} invoked by a non-owner.`);
    await sock.sendMessage(jid, { text: 'Perintah ini hanya dapat digunakan oleh owner KamlzBot. Ketik ,id untuk diagnosis identitas owner.' });
    return;
  }
  // All recognized commands can be invoked in groups and private chats.
  // Owner authorization above is intentionally retained.
  const featureCommand = BAILEYS_FEATURE_COMMANDS.has(parsed.command);

  try {
    if (featureCommand) {
      await handleBaileysFeature(sock, wamessage, parsed.command, parsed.args, {
        ROOT, FILES_DIR, PREFIX, MAX_UPLOAD_BYTES, config, logger, setAutoRejectCalls, getPollResults: getCachedPollResults, getCachedWAMessage, getLastMessageInChat
      });
      return;
    }
    switch (parsed.command) {
      case 'translate': {
        const action = String(parsed.args || 'status').trim().toLowerCase();
        if (action === 'on' || action === 'off') {
          const enabled = await setTranslationEnabled(jid, action === 'on');
          await sock.sendMessage(jid, { text: enabled ? '✅ Terjemahan otomatis aktif untuk chat ini. Pesan teks yang Anda kirim sendiri akan diterjemahkan sebagai pesan terpisah.' : '🛑 Terjemahan otomatis dimatikan untuk chat ini.' }, { quoted: wamessage });
        } else if (action === 'status') {
          const enabled = await getTranslationEnabled(jid);
          await sock.sendMessage(jid, { text: `Status terjemahan otomatis: ${enabled ? 'AKTIF' : 'NONAKTIF'}\nGunakan ${PREFIX}translate on atau ${PREFIX}translate off.\nTerjemahkan manual: ${PREFIX}tr teks` }, { quoted: wamessage });
        } else {
          await sock.sendMessage(jid, { text: `Format: ${PREFIX}translate on | off | status\nManual: ${PREFIX}tr teks` }, { quoted: wamessage });
        }
        break;
      }
      case 'tr': {
        if (!parsed.args) {
          await sock.sendMessage(jid, { text: `Cara pakai: ${PREFIX}tr teks yang ingin diterjemahkan` }, { quoted: wamessage });
          break;
        }
        await sock.sendMessage(jid, { text: '⏳ Menerjemahkan…' }, { quoted: wamessage });
        try {
          const translated = await translateText(parsed.args);
          await sock.sendMessage(jid, { text: `🌐 *Terjemahan*\n\n${translated}` }, { quoted: wamessage });
        } catch (error) {
          await sock.sendMessage(jid, { text: `❌ Terjemahan gagal: ${String(error?.message || error).slice(0, 900)}` }, { quoted: wamessage });
        }
        break;
      }

      case 'botbackup': {
        await sock.sendMessage(jid, {
          text: '🗜️ Sedang membuat backup ZIP seluruh data bot. Mohon tunggu...'
        }, { quoted: wamessage });

        try {
          const backup = await createBotBackup(ROOT, FILES_DIR);
          const sizeMB = (backup.size / (1024 * 1024)).toFixed(2);

          await sock.sendMessage(jid, {
            text:
              '✅ *BACKUP KAMLBOT BERHASIL*\n\n' +
              `📦 File: ${path.basename(backup.path)}\n` +
              `📁 Data masuk ZIP: ${backup.files} file\n` +
              `💾 Ukuran: ${sizeMB} MB\n` +
              `📍 Lokasi: ${backup.path}\n\n` +
              'Simpan ZIP ini dengan aman. Backup mencakup kredensial sesi dan konfigurasi rahasia.'
          }, { quoted: wamessage });
        } catch (error) {
          console.error('[BOT BACKUP]', error.message);
          await sock.sendMessage(jid, {
            text: `❌ Backup gagal: ${String(error.message).slice(0, 500)}`
          }, { quoted: wamessage });
        }
        break;
      }
      case 'kuotagemini': {
        const stats = await readPdfUsage();
        const provider = String(config.aiProvider || 'gemini').toLowerCase();
        const isGemini = provider === 'gemini';
        const model = isGemini
          ? (process.env.GEMINI_MODEL || config.aiGeminiModel || 'gemini-2.5-flash')
          : (process.env.OPENAI_MODEL || config.aiOpenAIModel || 'gpt-4o-mini');

        const last = stats.lastPdfAt
          ? new Date(stats.lastPdfAt).toLocaleString('id-ID', {
              timeZone: 'Asia/Jakarta'
            })
          : 'Belum ada';

        const text = [
          '📊 *STATISTIK AI PDF KAMLZBOT*',
          '',
          `🤖 Provider saat ini: ${provider.toUpperCase()}`,
          `🧠 Model konfigurasi: ${model}`,
          `📨 Permintaan AI PDF: ${Number(stats.pdfAiRequests || 0)}`,
          `✅ PDF berhasil: ${Number(stats.pdfSuccess || 0)}`,
          `❌ PDF gagal: ${Number(stats.pdfFailed || 0)}`,
          `🕒 Aktivitas terakhir: ${last}`,
          '',
          'ℹ️ Statistik lokal sejak fitur dipasang, bukan sisa kuota resmi.',
          '🔎 Cek kuota resmi: https://aistudio.google.com/usage'
        ].join('\n');

        await sock.sendMessage(jid, { text });
        break;
      }
      case 'kuota': {
        const apiKey = String(process.env.POLLINATIONS_API_KEY || '').trim();

        if (!apiKey) {
          await sock.sendMessage(jid, {
            text: '❌ POLLINATIONS_API_KEY belum tersedia di .env.'
          });
          break;
        }

        const getJson = async (url) => {
          const response = await fetch(url, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: 'application/json'
            },
            signal: AbortSignal.timeout(15000)
          });

          if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            throw error;
          }

          return response.json();
        };

        const [balanceResult, usageResult] = await Promise.allSettled([
          getJson('https://gen.pollinations.ai/account/balance'),
          getJson('https://gen.pollinations.ai/account/usage?limit=5')
        ]);

        const lines = [
          '📊 *STATUS POLLINATIONS*',
          '',
          '💰 *Saldo:*'
        ];

        if (balanceResult.status === 'fulfilled') {
          const balance = Number(balanceResult.value?.balance);
          lines.push(
            Number.isFinite(balance)
              ? `• ${balance.toLocaleString('id-ID')} Pollen`
              : '• Saldo diterima, tetapi formatnya tidak dikenali.'
          );
        } else {
          const status = balanceResult.reason?.status;
          lines.push(
            status === 403
              ? '• Gagal: API key tidak memiliki izin account:balance.'
              : status === 401
                ? '• Gagal: API key tidak valid atau tidak diizinkan.'
                : `• Gagal mengambil saldo (${status || 'koneksi'}).`
          );
        }

        lines.push('', '🧾 *5 Penggunaan Terbaru:*');

        if (usageResult.status === 'fulfilled') {
          const records = Array.isArray(usageResult.value?.usage)
            ? usageResult.value.usage
            : [];

          if (records.length === 0) {
            lines.push('Belum ada data penggunaan yang dikembalikan.');
          } else {
            for (const [i, item] of records.entries()) {
              const date = item.timestamp
                ? new Date(item.timestamp).toLocaleString('id-ID', {
                    timeZone: 'Asia/Jakarta'
                  })
                : 'Waktu tidak tersedia';

              const model = String(item.model || 'Model tidak diketahui')
                .slice(0, 80);
              const cost = Number(item.cost_usd);

              lines.push(
                '',
                `${i + 1}. ${date}`,
                `   Model: ${model}`,
                `   Biaya: ${Number.isFinite(cost) ? '$' + cost.toFixed(4) : 'Tidak tersedia'}`
              );
            }
          }
        } else {
          const status = usageResult.reason?.status;
          lines.push(
            status === 403
              ? 'Tidak tersedia: API key memerlukan izin account:usage.'
              : status === 401
                ? 'Gagal: API key tidak valid atau tidak diizinkan.'
                : `Gagal mengambil riwayat (${status || 'koneksi'}).`
          );
        }

        lines.push('', '🔐 Pemeriksaan hanya untuk owner bot.');
        await sock.sendMessage(jid, { text: lines.join('\n') });
        break;
      }

      case 'upfile':
        await handleUpfile(sock, wamessage, parsed.args);
        break;
      case 'ls':
        await handleList(sock, jid);
        break;
      case 'dlfile':
        await handleDownload(sock, jid, parsed.args);
        break;
      case 'delfile':
        await handleDeleteFile(sock, jid, parsed.args);
        break;
      case 'ytvideo':
      case 'dlvideo':
        await handleSocialDownload(sock, jid, parsed.args, 'video');
        break;
      case 'ytaudio':
      case 'dlaudio':
        await handleSocialDownload(sock, jid, parsed.args, 'audio');
        break;
      case 'trim':
      case 'rotate':
      case 'slow':
      case 'fast':
      case 'compress':
        await handleVideoEdit(sock, jid, parsed.args, parsed.command);
        break;
      case 'gambar':
      case 'video':
      case 'pdf':
        await handleAiMediaCommand(sock, wamessage, parsed.command, parsed.args);
        break;
      case 'ai':
        await handleAiCommand(sock, wamessage, parsed.args);
        break;
      case 'adduser':
        await handleAddAiGroupUser(sock, wamessage, 'add');
        break;
      case 'users':
        await handleAiGroupUsers(sock, wamessage);
        break;
      case 'help':
      case 'menu':
        await sock.sendMessage(jid, {
          text: `╭━━━〔 ✨ *${config.botName.toUpperCase()}* 〕━━━╮\n` +
            `┃ 🧭 *MENU UTAMA*\n` +
            `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
            `╭─「 📁 *MANAJEMEN FILE* 」\n` +
            `│ ${PREFIX}upfile — Simpan media/file ke VPS (reply file)\n` +
            `│ ${PREFIX}ls — Daftar file tersimpan\n` +
            `│ ${PREFIX}dlfile 1 — Ambil file berdasarkan nomor\n` +
            `│ ${PREFIX}dlfile nama.ext — Ambil file berdasarkan nama\n` +
            `│ ${PREFIX}delfile 1 — Hapus file berdasarkan nomor\n` +
            `│ ${PREFIX}delfile nama.ext — Hapus file berdasarkan nama\n` +
            `╰──────────────────╯\n\n` +
            `╭─「 📥 *DOWNLOADER* 」\n` +
            `│ ${PREFIX}ytvideo URL — Video YouTube/TikTok/Instagram\n` +
            `│ ${PREFIX}ytaudio URL — Audio MP3\n` +
            `│ YouTube memakai yt-dlp dengan fallback youtubei.js tanpa cookies.\n` +
            `│ Hanya link yang dapat diakses publik; kegagalan anti-bot tetap mungkin.\n` +
            `╰──────────────────╯\n\n` +
            `╭─「 🎬 *EDIT VIDEO* 」\n` +
            `│ ${PREFIX}trim file.mp4 | mulai | akhir — Potong video\n` +
            `│ ${PREFIX}rotate file.mp4 | 90 — Putar video\n` +
            `│ ${PREFIX}slow file.mp4 | 0.5 — Perlambat\n` +
            `│ ${PREFIX}fast file.mp4 | 1.5 — Percepat\n` +
            `│ ${PREFIX}compress file.mp4 | 28 — Kompres video\n` +
            `╰──────────────────╯\n\n` +
            `╭─「 🖼️ *AI MEDIA* 」\n` +
            `│ ${PREFIX}gambar deskripsi — Buat gambar AI\n` +
            `│ ${PREFIX}video deskripsi — Buat video AI\n` +
            `│ ${PREFIX}pdf topik — Buat materi PDF dengan AI\n` +
            `╰──────────────────╯\n\n` +
            `╭─「 🤖 *AI CHAT* 」\n` +
            `│ ${PREFIX}ai — Status & panduan AI\n` +
            `│ ${PREFIX}ai on / off — Aktifkan / matikan\n` +
            `│ ${PREFIX}ai provider gemini / gpt — Pilih AI\n` +
            `│ Chat pribadi: balasan otomatis tanpa prefix.\n` +
            `│ Grup: owner tambahkan anggota dengan ${PREFIX}adduser (reply/mention).\n` +
            `│ ${PREFIX}users — daftar anggota AI yang diizinkan di grup.\n` +
            `╰──────────────────╯\n\n` +
            `╭─「 🌐 *TERJEMAHAN INDONESIA ↔ MANDARIN* 」\n` +
            `│ ${PREFIX}translate on — Aktifkan terjemahan otomatis di chat\n` +
            `│ ${PREFIX}translate off — Matikan terjemahan otomatis\n` +
            `│ ${PREFIX}translate status — Cek status\n` +
            `│ ${PREFIX}tr teks — Terjemahkan manual\n` +
            `╰──────────────────╯\n\n` +
            `╭─「 🛡️ *UTILITAS & PRIVASI* 」\n` +
            `│ ${PREFIX}id — Diagnosis identitas owner\n` +
            `│ ${PREFIX}archive status / off — Status/matikan arsip\n` +
            `│ Arsip pesan hanya aktif setelah persetujuan eksplisit.\n` +
            `╰──────────────────╯\n\n` +
            `📦 Batas file: ${config.maxUploadSizeMB} MB\n🔒 Perintah administrasi dibatasi owner.\n\n` + FEATURE_HELP
        });
        break;
    }
  } catch (error) {
    console.error(`[COMMAND ${parsed.command}]`, error?.stack || error);
    const detail = String(error?.message || error || 'Kesalahan tidak diketahui');
    const userText = ['ytvideo', 'ytaudio', 'dlvideo', 'dlaudio'].includes(parsed.command)
      ? `❌ Unduhan gagal.\n${detail.slice(0, 1800)}`
      : `Terjadi kesalahan saat menjalankan ,${parsed.command}. Periksa log terminal untuk detailnya.`;
    await sock.sendMessage(jid, { text: userText }).catch(() => {});
  }
}

async function startBot() {
  await fs.mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await archiveStore.init();
  await fs.mkdir(FILES_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let sock;
  sock = makeWASocket({
    auth: state,
    logger,
    browser: config.syncFullHistory === true ? Browsers.macOS('Desktop') : [config.botName || 'KamlzBot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: QUERY_TIMEOUT_MS,
    syncFullHistory: config.syncFullHistory === true,
    getMessage: async (key) => getCachedMessage(key),
    cachedGroupMetadata: async (jid) => {
      const cached = groupMetadataCache.get(jid);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      try {
        const metadata = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, { value: metadata, expiresAt: Date.now() + 5 * 60 * 1000 });
        return metadata;
      } catch {
        return undefined;
      }
    },
    generateHighQualityLinkPreview: false
  });

  // Tandai ID pesan yang dikirim oleh bot agar echo bot tidak diterjemahkan ulang.
  const botSentIds = new Set();
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const result = await originalSendMessage(...args);
    const id = result?.key?.id;
    if (id) {
      botSentIds.add(`${result.key.remoteJid || args[0]}:${id}`);
      if (botSentIds.size > 2000) botSentIds.delete(botSentIds.values().next().value);
    }
    return result;
  };
  sock.__kamlzBotSentIds = botSentIds;


  sock.ev.on('call', async (calls) => {
    if (!autoRejectCalls) return;
    for (const call of Array.isArray(calls) ? calls : []) {
      if (call?.status !== 'offer' || !call?.id || !call?.from) continue;
      try {
        await sock.rejectCall(call.id, call.from);
        console.log('[CALL] Incoming call rejected by owner setting.');
      } catch (error) {
        console.error('[CALL] Failed to reject incoming call:', error?.message || error);
      }
    }
  });

  sock.ev.on('groups.update', (updates) => {
    for (const update of updates || []) if (update?.id) groupMetadataCache.delete(update.id);
  });
  sock.ev.on('group-participants.update', (update) => {
    if (update?.id) groupMetadataCache.delete(update.id);
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messaging-history.set', ({ messages = [] } = {}) => {
    for (const message of messages) rememberMessage(message);
  });
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && process.env.KAMLZBOT_PAIRING_CODE !== '1') {
      console.log('\nScan QR berikut melalui WhatsApp > Perangkat tertaut > Tautkan perangkat:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log(`✅ ${config.botName} terhubung ke WhatsApp.`);
      console.log(`📂 Folder file: ${FILES_DIR}`);
      console.log(`🔑 Owner: ${OWNER_NUMBER} | Prefix: ${PREFIX}`);
      startNewsScheduler(sock, config, ROOT, OWNER_NUMBER);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
        || lastDisconnect?.error?.statusCode
        || (lastDisconnect?.error ? new Boom(lastDisconnect.error).output?.statusCode : undefined);
      console.warn(`Koneksi WhatsApp terputus. Status: ${statusCode || 'tidak diketahui'}`);
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('Sesi logout dari WhatsApp. Hapus folder auth hanya jika Anda memang ingin menautkan ulang akun.');
        return;
      }
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startBot().catch((error) => console.error('Gagal menyambungkan ulang:', error));
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const message of messages) {
      rememberMessage(message);
      const body = messageBody(message);
      const parsed = parseCommand(body);
      const recognizedCommand = Boolean(parsed && KNOWN_COMMANDS.has(parsed.command));
      try {
        const ownArchiveCommand = message?.key?.fromMe === true
          && parsed?.command === 'archive';
        // Handle fresh incoming messages, plus archive commands mirrored from the owner's phone.
        if (type !== 'notify' && !ownArchiveCommand) continue;

        if (type === 'notify') {
          // Archive processing runs only for chats that explicitly opted in. It stays quiet
          // for ordinary messages; enable KAMLZBOT_VERBOSE_ARCHIVE=1 for archive diagnostics.
          const media = hasPrivacyWrapper(message.message) ? null : getMediaNode(message);
          await archiveStore.archiveIncoming({
            sock,
            message,
            body,
            media,
            downloadMediaMessage,
            logger,
            maxMediaBytes: MAX_ARCHIVE_MEDIA_BYTES,
            skip: Boolean(parsed)
          }).catch((error) => {
            if (recognizedCommand || process.env.KAMLZBOT_VERBOSE_ARCHIVE === '1') {
              console.error('[ARCHIVE] Gagal menyimpan cache pesan:', error?.stack || error);
            }
          });
        }

        await handleMessage(sock, message);
        if (type === 'notify' && message?.key?.fromMe && !recognizedCommand && body.trim()
          && !String(message?.key?.remoteJid || '').endsWith('@status')
          && !sock.__kamlzBotSentIds?.has(`${message.key.remoteJid}:${message.key.id}`)) {
          try {
            if (await getTranslationEnabled(message.key.remoteJid)) {
              const translated = await translateText(body);
              await sock.sendMessage(message.key.remoteJid, { text: `🌐 *Terjemahan*\n${translated}` });
            }
          } catch (error) {
            console.error('[TRANSLATE AUTO]', String(error?.message || error).slice(0, 400));
          }
        }
        if (type === 'notify' && !message?.key?.fromMe && !recognizedCommand) {
          await handleAutoAiReply(sock, message, body);
        }
      } catch (error) {
        // Do not print repeated failures for non-command chat traffic by default.
        if (recognizedCommand || process.env.KAMLZBOT_VERBOSE_NON_COMMAND_ERRORS === '1') {
          console.error('Kesalahan pemrosesan pesan:', error?.stack || error);
        }
      }
    }
  });

  if (process.env.KAMLZBOT_PAIRING_CODE === '1' && !state.creds.registered) {
    const pairingNumber = String(config.pairingCodeNumber || OWNER_NUMBER).replace(/\D/g, '');
    if (pairingNumber.length >= 8) {
      sock.requestPairingCode(pairingNumber)
        .then(code => console.log(`[PAIRING CODE] ${code}`))
        .catch(error => console.error('[PAIRING CODE] Gagal meminta kode pairing:', error?.message || error));
    } else {
      console.error('[PAIRING CODE] Atur pairingCodeNumber di config.json dengan kode negara, tanpa tanda +.');
    }
  }

  sock.ev.on('messages.update', async (updates) => {
    for (const item of updates || []) {
      const update = item?.update || {};
      if (Array.isArray(update.pollUpdates) && update.pollUpdates.length && typeof getAggregateVotesInPollMessage === 'function') {
        const pollCreation = getCachedMessage(item.key);
        if (pollCreation) {
          try {
            const aggregate = getAggregateVotesInPollMessage({ message: pollCreation, pollUpdates: update.pollUpdates });
            const cacheKey = messageCacheKey(item.key);
            if (cacheKey) {
              pollResultsStore.set(cacheKey, aggregate);
              while (pollResultsStore.size > 250) pollResultsStore.delete(pollResultsStore.keys().next().value);
            }
          } catch (error) {
            if (process.env.KAMLZBOT_VERBOSE_POLLS === '1') console.error('[POLL] Gagal mengagregasi vote:', error?.message || error);
          }
        }
      }
      const revokeStub = WAMessageStubType?.REVOKE;
      const revoked = (revokeStub !== undefined && update.messageStubType === revokeStub)
        || (Object.prototype.hasOwnProperty.call(update, 'message') && update.message === null);
      if (!revoked) continue;
      try {
        const ownerJid = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : '';
        await archiveStore.handleRevoked(sock, item.key, ownerJid);
      } catch (error) {
        if (process.env.KAMLZBOT_VERBOSE_ARCHIVE === '1') {
          console.error('[ARCHIVE] Gagal memproses pesan terhapus:', error?.stack || error);
        }
      }
    }
  });
}

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
startBot().catch((error) => {
  console.error('KamlzBot gagal dijalankan:', error?.stack || error);
  process.exitCode = 1;
});
