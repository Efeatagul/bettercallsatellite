import osmnx as ox
import os

def download_and_save_graph(places, filename="bursa_road_network.graphml"):
    """
    Belirtilen bölgeler için yol ağını indirir ve .graphml formatında kaydeder.
    """
    print(f"{places} için yol ağı indiriliyor...")
    
    # Birden fazla bölgeyi birleştirerek grafı oluşturuyoruz
    G = ox.graph_from_place(places, network_type='drive')
    
    print(f"Graf oluşturuldu. Node sayısı: {len(G.nodes)}, Edge sayısı: {len(G.edges)}")
    
    # .graphml olarak kaydetme
    ox.save_graphml(G, filepath=filename)
    print(f"Graf başarıyla '{filename}' olarak kaydedildi.")

if __name__ == "__main__":
    # Bursa'nın Nilüfer ve Osmangazi ilçelerini hedefliyoruz
    target_places = [
        "Nilüfer, Bursa, Turkey",
        "Osmangazi, Bursa, Turkey"
    ]
    
    # Mevcut dizine kaydetmek için dosya ismi
    output_file = "/home/grassified/bettercallsatellite/bursa_road_network.graphml"
    
    download_and_save_graph(target_places, output_file)