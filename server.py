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

import json, math, random, re, base64, os, tempfile
from datetime import datetime, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

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
        resp = requests.post(OVERPASS_URL, data={"data": ql_body}, timeout=28)
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
    """Verilen koordinat çevresini Overpass'tan çekip cache'le."""
    s, w, n, e = _bbox(lat, lon, 12)
    bbox = f"{s},{w},{n},{e}"
    print(f"[RAG] Seed başlıyor: {lat:.3f}, {lon:.3f} — bbox {bbox}")

    hospitals = _overpass(f"""[out:json][timeout:25];
(node["amenity"="hospital"]({bbox}); way["amenity"="hospital"]({bbox});
 node["amenity"="clinic"]({bbox}););
out body center 15;""")

    afad = _overpass(f"""[out:json][timeout:25];
(node["name"~"AFAD",i]({bbox}); way["name"~"AFAD",i]({bbox});
 node["operator"~"AFAD",i]({bbox}); node["office"]["name"~"AFAD",i]({bbox}););
out body center 10;""")

    fire = _overpass(f"""[out:json][timeout:20];
(node["amenity"="fire_station"]({bbox}); way["amenity"="fire_station"]({bbox}););
out body center 10;""")

    police = _overpass(f"""[out:json][timeout:20];
(node["amenity"="police"]({bbox}); way["amenity"="police"]({bbox}););
out body center 8;""")

    entry = {
        "lat": lat, "lon": lon,
        "hospitals":     hospitals,
        "afad_stations": afad,
        "fire_stations": fire,
        "police":        police,
        "seeded_at":     datetime.utcnow().isoformat(),
    }
    _save_cache(_cache_key(lat, lon), entry)
    print(f"[RAG] Tamamlandı: {len(hospitals)} hastane, {len(afad)} AFAD, "
          f"{len(fire)} itfaiye, {len(police)} polis")
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

