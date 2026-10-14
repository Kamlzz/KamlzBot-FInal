import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chooseUniqueName, resolveFileSelector, resolveInside, sanitizeStoredName, formatBytes } from './file-store.js';

const MEDIA_DOMAINS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'tiktok.com', 'instagram.com', 'instagr.am'
];
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpeg', '.mpg']);

export function parseSupportedMediaUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new Error('URL tidak valid. Gunakan tautan publik YouTube, TikTok, atau Instagram.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('URL harus menggunakan HTTPS biasa, tanpa user/password atau port khusus.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!MEDIA_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error('Domain tidak didukung. Gunakan tautan publik dari YouTube, TikTok, atau Instagram.');
  }
  url.hash = '';
  return url.toString();
}

export function parseTimeSeconds(value) {
  const input = String(value || '').trim();
  if (/^\d+(?:\.\d{1,3})?$/.test(input)) return Number(input);
  const pieces = input.split(':');
  if (pieces.length < 2 || pieces.length > 3 || pieces.some(part => !/^\d+(?:\.\d{1,3})?$/.test(part))) {
    throw new Error('Waktu harus berupa detik (12.5), MM:SS, atau HH:MM:SS.');
  }
  if (pieces.length === 2) return Number(pieces[0]) * 60 + Number(pieces[1]);
  return Number(pieces[0]) * 3600 + Number(pieces[1]) * 60 + Number(pieces[2]);
}

export function runBinary(binary, args, { timeoutMs = 10 * 60_000, cwd, maxOutputChars = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (target, chunk) => (target + chunk.toString()).slice(-maxOutputChars);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      hardKill.unref?.();
      finish(new Error(`${binary} melewati batas waktu ${Math.round(timeoutMs / 1000)} detik.`));
    }, timeoutMs);
    timer.unref?.();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.on('error', error => {
      if (error.code === 'ENOENT') {
        finish(new Error(`Program '${binary}' tidak ditemukan. Pastikan ffmpeg/yt-dlp sudah dipasang dan tersedia di PATH.`));
      } else finish(error);
    });
    child.on('close', code => {
      if (settled) return;
      if (code === 0) finish(null, { stdout: stdout.trim(), stderr: stderr.trim() });
      else {
        const detail = (stderr || stdout).trim().split('\n').slice(-8).join('\n').slice(-1600);
        finish(new Error(`${binary} gagal (exit ${code ?? 'unknown'}). ${detail || 'Tidak ada detail dari program.'}`));
      }
    });
  });
}


function youtubeVideoId(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) return url.pathname.split('/').filter(Boolean)[0] || '';
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.searchParams.get('v')) return url.searchParams.get('v');
  if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) return parts[1] || '';
  return '';
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadWithYoutubeJs(rawUrl, mode, tempDir, timeoutMs, maxBytes) {
  const videoId = youtubeVideoId(rawUrl);
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) throw new Error('ID video YouTube tidak dapat dikenali.');
  const ytModule = await import('youtubei.js');
  const { Innertube } = ytModule;
  let Platform = ytModule.Platform;
  if (!Platform) {
    try { Platform = (await import('youtubei.js/web')).Platform; } catch {}
  }
  // YouTube.js needs an interpreter for some obfuscated player scripts. This evaluates
  // the player code returned by YouTube itself, similar to what other extractors do.
  if (Platform?.shim) {
    Platform.shim.eval = async (data) => {
      const source = typeof data === 'string' ? data : data?.output;
      if (typeof source !== 'string' || !source) throw new Error('Kode player YouTube kosong.');
      return (new Function(source))();
    };
  }
  const yt = await withTimeout(
    Innertube.create({ lang: 'en', location: 'US', client_type: 'ANDROID', retrieve_player: true }),
    Math.min(timeoutMs, 45000), 'Inisialisasi youtubei.js timeout.'
  );
  const options = mode === 'video'
    ? { type: 'video+audio', quality: '360p', format: 'mp4' }
    : { type: 'audio', quality: 'best', format: 'mp4' };
  const webStream = await withTimeout(
    yt.download(videoId, options),
    Math.min(timeoutMs, 90000), 'youtubei.js gagal memperoleh stream sebelum timeout.'
  );
  if (!webStream || typeof webStream.getReader !== 'function') throw new Error('youtubei.js tidak mengembalikan stream yang valid.');
  const outputPath = path.join(tempDir, `youtubei-${videoId}.${mode === 'audio' ? 'm4a' : 'mp4'}`);
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) callback(new Error(`Unduhan YouTube melewati batas ${formatBytes(maxBytes)}.`));
      else callback(null, chunk);
    }
  });
  await withTimeout(
    pipeline(Readable.fromWeb(webStream), limiter, createWriteStream(outputPath, { flags: 'wx' })),
    timeoutMs, 'Unduhan youtubei.js melewati batas waktu.'
  );
  if (!(await fileSize(outputPath))) throw new Error('youtubei.js menghasilkan file kosong.');
  return outputPath;
}

