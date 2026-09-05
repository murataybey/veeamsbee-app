# Siaflex Sbee Intelligence

Veeam ortamınıza doğal dille soru sorun. Sbee, sorularınızı Veeam Intelligence
servisine iletir ve cevapları (tablolar dahil) tarayıcınızda gösterir — tamamen
kendi ağınızda çalışır, dışarıya yalnızca Veeam sunucusunun kendisi çıkar.

## Gereksinimler

- Linux sunucu (Ubuntu 22.04/24.04 test edildi), internet erişimi
- Docker (yoksa `install.sh` kurar) + docker compose eklentisi
- Lisanslı bir Veeam ürünü (VBR / Veeam ONE / VSPC), **Veeam Intelligence
  Advanced mode** açık (VBR web konsolu → Configuration → Veeam Intelligence)
- MFA'sız bir servis hesabı

## Kurulum (tek komut)

```bash
./install.sh
```

Betik sırasıyla: Docker'ı kontrol eder/kurar → `.env` oluşturur → kalıcı veri
dizinini hazırlar → imajı derler (Veeam MCP server'ı GitHub'dan çekip derler,
üzerine Sbee arayüzünü koyar) → servisi başlatır.

Sonra tarayıcıdan `http://<sunucu-ip>:8080` adresine gidin ve sağ üstteki
**⚙ Ayarlar → Sunucu Ekle** ile Veeam sunucunuzu tanıtın (isim, IP, kullanıcı
adı, parola). "Aktif Yap" dediğiniz sunucuya sorular gitmeye başlar.

## Yapılandırma

- `.env` — port, isteğe bağlı ilk sunucu tanımı, arayüz metinleri (bkz. `.env.example`)
- `data/servers.json` — kayıtlı sunucular (parolalar burada; dosya 600 izinli tutulur)
- `data/quota.json` — yerel soru sayacı (24 saatlik pencere)

## Günlük işletim

```bash
docker compose ps          # durum
docker compose logs -f     # loglar
docker compose restart     # yeniden başlat
docker compose up -d --build   # güncelleme sonrası yeniden derle
./uninstall.sh             # kaldır (veriler korunur)
```

## Farklı bir MCP server ile kullanma

Arayüz parametriktir; tool adını ve soru parametresini otomatik keşfeder.

1. `Dockerfile` içindeki `MCP_REPO` argümanını kendi reponuza çevirin
   (veya `docker compose build --build-arg MCP_REPO=...`).
2. MCP server'ınızın ihtiyacı olan ortam değişkenlerini `.env`'e ekleyin
   (hepsi çocuk sürece otomatik aktarılır).
3. Gerekirse `MCP_TOOL_NAME` / `MCP_QUESTION_ARG` ile tool seçimini sabitleyin.

## Notlar

- Arayüzde kimlik doğrulama yoktur; yalnızca güvenilir ağda yayınlayın
  (gerekirse önüne reverse proxy + parola koyun).
- Veeam Intelligence kotası: lisans başına 24 saatte 200 soru (Veeam bulut
  tarafında uygulanır). Arayüzdeki sayaç yerel bir tahmindir.
