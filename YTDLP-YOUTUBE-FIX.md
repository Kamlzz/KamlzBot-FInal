# KamlzBot: memperbaiki yt-dlp dan verifikasi YouTube

Error `Sign in to confirm you’re not a bot` dikirim oleh YouTube, bukan oleh WhatsApp/Baileys. Mulai dari memperbarui yt-dlp dengan binary resmi, karena paket pipx/Python 3.10 lama dapat menampilkan peringatan deprecation.

## 1. Perbarui yt-dlp di Ubuntu 22.04

Jalankan sebagai user `ubuntu` dari folder project; jangan memakai `sudo npm install`.

```bash
cd /home/ubuntu/coba/KamlzBot-Final
bash scripts/install-ubuntu22.sh
hash -r
which yt-dlp
yt-dlp --version
node --version
```

Script mengambil executable resmi standalone berdasarkan arsitektur CPU, sehingga tidak lagi menjalankan entrypoint Python 3.10 sistem. Node.js digunakan juga sebagai JS runtime untuk yt-dlp.

## 2. Bila YouTube masih meminta verifikasi

VPS biasanya tidak memiliki profile/browser Chrome untuk `--cookies-from-browser chrome`. Jangan jalankan opsi itu di VPS headless. Gunakan browser di komputer pribadi yang sudah login ke YouTube untuk mengekspor cookies dalam format Netscape/Mozilla `cookies.txt` (file dimulai dengan `# Netscape HTTP Cookie File` atau `# HTTP Cookie File`). Ekspor hanya domain yang diperlukan jika alat ekspor mendukungnya. Jangan kirim isi file ke chat atau log; cookies bisa memberikan akses ke sesi akun.

Unggah file melalui WinSCP ke path di luar web/public directory, misalnya:

```bash
mkdir -p /home/ubuntu/.config/kamlzbot
chmod 700 /home/ubuntu/.config/kamlzbot
# unggah youtube-cookies.txt ke folder di atas melalui WinSCP
chmod 600 /home/ubuntu/.config/kamlzbot/youtube-cookies.txt
head -n 1 /home/ubuntu/.config/kamlzbot/youtube-cookies.txt
```

`head -n 1` hanya memeriksa header format, bukan isi cookies. Jangan gunakan `cat` untuk menampilkan isi file.

Kemudian edit `config.json` dan tambahkan properti di dalam objek JSON:

```json
"ytDlpCookiesFile": "/home/ubuntu/.config/kamlzbot/youtube-cookies.txt"
```

Pastikan koma antara properti JSON benar dan jangan menggandakan key. Restart bot:

```bash
pm run check
npm test
pm2 restart KamlzBot
```

Jika memakai terminal langsung, hentikan bot dengan `Ctrl+C`, lalu `npm start`.

Cookies hanya dipakai untuk mengautentikasi sesi yang Anda miliki. Simpan file dengan permission `600`, jangan commit ke Git atau taruh dalam ZIP/share folder, dan hapus/rotasi jika diduga bocor. Cookies tidak menjamin semua challenge anti-bot YouTube dapat diselesaikan. Link privat, konten berbayar/DRM atau konten yang tidak memiliki izin tetap tidak didukung.
