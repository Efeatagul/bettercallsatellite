# 🛰️ BetterCallSatellite 
> *When disaster strikes and roads are blocked... Better Call Satellite!*

**BetterCallSatellite**, TUA Astro Hackathon 2026 kapsamında **CUDATech** takımı tarafından geliştirilen; yerli uydu verilerini kullanarak afet anında otonom rota optimizasyonu sağlayan bir karar destek sistemidir.

---

## 📖 Proje Hakkında
Afet durumlarında (deprem, sel, yangın vb.) yerdeki ulaşım ağları ciddi hasar görebilir ve standart navigasyon sistemleri yetersiz kalabilir. **BetterCallSatellite**, Türkiye'nin yerli uydularından (GÖKTÜRK-1, RASAT vb.) alınan yüksek çözünürlüklü görüntüleri analiz ederek; kapanan yolları, enkaz alanlarını veya su baskınlarını tespit eder. Kurtarma ekiplerine (AFAD, İtfaiye, Ambulans) en güvenli ve hızlı alternatif rotaları dinamik olarak sunar.

### ✨ Temel Özellikler
- **🛰️ Uydu Veri İşleme:** Yerli uydu görüntülerinin afet analizi için sisteme entegrasyonu.
- **🛣️ Dinamik Engel Analizi:** Görüntü işleme teknikleri ile yol üzerindeki fiziksel engellerin saptanması.
- **📍 Akıllı Rota Optimizasyonu:** Kapanan yolları gerçek zamanlı olarak devre dışı bırakan grafik (graph) tabanlı algoritmalar.
- **🔔 Kritik Bildirim Sistemi:** Saha ekiplerine anlık koordinat ve güvenli yol tariflerinin iletilmesi.
- **🗺️ Operasyonel Dashboard:** Merkezi yönetim ve saha ekipleri için interaktif harita arayüzü.

---

## 🏗️ Sistem Mimarisi (Çalışma Mantığı)
1. **Veri Girişi:** Yerli uydu portalından gelen ham/işlenmiş görüntülerin sisteme aktarılması.
2. **Anomali Tespiti:** Yazılım motorunun görüntüyü analiz ederek ulaşımı engelleyen unsurları (enkaz, çökme vb.) fark etmesi.
3. **Grafik Güncelleme:** Dijital harita üzerindeki yol ağının (OSM) tespit edilen yeni engellere göre otonom olarak güncellenmesi.
4. **Çıktı & Yönlendirme:** En kısa ve güvenli rotanın haritada çizilmesi ve ilgili birimlere iletilmesi.

---

## 🚀 Kurulum ve Çalıştırma
> **Not:** Projenin teknik bağımlılıkları ve kurulum adımları, geliştirme süreci ilerledikçe bu bölüme eklenecektir.

```bash
# Depoyu klonlayın
git clone [https://github.com/CUDATech/BetterCallSatellite.git](https://github.com/CUDATech/BetterCallSatellite.git)
