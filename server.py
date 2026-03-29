#!/usr/bin/env python3
"""
AfetAI — Backend v4  (MongoDB RAG + VLM Tool Calling)

YENİLİKLER v4:
  - MongoDB RAG: Hastane, AFAD istasyonu, itfaiye — Overpass API'den otomatik seed
  - /api/rag-context  → Koordinat bazlı tüm tesis verisini döndürür
  - /api/seed-location → Bölgeyi zorla yenile (her 24 saat otomatik)
  - /api/analyze      → RAG bağlamı VLM prompt'una eklenir, yanıtta rag{} alanı bulunur
  - Algoritmik fallback: MongoDB yoksa in-memory dict cache kullanılır
"""

import json, math, re, base64, os, tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)

@app.route("/")
def index():
    return send_from_directory(".", "simulasyon.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)

# ── MongoDB (isteğe bağlı) ────────────────────────────────────
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/")
DB_NAME   = "afetai_rag"
_mongo_db = None

def get_db():
    global _mongo_db
    if _mongo_db is not None:
        return _mongo_db
    try:
        from pymongo import MongoClient
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=2000)
        client.admin.command("ping")
        _mongo_db = client[DB_NAME]
        _mongo_db.rag_cache.create_index("cache_key", unique=True)
        print("[MongoDB] ✓ Bağlantı başarılı — afetai_rag")
        return _mongo_db
    except Exception as e:
        print(f"[MongoDB] Bağlanamadı: {e} — in-memory cache aktif")
        return None

# In-memory cache (MongoDB yoksa veya yedek olarak)
_mem_cache = {}   # cache_key → { hospitals, afad_stations, fire_stations, seeded_at }

# ── NASA FIRMS yangın verisi cache ───────────────────────────
_fire_cache = {}  # bbox_key → (datetime, fires_list)
FIRE_CACHE_MINS = 30   # 30 dakika cache

def _cache_key(lat, lon):
    return f"{round(lat, 2)},{round(lon, 2)}"

def _save_cache(key, entry):
    _mem_cache[key] = entry
    db = get_db()
    if db is not None:
        try:
            db.rag_cache.replace_one({"cache_key": key}, {"cache_key": key, **entry}, upsert=True)
        except Exception as e:
            print(f"[MongoDB] Yazma hatası: {e}")

def _load_cache(key):
    if key in _mem_cache:
        return _mem_cache[key]
    db = get_db()
    if db is not None:
        try:
            entry = db.rag_cache.find_one({"cache_key": key}, {"_id": 0})
            if entry:
                _mem_cache[key] = entry
                return entry
        except Exception as e:
            print(f"[MongoDB] Okuma hatası: {e}")
    return None

# ── Overpass API — bölge verisi çek ──────────────────────────
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

def _bbox(lat, lon, radius_km):
    d = radius_km / 111.0
    # Correct longitude scaling at given latitude
    d_lon = d / max(0.01, math.cos(math.radians(lat)))
    return round(lat - d, 5), round(lon - d_lon, 5), round(lat + d, 5), round(lon + d_lon, 5)

def _overpass(ql_body):
    """Overpass QL çalıştır, [{ name, lat, lon }] döndür."""
    try:
        import requests
        resp = requests.post(OVERPASS_URL, data={"data": ql_body}, timeout=14)
        resp.raise_for_status()
        results = []
        for el in resp.json().get("elements", []):
            lat = el.get("lat") or el.get("center", {}).get("lat")
            lon = el.get("lon") or el.get("center", {}).get("lon")
            if not lat or not lon:
                continue
            tags = el.get("tags", {})
            name = tags.get("name:tr") or tags.get("name") or tags.get("name:en") or "Bilinmeyen"
            results.append({
                "name": name,
                "lat":  round(float(lat), 6),
                "lon":  round(float(lon), 6),
                "osm_id": str(el.get("id", "")),
            })
        return results
    except Exception as e:
        print(f"[Overpass] Hata: {e}")
        return []

def seed_location(lat, lon):
    """Verilen koordinat çevresini Overpass'tan çekip cache'le (paralel)."""
    s, w, n, e = _bbox(lat, lon, 12)
    bbox = f"{s},{w},{n},{e}"
    print(f"[RAG] Seed başlıyor: {lat:.3f}, {lon:.3f} — bbox {bbox}")

    queries = {
        "hospitals": f"""[out:json][timeout:12];
(node["amenity"="hospital"]({bbox}); way["amenity"="hospital"]({bbox});
 node["amenity"="clinic"]({bbox}););
out body center 15;""",
        "afad_stations": f"""[out:json][timeout:12];
(node["name"~"AFAD",i]({bbox}); way["name"~"AFAD",i]({bbox});
 node["operator"~"AFAD",i]({bbox}); node["office"]["name"~"AFAD",i]({bbox}););
out body center 10;""",
        "fire_stations": f"""[out:json][timeout:12];
(node["amenity"="fire_station"]({bbox}); way["amenity"="fire_station"]({bbox}););
out body center 10;""",
        "police": f"""[out:json][timeout:12];
(node["amenity"="police"]({bbox}); way["amenity"="police"]({bbox}););
out body center 8;""",
    }

    results = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(_overpass, ql): key for key, ql in queries.items()}
        for fut in as_completed(futures):
            results[futures[fut]] = fut.result()

    entry = {
        "lat": lat, "lon": lon,
        **results,
        "seeded_at": datetime.utcnow().isoformat(),
    }
    _save_cache(_cache_key(lat, lon), entry)
    print(f"[RAG] Tamamlandı: {len(results.get('hospitals',[]))} hastane, "
          f"{len(results.get('afad_stations',[]))} AFAD, "
          f"{len(results.get('fire_stations',[]))} itfaiye, "
          f"{len(results.get('police',[]))} polis")
    return entry

def get_rag(lat, lon):
    """Cache'den döndür; yoksa ya da 24 saatten eskiyse yenile."""
    key   = _cache_key(lat, lon)
    entry = _load_cache(key)
    if entry:
        try:
            age = datetime.utcnow() - datetime.fromisoformat(entry["seeded_at"])
            if age < timedelta(hours=24):
                return entry
        except Exception:
            pass
    return seed_location(lat, lon)

# ── OSRM — gerçek yol ağı rotası ─────────────────────────────
OSRM_ENDPOINTS = [
    "https://router.project-osrm.org/route/v1/foot",
    "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
]

def _thin_coords(coords, max_points=300):
    """Thin dense coordinate lists, always preserving start and end."""
    if len(coords) <= max_points:
        return coords
    step = math.ceil(len(coords) / max_points)
    result = [c for i, c in enumerate(coords) if i % step == 0]
    if result[-1] != coords[-1]:
        result.append(coords[-1])
    return result

def _fetch_osrm_single(base, coords_str, params):
    """Single OSRM endpoint call (used by ThreadPoolExecutor)."""
    import requests as req_lib
    url = f"{base}/{coords_str}"
    resp = req_lib.get(url, params=params, timeout=8)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != "Ok" or not data.get("routes"):
        raise ValueError(data.get("message", "OSRM rota yok"))
    return data["routes"][0]

