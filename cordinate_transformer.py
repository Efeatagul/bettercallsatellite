from typing import Tuple

class CoordinateTransformer:
    """
    Piksel uzayından gerçek dünya (WGS84) koordinatlarına
    lineer interpolasyon ile dönüşüm sağlayan bağımsız GIS aracı.
    Halil'in NetworkX ve İlyas'ın Leaflet katmanlarıyla uyumlu çalışması
    için kesin (strict) dönüşüm matematiğini içerir.
    """
    
    def __init__(self, bbox: Tuple[float, float, float, float], img_size: Tuple[int, int]):
        """
        Args:
            bbox: (TopLat, BottomLat, LeftLon, RightLon) - Kuzey, Güney, Batı, Doğu sınırları
            img_size: (height, width) - İşlenen uydunun piksel çözünürlüğü
        """
        self.top_lat, self.bottom_lat, self.left_lon, self.right_lon = bbox
        self.img_height, self.img_width = img_size
        
        # 1 pikselin enlem ve boylam cinsinden derece (angular) karşılığı
        self.lat_res_per_px = abs(self.top_lat - self.bottom_lat) / self.img_height
        self.lon_res_per_px = abs(self.right_lon - self.left_lon) / self.img_width
        
        # WGS84 Projeksiyonunda 1 Derece Enlem ≈ 111,000 metredir (111 km).
        self.DEGREE_TO_METER = 111000.0

    def pixel_to_geo(self, x: float, y: float) -> Tuple[float, float]:
        """
        Piksel koordinatını (x, y) WGS84 (Lat, Lon) değerine dönüştür.
        (0,0) Görüntünün sol üst (Top-Left) köşesidir.
         - Y ekseninde aşağı indikçe (y artar) -> Enlem (Lat) azalır.
         - X ekseninde sağa gittikçe (x artar) -> Boylam (Lon) artar.
        """
        lat = self.top_lat - (y / self.img_height) * (self.top_lat - self.bottom_lat)
        lon = self.left_lon + (x / self.img_width) * (self.right_lon - self.left_lon)
        return float(lat), float(lon)

    def radius_pixel_to_meter(self, radius_px: float) -> float:
        """
        Piksel cinsinden yarıçapı, dikey (enlem) çözünürlüğü referans
        alarak gerçek dünyadaki Metre birimine çevirir (No-Go Zone hesabı için).
        """
        radius_deg = radius_px * self.lat_res_per_px
        radius_meter = radius_deg * self.DEGREE_TO_METER
        return float(radius_meter)

if __name__ == "__main__":
    # GIS Matematiksel Doğrulama (Unit Test / Dry Run)
    TEST_BBOX = (40.0, 39.0, 32.0, 33.0)  # Ankara çevresi sembolik bbox
    TEST_IMG_SIZE = (1000, 1000) # Görüntü (height=1000, width=1000)
    
    print("--- 🌍 SATELLITE GIS TRANSFORMER ---")
    transformer = CoordinateTransformer(bbox=TEST_BBOX, img_size=TEST_IMG_SIZE)
    
    # Tam merkezin koordinatını sorgulama (500x500 piksel)
    lat, lon = transformer.pixel_to_geo(500, 500)
    print(f"Merkez Piksel (X:500, Y:500) -> Geo(Lat: {lat}, Lon: {lon})")
    
    # Farazi büyük bir yarıçapı (örnek 50px) hesaplama
    meter = transformer.radius_pixel_to_meter(50)
    print(f"50 px (yarıçap) Anomali Alanı -> Gerçek Dünyada: {meter:.2f} Metre Yarıçap (Radius)")
