import networkx as nx
import osmnx as ox
import math

def calculate_edge_weight(length, traffic_density=0.0, free_flow_speed=50.0):
    """
    Mesafe ve trafik yoğunluğuna göre ağırlık (weight) hesaplar (Süre bazlı).
    Trafik yoğunluğu 0.0 (akıcı) ile 1.0 (durma noktası) arasındadır.
    """
    # Trafik yoğunluğu arttıkça hızı düşürür (minimum 1 km/h olacak şekilde)
    effective_speed = max(1.0, free_flow_speed * (1 - traffic_density))
    
    # Ağırlık = Mesafe (metre) / Hız (km/h -> m/min dönüşümü yapılabilir ama oran aynı kalır)
    # Burada direkt süreyi temsil eden bir katsayı döndürüyoruz.
    weight = length / effective_speed
    return weight


def block_nearest_node(G, lat, lng, block_reason="Afet"):
    """
    Belirtilen koordinata en yakın node'u (düğümü) bulur ve ona bağlı tüm yolları 
    'impassable' (weight=infinity) yaparak o noktayı ulaşılamaz kılar.
    """
    # osmnx.nearest_nodes fonksiyonu (X: longitude, Y: latitude) parametreleri alır
    nearest_node = ox.nearest_nodes(G, X=lng, Y=lat)
    print(f"[{block_reason}] Engellenen Koordinat: ({lat}, {lng}) -> En Yakın Node: {nearest_node}")
    
    closed_edges_count = 0
    # Gelen ve giden tüm kenarları (edgeleri) kapatıyoruz
    # u, v, key, data formatında döner
    for u, v, key, data in G.edges(nearest_node, keys=True, data=True):
        data['weight'] = math.inf
        closed_edges_count += 1
        
    # in_edges (gelen yönler) için de aynı işlemi yapalım
    # MultiDiGraph olduğu için yönlülük önemlidir.
    try:
        for u, v, key, data in G.in_edges(nearest_node, keys=True, data=True):
            data['weight'] = math.inf
            closed_edges_count += 1
    except:
        # Bazı graph tiplerinde in_edges farklı çalışabilir veya yoktur
        pass
        
    print(f"Toplam {closed_edges_count} bağlantı 'impassable' (weight=infinity) yapıldı.")
    return G, nearest_node

def build_graph_with_disaster(place_name="Nilüfer, Bursa, Turkey", disaster_lat=None, disaster_lng=None, default_weight=1.0):
    """
    Belirtilen bölge için bir yol ağı (graph) oluşturur.
    Afet koordinatlarına en yakın node'u bulur ve o node üzerinden geçen yolları (edge'leri) 'impassable' yapar.
    """
    print(f"{place_name} için yol ağı çekiliyor...")
    # Sadece araç yollarını çekiyoruz (drive network)
    G = ox.graph_from_place(place_name, network_type='drive')
    
    # Her edge'e mesafe ve trafik bazlı weight atama
    for u, v, key, data in G.edges(keys=True, data=True):
        length = data.get('length', 1.0)
        # Varsayılan trafik yoğunluğu
        traffic = data.get('traffic_density', 0.0) 
        # Varsayılan hız sınırı (yoksa 50 km/h alıyoruz)
        max_speed = data.get('maxspeed', 50)
        
        # maxspeed bazen liste veya string gelebilir, onu sayıya çevirelim
        if isinstance(max_speed, list):
            # En düşük hızı alalım (güvenlik için)
            try:
                max_speed = min([float(str(s).split()[0]) for s in max_speed])
            except:
                max_speed = 50.0
        elif isinstance(max_speed, str):
            try:
                max_speed = float(max_speed.split()[0])
            except:
                max_speed = 50.0
        
        data['weight'] = calculate_edge_weight(length, traffic, max_speed)
        
    print(f"Graf oluşturuldu. Node sayısı: {len(G.nodes)}, Edge sayısı: {len(G.edges)}")
    
    # Eğer afet noktası belirtilmişse, o noktayı engelle
    if disaster_lat is not None and disaster_lng is not None:
        G, _ = block_nearest_node(G, disaster_lat, disaster_lng, block_reason="Başlangıç Afet Noktası")
    
    return G

def calculate_shortest_route(G, start_lat, start_lng, target_lat, target_lng):
    """
    Dijkstra algoritmasını kullanarak belirtilen koordinatlar arasında en kısa rotayı hesaplar.
    Sonucu [(lat, lng), (lat, lng), ...] formatında döner.
    """
    start_node = ox.nearest_nodes(G, X=start_lng, Y=start_lat)
    target_node = ox.nearest_nodes(G, X=target_lng, Y=target_lat)
    
    print(f"Başlangıç node: {start_node}, Hedef node: {target_node}")
    
    try:
        # Dijkstra algoritması (weight='weight' parametresi ile çalışır)
        route_nodes = nx.shortest_path(G, source=start_node, target=target_node, weight='weight')
        
        # Bulunan node rotasını (lat, lng) koordinatları listesine çevirme
        route_coords = [(G.nodes[node]['y'], G.nodes[node]['x']) for node in route_nodes]
        print(f"Rota bulundu! Toplam {len(route_coords)} adım.")
        return route_coords
    except nx.NetworkXNoPath:
        print("Uyarı: Hedefe ulaşmak için uygun bir rota bulunamadı (yollar kapalı olabilir).")
        return None

# Test için örnek kullanım
if __name__ == "__main__":
    # Örnek: Bursa Nilüfer bölgesi için graf oluştur ve afet noktasını (misal) kapat
    # Nilüfer merkez tahmini koordinatları (Afet bölgesi)
    disaster_lat, disaster_lng = 40.2215, 28.9880 
    
    graph = build_graph_with_disaster(
        place_name="Nilüfer, Bursa, Turkey",
        disaster_lat=disaster_lat,
        disaster_lng=disaster_lng,
        default_weight=1.0  # Varsayılan ağırlık
    )
    
    # Rota hesaplamak için başlangıç ve bitiş koordinatları (örnek Koordinatlar)
    # Başlangıç
    start_lat, start_lng = 40.2000, 28.9500
    # Bitiş (Hedef)
    end_lat, end_lng = 40.2300, 29.0000
    
    route = calculate_shortest_route(graph, start_lat, start_lng, end_lat, end_lng)
    
    if route:
        print("Bulunan Rotanın İlk 5 Koordinatı (lat, lng):")
        for coord in route[:5]:
            print(coord)
