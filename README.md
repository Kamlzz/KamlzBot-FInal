# KamlzBot 3.1.0 — Final Full Install

KamlzBot 3.1.0 adalah bot WhatsApp berbasis Baileys dengan prefix `,`, owner awal `6285351262753`, penyimpanan file VPS, downloader YouTube/TikTok/Instagram, fallback YouTube melalui `youtubei.js` tanpa cookies, menu WhatsApp baru, mode AI otomatis Gemini/OpenAI, dan pengolahan video/audio via FFmpeg.

## Versi dan persyaratan

- Node.js 22 LTS (minimal Node.js 20 untuk Baileys 7).
- Baileys dipatok ke `@whiskeysockets/baileys@7.0.0-rc14`. Ini merupakan tag `latest` yang tersedia saat paket dibuat, tetapi masih **release candidate**; periksa npm/release notes sebelum upgrade mendatang.
- Ubuntu 22.04, FFmpeg/ffprobe, yt-dlp terkini, PM2 opsional.
- Koneksi internet VPS yang stabil.

Baileys 7 adalah ESM-only dan mempunyai breaking changes terkait LID serta auth-state. Paket ini sudah menggunakan ESM. Pertautkan ulang akun lewat QR saat instalasi bersih; jangan menyalin folder `auth` versi lama kecuali Anda memang ingin mencoba migrasi sesi dengan backup tersedia.

## Instalasi fresh di Ubuntu 22.04

Gunakan user biasa `ubuntu`, bukan root untuk `npm install`.

1. Unggah `KamlzBot-v3.1.0-final.zip` ke `/home/ubuntu/` menggunakan WinSCP.
2. Jika bot lama sedang berjalan, hentikan dan simpan backup:

```bash
pm2 stop KamlzBot 2>/dev/null || true
pm2 delete KamlzBot 2>/dev/null || true
cd /opt
sudo mv KamlzBot "KamlzBot-backup-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
```

3. Ekstrak paket dan beri folder nama standar:

```bash
sudo unzip -o /home/ubuntu/KamlzBot-v3.1.0-final.zip -d /opt
sudo mv /opt/KamlzBot-Final /opt/KamlzBot
sudo chown -R "$USER":"$USER" /opt/KamlzBot
```

4. Pasang dependensi sistem:

```bash
cd /opt/KamlzBot
bash scripts/install-ubuntu22.sh
```

5. Salin file pengguna dari backup sebelumnya jika ingin menyimpannya. Sesuaikan nama backup yang dibuat pada langkah 2:

```bash
# Contoh: ganti PATH_BACKUP dengan direktori backup Anda
mkdir -p /opt/KamlzBot/data/files
cp -an PATH_BACKUP/data/files/. /opt/KamlzBot/data/files/ 2>/dev/null || true
```

Jangan menimpa `config.json` baru kecuali Anda sudah memeriksa perubahannya. Jangan menyalin `auth/` lama untuk instalasi bersih; bot akan membuat sesi baru.

6. Instalasi npm dan tes:

```bash
cd /opt/KamlzBot
cp .env.example .env
nano .env  # masukkan API key yang ingin dipakai (opsional)
chmod 600 .env
npm install
npm run check
npm test
```

7. Jalankan di terminal dahulu, lalu scan QR WhatsApp > Perangkat tertaut > Tautkan perangkat:

```bash
npm start
```

Jika sudah terhubung dan command tes berhasil, hentikan dengan `Ctrl+C`, lalu jalankan di PM2:

```bash
pm2 start index.js --name KamlzBot --cwd /opt/KamlzBot
pm2 save
pm2 startup
```

Ikuti perintah tambahan yang ditampilkan oleh `pm2 startup`. Periksa log dengan `pm2 logs KamlzBot --lines 50`.

## Konfigurasi

Edit `/opt/KamlzBot/config.json`:

