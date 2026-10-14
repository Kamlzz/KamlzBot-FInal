#!/usr/bin/env bash
set -euo pipefail

# Run as the regular VPS user (usually ubuntu), not as root.
if [[ "$(id -u)" -eq 0 ]]; then
  echo "Jalankan sebagai user biasa (mis. ubuntu), bukan root." >&2
  exit 1
fi

SUDO=""
if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo tidak ditemukan. Pasang sudo atau jalankan langkah paket secara manual." >&2
  exit 1
fi
SUDO=sudo

$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl unzip ffmpeg build-essential

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/kamlzbot-nodesource.sh
  $SUDO bash /tmp/kamlzbot-nodesource.sh
  $SUDO apt-get install -y nodejs
fi

# Install the official standalone yt-dlp binary. This avoids binding yt-dlp to Ubuntu 22.04's
# system Python 3.10, which newer yt-dlp versions may deprecate/drop.
MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64) YTDLP_ASSET="yt-dlp_linux" ;;
  aarch64|arm64) YTDLP_ASSET="yt-dlp_linux_aarch64" ;;
  armv7l|armv6l) YTDLP_ASSET="yt-dlp_linux_armv7l" ;;
  *) echo "Arsitektur belum didukung installer otomatis: $MACHINE" >&2; exit 1 ;;
esac
mkdir -p "$HOME/.local/bin"
# Replace any previous pipx/venv wrapper instead of writing through a symlink.
rm -f "$HOME/.local/bin/yt-dlp"
curl -fL --retry 3 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" \
  -o "$HOME/.local/bin/yt-dlp"
chmod 755 "$HOME/.local/bin/yt-dlp"
$SUDO ln -sfn "$HOME/.local/bin/yt-dlp" /usr/local/bin/yt-dlp
hash -r

node --version
npm --version
ffmpeg -version | head -n 1
ffprobe -version | head -n 1
yt-dlp --version

echo "Dependensi sistem selesai dipasang. Jalankan npm install dari folder KamlzBot."
