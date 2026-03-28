import osmnx as ox
import networkx as nx
from route_planner import build_graph_with_disaster, calculate_shortest_route, block_nearest_node
import math

def prove_rerouting():
    # 1. Bölgeyi ve noktaları belirle (Nilüfer, Bursa)
    place = "Nilüfer, Bursa, Turkey"
    start_coords = (40.21, 28.93)  # A Noktası
    end_coords = (40.24, 28.98)    # B Noktası
    
    print("--- SENARYO 1: Normal Durum ---")
    # Afetsiz grafı oluştur
    G_normal = build_graph_with_disaster(place_name=place)
    
    # Normal rotayı hesapla
    route_normal = calculate_shortest_route(G_normal, *start_coords, *end_coords)
    
    if not route_normal:
        print("Hata: Normal rota bulunamadı!")
        return

    print(f"Normal Rota Adım Sayısı: {len(route_normal)}")
    
    # 2. Rotanın tam ortasında bir noktayı "Yangın" bölgesi olarak seçelim
    # Rotanın orta noktasındaki bir koordinatı alalım
    mid_index = len(route_normal) // 2
    fire_coords = route_normal[mid_index]
    
    print(f"\n--- SENARYO 2: Yangın Durumu ---")
    print(f"Yolun ortasına ({fire_coords}) bir YANGIN ekleniyor...")
    
    # Aynı graf üzerinde yangın noktasını engelle
    G_disaster, blocked_node = block_nearest_node(G_normal, *fire_coords, block_reason="YANGIN")
    
    # Yeni rotayı hesapla
    route_disaster = calculate_shortest_route(G_disaster, *start_coords, *end_coords)
    
    # 3. Sonuçları Karşılaştır
    print("\n--- KANIT VE ANALİZ ---")
    if route_disaster:
        print(f"Yeni Rota Adım Sayısı: {len(route_disaster)}")
        
        # Rotalar farklı mı?
        if route_normal != route_disaster:
            print("BAŞARILI: Rota otomatik olarak saptı! (Yangın bölgesi baypas edildi)")
            
            # Yangın noktasının yeni rotada olup olmadığını kontrol et
            # (En yakın node bazlı engelleme yaptığımız için node kontrolü daha kesin olur)
            new_route_nodes = ox.nearest_nodes(G_disaster, X=[c[1] for c in route_disaster], Y=[c[0] for c in route_disaster])
            if blocked_node not in new_route_nodes:
                print(f"KONTROL: Engellenen Node ({blocked_node}) yeni rotada bulunmuyor. Yol güvenli.")
        else:
            print("BİLGİ: Rota değişmedi. Yangın noktası zaten alternatif bir yoldaymış veya başka yol yok.")
    else:
        print("BİLGİ: Yangın nedeniyle ulaşım tamamen kesildi!")

if __name__ == "__main__":
    prove_rerouting()