# ── RAG → VLM Prompt ─────────────────────────────────────────
def build_rag_prompt(rag, assembly_points, epicenter, user_loc):
    mag  = epicenter["magnitude"]
    elat = epicenter["lat"]
    elon = epicenter["lon"]

    def dist(a): return _haversine(a["lat"], a["lon"], elat, elon)

    hospitals = sorted(rag.get("hospitals",     []), key=dist)[:6]
    afad      = sorted(rag.get("afad_stations", []), key=dist)[:4]
    fire      = sorted(rag.get("fire_stations", []), key=dist)[:3]

    def fmt(lst, emoji=""):
        if not lst:
            return "  (bölgede kayıt bulunamadı)"
        return "\n".join(
            f"  {emoji}{i+1}. {f['name']} — {dist(f):.1f} km "
            f"(Y={f['lat']:.4f}° X={f['lon']:.4f}°)"
            for i, f in enumerate(lst)
        )

    aps = "\n".join(
        f"  AP-{ap['id']:02d}: {ap['name']} | "
        f"hasar %{ap.get('damage_level',0)*100:.0f} | "
        f"{ap['capacity']:,} kişi | "
        f"{_haversine(ap['lat'],ap['lon'],elat,elon):.1f} km epimerkeze"
        for ap in assembly_points
    )

    return f"""
=== AFET BÖLGESİ BİLGİ HAVUZU (RAG) ===
Deprem: M{mag:.1f} | Y={elat:.4f}° X={elon:.4f}°
Kullanıcı: Y={user_loc['lat']:.4f}° X={user_loc['lon']:.4f}°
Tahmini hasar yarıçapı: {mag * 7:.1f} km

HASTANELER:
{fmt(hospitals, '🏥 ')}

AFAD İSTASYONLARI:
{fmt(afad, '🚨 ')}

İTFAİYE:
{fmt(fire, '🚒 ')}

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
                "En güvenli toplanma alanını seç, kullanıcıya güvenli rota belirle."
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
                        "description": "Kullanıcıdan toplanma alanına güvenli rota",
                        "minItems": 4,
                        "maxItems": 12,
                        "items": {
                            "type": "object",
                            "required": ["lat", "lon"],
                            "properties": {
                                "lat": {"type": "number"},
                                "lon": {"type": "number"}
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
        except: pass
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
    return jsonify({"suggested": SUGGESTED_MODELS, "current": current_model, "mlx_installed": MLX_IMPORT_OK})

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

@app.route("/api/analyze", methods=["POST"])
def analyze_earthquake():
    """
    Ana analiz endpoint'i.
    RAG verisi VLM prompt'una eklenir.
    Yanıt rag{hospitals, afad_stations, fire_stations} alanı içerir.
    """
    try:
        data            = request.get_json(force=True)
        epicenter       = data["epicenter"]
        user_loc        = data["user_location"]
        assembly_points = data["assembly_points"]
        image_b64       = data.get("image")

        rag_data   = get_rag(epicenter["lat"], epicenter["lon"])
        rag_prompt = build_rag_prompt(rag_data, assembly_points, epicenter, user_loc)

        if MLX_AVAILABLE and image_b64:
            result = _analyze_with_vlm(image_b64, epicenter, user_loc, assembly_points, rag_prompt, rag_data)
        else:
            result = _analyze_algorithmic(epicenter, user_loc, assembly_points, rag_data)

        result["rag"] = {
            "hospitals":     rag_data.get("hospitals",     [])[:8],
            "afad_stations": rag_data.get("afad_stations", [])[:5],
            "fire_stations": rag_data.get("fire_stations", [])[:4],
        }
        return jsonify(result)

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
            f"Y={ap['lat']:.5f}° X={ap['lon']:.5f}° "
            f"Hasar=%{ap.get('damage_level', ap.get('damage', 0))*100:.0f} Kapasite={ap['capacity']:,}"
            for ap in assembly_points
        )
        user_msg = (
            f"{rag_prompt}\n\n"
            "HARİTADAKİ GÖRSELLER:\n"
            "  • Kırmızı/turuncu bölgeler → deprem hasar alanları\n"
            "  • Yeşil daireler → güvenli toplanma alanları\n"
            "  • Sarı/kırmızı daireler → hasarlı toplanma alanları\n"
            "  • Mavi nokta 📍 → kullanıcının konumu\n"
            "  • Kırmızı ☄ → deprem epimerkezi\n\n"
            f"DEPREM: M{epicenter['magnitude']:.1f} "
            f"Y={epicenter['lat']:.5f}° X={epicenter['lon']:.5f}°\n\n"
            f"KULLANICI: Y={user_loc['lat']:.5f}° X={user_loc['lon']:.5f}°\n\n"
            f"TOPLANMA ALANLARI:\n{ap_list}\n\n"
            "GÖREV: `route_to_assembly_point` fonksiyonunu çağır."
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
    return {
        "model":            f"{current_model} (MLX — tool calling)",
        "tool_called":      "route_to_assembly_point",
        "selected_assembly": sel_ap,
        "reason":           tool_args.get("reason_tr", ""),
        "risk_assessment":  f"M{epicenter['magnitude']:.1f} depremi analiz edildi.",
        "route_notes":      tool_args.get("risk_notes_tr", ""),
        "afad_guidance":    tool_args.get("afad_guidance_tr", ""),
        "hospital_note":    tool_args.get("hospital_note_tr", ""),
        "waypoints":        _enrich_waypoints(tool_args.get("waypoints", []), user_loc, sel_ap),
        "model_raw_excerpt": raw[:300],
    }

# ── Algoritmik Fallback ───────────────────────────────────────

def _analyze_algorithmic(epicenter, user_loc, assembly_points, rag_data):
    sel_id    = _best_ap(epicenter, user_loc, assembly_points)
    sel_ap    = next(ap for ap in assembly_points if ap["id"] == sel_id)
    waypoints = _enrich_waypoints(
        _build_raw_waypoints(user_loc, sel_ap, epicenter, n=7), user_loc, sel_ap)
    d_km      = _haversine(sel_ap["lat"], sel_ap["lon"], user_loc["lat"], user_loc["lon"])

    hospitals = sorted(rag_data.get("hospitals", []),
                       key=lambda h: _haversine(h["lat"],h["lon"],epicenter["lat"],epicenter["lon"]))
    afad      = sorted(rag_data.get("afad_stations", []),
                       key=lambda a: _haversine(a["lat"],a["lon"],epicenter["lat"],epicenter["lon"]))

    return {
        "model":            "Algoritmik Fallback (mlx-vlm kurulu değil veya hata)",
        "tool_called":      "route_to_assembly_point (algoritmik)",
        "selected_assembly": sel_ap,
        "reason":           (
            f"{sel_ap['name']} seçildi — "
            f"hasar %{sel_ap['damage_level']*100:.0f}, "
            f"mesafe ≈{d_km:.1f} km, kapasite {sel_ap['capacity']:,} kişi."
        ),
        "risk_assessment":  f"M{epicenter['magnitude']:.1f} — en düşük hasar + en erişilebilir rota.",
        "route_notes":      "Hasarlı bina çevrelerinden uzak durun.",
        "afad_guidance":    (f"AFAD {afad[0]['name']} üzerinden koordine edilsin." if afad
                             else "AFAD istasyon verisi bulunamadı."),
        "hospital_note":    (f"En yakın: {hospitals[0]['name']}" if hospitals
                             else "Bölgede hastane verisi yok."),
        "waypoints":        waypoints,
    }

def _best_ap(epicenter, user_loc, aps):
    def score(ap):
        return _haversine(ap["lat"],ap["lon"],user_loc["lat"],user_loc["lon"]) + ap["damage_level"] * 4
    pool = [ap for ap in aps if ap["damage_level"] < 0.5] or aps
    return min(pool, key=score)["id"]

def _build_raw_waypoints(user_loc, dest_ap, epicenter, n=7):
    pts = []
    for i in range(n + 1):
        t   = i / n
        lat = user_loc["lat"] + (dest_ap["lat"] - user_loc["lat"]) * t
        lon = user_loc["lon"] + (dest_ap["lon"] - user_loc["lon"]) * t
        d   = _haversine(lat, lon, epicenter["lat"], epicenter["lon"])
        if d < 1.5 and d > 0:
            angle = math.atan2(lat - epicenter["lat"], lon - epicenter["lon"])
            push  = 0.008 * (1 - t)
            lat  += math.cos(angle) * push
            lon  += math.sin(angle) * push
        pts.append({"lat": round(lat, 6), "lon": round(lon, 6)})
    return pts

def _enrich_waypoints(raw_wpts, user_loc, dest_ap):
    wps = [{"lat": user_loc["lat"], "lon": user_loc["lon"],
             "x": user_loc["lon"], "y": user_loc["lat"],
             "z": user_loc.get("z", 0), "label": "BAŞLANGIÇ"}]
    for i, wp in enumerate(raw_wpts[1:-1] if len(raw_wpts) >= 3 else raw_wpts, start=1):
        wps.append({"lat": wp["lat"], "lon": wp["lon"],
                    "x": wp["lon"], "y": wp["lat"],
                    "z": 0, "label": f"WP-{str(i).zfill(2)}"})
    wps.append({"lat": dest_ap["lat"], "lon": dest_ap["lon"],
                "x": dest_ap["lon"], "y": dest_ap["lat"],
                "z": dest_ap.get("z", 0), "label": "TOPLANMA"})
    _fetch_elevations_sync(wps)
    return wps

def _fetch_elevations_sync(waypoints):
    # Bug #4 fix: Safe import with fallback
    try:
        import requests as req_lib
    except ImportError:
        print("[Open-Elevation] requests modulu yuklu degil - tahmini Z")
        for wp in waypoints:
            if wp.get("z", 0) == 0:
                import random as rnd
                wp["z"] = int(15 + rnd.uniform(0, 80))
        return
    locs = [{"latitude": wp["lat"], "longitude": wp["lon"]} for wp in waypoints]
    try:
        resp = req_lib.post("https://api.open-elevation.com/api/v1/lookup",
                            json={"locations": locs}, timeout=10)
        for i, r in enumerate(resp.json().get("results", [])):
            if i < len(waypoints):
                waypoints[i]["z"] = max(0, int(r.get("elevation", 0)))
    except Exception as e:
        print(f"[Open-Elevation] {e} — tahmini Z")
        for wp in waypoints:
            if wp["z"] == 0:
                wp["z"] = int(15 + random.uniform(0, 80))

def _haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat/2)**2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

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
