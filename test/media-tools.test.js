import assert from 'node:assert/strict';
import { parseSupportedMediaUrl, parseTimeSeconds } from '../lib/media-tools.js';

assert.equal(parseSupportedMediaUrl('https://youtu.be/abc123?t=4'), 'https://youtu.be/abc123?t=4');
assert.equal(parseSupportedMediaUrl('https://www.tiktok.com/@user/video/123'), 'https://www.tiktok.com/@user/video/123');
assert.equal(parseSupportedMediaUrl('https://www.instagram.com/reel/abc/'), 'https://www.instagram.com/reel/abc/');
assert.throws(() => parseSupportedMediaUrl('http://youtube.com/watch?v=abc'), /HTTPS/);
assert.throws(() => parseSupportedMediaUrl('https://youtube.com.evil.example/watch?v=abc'), /Domain tidak didukung/);
assert.throws(() => parseSupportedMediaUrl('https://example.com/video.mp4'), /Domain tidak didukung/);
assert.throws(() => parseSupportedMediaUrl('https://user:pass@youtube.com/watch?v=abc'), /HTTPS/);
assert.equal(parseTimeSeconds('12.5'), 12.5);
assert.equal(parseTimeSeconds('01:15'), 75);
assert.equal(parseTimeSeconds('00:01:15.5'), 75.5);
assert.throws(() => parseTimeSeconds('not-a-time'), /Waktu harus/);
console.log('media-tools.test.js: OK');
