# Analisis README resmi Baileys dan implementasi pada KamlzBot 2.2.0

Sumber acuan:
- README `master`: https://github.com/WhiskeySockets/Baileys/blob/master/README.md
- README rilis kompatibel: https://app.unpkg.com/@whiskeysockets/baileys@6.7.18/files/README.md

README Baileys adalah referensi API library, bukan daftar perintah bot yang bisa dipasang langsung. API perlu diintegrasikan menjadi handler, cache/event store, command, dan izin sendiri. README `master` juga memperingatkan perubahan breaking pada 7.0.0; paket ini mempertahankan major 6.x agar lebih sesuai dengan source KamlzBot yang berjalan.

## Matriks cakupan

| Area README | Cakupan dalam KamlzBot | Catatan |
|---|---|---|
| QR auth dan persistensi kredensial | Diimplementasikan | `useMultiFileAuthState`; tidak menghapus sesi lama. |
| Pairing code | Opt-in setup awal | `KAMLZBOT_PAIRING_CODE=1`, opsional `pairingCodeNumber`; jangan aktifkan pada sesi yang sudah tertaut. |
| Full history | Opt-in socket config | `syncFullHistory: true`; default false untuk hemat memori/jaringan. |
| Socket config / `getMessage` | Diimplementasikan | Cache pesan dalam memori dengan batas, untuk retry dan polling. Hilang saat restart. |
| Group metadata cache | Diimplementasikan | TTL lima menit dan invalidasi saat group/member update. |
| Event connection, auth, messages, updates, calls | Diimplementasikan | Reconnect, save credentials, parsing perintah, poll votes, anti-delete opt-in, panggilan opsional. |
| Text / quote / mentions / forward | Command | Balas kutipan untuk target; forward hanya melalui chat pribadi owner. |
| Location / contact / reaction / pin / poll | Command | `,loc`, `,contact`, `,react`, `,pinmsg`, `,poll`, `,pollresults`. |
| Link preview | Belum otomatis | README meminta `link-preview-js`; dependency opsional tidak ditambahkan. |
| Image / video / audio / document / GIF / View Once | Command | `,sendmedia`, `,sendgif`, `,viewonce`; View Once hanya untuk mengirim, bukan membaca atau menyimpan media masuk. |
| Download media / re-upload | Diimplementasikan di alur media | `,upfile` menggunakan `downloadMediaMessage`; re-upload request disediakan ketika tersedia. |
| Thumbnail image/video | Tidak dibundel | Bisa memerlukan `sharp`/`jimp` dan `ffmpeg`; sengaja tidak menambah dependensi sistem secara otomatis. |
| Edit/delete everyone | Command terbatas | `,edit` dan `,deleteeveryone` hanya untuk pesan yang dikenali sebagai pesan bot sendiri. |
| Delete for me / chat modification | Command | `,deleteforme`, `,archivechat`, `,mute`, `,markunread`, `,deletechat`, `,pinchat`, `,star`, timer pesan sementara. Perlu key/timestamp cache untuk sebagian operasi. |
| Call reject | Diimplementasikan | `,autoreject on|off`; default off. |
| Read receipt / presence | Command | `,markread`, `,presence`, `,presencecheck`; hasil presence bergantung pada update yang diterima dan privasi pengguna. |
| Query nomor, history, status, foto, business | Command/fitur internal | `,waexists`, `,history`, `,wastatus`, `,pp`, `,business`. Query history memakai cache terbatas; bukan ekspor riwayat. |
| Perubahan profil akun | Command | `,setname`, `,setstatus`, `,setpp`, `,removepp`. |
| Profil grup | Command | `,gpp`, `,setgpp`, `,removegpp`; harus diuji pada grup uji dan mungkin butuh admin. |
| Grup | Sebagian besar API umum | Buat grup, update anggota/subjek/deskripsi/pengaturan, undangan/kode, join, request join, metadata, ephemeral dan mode add. |
| Privasi / blocklist | Command | Baca/tetapkan beberapa pengaturan privacy dan blokir. Ketersediaan bergantung pada versi WhatsApp/Baileys. |
| Status/story | Command dengan penerima eksplisit | `,storytext`, `,storymedia`; maksimum 50 nomor yang dipilih owner. Tidak ada pengiriman status kepada daftar kontak yang tidak ditentukan. |
| Broadcast list metadata | Read-only command | `,broadcastinfo <timestamp>@broadcast`; pembuatan broadcast list tidak didukung oleh WA Web menurut README. |
| Raw WebSocket callbacks / protocol frames / debug dump | Tidak diekspos | Fitur developer tingkat rendah, bukan command biasa; debug default tetap tenang untuk menghindari log yang membanjiri terminal. |

## Hal penting sebelum dipasang

1. **Jangan upgrade Baileys ke 7.x secara langsung.** API dan tipe dapat berubah secara breaking. Paket ini masih menargetkan `@whiskeysockets/baileys ^6.7.18`.
2. Cache pesan dan polling bersifat in-memory dan terbatas (default 3000 message objects). Setelah restart, bot tidak menjamin dapat menyajikan semua pesan lama atau menghitung kembali vote polling lama.
3. `,history` meminta pesan terdahulu berdasarkan pesan paling tua yang masih tersimpan di cache. Hasil diterima lewat event history dan masuk cache; tidak dibuat arsip permanen.
4. `,storytext` dan `,storymedia` membutuhkan kata `CONFIRM` dan nomor penerima yang eksplisit. Maksimum 50 penerima per permintaan. Gunakan hanya untuk penerima yang memang dikehendaki.
5. Arsip anti-delete (` ,archive on`) adalah fungsi tersendiri dengan persetujuan chat. Media View Once masuk dan pesan sementara dikecualikan.
6. Semua command dibatasi untuk owner. Operasi grup/profil/privacy dapat ditolak oleh WhatsApp bila perlu hak admin atau kebijakan akun tidak mengizinkan.
7. Ini bukan salinan implementasi seluruh protokol internal Baileys. Link preview dan thumbnail opsional tidak diaktifkan; broadcast messaging generik dan WebSocket debug tidak diekspos sebagai command.