async function fileSize(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('Output media bukan file biasa.');
  return stat.size;
}

async function findProducedFile(tempDir, printedPath) {
  const candidates = [];
  if (printedPath) {
    const last = printedPath.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
    if (last) candidates.push(path.isAbsolute(last) ? last : path.resolve(tempDir, last));
  }
  const entries = await fs.readdir(tempDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.endsWith('.part') && !entry.name.endsWith('.ytdl')) candidates.push(path.join(tempDir, entry.name));
  }
  for (const candidate of [...new Set(candidates)]) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error('yt-dlp selesai tetapi file hasil tidak ditemukan. Periksa log VPS dan versi yt-dlp.');
}

export async function downloadSocialMedia(rawUrl, mode, { tempRoot, maxBytes = 100 * 1024 * 1024, timeoutMs = 15 * 60_000, cookiesFile = process.env.KAMLZBOT_YTDLP_COOKIES_FILE || '' } = {}) {
  if (!['video', 'audio'].includes(mode)) throw new Error('Mode harus video atau audio.');
  const url = parseSupportedMediaUrl(rawUrl);
  let cookiePath = '';
  if (String(cookiesFile || '').trim()) {
    cookiePath = path.resolve(String(cookiesFile).trim());
    let cookieStat;
    try { cookieStat = await fs.stat(cookiePath); }
    catch { throw new Error(`File cookie yt-dlp tidak ditemukan: ${cookiePath}. Pastikan path benar.`); }
    if (!cookieStat.isFile()) throw new Error('YTDLP_COOKIES_FILE harus menunjuk ke file cookies.txt biasa.');
    if (process.platform !== 'win32' && (cookieStat.mode & 0o077) !== 0) {
      throw new Error(`Izin file cookies terlalu terbuka. Jalankan: chmod 600 "${cookiePath}"`);
    }
  }
  await fs.mkdir(tempRoot || os.tmpdir(), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot || os.tmpdir(), 'kamlzbot-media-'));
  const maxMiB = `${Math.max(1, Math.floor(maxBytes / (1024 * 1024)))}M`;
  const outputTemplate = mode === 'video' ? '%(title).90B-%(id)s.%(ext)s' : 'source-%(id)s.%(ext)s';
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress', '--no-colors',
    '--remote-components', 'ejs:github', '--js-runtimes', 'node',
    '--max-filesize', maxMiB,
    '--extractor-retries', '2', '--fragment-retries', '2',
    '--paths', tempDir, '--output', outputTemplate,
    '--print', 'after_move:filepath'
  ];
  if (cookiePath) args.push('--cookies', cookiePath);
  if (mode === 'video') {
    args.push('--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4');
  } else {
    args.push('--format', 'bestaudio/best');
  }
  args.push(url);
  try {
    let downloadedPath;
    try {
      const result = await runBinary('yt-dlp', args, { timeoutMs, cwd: tempDir });
      downloadedPath = await findProducedFile(tempDir, result.stdout);
    } catch (primaryError) {
      const host = new URL(url).hostname.toLowerCase();
      const isYoutube = host === 'youtu.be' || host.endsWith('.youtube.com') || host === 'youtube.com' || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
      if (!isYoutube) throw primaryError;
      try {
        // Secondary no-cookie extractor for public YouTube videos. It is best-effort;
        // YouTube can still rate-limit or change player requirements.
        downloadedPath = await downloadWithYoutubeJs(url, mode, tempDir, timeoutMs, maxBytes);
      } catch (fallbackError) {
        throw new Error(`yt-dlp gagal: ${String(primaryError?.message || primaryError).slice(0, 650)}\nExtractor alternatif youtubei.js juga gagal: ${String(fallbackError?.message || fallbackError).slice(0, 650)}\nPastikan video publik dan coba lagi nanti. Tidak ada extractor yang menjamin semua video dapat diunduh tanpa cookies.`);
      }
    }
    const downloadedSize = await fileSize(downloadedPath);
    if (downloadedSize > maxBytes) throw new Error(`Hasil unduhan ${formatBytes(downloadedSize)} melewati batas ${formatBytes(maxBytes)}.`);

    let finalPath = downloadedPath;
    if (mode === 'audio') {
      finalPath = path.join(tempDir, `kamlz-audio-${Date.now()}.mp3`);
      await runBinary('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', downloadedPath,
        '-map', '0:a:0', '-vn', '-codec:a', 'libmp3lame', '-q:a', '3', '-map_metadata', '-1', finalPath
      ], { timeoutMs });
    } else {
      const extension = path.extname(downloadedPath).toLowerCase();
      // Normalize to H.264/AAC MP4 so WhatsApp has a broadly compatible video container.
      if (extension !== '.mp4') {
        finalPath = path.join(tempDir, `kamlz-video-${Date.now()}.mp4`);
        await runBinary('ffmpeg', [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', downloadedPath,
          '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart', finalPath
        ], { timeoutMs });
      }
    }
    const finalSize = await fileSize(finalPath);
    if (finalSize > maxBytes) throw new Error(`File hasil ${formatBytes(finalSize)} melewati batas ${formatBytes(maxBytes)}. Pilih kualitas lebih rendah atau naikkan batas dengan hati-hati.`);
    return {
      tempDir,
      filePath: finalPath,
      size: finalSize,
      mode,
      suggestedName: mode === 'audio' ? `audio-${Date.now()}.mp3` : path.basename(finalPath)
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const detail = String(error?.message || error);
    if (/Sign in to confirm (?:you're|you are) not a bot|Use --cookies-from-browser or --cookies/i.test(detail)) {
      throw new Error(
        'YouTube meminta verifikasi akses (anti-bot). Perbarui yt-dlp ke binary resmi terbaru, lalu jika perlu ekspor cookies YouTube dari browser yang sudah login ke file Netscape cookies.txt dan atur ytDlpCookiesFile di config.json. Jangan kirim file cookies ke siapa pun. Cookies mungkin tetap tidak menyelesaikan semua challenge YouTube.'
      );
    }
    throw error;
  }
}

