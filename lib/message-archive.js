import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeStoredName, chooseUniqueName, resolveInside } from './file-store.js';

function messageHash(jid, id) {
  return crypto.createHash('sha256').update(`${jid}\0${id}`).digest('hex');
}

function asNumber(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.toNumber === 'function') {
    try { return value.toNumber(); } catch { return 0; }
  }
  return Number(value) || 0;
}

function hasPrivacyWrapper(message) {
  let current = message;
  for (let depth = 0; depth < 8 && current; depth++) {
    // Do not persist messages deliberately marked View Once or disappearing/ephemeral.
    if (current.viewOnceMessage || current.viewOnceMessageV2 || current.viewOnceMessageV2Extension) return true;
    if (current.ephemeralMessage) return true;
    const body = current.imageMessage || current.videoMessage || current.documentMessage
      || current.audioMessage || current.stickerMessage;
    if (body?.viewOnce === true || body?.isViewOnce === true) return true;
    if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
    else if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }
  return false;
}

function privateJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function mediaExt(media) {
  const declared = media?.node?.fileName;
  if (declared && path.extname(declared)) return path.extname(declared).slice(1).toLowerCase();
  const mimetype = String(media?.node?.mimetype || 'application/octet-stream').toLowerCase();
  const knownExtensions = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/octet-stream': 'bin'
  };
  return knownExtensions[mimetype] || ({
    imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg', stickerMessage: 'webp', documentMessage: 'bin'
  }[media?.type] || 'bin');
}

function mediaBytes(media) {
  return asNumber(media?.node?.fileLength);
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, filePath);
}

