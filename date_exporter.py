import os
import json
import time
import requests  # type: ignore
from typing import List, Dict, Any, Optional

class DataExporter:
    """
    Sistem Entegrasyon Katmanı (The Architect).
    OpenCV (Algoritma) çıktılarını Backend (Efe Aydın) ve Frontend (İlyas)
    sistemleriyle haberleştiren, hata toleranslı (Fault Tolerant) veri yöneticisi.
    """
    
    def __init__(self, backend_url: str = "http://localhost:8000/report_bulk", output_dir: str = "data/output"):
        self.backend_url = backend_url
        self.output_dir = output_dir
        
        # Çıktı klasörünü her ihtimale karşı dosya ağacında garantile
        os.makedirs(self.output_dir, exist_ok=True)

    def send_bulk_payload(self, payloads: List[Dict[str, Any]]) -> bool:
        """
        Bulunan tüm anomalileri tek bir liste (array) içinde paketler ve Backend'e yollar.
        Eğer Backend çökmüşse, sunum anında verinin kaybolmaması için Offline JSON yedeği alır.
        Dönüş Zarfı: True (Post başarılı) / False (Hata verdi, Offline mode'a geçildi)
        """
        if not payloads:
            return True # Gönderilecek bir şey yok
            
        try:
            # 2 Saniye Timeout: İstek takılırsa UI veya OpenCV akışını süresiz kitlememek için.
            response = requests.post(self.backend_url, json={"data": payloads}, timeout=2)
            response.raise_for_status()
            print(f"[DATA EXPORTER] Backend Bulk Upload Başarılı. Toplam {len(payloads)} Kayıt Aktarıldı.")
            return True
            
        except (requests.exceptions.RequestException, Exception) as e:
            print(f"[DATA EXPORTER] 🔴 Backend Hatası / REST API Ulaşılamıyor: {e}")
            self._save_offline_fallback(payloads)
            return False

    def _save_offline_fallback(self, payloads: List[Dict[str, Any]]) -> None:
        """
        Hackathonlarda hayat kurtaran 'Plan B'. Backend'e ulaşılamadığında
        (Örn: sunucu kapalı, internet yok) çalışan acil durum yedeklemesi.
        """
        timestamp = int(time.time())
        offline_file = os.path.join(self.output_dir, f"OFFLINE_PAYLOADS_{timestamp}.json")
        
        with open(offline_file, "w", encoding="utf-8") as f:
            # 'status' tagiyle backend loglarında offline'dan geldiği ayırt edilebilir
            json.dump({"data": payloads, "status": "offline_backup_dump"}, f, indent=4)
            
        print(f"⚠️ [DATA EXPORTER] OFFLINE MOD: Veriler kaybolmadı. Lokal diske '{offline_file}' dosyasına yedeklendi.")

    def export_to_geojson(self, payloads: List[Dict[str, Any]], filename: Optional[str] = None) -> str:
        """
        Anomali listesini İlyas'ın (Leaflet.js) veya herhangi bir GIS sisteminin
        hiçbir parser'a dokunmadan doğrudan (Drag & Drop) okuyabileceği GeoJSON formatına çevirir.
        """
        if not payloads:
            return ""

        timestamp = int(time.time())
        if filename is None:
            filename = f"export_map_{timestamp}.geojson"
            
        filepath = os.path.join(self.output_dir, filename)
        
        features = []
        for p in payloads:
            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    # GeoJSON standardı [Boylam(Lon), Enlem(Lat)] sırasını ister!
                    "coordinates": [p.get("lon", 0.0), p.get("lat", 0.0)]
                },
                "properties": p
            }
            features.append(feature)
            
        geojson_data = {
            "type": "FeatureCollection",
            "features": features
        }
        
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(geojson_data, f, indent=4)
            
        print(f"[DATA EXPORTER] GeoJSON Harita Katmanı Derlendi: '{filepath}'")
        return filepath

if __name__ == "__main__":
    # Sistemin bağımsız (Standalone) çalışabilirliğini kanıtlayan birim test.
    print("--- 📡 THE ARCHITECT: BULK DATA EXPORTER & GIS MANAGER ---")
    exporter = DataExporter()
    
    mock_anomalies = [
        {"type": "fire", "lat": 39.92, "lon": 32.85, "intensity": 500, "radius_meter": 24.5},
        {"type": "debris", "lat": 39.91, "lon": 32.84, "intensity": 1200, "radius_meter": 60.1}
    ]
    
    # 1. Backend'e gönderimi test et (Eğer localhost:8000 ölü ise direkt OFFLINE uyarısı verecek)
    exporter.send_bulk_payload(mock_anomalies)
    
    # 2. İlyas'ın haritası için statik FeatureCollection çıkart
    output_geojson = exporter.export_to_geojson(mock_anomalies, filename="test_mission.geojson")
    print(f"Birim Test Tamamlandı. Lütfen '{output_geojson}' dosyasını kontrol edin.")
