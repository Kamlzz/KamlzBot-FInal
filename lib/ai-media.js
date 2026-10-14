import PDFDocument from 'pdfkit';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function apiError(provider, response, data) {
  return new Error(
    `${provider} API ${response.status}: ${data?.error?.message || 'permintaan gagal'}`
  );
}

function requireGeminiKey() {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY belum diatur di file .env.');
  return key;
}

export async function generateImage(prompt) {
  const apiKey = process.env.POLLINATIONS_API_KEY;

  if (!apiKey) {
    throw new Error("POLLINATIONS_API_KEY belum diatur di .env");
  }

  if (!prompt || !String(prompt).trim()) {
    throw new Error("Prompt gambar tidak boleh kosong");
  }

  const url = new URL(
    `https://gen.pollinations.ai/image/${encodeURIComponent(String(prompt).trim())}`
  );
  url.searchParams.set("model", "flux");
  url.searchParams.set("width", "1024");
  url.searchParams.set("height", "1024");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "image/*"
    },
    signal: AbortSignal.timeout(180000)
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(
      `Pollinations Image API ${response.status}: ${detail}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Pollinations tidak mengembalikan gambar. Content-Type: ${contentType}. ${detail}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw new Error("Pollinations mengembalikan gambar kosong");
  }

  return buffer;
}

export async function generateVideo(prompt) {
  const key = requireGeminiKey();
  const model = process.env.GEMINI_VIDEO_MODEL || 'veo-3.1-generate-preview';

  const startResponse = await fetch(
    `${API_BASE}/models/${encodeURIComponent(model)}:predictLongRunning`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { numberOfVideos: 1, aspectRatio: '16:9' }
      }),
      signal: AbortSignal.timeout(60000)
    }
  );

  const startData = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok) throw apiError('Veo', startResponse, startData);

  const operationName = startData?.name;
  if (
    typeof operationName !== 'string' ||
    !/^(models\/[A-Za-z0-9._-]+\/operations\/|operations\/)[A-Za-z0-9._/-]+$/.test(operationName)
  ) {
    throw new Error('Veo tidak mengembalikan nama operasi yang valid.');
  }

  // Maksimal sekitar 10 menit untuk menunggu proses pembuatan video.
  let result;
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(10000);

    const statusResponse = await fetch(
      `${API_BASE}/${operationName}`,
      {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(30000)
      }
    );
    const statusData = await statusResponse.json().catch(() => ({}));

    if (!statusResponse.ok) throw apiError('Veo status', statusResponse, statusData);
    if (statusData?.error) {
      throw new Error(`Veo gagal: ${statusData.error.message || 'proses video gagal'}`);
    }

    if (statusData?.done === true) {
      result = statusData;
      break;
    }
  }

  if (!result) {
    throw new Error('Pembuatan video belum selesai setelah 10 menit. Coba lagi nanti.');
  }

  const videoUri =
    result?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;

  if (!videoUri || !/^https:\/\/[^\s]+$/i.test(videoUri)) {
    throw new Error('Veo selesai, tetapi tautan video tidak ditemukan.');
  }

  const videoResponse = await fetch(videoUri, {
    headers: { 'x-goog-api-key': key },
    signal: AbortSignal.timeout(180000)
  });

  if (!videoResponse.ok) {
    throw new Error(`Gagal mengambil hasil video: HTTP ${videoResponse.status}.`);
  }

  const contentLength = Number(videoResponse.headers.get('content-length') || 0);
  const maxBytes = 64 * 1024 * 1024;
  if (contentLength > maxBytes) {
    throw new Error('Ukuran video melebihi batas pengiriman 64 MB.');
  }

  const buffer = Buffer.from(await videoResponse.arrayBuffer());
  if (buffer.length === 0) throw new Error('File video yang diterima kosong.');
  if (buffer.length > maxBytes) {
    throw new Error('Ukuran video melebihi batas pengiriman 64 MB.');
  }

  return buffer;
}

function pdfSafeText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '')
    .slice(0, 24000);
}

export async function createPdfBuffer(title, content) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    info: {
      Title: pdfSafeText(title).slice(0, 200),
      Author: 'KamlzBot'
    }
  });

  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.font('Helvetica-Bold')
    .fontSize(18)
    .text(pdfSafeText(title), { align: 'center' });

  doc.moveDown(1);
  doc.font('Helvetica')
    .fontSize(10)
    .text(pdfSafeText(content), {
      align: 'left',
      lineGap: 3
    });

  doc.end();
  return completed;
}
