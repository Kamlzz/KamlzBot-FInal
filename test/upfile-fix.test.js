import assert from 'node:assert/strict';
import { extractOriginalFilename, resolveUploadFilename, hasExpectedSize } from '../lib/upfile-fix.js';

const pdf = Buffer.from('%PDF-1.7\nexample pdf payload');
assert.equal(extractOriginalFilename({ message: { documentMessage: { fileName: 'Laporan Q3.pdf', mimetype: 'application/pdf' } } }), 'Laporan Q3.pdf');
assert.equal(extractOriginalFilename({ message: { extendedTextMessage: { contextInfo: { quotedMessage: { documentMessage: { fileName: 'laporan-asli.pdf' } } } } } }), 'laporan-asli.pdf');
assert.equal(extractOriginalFilename({ message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'arsip asli.zip' } } } } } } }), 'arsip asli.zip');
assert.equal(resolveUploadFilename({ originalFilename: 'Laporan Q3.pdf', mediaType: 'documentMessage', buffer: pdf, mimeType: 'application/octet-stream' }), 'Laporan Q3.pdf');
assert.equal(resolveUploadFilename({ requestedName: 'namabaru', originalFilename: 'asli.pdf', buffer: pdf, mimeType: 'application/pdf' }), 'namabaru.pdf');
assert.equal(resolveUploadFilename({ mediaType: 'documentMessage', media: { node: {} }, buffer: pdf, mimeType: 'application/octet-stream', timestamp: new Date('2026-10-15T00:00:00.000Z') }), 'document-2026-10-15T00-00-00-000Z.pdf');
assert.equal(resolveUploadFilename({ originalFilename: 'dokumen.bin', buffer: pdf, mimeType: 'application/octet-stream' }), 'dokumen.pdf');
assert.equal(hasExpectedSize(Buffer.from('abc'), 3), true);
assert.equal(hasExpectedSize(Buffer.from('abc'), 4), false);
assert.equal(hasExpectedSize(Buffer.from('abc'), 0), true);
console.log('PASS: original filename extraction, fallback, extension inference, and completeness checks');
