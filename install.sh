#!/usr/bin/env bash
# Siaflex Sbee Intelligence kurulum betiği
# Kullanım: ./install.sh   (Ubuntu/Debian tabanlı sistemlerde test edilmiştir)
set -euo pipefail
cd "$(dirname "$0")"

echo "==============================================="
echo "  Siaflex Sbee Intelligence - Kurulum"
echo "==============================================="

# 1) Docker kontrolü / kurulumu
if ! command -v docker >/dev/null 2>&1; then
    echo "[1/4] Docker bulunamadı, kuruluyor (get.docker.com)..."
    curl -fsSL https://get.docker.com | sh
else
    echo "[1/4] Docker mevcut: $(docker --version)"
fi

SUDO=""
if ! docker info >/dev/null 2>&1; then
    SUDO="sudo"
    if ! sudo docker info >/dev/null 2>&1; then
        echo "HATA: Docker daemon'a erişilemiyor. 'sudo systemctl start docker' deneyin."
        exit 1
    fi
fi

if ! $SUDO docker compose version >/dev/null 2>&1; then
    echo "HATA: 'docker compose' eklentisi yok. 'sudo apt-get install docker-compose-plugin' ile kurun."
    exit 1
fi

# 2) Yapılandırma dosyası
if [ ! -f .env ]; then
    echo "[2/4] .env oluşturuluyor (.env.example'dan)..."
    cp .env.example .env
    chmod 600 .env
    echo "     Not: Veeam sunucunuzu kurulumdan sonra arayüzdeki ⚙ Ayarlar'dan ekleyebilirsiniz."
else
    echo "[2/4] Mevcut .env korunuyor."
fi

# 3) Kalıcı veri dizini (container içindeki uid 1001 yazabilmeli)
echo "[3/4] Veri dizini hazırlanıyor..."
mkdir -p data
if [ "$(stat -c %u data)" != "1001" ]; then
    chown 1001:1001 data 2>/dev/null \
        || sudo -n chown 1001:1001 data 2>/dev/null \
        || chmod 777 data 2>/dev/null \
        || echo "     UYARI: data/ dizinine uid 1001 için yazma izni verilemedi."
fi

# 4) Build + başlat
echo "[4/4] İmaj derleniyor ve başlatılıyor (ilk derleme birkaç dakika sürebilir)..."
$SUDO docker compose up -d --build

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PORT=$(grep -E '^SBEE_PORT=' .env 2>/dev/null | cut -d= -f2)
PORT=${PORT:-8080}
echo ""
echo "==============================================="
echo "  Kurulum tamamlandı!"
echo "  Arayüz:  http://${IP:-localhost}:${PORT}"
echo "  Sunucu eklemek için: sağ üstteki ⚙ Ayarlar > Sunucu Ekle"
echo "  Durum:   $SUDO docker compose ps"
echo "  Loglar:  $SUDO docker compose logs -f"
echo "==============================================="
