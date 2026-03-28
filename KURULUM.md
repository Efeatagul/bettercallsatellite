# AfetAI — Kurulum & Çalıştırma Rehberi

## Gereksinimler

- macOS (Apple Silicon M1/M2/M3/M4)
- Python 3.10+
- pip
- Herhangi bir tarayıcı (Chrome/Safari/Firefox)

---

## 1. Python Bağımlılıkları

```bash
pip install flask flask-cors mlx-vlm requests geopy
```

> **Not:** `mlx-vlm` Apple Silicon gerektiriyor. Intel Mac'te kurulmaz.
> Kurulmasa bile sistem algoritmik fallback ile çalışmaya devam eder.

---

## 2. Backend Sunucusunu Başlat

```bash
cd "/Users/efeaydin/Downloads/Fronted 2"
python server.py
```

Sunucu başarıyla başlarsa:

```
────────────────────────────────────────────────────────────
  AfetAI Backend v3 — Dinamik Model Seçimi
  MLX    : ✓ kurulu — /api/load-model ile model seç
  Model  : (henüz seçilmedi — /api/load-model ile yükle)
  URL    : http://localhost:5050
────────────────────────────────────────────────────────────
```

> **Model başlangıçta yüklenmez.** Tarayıcıda "Model Seç" butonuyla seçilir.
> İlk yüklemede model HuggingFace'den indirilir.

### Sunucu Endpoint'leri

| Method | URL | Açıklama |
|--------|-----|----------|
| GET  | `http://localhost:5050/api/status`       | MLX + aktif model durumu |
| GET  | `http://localhost:5050/api/models`       | Önerilen model listesi |
| POST | `http://localhost:5050/api/load-model`   | Model yükle / değiştir |
| POST | `http://localhost:5050/api/unload-model` | Modeli bellekten kaldır |
| POST | `http://localhost:5050/api/geocode`      | Nominatim proxy |
| POST | `http://localhost:5050/api/analyze`      | VLM analiz + tool call |

### Önerilen Modeller

| Model | Boyut | Hız | Not |
|-------|-------|-----|-----|
| `mlx-community/Qwen2.5-VL-7B-Instruct-4bit` | ~4.5 GB | Orta | **Önerilen** |
| `mlx-community/Qwen2.5-VL-3B-Instruct-4bit` | ~2.1 GB | Hızlı | Düşük RAM |
| `mlx-community/Qwen2.5-VL-72B-Instruct-4bit` | ~40 GB | Yavaş | En yüksek doğruluk |
| `mlx-community/Phi-3.5-vision-instruct-4bit` | ~2.4 GB | Hızlı | Microsoft kompakt VLM |
| `mlx-community/llava-1.5-7b-4bit` | ~4.0 GB | Orta | Klasik referans |
| `mlx-community/InternVL2-8B-4bit` | ~4.8 GB | Orta | Güçlü görüntü anlama |

---

## 3. Frontend'i Aç

Yeni bir terminal sekmesinde:

```bash
cd "/Users/efeaydin/Downloads/Fronted 2"
open simulasyon.html
```

Veya doğrudan tarayıcıda dosyayı aç:
```
file:///Users/efeaydin/Downloads/Fronted 2/simulasyon.html
```

> **Öneri:** CORS sorunlarını önlemek için basit bir HTTP sunucusu kullan:
> ```bash
> python -m http.server 8080
> # → http://localhost:8080/simulasyon.html
> ```

---

## 4. Kullanım Akışı

1. **Mahalle Ara** — Arama kutusuna mahalle/şehir yaz, Enter'a bas
   - Nominatim koordinatları bulur
   - Overpass API gerçek toplanma alanlarını çeker
   - Harita bölgeye uçar

2. **Deprem Başlat** — Büyüklük kaydırıcısını ayarla, butona bas
   - Veya haritaya tıklayarak epimerkez seç
   - Hasar bölgeleri kırmızıya döner

3. **AI Analizi** — Qwen2.5-VL görüntüyü analiz eder
   - `route_to_assembly_point()` tool call yapılır
   - En güvenli toplanma alanı seçilir
   - Open-Elevation'dan gerçek Z değerleri çekilir
   - XYZ koordinatlı rota canvas'a çizilir

---

## 5. Mimari Özeti

```
[Kullanıcı arama] → Nominatim → lat/lon
                                   │
                             Overpass API
                          (gerçek toplanma alanları)
                                   │
                           [Leaflet Harita]
                        CartoDB Dark Matter tiles
                                   │
                        [Canvas Overlay — sim.js]
                    hasar bölgeleri / AP ikonları / rota
                                   │
                        captureMapImage() → PNG
                                   │
                    POST /api/analyze (server.py)
                                   │
                          Qwen2.5-VL-7B görür:
                       kırmızı hasar + renkli AP'ler
                                   │
                    Tool call: route_to_assembly_point(
                      assembly_point_id,
                      waypoints [{lat,lon}],
                      reason_tr,
                      risk_notes_tr
                    )
                                   │
                    Open-Elevation → Z değerleri eklenir
                                   │
                    Frontend → animasyonlu rota çizimi
                    Her WP etiketi: X°, Y°, Zm
```

---

## 6. Sunucu Kapalıyken (Fallback)

`server.py` çalışmıyorsa sistem otomatik olarak:
- Nominatim → doğrudan JS'den çağrılır
- Overpass API → doğrudan JS'den çağrılır
- Qwen2.5-VL → **algoritmik fallback** (mesafe + hasar skoru)
- Open-Elevation → doğrudan JS'den çağrılır

Tüm özellikler sunucu olmadan da çalışır, sadece AI yerine algoritma kullanılır.

---

## 7. Tüm Sayfalar

| Dosya | URL | İçerik |
|-------|-----|--------|
| `index.html` | `/index.html` | Ana sayfa |
| `ozet.html` | `/ozet.html` | Sistem özeti + grafikler |
| `girdiler.html` | `/girdiler.html` | Girdi/çıktı tanımları |
| `cozum.html` | `/cozum.html` | Çözüm akışı |
| `teknoloji.html` | `/teknoloji.html` | Tech stack + A* demo |
| `simulasyon.html` | `/simulasyon.html` | **Deprem simülasyonu** |

---

## 8. Kullanılan Ücretsiz API'ler

| API | URL | Limit |
|-----|-----|-------|
| Nominatim | nominatim.openstreetmap.org | 1 req/sn |
| Overpass | overpass-api.de | Ücretsiz |
| Open-Elevation | api.open-elevation.com | Ücretsiz |
| CartoDB Tiles | basemaps.cartocdn.com | Ücretsiz |





cd "/Users/efeaydin/Downloads/Fronted 2" && python3 -m http.server 8080 &>/tmp/afetai-server.log &
echo "PID: $!"
sleep 1
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/simulasyon.html