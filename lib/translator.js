import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SETTINGS_PATH = path.join(ROOT, 'data', 'translation-settings.json');
const DICT_PATH = path.join(ROOT, 'data', 'kosakata.json');
const MAX_TEXT = 5000;
let settings = {};
let settingsLoaded = false;
let dictionaryCache = [];
let dictionaryMtime = 0;

async function loadSettings() {
  if (settingsLoaded) return;
  try { settings = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8')); }
  catch { settings = {}; }
  settingsLoaded = true;
}
async function saveSettings() {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, SETTINGS_PATH);
}
export async function getTranslationEnabled(jid) {
  await loadSettings();
  return Boolean(settings[jid]?.enabled);
}
export async function setTranslationEnabled(jid, enabled) {
  await loadSettings();
  settings[jid] = { ...(settings[jid] || {}), enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
  await saveSettings();
  return Boolean(enabled);
}
async function loadDictionary() {
  try {
    const stat = await fs.stat(DICT_PATH);
    if (stat.mtimeMs !== dictionaryMtime) {
      const parsed = JSON.parse(await fs.readFile(DICT_PATH, 'utf8'));
      dictionaryCache = Array.isArray(parsed) ? parsed.filter(x => x && x.id && x.zh) : [];
      dictionaryMtime = stat.mtimeMs;
    }
  } catch { dictionaryCache = []; }
  return dictionaryCache;
}
function containsChinese(text) { return /[\u3400-\u9fff]/u.test(text); }
function selectGlossary(text, dictionary) {
  const lower = text.toLocaleLowerCase('id');
  const matched = dictionary.filter(x => lower.includes(String(x.id).toLocaleLowerCase('id')) || text.includes(String(x.zh)));
  return matched.slice(0, 80).map(x => `${x.id} = ${x.zh}${x.pinyin ? ` (${x.pinyin})` : ''}`).join('\n');
}
export async function translateText(input) {
  const text = String(input || '').trim().slice(0, MAX_TEXT);
  if (!text) throw new Error('Teks yang akan diterjemahkan kosong.');
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY belum diatur di .env. Isi sendiri di VPS; jangan kirim API key ke chat.');
  const model = String(process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite').trim();
  const dictionary = await loadDictionary();
  const glossary = selectGlossary(text, dictionary);
  const target = containsChinese(text) ? 'Bahasa Indonesia' : 'Mandarin sederhana (Hanzi sederhana)';
  const prompt = `Anda adalah penerjemah profesional untuk lingkungan pabrik peleburan nikel/RKEF. Terjemahkan teks berikut ke ${target}.
Aturan: pertahankan angka, satuan, nama alat, kode, dan maksud instruksi keselamatan; gunakan istilah teknis industri yang tepat; jangan menambah penjelasan atau mengarang konteks. Jika sumber Mandarin, terjemahkan ke bahasa Indonesia. Jika sumber Indonesia atau bahasa lain tanpa Hanzi, terjemahkan ke Mandarin sederhana. Setelah hasil Mandarin, tambahkan satu baris pinyin hanya jika hasil terjemahan berupa Mandarin dan teksnya pendek (maksimal 2 kalimat).

Kamus teknis rujukan (gunakan jika relevan):
${glossary || '(Tidak ada istilah kamus yang cocok; gunakan istilah industri baku.)'}

Teks sumber:
${text}`;

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        model,
        input: prompt,
        generation_config: {
          temperature: 0.2,
          max_output_tokens: 1400
        }
      }),
      signal: AbortSignal.timeout(45000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Gemini API ${response.status}: ${data?.error?.message || JSON.stringify(data)}`
    );
  }

  let result = String(data?.output_text || '').trim();

  if (!result && Array.isArray(data?.steps)) {
    result = data.steps
      .filter(step => step?.type === 'model_output')
      .flatMap(step => Array.isArray(step.content) ? step.content : [])
      .filter(item => item?.type === 'text')
      .map(item => item.text || '')
      .join('')
      .trim();
  }

  if (!result) {
    throw new Error('Gemini tidak mengembalikan teks terjemahan.');
  }

  return result;
}
