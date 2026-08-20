#!/usr/bin/env bash
# Sbee'yi durdurur ve container/imajı kaldırır. Veriler (data/) ve .env SİLİNMEZ.
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""
docker info >/dev/null 2>&1 || SUDO="sudo"
$SUDO docker compose down --rmi local
echo "Kaldırıldı. Sunucu kayıtları ve kota verisi data/ dizininde duruyor."
echo "Tamamen silmek için: rm -rf data .env"
