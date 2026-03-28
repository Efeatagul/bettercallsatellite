import networkx as nx
import osmnx as ox
import math

def build_graph_with_disaster(place_name="Nilüfer, Bursa, Turkey", disaster_lat=None, disaster_lng=None, default_weight=1.0):
    """
    Belirtilen bölge için bir yol ağı (graph) oluşturur. Her yola varsayılan bir 'weight' atar.
    Afet koordinatlarına en yakın node'u bulur ve o node üzerinden geçen yolları (edge'leri) 'impassable' yapar.
    """
    print(f"{place_name} için yol ağı çekiliyor...")
    # Sadece araç yollarını çekiyoruz (drive network)
    G = ox.graph_from_place(place_name, network_type='drive')
    
    # Her edge'e varsayılan weight atama
    for u, v, key, data in G.edges(keys=True, data=True):
        data['weight'] = default_weight
        
    print(f"Graf oluşturuldu. Node sayısı: {len(G.nodes)}, Edge sayısı: {len(G.edges)}")
    
    # Eğer afet noktası belirtilmişse, o noktaya en yakın node'un bağlandığı yolları (edgeleri) kapat
    if disaster_lat is not None and disaster_lng is not None:
        # osmnx.nearest_nodes fonksiyonu (X: longitude, Y: latitude) parametreleri alır
        nearest_node = ox.nearest_nodes(G, X=disaster_lng, Y=disaster_lat)
        print(f"Afet noktasına ({disaster_lat}, {disaster_lng}) en yakın node bulundu: {nearest_node}")
        
        # Bu node'a bağlı olan tüm edge'leri impassable yapalım (weight = infinity)
        closed_edges_count = 0
        # Gelen ve giden tüm kenarları kapatıyoruz
        for u, v, key, data in G.edges(nearest_node, keys=True, data=True):
            data['weight'] = math.inf
            closed_edges_count += 1
        for u, v, key, data in G.in_edges(nearest_node, keys=True, data=True):
            data['weight'] = math.inf
            closed_edges_count += 1
            
        print(f"Toplam {closed_edges_count} bağlantı 'impassable' (weight=infinity) yapıldı.")
    
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