def _fetch_osrm_route(from_lat, from_lon, to_lat, to_lon, max_points=300):
    """Fetch walking route from OSRM — endpoints tried in parallel.

    Returns (waypoints, distance_m, duration_s).
    Raises RuntimeError if all OSRM endpoints fail.
    """
    coords_str = f"{from_lon},{from_lat};{to_lon},{to_lat}"
    params = {"overview": "full", "geometries": "geojson", "steps": "false"}

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(_fetch_osrm_single, base, coords_str, params): base
                   for base in OSRM_ENDPOINTS}
        for fut in as_completed(futures):
            try:
                route = fut.result()
                coords = route["geometry"]["coordinates"]
                dist_m = route.get("distance", 0)
                dur_s  = route.get("duration", 0)
                thinned = _thin_coords(coords, max_points)
                waypoints = [{"lat": round(c[1], 6), "lon": round(c[0], 6)} for c in thinned]
                print(f"[OSRM] ✓ {len(waypoints)} nokta | {dist_m/1000:.2f} km | ~{dur_s//60} dk")
                return waypoints, dist_m, dur_s
            except Exception as e:
                print(f"[OSRM] {futures[fut]} başarısız: {e}")

    raise RuntimeError("OSRM ulaşılamadı")

def _decode_polyline6(encoded):
    """Decode Valhalla precision=6 polyline → list of [lat, lon]."""
    index = 0
    lat = lng = 0
    coords = []
    while index < len(encoded):
        val = shift = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            val |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        lat += ~(val >> 1) if (val & 1) else (val >> 1)
        val = shift = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            val |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        lng += ~(val >> 1) if (val & 1) else (val >> 1)
        coords.append([lat / 1e6, lng / 1e6])
    return coords

