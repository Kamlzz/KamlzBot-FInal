import fs from 'node:fs/promises';
import path from 'node:path';

let timer = null;
let activeSocket = null;
let running = false;
let seenIds = new Set();
let stateFile = '';

const API_URL = 'https://newsdata.io/api/1/latest';

function articleId(article) {
  return String(article?.article_id || article?.link || article?.title || '').trim();
}

function formatArticle(article, index) {
  const title = String(article?.title || 'Judul tidak tersedia').trim();
  const source = String(article?.source_name || article?.source_id || 'Sumber tidak diketahui').trim();
  const date = String(article?.pubDate || '').trim();
  const link = String(article?.link || '').trim();
  const description = String(article?.description || article?.content || '').trim();
  const parts = [`${index + 1}. *${title}*`, `   Sumber: ${source}${date ? ` | ${date}` : ''}`];
  if (description) parts.push(`   ${description.slice(0, 360)}${description.length > 360 ? '…' : ''}`);
  if (link) parts.push(`   ${link}`);
  return parts.join('\n');
}

async function loadSeen() {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    seenIds = new Set(Array.isArray(parsed) ? parsed.slice(-500) : []);
  } catch {
    seenIds = new Set();
  }
}

async function saveSeen() {
  try {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify([...seenIds].slice(-500), null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('[News] Gagal menyimpan deduplikasi:', error?.message || error);
  }
}

async function fetchNews(config) {
  const apiKey = String(process.env.NEWSDATA_API_KEY || config.newsApiKey || '').trim();
  if (!apiKey) throw new Error('NEWSDATA_API_KEY belum diisi pada .env');
  const params = new URLSearchParams({
    apikey: apiKey,
    country: 'id',
    language: 'id',
    category: 'business,domestic,environment,food,technology',
    size: '10'
  });
  const response = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`NewsData HTTP ${response.status}`);
  const data = await response.json();
  if (data?.status !== 'success' || !Array.isArray(data?.results)) {
    throw new Error(`Respons NewsData tidak sukses: ${String(data?.results?.message || data?.message || data?.status || 'format tidak dikenal')}`);
  }
  return data.results;
}

async function sendHourlyDigest(sock, config, ownerNumber) {
  if (running) return;
  running = true;
  try {
    const jid = `${String(ownerNumber || '').replace(/\D/g, '')}@s.whatsapp.net`;
    if (!ownerNumber || jid === '@s.whatsapp.net') throw new Error('ownerNumber belum benar di config.json');
    const articles = await fetchNews(config);
    const fresh = [];
    const candidatesInThisResponse = new Set();
    for (const item of articles) {
      const id = articleId(item);
      if (!id || seenIds.has(id) || candidatesInThisResponse.has(id)) continue;
      candidatesInThisResponse.add(id);
      fresh.push(item);
      if (fresh.length >= 5) break;
    }

    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    if (!fresh.length) {
      await sock.sendMessage(jid, {
        text: `📰 *RINGKASAN BERITA INDONESIA*\n🕒 ${now} WIB\nTidak ada artikel baru dari hasil NewsData.io pada pemeriksaan jam ini.\n\n_Pemeriksaan berikutnya otomatis satu jam lagi._`
      });
      console.log('[News] Tidak ada berita baru; pemberitahuan per jam dikirim ke owner.');
      return;
    }

    const message = `📰 *RINGKASAN BERITA INDONESIA*\n🕒 ${now} WIB\nBerita baru: ${fresh.length}\n\n${fresh.map(formatArticle).join('\n\n')}\n\n_Otomatis dikirim oleh KamlzBot setiap 1 jam._`;
    // Only mark IDs as seen after WhatsApp accepts the send, so failed sends can retry next hour.
    await sock.sendMessage(jid, { text: message });
    for (const item of fresh) {
      const id = articleId(item);
      if (id) seenIds.add(id);
    }
    await saveSeen();
    console.log(`[News] Mengirim ${fresh.length} berita baru ke owner.`);
  } catch (error) {
    console.error('[News] Pengiriman gagal:', error?.message || error);
  } finally {
    running = false;
  }
}

export function startNewsScheduler(sock, config, rootDir, ownerNumber) {
  // Avoid duplicate hourly timers when Baileys reconnects.
  if (timer) clearInterval(timer);
  activeSocket = sock;
  stateFile = path.join(rootDir, 'data', 'news-seen.json');
  loadSeen().then(() => {
    if (config.newsEnabled === false) {
      console.log('[News] Scheduler dinonaktifkan melalui config.json.');
      return;
    }
    console.log('[News] Scheduler aktif; pengiriman pertama dalam 1 jam.');
    timer = setInterval(() => {
      if (activeSocket) void sendHourlyDigest(activeSocket, config, ownerNumber);
    }, 60 * 60 * 1000);
    timer.unref?.();
  }).catch(error => console.error('[News] Gagal memulai scheduler:', error?.message || error));
}
