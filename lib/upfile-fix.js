import path from 'node:path';

const MIME_EXTENSIONS = new Map([
  ['application/pdf', 'pdf'], ['application/zip', 'zip'], ['application/x-zip-compressed', 'zip'],
  ['application/vnd.rar', 'rar'], ['application/x-rar-compressed', 'rar'], ['application/x-7z-compressed', '7z'],
  ['application/gzip', 'gz'], ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'], ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-powerpoint', 'ppt'], ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['text/plain', 'txt'], ['text/csv', 'csv'], ['application/json', 'json'],
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ['image/heic', 'heic'], ['image/heif', 'heif'], ['video/mp4', 'mp4'], ['video/quicktime', 'mov'],
  ['video/webm', 'webm'], ['audio/mpeg', 'mp3'], ['audio/ogg', 'ogg'], ['audio/mp4', 'm4a'],
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav']
]);

const MESSAGE_CHILD_KEYS = new Set([
  'message', 'quotedMessage', 'documentMessage', 'imageMessage', 'videoMessage', 'audioMessage',
  'stickerMessage', 'documentWithCaptionMessage', 'ephemeralMessage', 'viewOnceMessage',
  'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'extendedTextMessage', 'contextInfo',
  'messageContextInfo', 'editedMessage'
]);

function cleanCandidate(value) {
  if (typeof value !== 'string') return '';
  const result = value.trim().replace(/\\/g, '/').split('/').pop();
  if (!result || result === '.' || result === '..' || result.length > 240) return '';
  // Do not accept control characters; the downstream storage layer handles other unsafe punctuation.
  if (/[\x00-\x1f\x7f]/.test(result)) return '';
  return result;
}

/**
 * Extract a filename from a Baileys WAMessage or quoted message. The full original
 * WAMessage is preferred because quotedMessage in WhatsApp contextInfo can omit fields.
 */
export function extractOriginalFilename(messageLike) {
  if (!messageLike || typeof messageLike !== 'object') return '';
  const queue = [{ value: messageLike, depth: 0 }];
  const seen = new Set();
  let visited = 0;
  const weakCandidates = [];

  while (queue.length && visited < 160) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 12) continue;
    seen.add(value);
    visited += 1;

    // Explicit filename fields are authoritative and searched before weaker title/name fields.
    for (const key of ['fileName', 'filename', 'file_name', 'originalFileName', 'originalFilename']) {
      const candidate = cleanCandidate(value[key]);
      if (candidate) return candidate;
    }
    for (const key of ['displayName', 'title', 'name']) {
      const candidate = cleanCandidate(value[key]);
      if (candidate && /\.[a-z0-9]{1,12}$/i.test(candidate)) weakCandidates.push(candidate);
    }

    for (const [key, child] of Object.entries(value)) {
      if (MESSAGE_CHILD_KEYS.has(key) && child && typeof child === 'object') {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return weakCandidates[0] || '';
}

function extensionFromSignature(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length < 4) return '';
  const ascii = buffer.toString('latin1', 0, Math.min(buffer.length, 8192));
  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'wav';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') return 'avi';
  if (ascii.length >= 12 && ascii.slice(4, 8) === 'ftyp') return 'mp4';
  if (ascii.startsWith('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'mp3';
  if (ascii.startsWith('Rar!\x1a\x07')) return 'rar';
  if (buffer.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return 'gz';
  if (ascii.startsWith('MZ')) return 'exe';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'elf';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    if (buffer.includes(Buffer.from('word/'))) return 'docx';
    if (buffer.includes(Buffer.from('xl/'))) return 'xlsx';
    if (buffer.includes(Buffer.from('ppt/'))) return 'pptx';
    return 'zip';
  }
  return '';
}

function normalizeMimeExtension(mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') return '';
  return MIME_EXTENSIONS.get(type) || '';
}

function metadataFilename(media) {
  return extractOriginalFilename(media?.node || media);
}

function stampForFilename(date) {
  const value = date instanceof Date ? date : new Date(date || Date.now());
  return value.toISOString().replace(/[:.]/g, '-');
}

/** Resolve a safe candidate; caller still sanitizes it for the file system. */
export function resolveUploadFilename({
  requestedName = '', originalFilename = '', media = null, mediaType = 'documentMessage',
  buffer = Buffer.alloc(0), mimeType = '', timestamp = new Date()
} = {}) {
  const explicit = cleanCandidate(String(requestedName || '').trim());
  const original = explicit || cleanCandidate(originalFilename) || metadataFilename(media);
  const signatureExt = extensionFromSignature(buffer);
  const mimeExt = normalizeMimeExtension(mimeType || media?.node?.mimetype);
  const fallbackTypeExt = ({
    imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg', stickerMessage: 'webp'
  })[mediaType] || '';
  const inferredExt = mimeExt || signatureExt || fallbackTypeExt || 'bin';

  if (original) {
    const ext = path.extname(original);
    if (!ext) return `${original}.${inferredExt}`;
    // Repair misleading WhatsApp generic .bin when a reliable signature is available.
    if (!explicit && ext.toLowerCase() === '.bin' && signatureExt) {
      return `${path.basename(original, ext)}.${signatureExt}`;
    }
    return original;
  }

  const label = String(mediaType || 'documentMessage').replace(/Message$/i, '').toLowerCase() || 'file';
  return `${label}-${stampForFilename(timestamp)}.${inferredExt}`;
}

export function hasExpectedSize(buffer, expectedSize) {
  const expected = Number(expectedSize) || 0;
  return expected <= 0 || (Buffer.isBuffer(buffer) && buffer.length === expected);
}