def _fetch_valhalla_route(from_lat, from_lon, to_lat, to_lon, max_points=300):
    """Valhalla pedestrian routing — OSM community public instance."""
    import requests as req_lib
    body = {
        "locations": [
            {"lon": from_lon, "lat": from_lat},
            {"lon": to_lon,   "lat": to_lat},
        ],
        "costing": "pedestrian",
        "directions_options": {"units": "km"},
    }
    resp = req_lib.post("https://valhalla1.openstreetmap.de/route",
                        json=body, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("trip", {}).get("legs"):
        raise ValueError("Valhalla rota yok")
    leg      = data["trip"]["legs"][0]
    latlon   = _decode_polyline6(leg["shape"])
    thinned  = _thin_coords([[c[1], c[0]] for c in latlon], max_points)  # [lon, lat]
    waypoints = [{"lat": round(c[1], 6), "lon": round(c[0], 6)} for c in thinned]
    dist_m   = data["trip"]["summary"]["length"] * 1000
    dur_s    = data["trip"]["summary"]["time"]
    print(f"[Valhalla] ✓ {len(waypoints)} nokta | {dist_m/1000:.2f} km | ~{int(dur_s//60)} dk")
    return waypoints, dist_m, dur_s

def _get_route(from_lat, from_lon, to_lat, to_lon, max_points=300):
    """Try OSRM (parallel) then Valhalla, raise RuntimeError if both fail."""
    try:
        return _fetch_osrm_route(from_lat, from_lon, to_lat, to_lon, max_points)
    except Exception as e:
        print(f"[OSRM] Başarısız: {e} — Valhalla deneniyor")
    try:
        return _fetch_valhalla_route(from_lat, from_lon, to_lat, to_lon, max_points)
    except Exception as e:
        raise RuntimeError(f"OSRM ve Valhalla başarısız: {e}")

# ── RAG → VLM Prompt ─────────────────────────────────────────
def build_rag_prompt(rag, assembly_points, epicenter, user_loc):
    mag  = epicenter["magnitude"]
    elat = epicenter["lat"]
    elon = epicenter["lon"]
    ulat = user_loc["lat"]
    ulon = user_loc["lon"]

    def d_epi(a):  return _haversine(a["lat"], a["lon"], elat, elon)
    def d_user(a): return _haversine(a["lat"], a["lon"], ulat, ulon)

    hospitals = sorted(rag.get("hospitals",     []), key=d_epi)[:6]
    afad      = sorted(rag.get("afad_stations", []), key=d_epi)[:4]
    fire      = sorted(rag.get("fire_stations", []), key=d_epi)[:3]
    police    = sorted(rag.get("police",        []), key=d_epi)[:3]

    def fmt(lst, emoji=""):
        if not lst:
            return "  (bölgede kayıt bulunamadı)"
        return "\n".join(
            f"  {emoji}{i+1}. {f['name']} — "
            f"epimerkeze {d_epi(f):.1f} km, kullanıcıya {d_user(f):.1f} km "
            f"(lat={f['lat']:.5f} lon={f['lon']:.5f})"
            for i, f in enumerate(lst)
        )

    dmg_r = mag * 7
    aps = "\n".join(
        f"  AP-{ap['id']:02d}: {ap['name']} | "
        f"hasar %{ap.get('damage_level',0)*100:.0f} | "
        f"{ap.get('capacity',0):,} kişi | "
        f"epimerkeze {d_epi(ap):.1f} km | "
        f"kullanıcıya {d_user(ap):.1f} km"
        for ap in assembly_points
    )

    return f"""
=== AFET BÖLGESİ BİLGİ HAVUZU (RAG) ===
Deprem: M{mag:.1f} | lat={elat:.5f} lon={elon:.5f}
Kullanıcı: lat={ulat:.5f} lon={ulon:.5f}
Tahmini hasar yarıçapı: {dmg_r:.1f} km (ağır hasar: {dmg_r*0.45:.1f} km)

HASTANELER:
{fmt(hospitals, '🏥 ')}

AFAD İSTASYONLARI:
{fmt(afad, '🚨 ')}

İTFAİYE:
{fmt(fire, '🚒 ')}

POLİS:
{fmt(police, '🚔 ')}

TOPLANMA ALANLARI:
{aps}
=======================================
"""

# ── Tool tanımı ───────────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "route_to_assembly_point",
            "description": (
                "Deprem haritasını ve bölge bilgi havuzunu analiz et. "
                "En güvenli toplanma alanını seç, kullanıcıya WGS84 coğrafi koordinat "
                "sisteminde güvenli tahliye rotası üret. "
                "TÜM koordinatlar ondalık derece WGS84 formatında olmalı "
                "(örn: lat=36.20134, lon=36.15872). Piksel veya metre koordinatı KULLANMA."
            ),
            "parameters": {
                "type": "object",
                "required": ["assembly_point_id", "reason_tr", "risk_notes_tr", "waypoints"],
                "properties": {
                    "assembly_point_id": {
                        "type": "integer",
                        "description": "Seçilen toplanma alanının ID numarası"
                    },
                    "reason_tr": {
                        "type": "string",
                        "description": (
                            "Türkçe seçim gerekçesi: hasar oranı, mesafe, "
                            "kapasite, hastane/AFAD yakınlığı"
                        )
                    },
                    "risk_notes_tr": {
                        "type": "string",
                        "description": "Rota boyunca dikkat edilmesi gereken Türkçe uyarılar"
                    },
                    "afad_guidance_tr": {
                        "type": "string",
                        "description": (
                            "AFAD ekiplerinin hangi rotayı "
                            "kullanması gerektiğine dair Türkçe yönlendirme"
                        )
                    },
                    "hospital_note_tr": {
                        "type": "string",
                        "description": "Yaralıların yönlendirileceği en yakın hastane"
                    },
                    "waypoints": {
                        "type": "array",
                        "description": (
                            "Kullanıcıdan toplanma alanına güvenli tahliye rotası. "
                            "WGS84 ondalık derece koordinatları (EPSG:4326). "
                            "İlk nokta kullanıcı konumu, son nokta toplanma alanı. "
                            "Hasar bölgelerinden ve yıkık binalardan uzak geçiş noktaları seç. "
                            "lat: enlem -90..+90, lon: boylam -180..+180."
                        ),
                        "minItems": 4,
                        "maxItems": 12,
                        "items": {
                            "type": "object",
                            "required": ["lat", "lon"],
                            "properties": {
                                "lat": {
                                    "type": "number",
                                    "description": "Enlem — WGS84 ondalık derece, -90 ile +90 arası"
                                },
                                "lon": {
                                    "type": "number",
                                    "description": "Boylam — WGS84 ondalık derece, -180 ile +180 arası"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
]

# ── MLX durumu ────────────────────────────────────────────────
MLX_AVAILABLE = False
MLX_IMPORT_OK = False
vlm_model     = None
vlm_processor = None
current_model = None

SUGGESTED_MODELS = [
    {"id": "mlx-community/Qwen2.5-VL-7B-Instruct-4bit",  "name": "Qwen2.5-VL 7B",  "size": "~4.5 GB", "speed": "Orta",  "notes": "Önerilen — iyi denge"},
    {"id": "mlx-community/Qwen2.5-VL-3B-Instruct-4bit",  "name": "Qwen2.5-VL 3B",  "size": "~2.1 GB", "speed": "Hızlı", "notes": "Düşük RAM için ideal"},
    {"id": "mlx-community/Qwen2.5-VL-72B-Instruct-4bit", "name": "Qwen2.5-VL 72B", "size": "~40 GB",  "speed": "Yavaş", "notes": "En yüksek doğruluk"},
    {"id": "mlx-community/Phi-3.5-vision-instruct-4bit",  "name": "Phi-3.5 Vision", "size": "~2.4 GB", "speed": "Hızlı", "notes": "Microsoft — kompakt VLM"},
    {"id": "mlx-community/llava-1.5-7b-4bit",             "name": "LLaVA 1.5 7B",   "size": "~4.0 GB", "speed": "Orta",  "notes": "Klasik VLM referansı"},
    {"id": "mlx-community/InternVL2-8B-4bit",             "name": "InternVL2 8B",    "size": "~4.8 GB", "speed": "Orta",  "notes": "Güçlü görüntü anlama"},
]

def scan_local_models():
    """~/.cache/huggingface/hub/ içindeki indirilen mlx modellerini tarar."""
    hf_cache = os.path.expanduser("~/.cache/huggingface/hub")
    local = []
    if not os.path.isdir(hf_cache):
        return local
    for entry in sorted(os.listdir(hf_cache)):
        if not entry.startswith("models--"):
            continue
        # models--mlx-community--Qwen2.5-VL-7B-Instruct-4bit
        # → mlx-community/Qwen2.5-VL-7B-Instruct-4bit
        parts = entry[len("models--"):].split("--", 1)
        if len(parts) != 2:
            continue
        model_id = f"{parts[0]}/{parts[1]}"
        # snapshots klasörü varsa gerçekten indirilmiş sayılır
        snap_dir = os.path.join(hf_cache, entry, "snapshots")
        if not os.path.isdir(snap_dir):
            continue
        # boyut hesapla — HuggingFace blobs/ klasöründen
        blobs_dir = os.path.join(hf_cache, entry, "blobs")
        total = 0
        try:
            for fname in os.listdir(blobs_dir):
                fp = os.path.join(blobs_dir, fname)
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
        except OSError:
            pass
        size_str = f"{total / 1e9:.1f} GB" if total > 1e9 else f"{total / 1e6:.0f} MB"
        local.append({
            "id":     model_id,
            "name":   parts[1],
            "size":   size_str,
            "speed":  "—",
            "notes":  "Yerel — indirme gerekmez",
            "local":  True,
        })
    return local

try:
    import mlx.core as _mx
    from mlx_vlm import load as _mlx_load, generate as _mlx_generate
    MLX_IMPORT_OK = True
    print("[AfetAI] ✓ mlx-vlm kurulu — /api/load-model ile model seçin")
except Exception as _exc:
    print(f"[AfetAI] mlx-vlm yok: {_exc} → algoritmik fallback aktif")

def _do_load_model(model_path):
    global vlm_model, vlm_processor, current_model, MLX_AVAILABLE
    if not MLX_IMPORT_OK:
        raise RuntimeError("mlx-vlm kurulu değil")
    from mlx_vlm import load
    print(f"[AfetAI] Yükleniyor: {model_path}")
    vlm_model, vlm_processor = load(model_path)
    current_model = model_path
    MLX_AVAILABLE = True
    print(f"[AfetAI] ✓ Hazır: {model_path}")

# ── Endpoint'ler ──────────────────────────────────────────────

@app.route("/api/status", methods=["GET"])
def status():
    db = get_db()
    rag_count = len(_mem_cache)
    if db is not None:
        try: rag_count = db.rag_cache.count_documents({})
        except Exception: pass
    return jsonify({
        "mlx_available": MLX_AVAILABLE,
        "mlx_installed": MLX_IMPORT_OK,
        "model":         current_model,
        "mongo":         db is not None,
        "rag_entries":   rag_count,
        "mode": (
            f"MLX — {current_model}" if MLX_AVAILABLE else
            ("mlx-vlm kurulu, model seçilmedi" if MLX_IMPORT_OK else "Algoritmik fallback")
        ),
        "tools": [t["function"]["name"] for t in TOOLS],
    })

@app.route("/api/models", methods=["GET"])
def list_models():
    local = scan_local_models()
    local_ids = {m["id"] for m in local}
    # Yerel olmayanları "önerilen" olarak ekle
    remote = [m for m in SUGGESTED_MODELS if m["id"] not in local_ids]
    return jsonify({
        "local":       local,
        "suggested":   remote,
        "current":     current_model,
        "mlx_installed": MLX_IMPORT_OK,
    })

@app.route("/api/load-model", methods=["POST"])
def load_model_endpoint():
    global vlm_model, vlm_processor, current_model, MLX_AVAILABLE
    data = request.get_json(force=True)
    model_path = (data.get("model") or "").strip()
    if not model_path: return jsonify({"error": "model boş"}), 400
    if not MLX_IMPORT_OK: return jsonify({"error": "mlx-vlm kurulu değil"}), 503
    if model_path == current_model and MLX_AVAILABLE:
        return jsonify({"status": "already_loaded", "model": current_model})
    try:
        vlm_model = vlm_processor = current_model = None; MLX_AVAILABLE = False
        _do_load_model(model_path)
        return jsonify({"status": "loaded", "model": current_model})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

@app.route("/api/unload-model", methods=["POST"])
def unload_model():
    global vlm_model, vlm_processor, current_model, MLX_AVAILABLE
    vlm_model = vlm_processor = current_model = None; MLX_AVAILABLE = False
    return jsonify({"status": "unloaded"})

# ─────────────────────────────────────────────────────────────
# NASA FIRMS — Gerçek zamanlı yangın noktaları
# ─────────────────────────────────────────────────────────────
@app.route("/api/fires", methods=["POST", "GET"])
def get_fires():
    """NASA FIRMS VIIRS NOAA-20 24h CSV'den bölgesel yangın noktaları döndürür.
    Kaynak: https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/
    API key gerekmez — public data feed."""
    import io, csv as csv_mod

    data      = request.get_json(force=True) if request.method == "POST" else {}
    lat       = float(data.get("lat", 36.2))
    lon       = float(data.get("lon", 36.16))
    radius    = float(data.get("radius", 3.0))  # derece cinsinden bounding box yarıçapı

    s, w, n, e = lat - radius, lon - radius, lat + radius, lon + radius
    cache_key  = f"{round(s,2)},{round(w,2)},{round(n,2)},{round(e,2)}"

    # Cache kontrolü
    if cache_key in _fire_cache:
        cached_at, fires = _fire_cache[cache_key]
        age_min = (datetime.utcnow() - cached_at).total_seconds() / 60
        if age_min < FIRE_CACHE_MINS:
            return jsonify({
                "fires": fires, "count": len(fires),
                "source": "NASA FIRMS VIIRS NOAA-20 (cache)",
                "cached_min_ago": round(age_min, 1)
            })

    # NASA FIRMS public CSV endpoint'leri (VIIRS önce, MODIS fallback)
    sources = [
        ("VIIRS NOAA-20",  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv"),
        ("VIIRS Suomi-NPP", "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv"),
        ("MODIS Terra",    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv"),
    ]

    fires = []
    used_source = "error"

    try:
        import requests as req_lib
    except ImportError:
        return jsonify({"fires": [], "error": "requests modülü yok", "source": "error"})

    for source_name, url in sources:
        try:
            resp = req_lib.get(url, timeout=20, headers={"User-Agent": "AfetAI/1.0"})
            resp.raise_for_status()
            reader = csv_mod.DictReader(io.StringIO(resp.text))
            fires  = []
            for row in reader:
                try:
                    flat = float(row["latitude"])
                    flon = float(row["longitude"])
                    if not (s <= flat <= n and w <= flon <= e):
                        continue
                    # Güven seviyesini normalize et (nominal: l/n/h → 0-100)
                    raw_conf = row.get("confidence", "n")
                    if   raw_conf in ("h", "high"):   conf_pct = 80
                    elif raw_conf in ("l", "low"):    conf_pct = 30
                    elif raw_conf in ("n", "nominal"):conf_pct = 55
                    else:
                        try:    conf_pct = int(raw_conf)
                        except: conf_pct = 50
                    brightness = float(row.get("bright_ti4") or row.get("brightness") or 0)
                    fires.append({
                        "lat":        flat,
                        "lon":        flon,
                        "brightness": round(brightness, 1),
                        "confidence": conf_pct,
                        "frp":        round(float(row.get("frp") or 0), 2),
                        "date":       row.get("acq_date", ""),
                        "time":       row.get("acq_time", ""),
                        "satellite":  row.get("satellite", source_name),
                        "daynight":   row.get("daynight", ""),
                    })
                except (ValueError, KeyError):
                    continue
            used_source = f"NASA FIRMS {source_name}"
            break  # başarılı — diğer kaynakları deneme
        except Exception as exc:
            print(f"[FIRMS] {source_name} başarısız: {exc}")
            continue

    _fire_cache[cache_key] = (datetime.utcnow(), fires)
    return jsonify({
        "fires":  fires,
        "count":  len(fires),
        "source": used_source,
        "bbox":   {"south": s, "west": w, "north": n, "east": e},
    })

@app.route("/api/geocode", methods=["POST"])
def geocode():
    try:
        from geopy.geocoders import Nominatim
        data = request.get_json(force=True)
        geo  = Nominatim(user_agent="AfetAI-v4/1.0")
        loc  = geo.geocode(data.get("query", ""), language="tr", timeout=10)
        if not loc: return jsonify({"error": "Bulunamadı"}), 404
        return jsonify({"lat": loc.latitude, "lon": loc.longitude, "display_name": loc.address})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/rag-context", methods=["GET", "POST"])
def rag_context_ep():
    """
    Koordinat için RAG verisi döndür (hastane, AFAD, itfaiye).
    Cache yoksa Overpass'tan otomatik çeker (~5-15 sn).
    GET  /api/rag-context?lat=36.2&lon=36.1
    POST /api/rag-context { "lat": 36.2, "lon": 36.1 }
    """
    if request.method == "POST":
        d = request.get_json(force=True)
        lat, lon = float(d["lat"]), float(d["lon"])
    else:
        lat = float(request.args.get("lat", 36.2))
        lon = float(request.args.get("lon", 36.1))
    rag = get_rag(lat, lon)
    return jsonify({
        "hospitals":     rag.get("hospitals",     [])[:10],
        "afad_stations": rag.get("afad_stations", [])[:6],
        "fire_stations": rag.get("fire_stations", [])[:5],
        "police":        rag.get("police",        [])[:4],
        "seeded_at":     rag.get("seeded_at", ""),
    })

@app.route("/api/seed-location", methods=["POST"])
def seed_location_ep():
    """Bir konumu Overpass'tan zorla yenile."""
    d   = request.get_json(force=True)
    lat = float(d.get("lat", 36.2))
    lon = float(d.get("lon", 36.1))
    res = seed_location(lat, lon)
    return jsonify({
        "status":        "seeded",
        "hospitals":     len(res.get("hospitals",     [])),
        "afad_stations": len(res.get("afad_stations", [])),
        "fire_stations": len(res.get("fire_stations", [])),
        "seeded_at":     res["seeded_at"],
    })

@app.route("/api/route", methods=["POST"])
def route_ep():
    """Compute walking route between two points using OSRM (real road network).

    POST /api/route {
      "from": {"lat": 36.20, "lon": 36.16},
      "to":   {"lat": 36.21, "lon": 36.17},
      "epicenter": {"lat": 36.19, "lon": 36.17, "magnitude": 7.4}  // optional
    }

    Returns enriched waypoints with danger zones, bearing, elevation,
    plus a GeoJSON FeatureCollection ready for map rendering.
    """
    try:
        d = request.get_json(force=True)
        frm = d.get("from") or d.get("user_location")
        to  = d.get("to")   or d.get("destination")
        epi = d.get("epicenter")

        if not frm or not to:
            return jsonify({"error": "'from' ve 'to' alanları gerekli"}), 400

        osrm_used = False
        dist_m = 0
        dur_s  = 0
        try:
            raw_wpts, dist_m, dur_s = _get_route(
                float(frm["lat"]), float(frm["lon"]),
                float(to["lat"]),  float(to["lon"]))
            osrm_used = True
        except Exception:
            raw_wpts = _build_raw_waypoints(
                {"lat": float(frm["lat"]), "lon": float(frm["lon"])},
                {"lat": float(to["lat"]),  "lon": float(to["lon"])},
                epi or {"lat": 0, "lon": 0, "magnitude": 0}, n=8)
            dist_m = int(_haversine_m(float(frm["lat"]), float(frm["lon"]),
                                       float(to["lat"]),  float(to["lon"])))

        enriched = _enrich_waypoints(raw_wpts, frm, to, epi)

        return jsonify({
            "waypoints":       enriched,
            "osrm_used":       osrm_used,
            "route_distance_m": dist_m,
            "route_duration_s": dur_s,
            "walking_min":     dur_s // 60 if dur_s else None,
            "geojson":         _route_geojson(enriched, epicenter=epi),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/analyze", methods=["POST"])
def analyze_earthquake():
    """
    Ana analiz endpoint'i.
    RAG verisi VLM prompt'una eklenir.
    Yanıt rag{hospitals, afad_stations, fire_stations} alanı içerir.
    """
    try:
        data = request.get_json(force=True)
        if not data:
            return jsonify({"error": "JSON body gerekli"}), 400

        # validate required fields
        for key in ("epicenter", "user_location", "assembly_points"):
            if key not in data:
                return jsonify({"error": f"'{key}' alanı eksik"}), 400

        epicenter       = data["epicenter"]
        user_loc        = data["user_location"]
        assembly_points = data["assembly_points"]
        image_b64       = data.get("image")

        # validate coordinate ranges
        for label, obj in [("epicenter", epicenter), ("user_location", user_loc)]:
            lat, lon = float(obj.get("lat", 0)), float(obj.get("lon", 0))
            if not _validate_wgs84(lat, lon):
                return jsonify({"error": f"'{label}' geçersiz koordinat: lat={lat}, lon={lon}"}), 400

        if not assembly_points:
            return jsonify({"error": "En az bir toplanma alanı gerekli"}), 400

        # Start RAG fetch in background thread while we prepare
        rag_future = ThreadPoolExecutor(max_workers=1).submit(
            get_rag, epicenter["lat"], epicenter["lon"])
        rag_data   = rag_future.result(timeout=20)
        rag_prompt = build_rag_prompt(rag_data, assembly_points, epicenter, user_loc)

        if MLX_AVAILABLE and image_b64:
            result = _analyze_with_vlm(image_b64, epicenter, user_loc, assembly_points, rag_prompt, rag_data)
        else:
            result = _analyze_algorithmic(epicenter, user_loc, assembly_points, rag_data)

        result["rag"] = {
            "hospitals":     rag_data.get("hospitals",     [])[:8],
            "afad_stations": rag_data.get("afad_stations", [])[:5],
            "fire_stations": rag_data.get("fire_stations", [])[:4],
            "police":        rag_data.get("police",        [])[:4],
        }
        waypoints = result.get("waypoints", [])
        result["geojson"] = _route_geojson(waypoints, rag_data, epicenter)
        result["route_distance_m"] = waypoints[-1].get("cumulative_m", 0) if waypoints else 0
        return jsonify(result)

    except KeyError as ke:
        return jsonify({"error": f"Eksik alan: {ke}"}), 400
    except (ValueError, TypeError) as ve:
        return jsonify({"error": f"Geçersiz veri: {ve}"}), 400
    except Exception as exc:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(exc)}), 500

# ── VLM Analiz ────────────────────────────────────────────────

def _analyze_with_vlm(image_b64, epicenter, user_loc, assembly_points, rag_prompt, rag_data=None):
    raw       = image_b64.split(",")[1] if "," in image_b64 else image_b64
    img_bytes = base64.b64decode(raw)
    tmp       = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.write(img_bytes); tmp.close()
    try:
        ap_list = "\n".join(
            f"  AP-{ap['id']:02d}: {ap['name']} "
            f"lat={ap['lat']:.6f} lon={ap['lon']:.6f} "
            f"hasar=%{ap.get('damage_level', ap.get('damage', 0))*100:.0f} "
            f"kapasite={ap['capacity']:,}"
            for ap in assembly_points
        )
        user_msg = (
            f"{rag_prompt}\n\n"
            "KOORDİNAT SİSTEMİ: WGS84 ondalık derece (EPSG:4326). "
            "Tüm waypoint lat/lon değerleri bu sistemde olmalı. "
            "lat: -90..+90, lon: -180..+180. Piksel veya metre koordinatı KULLANMA.\n\n"
            "HARİTADAKİ GÖRSELLER:\n"
            "  • Kırmızı/turuncu bölgeler → deprem hasar alanları\n"
            "  • Yeşil daireler → güvenli toplanma alanları\n"
            "  • Sarı/kırmızı daireler → hasarlı toplanma alanları\n"
            "  • Mavi nokta 📍 → kullanıcının konumu\n"
            "  • Kırmızı ☄ → deprem epimerkezi\n\n"
            f"DEPREM: M{epicenter['magnitude']:.1f} "
            f"lat={epicenter['lat']:.6f} lon={epicenter['lon']:.6f}\n\n"
            f"KULLANICI: lat={user_loc['lat']:.6f} lon={user_loc['lon']:.6f}\n\n"
            f"TOPLANMA ALANLARI:\n{ap_list}\n\n"
            "GÖREV: `route_to_assembly_point` fonksiyonunu WGS84 koordinatlarla çağır. "
            "Waypoint lat/lon değerleri yukarıdaki koordinatlara yakın olmalı."
        )
        messages = [{"role": "user", "content": [
            {"type": "image", "image": f"file://{tmp.name}"},
            {"type": "text",  "text": user_msg},
        ]}]
        formatted = _format_with_tools(messages)
        from mlx_vlm import generate
        output = generate(vlm_model, vlm_processor, tmp.name, formatted,
                          max_tokens=800, temperature=0.1)
        print(f"[VLM] Çıktı:\n{output[:500]}")
        return _build_result_from_tool(_parse_tool_call(output),
                                       assembly_points, user_loc, epicenter, output)
    except Exception as exc:
        print(f"[VLM] Hata: {exc} — algoritmik fallback")
        # Bug #1 fix: Pass rag_data to fallback instead of empty dict
        return _analyze_algorithmic(epicenter, user_loc, assembly_points, rag_data or {})
    finally:
        os.unlink(tmp.name)

def _format_with_tools(messages):
    if vlm_processor is not None:
        try:
            fmt = vlm_processor.apply_chat_template(
                messages, tools=TOOLS, tokenize=False, add_generation_prompt=True)
            return fmt
        except (TypeError, AttributeError):
            pass
    # Bug #3 fix: Model-specific fallback templates
    tool_desc = json.dumps(TOOLS[0]["function"], ensure_ascii=False, indent=2)
    text_part = next((c["text"] for c in messages[0]["content"] if c["type"] == "text"), "")
    model_lower = (current_model or "").lower()
    # Detect vision token style based on model family
    if "phi" in model_lower or "llava" in model_lower or "intern" in model_lower:
        vision_token = "<image>"
    else:
        vision_token = "<|vision_start|><|image_pad|><|vision_end|>"
    lines = [
        "<|im_start|>system",
        "Afet mudahale AI. Asagidaki tool fonksiyonunu cagir:",
        "```json",
        tool_desc,
        "```",
        '<tool_call>{"name": "route_to_assembly_point", "arguments": {...}}</tool_call>',
        "<|im_end|>",
        "<|im_start|>user",
        vision_token,
        text_part,
        "<|im_end|>",
        "<|im_start|>assistant",
    ]
    return "\n".join(lines) + "\n"

def _extract_json_objects(text):
    """Extract JSON objects by tracking balanced braces (handles nested structures)."""
    results = []
    i = 0
    while i < len(text):
        if text[i] == '{':
            depth = 1
            start = i
            i += 1
            while i < len(text) and depth > 0:
                if text[i] == '{': depth += 1
                elif text[i] == '}': depth -= 1
                i += 1
            candidate = text[start:i]
            if len(candidate) > 10:
                try:
                    parsed = json.loads(candidate)
                    results.append(parsed)
                except json.JSONDecodeError:
                    pass
        else:
            i += 1
    return results

def _parse_tool_call(output):
    """Bug #2 fix: More robust JSON extraction with balanced-brace parsing."""
    # Strategy 1: tool_call tags
    m = re.search(r"<tool_call>\s*(\{.+\})\s*</tool_call>", output, re.DOTALL)
    if m:
        try:
            d = json.loads(m.group(1)); return d.get("arguments", d)
        except json.JSONDecodeError:
            pass
    # Strategy 2: JSON code blocks
    m = re.search(r"```(?:json)?\s*(\{.+\})\s*```", output, re.DOTALL)
    if m:
        try:
            d = json.loads(m.group(1)); return d.get("arguments", d)
        except json.JSONDecodeError:
            pass
    # Strategy 3: "arguments" key with balanced braces
    m = re.search(r'"arguments"\s*:\s*(\{.+\})', output, re.DOTALL)
    if m:
        for obj in _extract_json_objects(m.group(1)):
            if "waypoints" in obj or "assembly_point_id" in obj:
                return obj
    # Strategy 4: Find all balanced JSON objects, prefer ones with relevant keys
    candidates = _extract_json_objects(output)
    with_args = [c for c in candidates if "arguments" in c]
    if with_args:
        return with_args[0].get("arguments", with_args[0])
    with_wp = [c for c in candidates if "waypoints" in c or "assembly_point_id" in c]
    if with_wp:
        return max(with_wp, key=lambda x: len(json.dumps(x)))
    raise ValueError("Tool call parse edilemedi")

def _build_result_from_tool(tool_args, assembly_points, user_loc, epicenter, raw):
    sel_id = int(tool_args.get("assembly_point_id", 1))
    sel_ap = next((ap for ap in assembly_points if ap["id"] == sel_id), assembly_points[0])

    # Try OSRM for real road routing; fall back to VLM's raw waypoints
    osrm_used = False
    osrm_dist_m = 0
    osrm_dur_s  = 0
    try:
        osrm_wpts, osrm_dist_m, osrm_dur_s = _get_route(
            user_loc["lat"], user_loc["lon"], sel_ap["lat"], sel_ap["lon"])
        waypoints = _enrich_waypoints(osrm_wpts, user_loc, sel_ap, epicenter)
        osrm_used = True
    except Exception:
        waypoints = _enrich_waypoints(
            tool_args.get("waypoints", []), user_loc, sel_ap, epicenter)

    return {
        "model":            f"{current_model} (MLX — tool calling)",
        "tool_called":      "route_to_assembly_point",
        "selected_assembly": sel_ap,
        "reason":           tool_args.get("reason_tr", ""),
        "risk_assessment":  f"M{epicenter['magnitude']:.1f} depremi analiz edildi.",
        "route_notes":      tool_args.get("risk_notes_tr", ""),
        "afad_guidance":    tool_args.get("afad_guidance_tr", ""),
        "hospital_note":    tool_args.get("hospital_note_tr", ""),
        "waypoints":        waypoints,
        "osrm_used":        osrm_used,
        "route_distance_m": osrm_dist_m,
        "route_duration_s": osrm_dur_s,
        "model_raw_excerpt": raw[:300],
    }

# ── Algoritmik Fallback ───────────────────────────────────────

def _analyze_algorithmic(epicenter, user_loc, assembly_points, rag_data):
    sel_id    = _best_ap(epicenter, user_loc, assembly_points, rag_data)
    sel_ap    = next((ap for ap in assembly_points if ap["id"] == sel_id), assembly_points[0])

    # Try OSRM for real road routing; fall back to straight-line avoidance
    osrm_used  = False
    osrm_dist_m = 0
    osrm_dur_s  = 0
    try:
        osrm_wpts, osrm_dist_m, osrm_dur_s = _get_route(
            user_loc["lat"], user_loc["lon"], sel_ap["lat"], sel_ap["lon"])
        waypoints = _enrich_waypoints(osrm_wpts, user_loc, sel_ap, epicenter)
        osrm_used = True
        print(f"[Analiz] Gerçek yol rotası: {osrm_dist_m/1000:.2f} km")
    except Exception as osrm_err:
        print(f"[Analiz] OSRM başarısız ({osrm_err}) — algoritmik rota")
        waypoints = _enrich_waypoints(
            _build_raw_waypoints(user_loc, sel_ap, epicenter, n=8), user_loc, sel_ap, epicenter)

    d_user_km = _haversine(sel_ap["lat"], sel_ap["lon"], user_loc["lat"], user_loc["lon"])
    d_epi_km  = _haversine(sel_ap["lat"], sel_ap["lon"], epicenter["lat"], epicenter["lon"])
    mag       = epicenter.get("magnitude", 5.0)
    dmg       = sel_ap.get("damage_level", sel_ap.get("damage", 0))
    route_m   = waypoints[-1].get("cumulative_m", 0) if waypoints else 0

    # sort by distance to user (more actionable than distance to epicenter)
    hospitals = sorted(rag_data.get("hospitals", []),
                       key=lambda h: _haversine(h["lat"], h["lon"], user_loc["lat"], user_loc["lon"]))
    afad      = sorted(rag_data.get("afad_stations", []),
                       key=lambda a: _haversine(a["lat"], a["lon"], sel_ap["lat"], sel_ap["lon"]))
    police    = sorted(rag_data.get("police", []),
                       key=lambda p: _haversine(p["lat"], p["lon"], user_loc["lat"], user_loc["lon"]))

    # risk text based on magnitude
    if mag >= 7:
        risk_text = f"M{mag:.1f} — çok şiddetli deprem. Yıkılma riski yüksek, artçılar beklenir."
    elif mag >= 5.5:
        risk_text = f"M{mag:.1f} — orta-şiddetli deprem. Hasarlı binalardan uzak durun."
    else:
        risk_text = f"M{mag:.1f} — hafif deprem. Yapısal risklere dikkat edin."

    # AFAD guidance with distance
    if afad:
        a0 = afad[0]
        a0_km = _haversine(a0["lat"], a0["lon"], sel_ap["lat"], sel_ap["lon"])
        afad_text = f"AFAD {a0['name']} toplanma alanına {a0_km:.1f} km — koordinasyon buradan."
    else:
        afad_text = "AFAD istasyon verisi bulunamadı."

    # hospital note with distance
    if hospitals:
        h0 = hospitals[0]
        h0_km = _haversine(h0["lat"], h0["lon"], user_loc["lat"], user_loc["lon"])
        hosp_text = f"En yakın: {h0['name']} ({h0_km:.1f} km)"
    else:
        hosp_text = "Bölgede hastane verisi yok."

    # route description
    if osrm_used:
        dur_min = osrm_dur_s // 60
        route_desc = f"rota {osrm_dist_m:,.0f} m, ~{dur_min} dk yürüyüş, gerçek yol ağı"
        model_tag  = "Algoritmik + OSRM (gerçek yol ağı)"
    else:
        route_desc = f"rota {route_m:,} m (düz hat tahmini)"
        model_tag  = "Algoritmik Fallback (mlx-vlm kurulu değil veya hata)"

    return {
        "model":            model_tag,
        "tool_called":      "route_to_assembly_point (algoritmik)",
        "selected_assembly": sel_ap,
        "reason":           (
            f"{sel_ap['name']} seçildi — "
            f"hasar %{dmg*100:.0f}, "
            f"mesafe ≈{d_user_km:.1f} km ({route_desc}), "
            f"kapasite {sel_ap.get('capacity', 0):,} kişi, "
            f"epimerkeze {d_epi_km:.1f} km."
        ),
        "risk_assessment":  risk_text,
        "route_notes":      (
            "Hasarlı bina çevrelerinden uzak durun. "
            f"Rota üzerinde {sum(1 for w in waypoints if w.get('danger') == 'high')} yüksek, "
            f"{sum(1 for w in waypoints if w.get('danger') == 'medium')} orta riskli bölge var."
        ),
        "afad_guidance":    afad_text,
        "hospital_note":    hosp_text,
        "waypoints":        waypoints,
        "osrm_used":        osrm_used,
        "route_distance_m": osrm_dist_m if osrm_used else route_m,
        "route_duration_s": osrm_dur_s,
    }

def _best_ap(epicenter, user_loc, aps, rag_data=None):
    """Select best AP considering damage, distance, capacity, and nearby facilities."""
    mag = epicenter.get("magnitude", 5.0)
    damage_r = mag * 7          # estimated full damage radius (km)
    heavy_r  = damage_r * 0.45  # inner heavy-damage zone

    rag = rag_data or {}
    hospitals = rag.get("hospitals", [])
    afad      = rag.get("afad_stations", [])

    def score(ap):
        d_user = _haversine(ap["lat"], ap["lon"], user_loc["lat"], user_loc["lon"])
        d_epi  = _haversine(ap["lat"], ap["lon"], epicenter["lat"], epicenter["lon"])
        dmg    = ap.get("damage_level", ap.get("damage", 0))

        s = d_user * 1.5   # prefer closer to user
        s += dmg * 8       # penalise damage

        # heavy penalty inside damage zones
        if d_epi < heavy_r:
            s += 12
        elif d_epi < damage_r * 0.7:
            s += 4

        # bonus for nearby hospital (within 3 km)
        if hospitals:
            h_min = min(_haversine(ap["lat"], ap["lon"], h["lat"], h["lon"]) for h in hospitals)
            if h_min < 3:
                s -= 1.5

        # bonus for nearby AFAD (within 5 km)
        if afad:
            a_min = min(_haversine(ap["lat"], ap["lon"], a["lat"], a["lon"]) for a in afad)
            if a_min < 5:
                s -= 1.0

        # small bonus for higher capacity
        s -= min(ap.get("capacity", 1000) / 5000, 1.0)

        return s

    pool = [ap for ap in aps if ap.get("damage_level", ap.get("damage", 0)) < 0.5] or aps
    return min(pool, key=score)["id"]

def _build_raw_waypoints(user_loc, dest_ap, epicenter, n=8):
    """Build waypoints with magnitude-aware epicenter avoidance.

    Points that fall inside the damage zone are pushed radially outward.
    Push strength is proportional to how far inside the zone they are.
    """
    mag      = epicenter.get("magnitude", 5.0)
    avoid_km = mag * 3.5   # avoidance radius ≈ half the estimated damage radius

    u_lat, u_lon = user_loc["lat"], user_loc["lon"]
    d_lat, d_lon = dest_ap["lat"], dest_ap["lon"]
    e_lat, e_lon = epicenter["lat"], epicenter["lon"]

    pts = []
    for i in range(n + 1):
        t   = i / n
        lat = u_lat + (d_lat - u_lat) * t
        lon = u_lon + (d_lon - u_lon) * t
        d   = _haversine(lat, lon, e_lat, e_lon)

        if 0 < d < avoid_km:
            # push radially away from epicenter, proportional to overlap
            angle   = math.atan2(lat - e_lat, lon - e_lon)
            push_km = (avoid_km - d) * 0.6
            push_deg = push_km / 111.0
            lat += math.cos(angle) * push_deg
            lon += math.sin(angle) * push_deg / max(0.01, math.cos(math.radians(lat)))

        pts.append({"lat": round(lat, 6), "lon": round(lon, 6)})
    return pts

def _enrich_waypoints(raw_wpts, user_loc, dest_ap, epicenter=None):
    """Enrich raw waypoints with navigation metadata and danger zones.

    Each waypoint receives: index, label, x/y/z, distance_m, cumulative_m,
    bearing_deg, and danger (False | 'medium' | 'high') — matching the
    frontend's markDangerSegments() logic.
    """
    # Filter out VLM-hallucinated pixel/metre coordinates — keep only valid WGS84
    valid_inner = [
        wp for wp in (raw_wpts[1:-1] if len(raw_wpts) >= 3 else raw_wpts)
        if _validate_wgs84(float(wp["lat"]), float(wp["lon"]))
    ]

    # Damage radii (match frontend: magnitude * 7 km, heavy = 45%)
    mag     = (epicenter or {}).get("magnitude", 5.0)
    e_lat   = (epicenter or {}).get("lat", 0)
    e_lon   = (epicenter or {}).get("lon", 0)
    max_r   = mag * 7
    heavy_r = max_r * 0.45

    def _danger(lat, lon):
        if not epicenter:
            return False
        d = _haversine(lat, lon, e_lat, e_lon)
        if d < heavy_r:
            return "high"
        if d < max_r * 0.7:
            return "medium"
        return False

    def _wp(lat, lon, z, index, label, dist_m, cum_m, brg):
        return {
            "lat": lat, "lon": lon,
            "x": lon, "y": lat,
            "z": z,
            "index": index, "label": label,
            "distance_m": round(dist_m),
            "cumulative_m": round(cum_m),
            "bearing_deg": brg,
            "danger": _danger(lat, lon),
        }

    wps = [_wp(user_loc["lat"], user_loc["lon"],
               user_loc.get("z", 0), 0, "BAŞLANGIÇ", 0, 0, None)]

    cumulative = 0.0
    for i, wp in enumerate(valid_inner, start=1):
        lat, lon = float(wp["lat"]), float(wp["lon"])
        prev = wps[-1]
        d_m = _haversine_m(prev["lat"], prev["lon"], lat, lon)
        cumulative += d_m
        wps.append(_wp(lat, lon, 0, i, f"WP-{str(i).zfill(2)}", d_m, cumulative,
                       _bearing(prev["lat"], prev["lon"], lat, lon)))

    dest_lat, dest_lon = dest_ap["lat"], dest_ap["lon"]
    prev = wps[-1]
    d_m = _haversine_m(prev["lat"], prev["lon"], dest_lat, dest_lon)
    cumulative += d_m
    wps.append(_wp(dest_lat, dest_lon, dest_ap.get("z", 0),
                   len(wps), "TOPLANMA", d_m, cumulative,
                   _bearing(prev["lat"], prev["lon"], dest_lat, dest_lon)))

    # Patch bearing_deg on each point → points toward the next segment
    for idx in range(len(wps) - 1):
        wps[idx]["bearing_deg"] = _bearing(
            wps[idx]["lat"], wps[idx]["lon"],
            wps[idx + 1]["lat"], wps[idx + 1]["lon"]
        )

    _fetch_elevations_sync(wps)
    return wps


def _route_geojson(waypoints, rag_data=None, epicenter=None):
    """Convert enriched waypoints + RAG facilities to a GeoJSON FeatureCollection.

    Features included:
      - LineString: full evacuation route ([lon, lat, z] per GeoJSON spec)
      - Point per waypoint: navigation properties + danger level
      - Point per RAG facility (hospital, AFAD, fire, police) with category tags
      - Point for epicenter (if provided)
    """
    features = []

    # ── route line ─────────────────────────────────────────────
    if waypoints:
        coords  = [[wp["lon"], wp["lat"], wp.get("z", 0)] for wp in waypoints]
        total_m = waypoints[-1].get("cumulative_m", 0)
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "feature_type":    "route",
                "total_distance_m": total_m,
                "waypoint_count":  len(waypoints),
            },
        })

        # ── waypoint markers ──────────────────────────────────
        for i, wp in enumerate(waypoints):
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point",
                             "coordinates": [wp["lon"], wp["lat"], wp.get("z", 0)]},
                "properties": {
                    "feature_type": "waypoint",
                    "index":        wp.get("index", i),
                    "label":        wp.get("label", ""),
                    "bearing_deg":  wp.get("bearing_deg"),
                    "distance_m":   wp.get("distance_m", 0),
                    "cumulative_m": wp.get("cumulative_m", 0),
                    "elevation_m":  wp.get("z", 0),
                    "danger":       wp.get("danger", False),
                },
            })

    # ── epicenter ──────────────────────────────────────────────
    if epicenter:
        mag = epicenter.get("magnitude", 5.0)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point",
                         "coordinates": [epicenter["lon"], epicenter["lat"]]},
            "properties": {
                "feature_type":   "epicenter",
                "magnitude":      mag,
                "damage_radius_km": mag * 7,
                "heavy_radius_km":  mag * 7 * 0.45,
            },
        })

    # ── RAG facilities ─────────────────────────────────────────
    rag = rag_data or {}
    _categories = [
        ("hospitals",     "hospital",     "🏥"),
        ("afad_stations", "afad",         "🚨"),
        ("fire_stations", "fire_station", "🚒"),
        ("police",        "police",       "🚔"),
    ]
    for key, cat, icon in _categories:
        for fac in rag.get(key, []):
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point",
                             "coordinates": [fac["lon"], fac["lat"]]},
                "properties": {
                    "feature_type": "facility",
                    "category":     cat,
                    "icon":         icon,
                    "name":         fac.get("name", ""),
                    "osm_id":       fac.get("osm_id", ""),
                },
            })

    return {"type": "FeatureCollection", "features": features}