- `ownerNumber`: nomor owner internasional tanpa `+`, default `6285351262753`.
- `ownerLids`: daftar LID yang diperoleh lewat command `,id` jika mapping nomor tidak tersedia. Angka LID jangan ditebak.
- `prefix`: default `,`.
- `maxUploadSizeMB`: batas file upload, download sosial, dan output video.
- `maxMediaProcessMB`: batas file input/output untuk pemrosesan video.
- `maxMediaDurationMinutes`: batas durasi video sebelum proses.
- `mediaDownloadTimeoutMinutes`: timeout yt-dlp.
- `ytDlpCookiesFile`: opsional, path absolut atau relatif ke file Netscape `cookies.txt` yang diekspor dari browser milik Anda. Kosongkan jika tidak diperlukan; file harus hanya dapat dibaca owner (`chmod 600`).
- `syncFullHistory`: default `false` untuk mengurangi beban RAM/log dan sync awal.

## Command file

- `,upfile` — reply dokumen/foto/video/audio/stiker lalu simpan ke VPS.
- `,upfile nama-baru.mp4` — simpan dengan nama pilihan.
- `,ls` — daftar file, urutan alfabetis deterministik.
- `,dlfile 1` — download file nomor 1 dari daftar `,ls`.
- `,dlfile nama file.mp4` — download berdasarkan nama.

## Download YouTube, TikTok, Instagram

- `,ytvideo https://...` atau `,dlvideo https://...` — download video publik dan normalisasi ke MP4/H.264/AAC bila perlu.
- `,ytaudio https://...` atau `,dlaudio https://...` — download audio, lalu FFmpeg mengonversinya ke MP3.

Playlist dinonaktifkan agar command tidak mengunduh ratusan file tanpa sengaja. Hanya host YouTube, TikTok, dan Instagram (termasuk subdomainnya) yang diterima. File hasil disimpan di `data/files/` dan dikirim di chat. Jika file terlalu besar untuk dikirim sebagai video/audio biasa, bot mengirimnya sebagai dokumen.

Unduh hanya konten yang Anda punya hak untuk simpan atau gunakan. Secara default bot tidak menggunakan cookie login. Untuk YouTube, versi ini mencoba yt-dlp lebih dahulu lalu `youtubei.js` sebagai extractor kedua tanpa cookies; kedua metode tetap bisa gagal jika YouTube meminta verifikasi, mengubah player, atau membatasi IP VPS. TikTok dan Instagram tetap memakai yt-dlp. Jika YouTube meminta verifikasi, bot mencoba extractor kedua `youtubei.js` tanpa cookies. Tidak ada modul yang menjamin semua video publik dapat diunduh karena YouTube bisa membatasi IP VPS atau mengubah player. `ytDlpCookiesFile` tetap opsional untuk pengguna yang memilih mengatur cookies sendiri; file cookies sensitif dan tidak diperlukan untuk menjalankan bot.

## AI chat otomatis (Gemini / OpenAI GPT)

API key opsional disimpan di `.env`, bukan di `config.json` dan jangan pernah dikirim lewat WhatsApp:

```bash
cd /opt/KamlzBot
cp .env.example .env
nano .env
chmod 600 .env
```

Isi `GEMINI_API_KEY` untuk Gemini dan/atau `OPENAI_API_KEY` untuk GPT. Ambil key dari Google AI Studio atau platform OpenAI resmi. Restart bot setelah mengubah `.env`.

Perintah owner melalui chat pribadi:

- `,ai` — status dan petunjuk.
- `,ai on` / `,ai off` — aktifkan atau matikan balasan otomatis.
- `,ai provider gemini` / `,ai provider gpt` — pilih provider.
- `,ai reset` — hapus konteks percakapan AI chat tersebut dari RAM.

Saat aktif, bot menjawab pesan teks masuk tanpa prefix di chat pribadi. Untuk mencegah spam, grup tidak dijawab otomatis. Konteks chat disimpan sementara di RAM (maksimal beberapa giliran), tidak ditulis ke file, dan hilang saat proses bot restart. Pemakaian API dapat dikenakan biaya/kuota oleh penyedia. Jangan aktifkan mode otomatis sebelum API key provider terpilih tersedia.