async function probeVideo(inputPath) {
  const { stdout } = await runBinary('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type',
    '-of', 'json', inputPath
  ], { timeoutMs: 30_000 });
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('ffprobe tidak dapat membaca metadata video.'); }
  if (!(data.streams || []).some(stream => stream.codec_type === 'video')) throw new Error('File tidak memiliki stream video.');
  return {
    duration: Number(data.format?.duration || 0),
    hasAudio: (data.streams || []).some(stream => stream.codec_type === 'audio')
  };
}

export async function editStoredVideo(filesDir, expression, operation, {
  maxInputBytes = 100 * 1024 * 1024,
  maxOutputBytes = 100 * 1024 * 1024,
  maxDurationSeconds = 1800
} = {}) {
  if (!['trim', 'rotate', 'slow', 'fast', 'compress'].includes(operation)) throw new Error('Operasi edit tidak dikenal.');
  const parts = String(expression || '').split('|').map(part => part.trim());
  if (!parts[0]) throw new Error('Sertakan nama file. Gunakan ,ls untuk melihat daftar file tersimpan.');
  const inputName = await resolveFileSelector(filesDir, parts[0]);
  if (!VIDEO_EXTENSIONS.has(path.extname(inputName).toLowerCase())) throw new Error('File harus berupa video (MP4, MOV, MKV, WEBM, AVI, atau M4V).');
  const inputPath = resolveInside(filesDir, inputName);
  const inputStat = await fs.stat(inputPath);
  if (inputStat.size > maxInputBytes) throw new Error(`File sumber ${formatBytes(inputStat.size)} melewati batas ${formatBytes(maxInputBytes)}.`);
  const probe = await probeVideo(inputPath);
  if (!probe.duration || !Number.isFinite(probe.duration)) throw new Error('Durasi video tidak dapat dibaca.');
  if (probe.duration > maxDurationSeconds) throw new Error(`Durasi video melebihi batas ${Math.round(maxDurationSeconds / 60)} menit.`);

  let filter = null;
  let extraInputArgs = [];
  let durationAfter = probe.duration;
  let suffix = operation;
  let crf = 28;
  if (operation === 'trim') {
    if (parts.length !== 3) throw new Error('Format: ,trim nama-video.mp4 | 00:00:05 | 00:00:15');
    const start = parseTimeSeconds(parts[1]);
    const end = parseTimeSeconds(parts[2]);
    if (start < 0 || end <= start || start >= probe.duration || end > probe.duration + 0.1) throw new Error(`Rentang trim harus berada dalam durasi video ${probe.duration.toFixed(1)} detik.`);
    durationAfter = end - start;
    extraInputArgs = ['-ss', String(start)];
    filter = { output: ['-t', String(durationAfter)] };
    suffix = `trim-${Math.round(start)}-${Math.round(end)}`;
  } else if (operation === 'rotate') {
    const degrees = Number(parts[1] || 90);
    if (![90, 180, 270].includes(degrees)) throw new Error('Sudut rotate yang didukung: 90, 180, atau 270.');
    filter = { video: degrees === 90 ? 'transpose=1' : degrees === 180 ? 'hflip,vflip' : 'transpose=2' };
    suffix = `rotate-${degrees}`;
  } else if (operation === 'slow' || operation === 'fast') {
    const factor = Number(parts[1] || (operation === 'slow' ? 0.5 : 1.5));
    const okay = operation === 'slow' ? factor >= 0.5 && factor <= 0.9 : factor >= 1.1 && factor <= 2.0;
    if (!okay) throw new Error(operation === 'slow' ? 'Slow mendukung faktor 0.5 sampai 0.9 (0.5 = setengah kecepatan).' : 'Fast mendukung faktor 1.1 sampai 2.0 (2 = dua kali lebih cepat).');
    durationAfter = probe.duration / factor;
    if (durationAfter > maxDurationSeconds) throw new Error('Durasi setelah slow melebihi batas pemrosesan.');
    filter = { video: `setpts=${(1 / factor).toFixed(5)}*PTS`, audio: `atempo=${factor}` };
    suffix = `${operation}-${String(factor).replace('.', '-')}`;
  } else if (operation === 'compress') {
    crf = Number(parts[1] || 28);
    if (!Number.isInteger(crf) || crf < 18 || crf > 35) throw new Error('CRF compress harus bilangan bulat 18–35. Angka lebih tinggi biasanya menghasilkan file lebih kecil dengan kualitas lebih rendah.');
    suffix = `compress-crf${crf}`;
  }

  const stem = path.basename(inputName, path.extname(inputName));
  const outputName = await chooseUniqueName(filesDir, sanitizeStoredName(`${stem}-${suffix}.mp4`));
  const outputPath = resolveInside(filesDir, outputName);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...extraInputArgs, '-i', inputPath];
  if (filter?.output) args.push(...filter.output);
  args.push('-map', '0:v:0', '-map', '0:a?', '-sn', '-dn');
  if (filter?.video) args.push('-vf', filter.video);
  if (filter?.audio && probe.hasAudio) args.push('-af', filter.audio);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf));
  if (probe.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-movflags', '+faststart', outputPath);

  try {
    await runBinary('ffmpeg', args, { timeoutMs: 15 * 60_000 });
    const size = await fileSize(outputPath);
    if (size > maxOutputBytes) {
      await fs.rm(outputPath, { force: true });
      throw new Error(`Hasil edit ${formatBytes(size)} melewati batas output ${formatBytes(maxOutputBytes)}.`);
    }
    return { name: outputName, filePath: outputPath, size, duration: durationAfter };
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export { VIDEO_EXTENSIONS };