def _fetch_elevations_sync(waypoints):
    # Bug #4 fix: Safe import with fallback
    try:
        import requests as req_lib
    except ImportError:
        print("[Open-Elevation] requests modulu yuklu degil - tahmini Z")
        _fill_estimated_elevation(waypoints)
        return
    locs = [{"latitude": wp["lat"], "longitude": wp["lon"]} for wp in waypoints]
    try:
        resp = req_lib.post("https://api.open-elevation.com/api/v1/lookup",
                            json={"locations": locs}, timeout=5)
        resp.raise_for_status()
        for i, r in enumerate(resp.json().get("results", [])):
            if i < len(waypoints):
                waypoints[i]["z"] = max(0, int(r.get("elevation", 0)))
    except Exception as e:
        print(f"[Open-Elevation] {e} — tahmini Z")
        _fill_estimated_elevation(waypoints)

def _fill_estimated_elevation(waypoints):
    """Türkiye coğrafyasına uygun kaba yükseklik tahmini (Open-Elevation erişilemediğinde).

    Gerçek SRTM verisi kullanılamadığında enlem/boylama göre kabaca bir değer
    atıyoruz. Hatalı rastgele değer yerine bölgesel ortalama kullanmak
    rota gradient hesaplamalarını biraz daha gerçekçi kılıyor.

    Bölge yaklaşımı (enlem kuşakları — Türkiye içi):
      ≤36°N  → Akdeniz / Ege kıyısı  → 0-200 m
      36-38° → İç Anadolu etekleri   → 100-600 m
      38-40° → İç/Doğu Anadolu      → 500-1200 m
      >40°N  → Karadeniz/Doğu       → 200-800 m
    """
    for wp in waypoints:
        if wp.get("z", 0) != 0:
            continue
        lat = wp.get("lat", 38.0)
        if   lat <= 36.5: z = int(50  + (lat - 36.0) * 200)
        elif lat <= 38.5: z = int(150 + (lat - 36.5) * 250)
        elif lat <= 40.0: z = int(650 + (lat - 38.5) * 350)
        else:             z = int(400 + (lat - 40.0) * 80)
        wp["z"] = max(0, min(z, 3000))