## Edit video via FFmpeg

Simpan video lebih dahulu dengan `,upfile`, lalu jalankan command berbasis filename. Pakai pemisah `|` supaya nama file dengan spasi bisa dipakai.

- `,trim video.mp4 | 00:00:05 | 00:00:15` — potong dari 5 hingga 15 detik.
- `,rotate video.mp4 | 90` — putar 90°, valid `90`, `180`, `270`.
- `,slow video.mp4 | 0.5` — setengah kecepatan; rentang `0.5`–`0.9`.
- `,fast video.mp4 | 1.5` — 1,5 kali kecepatan; rentang `1.1`–`2.0`.
- `,compress video.mp4 | 28` — kompres H.264 dengan CRF 18–35. CRF lebih tinggi biasanya menghasilkan file lebih kecil dengan kualitas lebih rendah.

Hasil edit MP4 juga disimpan di `data/files/` dan dikirim kembali. Pemrosesan memakai satu command per permintaan, batas ukuran 100 MB dan durasi 30 menit secara default untuk menghindari kehabisan RAM/CPU pada VPS 2 vCPU/4 GB. Hasil besar dapat memerlukan waktu atau melebihi batas WhatsApp.

## Fitur Baileys yang dibawa

Paket mempertahankan command praktis dari feature pack sebelumnya: reaksi, pin/unpin pesan, edit/hapus pesan yang dikirim bot, polling, share lokasi/kontak, forward pesan reply, status/profil, grup, metadata peserta, undangan grup, blocklist/privacy, presence, mute/pin/archive chat, serta helper cache pesan untuk retry/polling. Gunakan `,help` untuk menu command yang dibangun di source.

Tidak ada bot wrapper yang dapat mengubah setiap API internal Baileys menjadi command yang universal. Sebagian endpoint memerlukan izin admin, jenis chat tertentu, data event, atau dukungan WhatsApp yang berubah-ubah. Coba command admin pada grup uji dahulu.

## Logs dan troubleshooting

- Log rutin dibuat ringkas; chat biasa yang tidak memakai prefix tidak dicatat sebagai command.
- `Closing session: SessionEntry`, error dekripsi Signal tertentu dan timeout init query nonfatal disaring.
- Untuk debug sementara, jalankan `BAILEYS_LOG_LEVEL=warn KAMLZBOT_VERBOSE_ARCHIVE=1 npm start` dari terminal. Jangan hidupkan debug verbose permanen tanpa perlu.
- `yt-dlp` gagal: jalankan `bash scripts/install-ubuntu22.sh`, periksa `yt-dlp --version` dan `which yt-dlp`. Jika YouTube meminta verifikasi, lihat bagian cookies di atas; file cookie harus format Netscape dan izin `600`.
- FFmpeg gagal: periksa `ffmpeg -version` dan `ffprobe -version`.
- Bot tidak merespons: `pm2 logs KamlzBot --lines 100`; pastikan `config.json` valid dan `npm run check` lulus.
- Owner tidak terdeteksi: kirim `,id` ke chat pribadi dan periksa `ownerNumber` atau tambahkan LID yang benar ke `ownerLids`.

## Data and security

- `auth/`: kredensial sesi WhatsApp; jangan dibagikan.
- `data/files/`: file pengguna dan hasil media.
- `data/tmp/`: working directory unduhan sementara.
- `data/deleted/`, `data/archive-cache/`, `data/archive-chats.json`: data fitur arsip anti-delete berbasis persetujuan yang telah ada di source. View Once dan pesan sementara dikecualikan.
- Perintah bot dibatasi owner. Jangan mengekspos folder bot atau port file server ke internet.

## Referensi resmi

- Baileys README: https://github.com/WhiskeySockets/Baileys/blob/master/README.md
- Panduan instalasi: https://baileys.wiki
- Panduan migrasi v7: https://baileys.wiki/docs/migration/to-v7.0.0
- yt-dlp: https://github.com/yt-dlp/yt-dlp
- FFmpeg filters: https://ffmpeg.org/ffmpeg-filters.html
