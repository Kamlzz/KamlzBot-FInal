# Analisis migrasi KamlzBot ke Baileys 7

Tanggal pemeriksaan: 14 Oktober 2026.

## Versi

Saat paket disusun, npm menampilkan `7.0.0-rc14` sebagai tag `latest`, sementara `6.7.24` masih ditandai `legacy`. RC14 adalah release candidate, bukan versi stabil final. Paket ini mengunci persis `@whiskeysockets/baileys@7.0.0-rc14` supaya build reproducible dan tidak melompat ke prerelease baru tanpa tes.

## Migrasi yang dilakukan

- Proyek CommonJS diubah ke ESM (`"type": "module"`).
- Import Baileys menggunakan default export dan named exports sesuai dokumentasi v7.
- Path file menggunakan `fileURLToPath(import.meta.url)` sebagai pengganti `__dirname`.
- Modul helper lokal diubah ke ESM dengan ekstensi `.js` pada import.
- `useMultiFileAuthState` dipakai kembali agar auth state versi Baileys dapat menyimpan key baru; versi 7 mengubah struktur/dukungan LID, sehingga sesi lama tidak dijamin dapat dipakai tanpa relink.
- Owner resolver mendukung mapping LID ke phone number dan allowlist manual `ownerLids`.
- Logging Signal housekeeping dan beberapa timeout inisialisasi nonfatal difilter, tetapi log command/error nyata dipertahankan.
- Perintah file dan arsip pesan yang disetujui dipertahankan; media View Once dan pesan sementara tetap dikecualikan dari arsip.
- Modul downloader memakai argumen proses terpisah, bukan shell string, membatasi URL ke host yang diminta, mematikan playlist, menegakkan batas ukuran/timeouts, lalu menyimpan file di `data/files/`.
- Konversi audio ke MP3 dan edit video menggunakan FFmpeg dengan output dan durasi dibatasi.

## Fitur API versus command

Baileys adalah library protokol/socket, bukan fitur menu siap pakai. KamlzBot mengimplementasikan command praktis atas subset API, tetapi tidak mengklaim semua metode internal/event/protobuf Baileys memiliki command karena beberapa memerlukan event, kredensial, aliran state, izin admin, tipe pesan, atau pengetahuan protokol. Semua fitur command tetap perlu diuji pada akun WhatsApp serta versi server yang dipakai.

## Risiko/tes yang belum dapat dilakukan di lingkungan ini

Lingkungan pengerjaan tidak memiliki akses DNS keluar ke GitHub/npm saat membangun arsip. Oleh sebab itu paket tidak bisa menjalankan `npm install` atau koneksi WhatsApp live di sini. Pemeriksaan yang dijalankan di lingkungan ini: sintaks Node untuk source, dan unit test helper file, log, arsip, URL dan parser waktu media. Sebelum production, jalankan `npm install`, `npm run check`, `npm test`, kemudian uji QR pairing, `,help`, `,ls`, `,dlfile 1`, unduh dari link publik yang memang boleh diunduh, dan setiap operasi FFmpeg pada file kecil.

Tambahan verifikasi media: source FFmpeg diuji dengan klip uji lokal 3 detik. Kelima operasi `trim`, `rotate`, `slow`, `fast`, dan `compress` menghasilkan MP4 valid. Test command Baileys di lingkungan tanpa jaringan dijalankan menggunakan stub minimal untuk import `downloadMediaMessage`, sehingga test itu menguji logika pembangun perintah, bukan kompatibilitas end-to-end dengan socket Baileys RC14.