def _haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in kilometres (WGS84 mean radius)."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def _haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres."""
    return _haversine(lat1, lon1, lat2, lon2) * 1000.0

def _bearing(lat1, lon1, lat2, lon2):
    """Forward azimuth (compass bearing) from point 1 to point 2.
    Returns degrees clockwise from true north (0 = N, 90 = E, 180 = S, 270 = W)."""
    lat1, lat2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return round((math.degrees(math.atan2(x, y)) + 360) % 360, 1)

def _validate_wgs84(lat, lon):
    """Return True if lat/lon are plausible WGS84 decimal-degree values."""
    return -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0

# ── Entry point ───────────────────────────────────────────────
if __name__ == "__main__":
    get_db()   # MongoDB bağlantısını dene
    print("─" * 64)
    print("  AfetAI Backend v4 — MongoDB RAG + VLM Tool Calling")
    print(f"  MLX    : {'✓ kurulu' if MLX_IMPORT_OK else '✗ — pip install mlx-vlm'}")
    print(f"  Model  : {current_model or '(seçilmedi — /api/load-model)'}")
    print("  URL    : http://localhost:5050")
    print("─" * 64)
    print("  ENDPOINT'LER:")
    print("    GET/POST /api/rag-context   → Hastane / AFAD / İtfaiye")
    print("    POST     /api/seed-location → Bölgeyi Overpass'tan yenile")
    print("    POST     /api/analyze       → RAG bağlamlı VLM analizi")
    print("    GET      /api/status        → mongo + rag_entries dahil")
    print()
    app.run(host="0.0.0.0", port=5050, debug=False)
