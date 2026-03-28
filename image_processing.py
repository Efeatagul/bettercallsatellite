import cv2  # type: ignore
import numpy as np  # type: ignore
import requests  # type: ignore
import matplotlib.pyplot as plt  # type: ignore
import json
import os
import time
import glob
import threading
from typing import List, Tuple, Dict, Optional, Any

class SatelliteCoreEngine:
    """
    Profesyonel, modüler ve yüksek performanslı OpenCV uydu analiz motoru.
    Gelişmiş Gürültü Filtreleme (CLAHE, Morphology), Geometrik Hesaplamalar (Centroid)
    ve Zamansal Değişim (Temporal Change) Analizi entegrasyonu sunar.
    """
    
    def __init__(self, bbox: Tuple[float, float, float, float] = (40.0, 39.8, 32.7, 33.0)):
        self.top_lat, self.bottom_lat, self.left_lon, self.right_lon = bbox
        
        # Tespit sınıflarına özel BGR renk paketleri
        self.color_map = {
            "fire": (0, 0, 255),    # Kırmızı
            "flood": (255, 0, 0),   # Mavi
            "debris": (0, 255, 255) # Sarı
        }
        
        # Maksimum optimizasyon için gürültü alanı alt sınırı
        self.min_contour_area = 100

    def apply_clahe(self, img: np.ndarray) -> np.ndarray:
        """CLAHE (Contrast Limited Adaptive Histogram Equalization) ile yerel kontrast artırımı."""
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        return cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)

    def preprocess(self, img: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Görüntüyü temizle, CLAHE ile aydınlat, blur (Bulanıklaştırma) ve HSV'ye dönüştür."""
        enhanced = self.apply_clahe(img)
        blurred = cv2.GaussianBlur(enhanced, (5, 5), 0)
        hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)
        return enhanced, blurred, hsv

    def _get_cloud_shadow_mask(self, hsv: np.ndarray) -> np.ndarray:
        """False Positive hatalarını engellemek için Bulut (Cloud) ve Gölge (Shadow) maskesi."""
        lower_cloud = np.array([0, 0, 200])
        upper_cloud = np.array([179, 40, 255])
        lower_shadow = np.array([0, 0, 0])
        upper_shadow = np.array([179, 255, 40])
        
        cloud_mask = cv2.inRange(hsv, lower_cloud, upper_cloud)
        shadow_mask = cv2.inRange(hsv, lower_shadow, upper_shadow)
        
        # Morfolojik kapanma (Closing) ile pürüzsüz maske yüzeyi elde edilmesi
        kernel = np.ones((5, 5), np.uint8)
        mask_combined = cv2.bitwise_or(cloud_mask, shadow_mask)
        return cv2.morphologyEx(mask_combined, cv2.MORPH_CLOSE, kernel)

    def detect_fire(self, hsv: np.ndarray, blurred: np.ndarray) -> np.ndarray:
        """Kırmızı/Turuncu sıcaklık tonları ve bitki dokusu tüketim (Pseudo-NDVI) kontrolü."""
        lower_red1 = np.array([0, 120, 70])
        upper_red1 = np.array([10, 255, 255])
        lower_red2 = np.array([160, 120, 70])
        upper_red2 = np.array([179, 255, 255])
        lower_yellow = np.array([10, 100, 100])
        upper_yellow = np.array([35, 255, 255])
        
        base_mask = (cv2.inRange(hsv, lower_red1, upper_red1) | 
                     cv2.inRange(hsv, lower_red2, upper_red2) | 
                     cv2.inRange(hsv, lower_yellow, upper_yellow))
        
        # Pseudo-NDVI (Yangın yeşili tüketir, bu yüzden Kırmızı kanal > Yeşil kanal kontrolü)
        b, g, r = cv2.split(blurred)
        pseudo_ndvi_mask = ((r.astype(int) - g.astype(int)) > 50).astype(np.uint8) * 255
        
        # Morfolojik Açılma (Opening) ile hatalı piksel gruplarını ezen katı mimari.
        combined = cv2.bitwise_and(base_mask, pseudo_ndvi_mask)
        kernel = np.ones((3, 3), np.uint8)
        return cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel)

    def detect_flood(self, hsv: np.ndarray) -> np.ndarray:
        """Sel Tespiti: Temiz Mavi (Su) ve Bulanık Kahverengi (Çamur Dalgası)."""
        lower_blue = np.array([90, 50, 50])
        upper_blue = np.array([130, 255, 255])
        lower_brown = np.array([10, 50, 20])
        upper_brown = np.array([30, 255, 200])
        
        mask = cv2.inRange(hsv, lower_blue, upper_blue) | cv2.inRange(hsv, lower_brown, upper_brown)
        kernel = np.ones((5, 5), np.uint8)
        return cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    def detect_debris(self, blurred: np.ndarray, ref_gray: Optional[np.ndarray] = None) -> np.ndarray:
        """Canny Edge, Geometrik Genişletme (Dilatation) ve Mutlak Değişim Tespiti (Change Detection)."""
        gray = cv2.cvtColor(blurred, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 100, 200)
        
        kernel = np.ones((5, 5), np.uint8)
        dilated = cv2.dilate(edges, kernel, iterations=2)
        base_mask = cv2.morphologyEx(dilated, cv2.MORPH_OPEN, kernel)
        
        # Referans Resim Verilmişse Sinerjik Kesin Yıkım Kontrolü
        if ref_gray is not None:
            gray_blur = cv2.GaussianBlur(gray, (5, 5), 0)
            diff = cv2.absdiff(ref_gray, gray_blur)
            _, change_mask = cv2.threshold(diff, 30, 255, cv2.THRESH_BINARY)
            change_mask = cv2.morphologyEx(change_mask, cv2.MORPH_OPEN, kernel)
            base_mask = cv2.bitwise_and(base_mask, change_mask)
            
        return base_mask

    def pix2geo(self, x: float, y: float, img_w: int, img_h: int) -> Tuple[float, float]:
        """Görüntü uzayından WGS84 Coğrafi Projeksiyona Linear Interpolasyon."""
        lat = float(self.top_lat - (y / img_h) * (self.top_lat - self.bottom_lat))
        lon = float(self.left_lon + (x / img_w) * (self.right_lon - self.left_lon))
        return lat, lon

    def extract_anomalies(self, mask: np.ndarray, current_type: str, img_shape: Tuple[int, int]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Maskelerden Contour ve Merkez Koordinatlarının (Centroiding) Modüler Hesaplaması."""
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        height, width = img_shape
        
        payloads = []
        visual_data = []
        lat_res_per_px = float(abs(self.top_lat - self.bottom_lat) / height)
        
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area > self.min_contour_area:
                x, y, w, h = cv2.boundingRect(cnt)
                
                # Image Moments kullanımı ile Geokimyasal merkez tespiti
                M = cv2.moments(cnt)
                cX = int(M["m10"] / M["m00"]) if M["m00"] != 0 else 0
                cY = int(M["m01"] / M["m00"]) if M["m00"] != 0 else 0
                
                _, radius_px = cv2.minEnclosingCircle(cnt)
                radius_px = float(radius_px)
                
                lat, lon = self.pix2geo(cX, cY, width, height)
                
                radius_deg = float(radius_px * lat_res_per_px)
                radius_meter = float(radius_deg * 111000.0)
                
                payloads.append({
                    "type": str(current_type),
                    "lat": lat,
                    "lon": lon,
                    "intensity": area,
                    "radius_deg": radius_deg,
                    "radius_meter": radius_meter
                })
                
                visual_data.append({"bbox": (x, y, w, h), "centroid": (cX, cY), "radius": radius_px})
                
        return payloads, visual_data

    def process(self, image_path: str, modes: List[str] = ["fire", "flood", "debris"], ref_img_path: Optional[str] = None) -> np.ndarray:
        """Genişletilmiş Core Engine Veri hattı tetikleyicisi."""
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Okuma Hatası. Geçersiz PATH: {image_path}")
            
        h, w = img.shape[:2]
        enhanced, blurred, hsv = self.preprocess(img)
        noise_mask = self._get_cloud_shadow_mask(hsv)
        
        ref_gray = None
        if ref_img_path and os.path.exists(ref_img_path):
            ref = cv2.imread(ref_img_path)
            if ref is not None:
                ref = cv2.resize(ref, (w, h))
                ref_gray = cv2.cvtColor(cv2.GaussianBlur(ref, (5, 5), 0), cv2.COLOR_BGR2GRAY)
        
        visual_out = enhanced.copy()
        all_payloads = []
        
        for mode in modes:
            if mode == "fire":
                raw_mask = self.detect_fire(hsv, blurred)
            elif mode == "flood":
                raw_mask = self.detect_flood(hsv)
            elif mode == "debris":
                raw_mask = self.detect_debris(blurred, ref_gray=ref_gray)
            else:
                continue

            clean_mask = cv2.bitwise_and(raw_mask, cv2.bitwise_not(noise_mask))
            
            # Mission Critical: Isı Haritalandırması (Zeminsel Yıkım Verisi)
            if mode == "debris":
                heatmap = cv2.applyColorMap(clean_mask, cv2.COLORMAP_JET)
                mask_3ch = cv2.cvtColor(clean_mask, cv2.COLOR_GRAY2BGR)
                heatmap_overlay = np.where(mask_3ch > 0, heatmap, visual_out)
                visual_out = cv2.addWeighted(visual_out, 0.6, heatmap_overlay, 0.4, 0)

            # Metadata Çekimi
            payloads, v_data = self.extract_anomalies(clean_mask, mode, (h, w))
            all_payloads.extend(payloads)
            
            color = self.color_map.get(mode, (255, 255, 255))
            for item in v_data:
                bx, by, bw, bh = item["bbox"]
                cx, cy = item["centroid"]
                r = item["radius"]
                
                cv2.rectangle(visual_out, (bx, by), (bx+bw, by+bh), color, 2)
                cv2.putText(visual_out, str(mode).upper(), (bx, by - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
                cv2.circle(visual_out, (cx, cy), 5, (255, 255, 255), -1)
                cv2.circle(visual_out, (cx, cy), int(r), (0, 255, 255), 2)

        self._draw_hud(visual_out, modes, len(all_payloads))
        
        # Async Ops
        if all_payloads:
            threading.Thread(target=self._export_data, args=(all_payloads,), daemon=True).start()
            
        return visual_out

    def _draw_hud(self, img: np.ndarray, modes: List[str], count: int) -> None:
        cv2.rectangle(img, (5, 5), (320, 110), (0, 0, 0), -1)
        m_str = "ALL" if len(modes) > 1 else str(modes[0]).upper()
        cv2.putText(img, f"SYS_STATUS: ACTIVE(OPENCV_CORE)", (15, 30), cv2.FONT_HERSHEY_PLAIN, 1.0, (0, 255, 0), 2)
        cv2.putText(img, f"SCAN_MODE: {m_str}", (15, 55), cv2.FONT_HERSHEY_PLAIN, 1.2, (0, 255, 255), 2)
        cv2.putText(img, f"OBJECTS_FOUND: {count}", (15, 80), cv2.FONT_HERSHEY_PLAIN, 1.2, (0, 165, 255), 2)
        cv2.putText(img, f"TIMESTAMP: {int(time.time())}", (15, 105), cv2.FONT_HERSHEY_PLAIN, 0.8, (255, 255, 255), 1)

    def _export_data(self, payloads: List[Dict[str, Any]]) -> None:
        """Asenkron Bulk POST işlemleri & Offline JSON/GEOJSON Fallback"""
        os.makedirs(os.path.join("data", "output"), exist_ok=True)
        try:
            requests.post("http://localhost:8000/report_bulk", json={"data": payloads}, timeout=2)
            print(f"---> [THREAD] Backend Upload O.K. ({len(payloads)} adet)")
        except Exception as e:
            offline_file = os.path.join("data", "output", f"OFFLINE_PAYLOADS_{int(time.time())}.json")
            with open(offline_file, "w", encoding="utf-8") as f:
                json.dump({"data": payloads}, f, indent=4)
        
        geofile = os.path.join("data", "output", f"export_map_{int(time.time())}.geojson")
        features = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]}, "properties": p} for p in payloads]
        with open(geofile, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f, indent=4)


# Hackathon Video/Simülasyon Wrapper'ı Dışarıda Bırakıldı (Core Bağımsız)
def process_video_stream(folder_path: str, modes: List[str]=["fire", "flood", "debris"]):
    print(f"\n🎥 CANLI YAYIN SIMÜLASYONU BAŞLIYOR... Klasör: {folder_path} | Modlar: {modes}")
    images = sorted(glob.glob(os.path.join(folder_path, "*.jpg")) + glob.glob(os.path.join(folder_path, "*.png")))
    
    if not images:
        print("Klasörde görüntü bulunamadı!")
        return

    cv2.namedWindow('MISSION CONTROL - Sat Stream', cv2.WINDOW_NORMAL)
    engine = SatelliteCoreEngine()
    
    for img_path in images:
        try:
            visual_img = engine.process(img_path, modes=modes)
            cv2.imshow('MISSION CONTROL - Sat Stream', visual_img)
        except Exception as e:
            print(f"Hata: {e}")
            
        if cv2.waitKey(1000) & 0xFF == ord('q'):
            break
            
    cv2.destroyAllWindows()
    print("🎥 Simülasyon Tamamlandı.")

if __name__ == "__main__":
    print("🚀 Modüler OpenCV Core Engine (Pythonic Architecture) Başlatıldı.")
    # Tek Görsel Analiz:
    # engine = SatelliteCoreEngine()
    # out_img = engine.process("data/raw/ornek.jpg", modes=["fire", "flood", "debris"])
    # cv2.imwrite("data/output/sonuc.jpg", out_img)
    # plt.imshow(cv2.cvtColor(out_img, cv2.COLOR_BGR2RGB)); plt.show()