class MessageArchive {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir);
    this.cacheDir = path.resolve(this.rootDir, options.cacheDir || './data/archive-cache');
    this.deletedDir = path.resolve(this.rootDir, options.deletedDir || './data/deleted');
    this.settingsPath = path.resolve(this.rootDir, options.settingsPath || './data/archive-chats.json');
    this.retentionDays = Math.max(1, Number(options.retentionDays) || 7);
    this.settings = { chats: {} };
    this.lastPruneAt = 0;
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.cacheDir, 'media'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.deletedDir, 'media'), { recursive: true, mode: 0o700 });
    await fs.chmod(this.cacheDir, 0o700).catch(() => {});
    await fs.chmod(path.join(this.cacheDir, 'media'), 0o700).catch(() => {});
    await fs.chmod(this.deletedDir, 0o700).catch(() => {});
    await fs.chmod(path.join(this.deletedDir, 'media'), 0o700).catch(() => {});
    try {
      const parsed = JSON.parse(await fs.readFile(this.settingsPath, 'utf8'));
      if (parsed && parsed.chats && typeof parsed.chats === 'object') this.settings = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      await this.saveSettings();
    }
    await this.pruneExpired(true);
  }

  async saveSettings() {
    await writeJsonAtomic(this.settingsPath, this.settings);
  }

  status(jid) {
    return this.settings.chats[jid]?.status || 'off';
  }

  async requestConsent(jid) {
    if (this.status(jid) === 'enabled') return 'enabled';
    if (this.status(jid) === 'pending') return 'pending';
    this.settings.chats[jid] = { status: 'pending', requestedAt: Date.now() };
    await this.saveSettings();
    return 'created';
  }

  async approve(jid) {
    if (this.status(jid) !== 'pending') return false;
    this.settings.chats[jid] = {
      status: 'enabled',
      requestedAt: this.settings.chats[jid].requestedAt || Date.now(),
      approvedAt: Date.now()
    };
    await this.saveSettings();
    return true;
  }

  async disable(jid) {
    // Withdrawal/off also clears queued messages that have not been deleted yet.
    let entries = [];
    try { entries = await fs.readdir(this.cacheDir, { withFileTypes: true }); } catch { /* cache may not exist */ }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const jsonPath = path.join(this.cacheDir, entry.name);
      let record;
      try { record = JSON.parse(await fs.readFile(jsonPath, 'utf8')); } catch { continue; }
      if (record.chatJid !== jid) continue;
      if (record.mediaPath) {
        try { await fs.rm(resolveInside(this.cacheDir, record.mediaPath), { force: true }); } catch { /* best effort */ }
      }
      await fs.rm(jsonPath, { force: true }).catch(() => {});
    }
    this.settings.chats[jid] = { status: 'off', updatedAt: Date.now() };
    await this.saveSettings();
  }

  async pruneExpired(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPruneAt < 60 * 60 * 1000) return;
    this.lastPruneAt = now;
    let entries = [];
    try { entries = await fs.readdir(this.cacheDir, { withFileTypes: true }); } catch { return; }
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const jsonPath = path.join(this.cacheDir, entry.name);
      let record;
      try { record = JSON.parse(await fs.readFile(jsonPath, 'utf8')); } catch { continue; }
      if (Number(record.archivedAt) >= cutoff) continue;
      if (record.mediaPath) {
        try { await fs.rm(resolveInside(this.cacheDir, record.mediaPath), { force: true }); } catch { /* best effort */ }
      }
      await fs.rm(jsonPath, { force: true }).catch(() => {});
    }
  }

  async archiveIncoming({ sock, message, body, media, downloadMediaMessage, logger, maxMediaBytes, skip = false }) {
    const key = message?.key || {};
    const jid = String(key.remoteJid || '');
    if (key.fromMe || !privateJid(jid) || jid === 'status@broadcast' || !key.id) return false;
    if (this.status(jid) !== 'enabled' || skip || hasPrivacyWrapper(message.message)) return false;
    if (!body && !media) return false;

    await this.pruneExpired(false);
    const hash = messageHash(jid, key.id);
    const jsonPath = path.join(this.cacheDir, `${hash}.json`);
    try {
      await fs.access(jsonPath);
      return false; // Duplicate upsert; avoid duplicate media copies.
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    let record = {
      id: key.id,
      chatJid: jid,
      senderJid: key.participant || key.remoteJid,
      pushName: message.pushName || '',
      timestamp: asNumber(message.messageTimestamp),
      archivedAt: Date.now(),
      body: String(body || ''),
      mediaType: media?.type || null,
      mediaFileName: media?.node?.fileName ? sanitizeStoredName(media.node.fileName) : null,
      mimetype: media?.node?.mimetype || null,
      mediaPath: null,
      mediaSize: mediaBytes(media),
      mediaArchiveStatus: media ? 'not-downloaded' : 'none'
    };

    if (media && downloadMediaMessage) {
      const declared = mediaBytes(media);
      if (declared > maxMediaBytes) {
        record.mediaArchiveStatus = `skipped-over-limit-${declared}`;
      } else {
        try {
          const content = await downloadMediaMessage(message, 'buffer', {}, {
            logger,
            reuploadRequest: (m) => sock.updateMediaMessage(m)
          });
          const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
          if (buffer.length && buffer.length <= maxMediaBytes) {
            const ext = mediaExt(media);
            const base = record.mediaFileName || `media-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
            const desiredName = sanitizeStoredName(base);
            const cacheMediaDir = path.join(this.cacheDir, 'media');
            await fs.mkdir(cacheMediaDir, { recursive: true, mode: 0o700 });
            const preferred = `${hash}-${desiredName}`;
            const name = await chooseUniqueName(cacheMediaDir, preferred);
            const dest = resolveInside(cacheMediaDir, name);
            await fs.writeFile(dest, buffer, { flag: 'wx', mode: 0o600 });
            record.mediaPath = path.relative(this.cacheDir, dest);
            record.mediaSize = buffer.length;
            record.mediaFileName = desiredName;
            record.mediaArchiveStatus = 'saved';
          } else {
            record.mediaArchiveStatus = buffer.length ? 'skipped-over-limit-after-download' : 'empty-media';
          }
        } catch (error) {
          record.mediaArchiveStatus = 'download-failed';
          // Do not flood logs; message text can still be archived for anti-delete.
          if (process.env.KAMLZBOT_VERBOSE_ARCHIVE === '1') console.warn('[ARCHIVE] Gagal meng-cache media biasa:', error?.message || error);
        }
      }
    }

    await writeJsonAtomic(jsonPath, record);
    return true;
  }

  async handleRevoked(sock, key, ownerJid) {
    const jid = String(key?.remoteJid || '');
    const id = String(key?.id || '');
    if (!jid || !id) return false;
    const hash = messageHash(jid, id);
    const jsonPath = path.join(this.cacheDir, `${hash}.json`);
    let record;
    try { record = JSON.parse(await fs.readFile(jsonPath, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let retainedMedia = null;
    if (record.mediaPath) {
      try {
        const cachedPath = resolveInside(this.cacheDir, record.mediaPath);
        const originalName = sanitizeStoredName(record.mediaFileName || `attachment.${mediaExt({ type: record.mediaType, node: { mimetype: record.mimetype } })}`);
        const mediaDir = path.join(this.deletedDir, 'media');
        await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
        const uniqueName = await chooseUniqueName(mediaDir, `${stamp}-${hash.slice(0, 10)}-${originalName}`);
        retainedMedia = resolveInside(mediaDir, uniqueName);
        await fs.copyFile(cachedPath, retainedMedia);
        await fs.chmod(retainedMedia, 0o600).catch(() => {});
        record.deletedMediaPath = path.relative(this.rootDir, retainedMedia);
      } catch (error) {
        record.deletedMediaPath = null;
        record.mediaArchiveStatus = `could-not-retain-${error?.code || 'error'}`;
      }
    }

    record.deletedAt = Date.now();
    const deletedName = `${stamp}-${hash.slice(0, 16)}.json`;
    const deletedJson = resolveInside(this.deletedDir, deletedName);
    await writeJsonAtomic(deletedJson, record);
    if (record.mediaPath) await fs.rm(resolveInside(this.cacheDir, record.mediaPath), { force: true }).catch(() => {});
    await fs.rm(jsonPath, { force: true });

    const chatLabel = jid;
    const senderLabel = record.pushName ? `${record.pushName} (${record.senderJid})` : record.senderJid;
    const details = [
      '🗑️ *Pesan yang dihapus terdeteksi (KamlzBot)*',
      `Chat: ${chatLabel}`,
      `Pengirim: ${senderLabel || '-'}`,
      `Waktu pesan: ${record.timestamp ? new Date(record.timestamp * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-'}`,
      '',
      record.body ? `Isi pesan:\n${record.body}` : '(Pesan tidak memiliki teks/caption.)',
      record.mediaArchiveStatus === 'saved' && record.deletedMediaPath
        ? `\nMedia biasa ikut disimpan: data/deleted/media/${path.basename(record.deletedMediaPath)}`
        : (record.mediaType ? `\nMedia tidak berhasil disimpan: ${record.mediaArchiveStatus}` : ''),
      `\nArsip lokal: data/deleted/${deletedName}`
    ].join('\n');

    if (ownerJid) {
      await sock.sendMessage(ownerJid, { text: details }).catch((error) => {
        if (process.env.KAMLZBOT_VERBOSE_ARCHIVE === '1') console.error('[ARCHIVE] Tidak dapat mengirim notifikasi ke owner:', error?.message || error);
      });
      if (retainedMedia) {
        await sock.sendMessage(ownerJid, {
          document: { url: retainedMedia },
          mimetype: record.mimetype || 'application/octet-stream',
          fileName: record.mediaFileName || path.basename(retainedMedia),
          caption: 'Lampiran biasa dari pesan yang dihapus; hanya disimpan pada chat yang telah menyetujui arsip.'
        }).catch((error) => { if (process.env.KAMLZBOT_VERBOSE_ARCHIVE === '1') console.error('[ARCHIVE] Tidak dapat mengirim lampiran arsip:', error?.message || error); });
      }
    }
    if (process.env.KAMLZBOT_VERBOSE_ARCHIVE === '1') console.log(`[ARCHIVE] Revoked message archived: ${deletedName}`);
    return true;
  }
}

export { MessageArchive, hasPrivacyWrapper, messageHash, privateJid };
