# KamlzBot 3.1.0 — Instal ulang penuh di Ubuntu 22.04

Paket final ini mengganti source versi sebelumnya. Gunakan user `ubuntu` untuk npm, jangan `sudo npm install`. Contoh mengasumsikan file ZIP diunggah lewat WinSCP ke `/home/ubuntu/KamlzBot-v3.1.0-final.zip`.

## 1. Backup dan hentikan bot

```bash
cd /opt/KamlzBot 2>/dev/null || true
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$HOME/KamlzBot-backup-$STAMP"
cp -a config.json data auth "$HOME/KamlzBot-backup-$STAMP/" 2>/dev/null || true
pm2 stop KamlzBot 2>/dev/null || true
pm2 delete KamlzBot 2>/dev/null || true
cd /opt
sudo mv KamlzBot "KamlzBot-old-$STAMP" 2>/dev/null || true
```

Backup ini untuk menjaga `config.json`, file data, dan sesi auth lama. Jangan menjalankan dua bot dengan sesi WhatsApp yang sama secara bersamaan.

## 2. Ekstrak paket final

```bash
sudo unzip -o /home/ubuntu/KamlzBot-v3.1.0-final.zip -d /opt
sudo mv /opt/KamlzBot-Final /opt/KamlzBot
sudo chown -R ubuntu:ubuntu /opt/KamlzBot
cd /opt/KamlzBot
bash scripts/install-ubuntu22.sh
npm install
cp .env.example .env
nano .env
chmod 600 .env
npm run check
npm test
```

Di `.env`, isi `GEMINI_API_KEY` dan/atau `OPENAI_API_KEY` jika ingin memakai AI. API key opsional; jangan mengirimkannya lewat WhatsApp atau menaruhnya di `config.json`. Jika ingin mempertahankan data lama, salin isi `data/files/` dari backup lama ke `/opt/KamlzBot/data/files/` setelah instalasi. Jangan salin `auth/` lama untuk instalasi bersih kecuali memang ingin mencoba mempertahankan sesi; jika disalin, lakukan dengan bot dalam keadaan berhenti.

## 3. Jalankan dan tautkan WhatsApp

```bash
cd /opt/KamlzBot
npm start
```

Scan QR melalui WhatsApp > Perangkat tertaut > Tautkan perangkat. Setelah berhasil, hentikan dengan `Ctrl+C`, lalu: 

```bash
pm2 start index.js --name KamlzBot --cwd /opt/KamlzBot
pm2 save
pm2 startup
```

Jalankan perintah tambahan yang ditampilkan oleh `pm2 startup`, lalu periksa `pm2 logs KamlzBot --lines 80`.

## 4. Perintah penting

- `,menu` — menu WhatsApp yang diperbarui.
- `,ytvideo URL` — unduh video YouTube/TikTok/Instagram.
- `,ytaudio URL` — unduh audio MP3. YouTube mencoba `yt-dlp`, lalu `youtubei.js` tanpa cookies jika extractor utama gagal. Tetap mungkin gagal bila YouTube membatasi IP atau meminta verifikasi.
- `,ai` — petunjuk AI; `,ai provider gemini` atau `,ai provider gpt`; `,ai on` dan `,ai off`.
- `,ai on` hanya berhasil jika API key provider yang dipilih sudah diatur. Mode AI otomatis hanya membalas chat pribadi, bukan grup.

## 5. Catatan keamanan

- Jangan menghapus backup sampai bot baru berfungsi.
- Jangan membagikan `auth/`, `.env`, API key, atau cookies.
- API Gemini/OpenAI bisa memerlukan billing dan memiliki kuota/rate limit.
- Unduh hanya media yang Anda punya hak untuk simpan.
