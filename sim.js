/* ============================================================
   AfetAI — sim.js  (Gerçek Harita + Geocoding Motoru)

   Geocoding  : Nominatim (OpenStreetMap) — ücretsiz, API key yok
   Toplanma   : Overpass API — gerçek OSM verisi
   Yükseklik  : Open-Elevation API (SRTM 30m) — gerçek Z değerleri
   Harita     : Leaflet + CartoDB Dark Matter tiles
   AI         : Qwen2.5-VL-7B (localhost:5050) → fallback algoritmik

   Koordinat sistemi:
     X = Boylam (°E)   — Nominatim / OSM değeri
     Y = Enlem  (°N)   — Nominatim / OSM değeri
     Z = İrtifa (m)    — Open-Elevation SRTM
   ============================================================ */

'use strict';

// ── Leaflet harita & canvas ───────────────────────────────────
let map;
let overlay, octx;

// ── Konum durumu ──────────────────────────────────────────────
let centerLat = 36.2021;
let centerLon = 36.1600;
let userLat   = 36.2021;
let userLon   = 36.1600;

// ── Toplanma alanları ─────────────────────────────────────────
let assemblyPoints = [];  // { id, name, lat, lon, z, capacity, type, damage }

// ── Deprem durumu ─────────────────────────────────────────────
let epicenter = null;     // { lat, lon, magnitude }
let magnitude = 7.4;
let damageField = null;   // Map<"lat,lon", 0-1> -- yoğun grid gerekmiyor, circle tabanlı

// ── Animasyon durumu ──────────────────────────────────────────
const PHASE = { IDLE:0, QUAKE:1, DAMAGE:2, ANALYSIS:3, RESULT:4 };
let phase = PHASE.IDLE;

let shockwaves = [];       // { startTime, maxRadiusKm, magnitude }
let shakeUntil = 0;

let selectedAP   = null;
let routeWaypoints = [];   // { lat, lon, z, label, x, y }  (x=lon alias, y=lat alias)
let routeProgress = 0;
let isAnimatingRoute = false;
let routeAnimSpeed = 1;
let aiResult = null;
let apRouteAbort = null;

// ── Leaflet harita katmanları (zoom/pan ile doğru hareket eder) ──
let damageLayer    = null;   // L.LayerGroup — hasar bölgeleri (L.circle)
let apLayer        = null;   // L.LayerGroup — toplanma alanı markerları
let epicenterLayer = null;   // L.LayerGroup — epimerkez marker
let userLayer      = null;   // L.LayerGroup — kullanıcı konumu
let routeLineLayer = null;   // L.LayerGroup — SVG rota polylineleri
let afadLayer      = null;   // L.LayerGroup — AFAD istasyonları (RAG)
let hospitalLayer  = null;   // L.LayerGroup — hastaneler (RAG)
let afadRouteLayer = null;   // L.LayerGroup — AFAD → AP rotaları
// Canvas sadece: şok dalgası animasyonu + HUD

// ── MongoDB RAG verisi ────────────────────────────────────────
let ragData = null;          // { hospitals, afad_stations, fire_stations }

// ── Rota — ön-oluşturulmuş Canvas polylineler (setLatLngs → drift yok) ──
let routeRenderer    = null;
let routeLines       = null;   // { safe, safeG, med, medG, high, highG, head }
let routeLabelsLayer = null;   // SVG LayerGroup — waypoint etiketleri
let routeLabelsAdded = false;
let apRoutesLayer    = null;   // diğer AP'lere soluk rotalar

// ── Analiz kuyruğu + kalp atışı ──────────────────────────────
let analysisQueue     = [];   // M4.6+ depremler, büyüklüğe göre azalan
let queueCursor       = 0;
let heartbeatTimer    = null;
let heartbeatCountdown = 150; // saniye
const HEARTBEAT_SEC   = 150;  // 2.5 dakika

// ── Gerçek deprem verisi (USGS) ──────────────────────────────
let recentQuakes    = [];       // USGS GeoJSON features
let selectedQuakeId = null;
let earthquakeLayer = null;     // Leaflet LayerGroup
let quakeMagFilter  = 2.5;
let quakeRefreshTimer = null;

// ── Render döngüsü ────────────────────────────────────────────
let animFrame;

// ── Uydu görüntüsü tetikleme (3 art arda tıklama) ────────────
let mapClickCount = 0;
let mapClickTimer = null;
let satellitePopup = null;
let satelliteClickCount = 0;

// ── NASA FIRMS / MODIS yangın katmanı ────────────────────────
let fireLayer      = null;   // Leaflet LayerGroup — FIRMS noktaları
let fireGibsLayer  = null;   // NASA GIBS MODIS tile katmanı
let fireLayerOn    = false;

// ─────────────────────────────────────────────────────────────
// STATİK VERİ — Toplanma Alanları / AFAD / Hastaneler
// (Overpass/RAG boş döndüğünde veya sunucu yokken kullanılır)
// ─────────────────────────────────────────────────────────────
let hospitalRouteLayer = null;  // Leaflet LayerGroup — hastane → AP rotaları

const STATIC_ASSEMBLY_POINTS = [
    // ── İskenderun ───────────────────────────────────────────
    { il:'Hatay', ilce:'İskenderun', name:'İskenderun Millet Parkı',      lat:36.5876, lon:36.1727, capacity:5000, type:'official' },
    { il:'Hatay', ilce:'İskenderun', name:'PAC Yeşil Alanı',              lat:36.5905, lon:36.1680, capacity:3000, type:'official' },
    { il:'Hatay', ilce:'İskenderun', name:'5 Temmuz Stadyumu',            lat:36.5855, lon:36.1810, capacity:8000, type:'official' },
    { il:'Hatay', ilce:'İskenderun', name:'Eski Bit Pazarı Yeri',         lat:36.5840, lon:36.1740, capacity:2000, type:'official' },
    { il:'Hatay', ilce:'İskenderun', name:'Tayfur Sökmen Blv. Parkı',     lat:36.5850, lon:36.1756, capacity:2500, type:'official' },
    { il:'Hatay', ilce:'İskenderun', name:'Adnan Kahveci Çocuk Parkı',    lat:36.5895, lon:36.1700, capacity:1500, type:'official' },
    { il:'Hatay', ilce:'İskenderun', name:'Piri Sultan Abdal Parkı',      lat:36.5920, lon:36.1720, capacity:2000, type:'official' },
    // ── Antakya ──────────────────────────────────────────────
    { il:'Hatay', ilce:'Antakya',    name:'Hatay Millet Bahçesi',         lat:36.2038, lon:36.1598, capacity:10000, type:'official' },
    { il:'Hatay', ilce:'Antakya',    name:'Semt Pazarı Alanı',            lat:36.2012, lon:36.1625, capacity:3000, type:'official' },
    { il:'Hatay', ilce:'Antakya',    name:'Hastane Havuzlar Parkı',       lat:36.2028, lon:36.1590, capacity:2500, type:'official' },
    // ── Defne ────────────────────────────────────────────────
    { il:'Hatay', ilce:'Defne',      name:'Sevgi Parkı (Sümerler)',       lat:36.2390, lon:36.2175, capacity:2000, type:'official' },
    // ── Adana ────────────────────────────────────────────────
    { il:'Adana', ilce:'Seyhan',     name:'Atatürk Parkı',                lat:37.0086, lon:35.3281, capacity:6000, type:'official' },
    { il:'Adana', ilce:'Seyhan',     name:'Sabancı Doğal Parkı',          lat:37.0060, lon:35.3250, capacity:4000, type:'official' },
    { il:'Adana', ilce:'Seyhan',     name:'Adana Lions Kulübü Parkı',     lat:37.0020, lon:35.3190, capacity:2000, type:'official' },
    { il:'Adana', ilce:'Seyhan',     name:'Akkapı 1 Nolu Park',           lat:37.0045, lon:35.3310, capacity:1500, type:'official' },
    { il:'Adana', ilce:'Yüreğir',    name:'2 Temmuz Çocuk Parkı',         lat:37.0030, lon:35.3200, capacity:1200, type:'official' },
    // ── Gaziantep ────────────────────────────────────────────
    { il:'Gaziantep', ilce:'Şahinbey',   name:'Hoşgör Meydan Parkı',     lat:37.0680, lon:37.3780, capacity:3000, type:'official' },
    { il:'Gaziantep', ilce:'Şahinbey',   name:'Vadi Allaben Parkı',       lat:37.0730, lon:37.3650, capacity:4000, type:'official' },
    { il:'Gaziantep', ilce:'Şehitkamil', name:'Seyrantepe Pazaryeri',     lat:37.0790, lon:37.3720, capacity:3500, type:'official' },
    // ── İstanbul — Kadıköy ───────────────────────────────────
    { il:'İstanbul', ilce:'Kadıköy',      name:'Koşuyolu Parkı',          lat:40.9895, lon:29.0470, capacity:5000, type:'official' },
    { il:'İstanbul', ilce:'Kadıköy',      name:'Kriton Curi Parkı',       lat:40.9870, lon:29.0310, capacity:3000, type:'official' },
    { il:'İstanbul', ilce:'Kadıköy',      name:'Söğütlüçeşme Alanı',      lat:40.9852, lon:29.0492, capacity:2500, type:'official' },
    { il:'İstanbul', ilce:'Kadıköy',      name:'Göztepe Parkı',           lat:40.9635, lon:29.0680, capacity:4000, type:'official' },
    // ── İstanbul — Beşiktaş ──────────────────────────────────
    { il:'İstanbul', ilce:'Beşiktaş',     name:'Abbasağa Parkı',          lat:41.0433, lon:29.0080, capacity:3500, type:'official' },
    { il:'İstanbul', ilce:'Beşiktaş',     name:'Dilek Sabancı Parkı',     lat:41.0724, lon:29.0099, capacity:3000, type:'official' },
    { il:'İstanbul', ilce:'Beşiktaş',     name:'Sanatçılar Parkı',        lat:41.0820, lon:29.0030, capacity:2000, type:'official' },
    // ── İstanbul — Küçükçekmece ──────────────────────────────
    { il:'İstanbul', ilce:'Küçükçekmece', name:'Selçuklu Parkı (Atakent)',lat:40.9955, lon:28.7525, capacity:5000, type:'official' },
    { il:'İstanbul', ilce:'Küçükçekmece', name:'29 Ekim Cumhuriyet Parkı',lat:41.0077, lon:28.7546, capacity:4000, type:'official' },
];

const STATIC_AFAD_STATIONS = [
    { il:'İstanbul',      name:'İstanbul AFAD (Eyüpsultan)',          lat:41.1020, lon:28.8770 },
    { il:'Ankara',        name:'Ankara AFAD (Çankaya)',                lat:39.8783, lon:32.7593 },
    { il:'İzmir',         name:'İzmir AFAD (Bornova)',                 lat:38.4620, lon:27.2178 },
    { il:'Antalya',       name:'Antalya AFAD (Döşemealtı)',            lat:37.1195, lon:30.6005 },
    { il:'Adana',         name:'Adana AFAD (Çukurova)',                lat:36.9990, lon:35.2648 },
    { il:'Konya',         name:'Konya AFAD (Selçuklu)',                lat:37.9312, lon:32.4648 },
    { il:'Gaziantep',     name:'Gaziantep AFAD (Şehitkamil)',          lat:37.0713, lon:37.3635 },
    { il:'Şanlıurfa',     name:'Şanlıurfa AFAD (Karaköprü)',           lat:37.2172, lon:38.9695 },
    { il:'Kocaeli',       name:'Kocaeli AFAD (İzmit)',                 lat:40.7730, lon:29.9310 },
    { il:'Mersin',        name:'Mersin AFAD (Yenişehir)',              lat:36.8208, lon:34.6408 },
    { il:'Diyarbakır',    name:'Diyarbakır AFAD (Kayapınar)',          lat:37.9438, lon:40.1812 },
    { il:'Kayseri',       name:'Kayseri AFAD (Kocasinan)',             lat:38.7428, lon:35.4912 },
    { il:'Samsun',        name:'Samsun AFAD (Atakum)',                 lat:41.3025, lon:36.2810 },
    { il:'Balıkesir',     name:'Balıkesir AFAD (Altıeylül)',           lat:39.6308, lon:27.8672 },
    { il:'Kahramanmaraş', name:'Kahramanmaraş AFAD (Dulkadiroğlu)',    lat:37.5858, lon:36.9372 },
    { il:'Van',           name:'Van AFAD (Edremit)',                   lat:38.4858, lon:43.3492 },
    { il:'Aydın',         name:'Aydın AFAD (Efeler)',                  lat:37.8428, lon:27.8378 },
    { il:'Denizli',       name:'Denizli AFAD (Merkezefendi)',           lat:37.7758, lon:29.0820 },
    { il:'Sakarya',       name:'Sakarya AFAD (Adapazarı)',             lat:40.7858, lon:30.4128 },
    { il:'Hatay',         name:'Hatay AFAD (Serinyol/Antakya)',        lat:36.2920, lon:36.2018 },
];

const STATIC_HOSPITALS = [
    { il:'İstanbul',      name:'Çam ve Sakura Şehir Hastanesi',        lat:41.1012, lon:28.7885 },
    { il:'Ankara',        name:'Bilkent Şehir Hastanesi',              lat:39.8725, lon:32.7482 },
    { il:'İzmir',         name:'İzmir Şehir Hastanesi (Bayraklı)',     lat:38.4548, lon:27.1730 },
    { il:'Antalya',       name:'Antalya Eğitim ve Araştırma Hst.',     lat:36.8690, lon:30.7268 },
    { il:'Adana',         name:'Adana Şehir Hastanesi (Yüreğir)',      lat:36.9768, lon:35.3432 },
    { il:'Konya',         name:'Konya Şehir Hastanesi (Karatay)',      lat:37.8782, lon:32.5198 },
    { il:'Gaziantep',     name:'Gaziantep Şehir Hastanesi',            lat:37.0312, lon:37.3282 },
    { il:'Şanlıurfa',     name:'Mehmet Akif İnan EAH',                 lat:37.1728, lon:38.8022 },
    { il:'Kocaeli',       name:'Kocaeli Şehir Hastanesi (İzmit)',      lat:40.7668, lon:29.9252 },
    { il:'Mersin',        name:'Mersin Şehir Hastanesi (Toroslar)',    lat:36.8898, lon:34.6092 },
    { il:'Diyarbakır',    name:'Gazi Yaşargil EAH (Kayapınar)',        lat:37.9140, lon:40.1618 },
    { il:'Kayseri',       name:'Kayseri Şehir Hastanesi (Kocasinan)',  lat:38.7032, lon:35.4658 },
    { il:'Samsun',        name:'Samsun Eğitim ve Araştırma Hst.',      lat:41.2830, lon:36.3242 },
    { il:'Balıkesir',     name:'Atatürk Şehir Hastanesi (Altıeylül)', lat:39.6328, lon:27.8638 },
    { il:'Kahramanmaraş', name:'Necip Fazıl Şehir Hastanesi',          lat:37.5722, lon:36.9292 },
    { il:'Van',           name:'Van Bölge EAH (Edremit)',              lat:38.4722, lon:43.3658 },
    { il:'Aydın',         name:'Aydın Devlet Hastanesi (Efeler)',      lat:37.8510, lon:27.8432 },
    { il:'Denizli',       name:'Denizli Devlet Hastanesi',             lat:37.7828, lon:29.0872 },
    { il:'Sakarya',       name:'Sakarya EAH (Adapazarı)',              lat:40.7748, lon:30.4198 },
    { il:'Hatay',         name:'Hatay Eğitim ve Araştırma Hst.',       lat:36.2082, lon:36.1782 },
];

/**
 * Belirli bir koordinata yakın statik veri döndür.
 * radiusKm içindeki tüm kayıtları filtreler.
 */
function getStaticDataForArea(lat, lon, radiusKm = 80) {
    const filter = arr => arr.filter(p => haversineKm(p.lat, p.lon, lat, lon) <= radiusKm);
    return {
        assembly_points: filter(STATIC_ASSEMBLY_POINTS),
        afad_stations:   filter(STATIC_AFAD_STATIONS),
        hospitals:       filter(STATIC_HOSPITALS),
    };
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupControls();
    initModelSelector();
    checkServerStatus();
    loadDefaultAssemblyPoints(centerLat, centerLon);
    updateAPTable();
    updateUserLayer(); // Başlangıç kullanıcı konumu Leaflet marker
    startRenderLoop();
    initEarthquakePanel();
    initHeartbeat();
});

// ─────────────────────────────────────────────────────────────
// LEAFLET HARİTA
// ─────────────────────────────────────────────────────────────
function initMap() {
    map = L.map('map-container', {
        center: [centerLat, centerLon],
        zoom: 14,
        zoomControl: true,
        attributionControl: true,
    });

    // Esri World Imagery — gerçek uydu görüntüsü (evler, arabalar, sokaklar)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri, Maxar, Earthstar Geographics',
        maxZoom: 19,
    }).addTo(map);

    // Leaflet harita katmanları — zoom/pan ile otomatik hareket eder
    damageLayer    = L.layerGroup().addTo(map);
    apLayer        = L.layerGroup().addTo(map);
    epicenterLayer = L.layerGroup().addTo(map);
    routeLineLayer = L.layerGroup().addTo(map); // eski; yeni routeLines kullanılıyor
    userLayer      = L.layerGroup().addTo(map);

    // Diğer AP'lere soluk rotalar (AI analizi sonrası)
    apRoutesLayer    = L.layerGroup().addTo(map);
    routeLabelsLayer = L.layerGroup().addTo(map);

    // RAG katmanları — AFAD istasyonları ve hastaneler
    afadLayer         = L.layerGroup().addTo(map);
    hospitalLayer     = L.layerGroup().addTo(map);
    afadRouteLayer    = L.layerGroup().addTo(map);
    hospitalRouteLayer = L.layerGroup().addTo(map);

    // Rota için ön-oluşturulmuş Canvas polylineler
    // setLatLngs() her frame DOM oluşturma/silme yapmaz → performanslı + drift yok
    routeRenderer = L.canvas({ padding: 0.5 });
    routeLines = {
        highG: L.polyline([], { renderer: routeRenderer, color: '#ff3b5c', weight: 11, opacity: 0.18, interactive: false }).addTo(map),
        high:  L.polyline([], { renderer: routeRenderer, color: '#ff3b5c', weight: 3,  opacity: 0.92, interactive: false }).addTo(map),
        medG:  L.polyline([], { renderer: routeRenderer, color: '#ff9f0a', weight: 11, opacity: 0.18, interactive: false }).addTo(map),
        med:   L.polyline([], { renderer: routeRenderer, color: '#ff9f0a', weight: 3,  opacity: 0.92, interactive: false }).addTo(map),
        safeG: L.polyline([], { renderer: routeRenderer, color: '#00d4ff', weight: 11, opacity: 0.18, interactive: false }).addTo(map),
        safe:  L.polyline([], { renderer: routeRenderer, color: '#00d4ff', weight: 3,  opacity: 0.92, interactive: false }).addTo(map),
        head:  L.circleMarker([0, 0], { renderer: routeRenderer, radius: 7, fillColor: '#fff', color: '#00d4ff', weight: 2, fillOpacity: 1, interactive: false }),
    };

    // Canvas overlay — SADECE şok dalgası animasyonu + HUD için
    overlay = document.getElementById('sim-overlay');
    octx = overlay.getContext('2d');
    syncOverlaySize();

    // Harita boyutu değişince canvas'ı senkronize et
    map.on('resize', syncOverlaySize);
    window.addEventListener('resize', syncOverlaySize);

    // Haritaya tıkla → epimerkez seç + 3 tıklama uydu görüntüsü
    map.on('click', e => {
        // 3 art arda tıklama — uydu tarama görüntüsü
        mapClickCount++;
        clearTimeout(mapClickTimer);
        mapClickTimer = setTimeout(() => { mapClickCount = 0; }, 2000);

        if (mapClickCount >= 3) {
            mapClickCount = 0;
            clearTimeout(mapClickTimer);
            showSatelliteOverlay(e.latlng);
            return; // epimerkez ayarlamasını atla
        }

        if (phase === PHASE.IDLE || phase === PHASE.DAMAGE) {
            setEpicenterAt(e.latlng.lat, e.latlng.lng);
        }
    });
}

function syncOverlaySize() {
    const root = document.getElementById('map-root');
    if (!root || !overlay) return;
    overlay.width  = root.clientWidth;
    overlay.height = root.clientHeight;
}

// ─────────────────────────────────────────────────────────────
// KONTROLLER
// ─────────────────────────────────────────────────────────────
function setupControls() {
    const magSlider   = document.getElementById('magSlider');
    const magDisplay  = document.getElementById('magDisplay');
    const btnSearch   = document.getElementById('btnSearch');
    const searchInput = document.getElementById('search-input');
    const btnQuake    = document.getElementById('btnQuake');
    const btnAnalyze  = document.getElementById('btnAIAnalyze');
    const btnReset    = document.getElementById('btnSimReset');

    if (magSlider) {
        magSlider.addEventListener('input', () => {
            magnitude = parseFloat(magSlider.value);
            if (magDisplay) magDisplay.textContent = `M${magnitude.toFixed(1)}`;
        });
    }

    if (btnSearch) btnSearch.addEventListener('click', () => doSearch());
    if (searchInput) {
        searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    }

    if (btnQuake)   btnQuake.addEventListener('click', triggerEarthquake);
    if (btnAnalyze) btnAnalyze.addEventListener('click', startAIAnalysis);
    if (btnReset)   btnReset.addEventListener('click', () => fullReset());

    const btnFire = document.getElementById('btnFireLayer');
    if (btnFire) btnFire.addEventListener('click', toggleFireLayer);
}

function doSearch() {
    const q = document.getElementById('search-input')?.value?.trim();
    if (q) searchNeighborhood(q);
}

// ─────────────────────────────────────────────────────────────
// GEOCODİNG — Nominatim (ücretsiz, API key yok)
// ─────────────────────────────────────────────────────────────
async function searchNeighborhood(query) {
    setStatus(`"${query}" aranıyor (Nominatim)...`);
    hideSearchResults();

    try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1&accept-language=tr`;
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'AfetAI-Hackathon/1.0 (afetai@example.com)' }
        });

        if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
        const results = await resp.json();

        if (results.length === 0) {
            setStatus(`❌ "${query}" bulunamadı. Daha spesifik yazın (ör: "Kadıköy İstanbul").`);
            return;
        }

        // Birden fazla sonuç varsa dropdown göster
        if (results.length > 1) {
            showSearchResults(results);
        } else {
            applyGeoResult(results[0]);
        }

    } catch (err) {
        console.error('[Nominatim]', err);
        setStatus(`❌ Geocoding hatası: ${err.message}`);
    }
}

function showSearchResults(results) {
    const box = document.getElementById('search-results');
    if (!box) return;
    box.innerHTML = results.map((r, i) => `
        <button class="d-block w-100 text-start px-3 py-2 border-0 text-white small"
                style="background:transparent; border-bottom: 1px solid rgba(255,255,255,0.06) !important;"
                onclick="window._selectResult(${i})" onmouseover="this.style.background='rgba(0,212,255,0.08)'" onmouseout="this.style.background='transparent'">
            <i class="fa-solid fa-location-dot text-primary me-2 fa-xs"></i>${r.display_name}
        </button>`).join('');
    box.classList.remove('d-none');
    window._geoResults = results;
    window._selectResult = (i) => { hideSearchResults(); applyGeoResult(results[i]); };
    // Dışarı tıklanınca kapat
    setTimeout(() => document.addEventListener('click', hideSearchResults, { once: true }), 100);
}

function hideSearchResults() {
    const box = document.getElementById('search-results');
    if (box) box.classList.add('d-none');
}

async function applyGeoResult(result) {
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);

    centerLat = lat;
    centerLon = lon;
    userLat   = lat;
    userLon   = lon;

    const shortName = result.display_name.split(',').slice(0, 3).join(', ');
    updateHUD(shortName, lat, lon);
    updateUserLayer();

    map.flyTo([lat, lon], 15, { duration: 1.8, easeLinearity: 0.35 });

    fullReset(false); // harita değişti, simülasyonu sıfırla ama haritayı silme

    // OSM'den gerçek toplanma alanlarını yükle
    setStatus('OpenStreetMap\'den toplanma alanları yükleniyor (Overpass API)...');
    await fetchOSMAssemblyPoints(lat, lon);

    // Toplanma alanlarına gerçek yol rotaları hemen çiz
    setStatus('Toplanma alanlarına OSRM rotaları hesaplanıyor...');
    await showAllAPRoutes().catch(err => console.warn('[AP routes]', err));

    // AFAD + hastane verisini arka planda çek → geldikten sonra AFAD rotalarını çiz
    setStatus('✓ Rotalar hazır. AFAD istasyonları yükleniyor...');
    fetchAndApplyRAG(lat, lon)
        .then(() => { drawAFADRoutes(); drawHospitalRoutes(); })
        .catch(err => console.warn('[RAG/AFAD]', err));

    setStatus('✓ Yüklendi. Haritaya tıklayarak epimerkez seçin veya "Deprem Başlat" butonunu kullanın.');
}

function updateHUD(name, lat, lon) {
    const nameEl  = document.getElementById('locationDisplay');
    const coordEl = document.getElementById('coordDisplay');
    if (nameEl)  nameEl.textContent  = name;
    if (coordEl) coordEl.textContent = `Y: ${lat.toFixed(5)}° | X: ${lon.toFixed(5)}°`;
}

// ─────────────────────────────────────────────────────────────
// OVERPASS API — Gerçek toplanma alanları
// ─────────────────────────────────────────────────────────────
async function fetchOSMAssemblyPoints(lat, lon, radiusM = 4000) {
    // Önce resmi toplanma noktaları, sonra parklar/spor alanları
    const query = `
[out:json][timeout:30];
(
  node["emergency"="assembly_point"](around:${radiusM},${lat},${lon});
  node["assembly_point"="yes"](around:${radiusM},${lat},${lon});
  way["emergency"="assembly_point"](around:${radiusM},${lat},${lon});
  node["leisure"="park"]["name"](around:${radiusM},${lat},${lon});
  way["leisure"="park"]["name"](around:${radiusM},${lat},${lon});
  node["leisure"="sports_centre"]["name"](around:${radiusM},${lat},${lon});
  way["leisure"="sports_centre"]["name"](around:${radiusM},${lat},${lon});
);
out center 8;`;

    try {
        const resp = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
            signal: AbortSignal.timeout(25000),
        });

        if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
        const data = await resp.json();
        const elements = (data.elements || []).filter(el => {
            const alat = el.center?.lat || el.lat;
            const alon = el.center?.lon || el.lon;
            return alat && alon;
        });

        const badgeEl = document.getElementById('apSourceBadge');

        if (elements.length > 0) {
            const isOfficial = elements.some(el => el.tags?.emergency === 'assembly_point');
            assemblyPoints = elements.slice(0, 6).map((el, i) => {
                const alat = el.center?.lat ?? el.lat;
                const alon = el.center?.lon ?? el.lon;
                const isAP = el.tags?.emergency === 'assembly_point';
                return {
                    id: i + 1,
                    name: el.tags?.['name:tr'] || el.tags?.name || (isAP ? `Toplanma Noktası ${i+1}` : `Park ${i+1}`),
                    lat: alat, lon: alon,
                    z: 0, // Open-Elevation ile doldurulacak
                    capacity: isAP ? 3000 : [500,1000,1500,2000,2500,3000][i],
                    type: isAP ? 'official' : 'park',
                    damage: 0,
                };
            });

            if (badgeEl) {
                badgeEl.textContent = isOfficial ? `${assemblyPoints.length} resmi AP` : `${assemblyPoints.length} park/alan`;
                badgeEl.style.background = isOfficial ? 'rgba(0,255,136,0.12)' : 'rgba(255,200,50,0.12)';
                badgeEl.style.color = isOfficial ? 'var(--color-success)' : '#f59e0b';
            }

            // Z değerlerini toplu çek
            await fetchElevations(assemblyPoints);

        } else {
            // Overpass boş — statik veriyi dene
            const staticNearby = getStaticDataForArea(lat, lon, 50).assembly_points;
            if (staticNearby.length > 0) {
                assemblyPoints = staticNearby.slice(0, 8).map((p, i) => ({
                    id: i + 1, name: p.name,
                    lat: p.lat, lon: p.lon, z: 0,
                    capacity: p.capacity, type: p.type, damage: 0,
                }));
                if (badgeEl) { badgeEl.textContent = `${assemblyPoints.length} statik AP`; badgeEl.style.background = 'rgba(0,212,255,0.12)'; badgeEl.style.color = '#00d4ff'; }
            } else {
                loadDefaultAssemblyPoints(lat, lon);
                if (badgeEl) { badgeEl.textContent = 'Simüle (OSM boş)'; badgeEl.style.background = 'rgba(168,85,247,0.12)'; badgeEl.style.color = 'var(--color-purple)'; }
            }
            await fetchElevations(assemblyPoints);
        }

    } catch (err) {
        console.warn('[Overpass]', err.message);
        // Hata durumunda da statik veriyi dene
        const staticNearby = getStaticDataForArea(lat, lon, 50).assembly_points;
        if (staticNearby.length > 0) {
            assemblyPoints = staticNearby.slice(0, 8).map((p, i) => ({
                id: i + 1, name: p.name,
                lat: p.lat, lon: p.lon, z: 0,
                capacity: p.capacity, type: p.type, damage: 0,
            }));
        } else {
            loadDefaultAssemblyPoints(lat, lon);
        }
        const badgeEl = document.getElementById('apSourceBadge');
        if (badgeEl) { badgeEl.textContent = 'Statik/Fallback'; badgeEl.style.color = '#f59e0b'; }
    }

    updateAPTable();
}

function loadDefaultAssemblyPoints(lat, lon) {
    const defs = [
        [0.009, 0.005, 'Kuzey Park Alanı', 1500],
        [-0.006, 0.012, 'Doğu Spor Sahası', 2800],
        [0.004, -0.011, 'Batı Meydan', 3500],
        [-0.012, -0.003, 'Güney Toplanma Alanı', 2000],
        [0.014, 0.009, 'KD Açık Alan', 1200],
        [-0.007, 0.015, 'Kıyı/Liman Bölgesi', 5000],
    ];
    assemblyPoints = defs.map(([dlat, dlon, name, cap], i) => ({
        id: i + 1, name,
        lat: parseFloat((lat + dlat).toFixed(6)),
        lon: parseFloat((lon + dlon).toFixed(6)),
        z: Math.floor(15 + Math.random() * 120),
        capacity: cap,
        type: 'simulated',
        damage: 0,
    }));
}

// ─────────────────────────────────────────────────────────────
// OPEN-ELEVATION API — Gerçek Z değerleri (SRTM 30m)
// ─────────────────────────────────────────────────────────────
async function fetchElevations(points) {
    if (!points || points.length === 0) return;
    const locations = points.map(p => ({ latitude: p.lat, longitude: p.lon }));

    try {
        const resp = await fetch('https://api.open-elevation.com/api/v1/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations }),
            signal: AbortSignal.timeout(10000),
        });
        const data = await resp.json();
        (data.results || []).forEach((r, i) => {
            if (points[i]) points[i].z = Math.max(0, r.elevation ?? points[i].z);
        });
    } catch {
        // Fallback: basit tahmini yükseklik (enlem bazlı)
        points.forEach(p => { if (!p.z) p.z = Math.floor(20 + Math.random() * 100); });
    }
}

async function fetchWaypointElevations(waypoints) {
    if (!waypoints.length) return;
    const locations = waypoints.map(wp => ({ latitude: wp.lat, longitude: wp.lon }));
    try {
        const resp = await fetch('https://api.open-elevation.com/api/v1/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations }),
            signal: AbortSignal.timeout(12000),
        });
        const data = await resp.json();
        (data.results || []).forEach((r, i) => {
            if (waypoints[i]) {
                waypoints[i].z = Math.max(0, r.elevation ?? 0);
            }
        });
    } catch {
        waypoints.forEach(wp => { if (!wp.z) wp.z = Math.floor(20 + Math.random() * 80); });
    }
}

// ─────────────────────────────────────────────────────────────
// DEPREM TEPKİLEME
// ─────────────────────────────────────────────────────────────
function setEpicenterAt(lat, lon) {
    epicenter = { lat, lon, magnitude };
    updateEpicenterLayer();
    applyDamage();
}

function triggerEarthquake() {
    if (phase === PHASE.QUAKE || phase === PHASE.ANALYSIS) return;

    // Epimerkez: merkeze yakın rastgele nokta
    const spread = magnitude * 0.008;
    const eLat = centerLat + (Math.random() - 0.5) * spread;
    const eLon = centerLon + (Math.random() - 0.5) * spread;

    epicenter = { lat: eLat, lon: eLon, magnitude };
    selectedAP = null;
    routeWaypoints = [];
    routeProgress = 0;
    isAnimatingRoute = false;
    aiResult = null;
    shockwaves = [];
    clearAllLayers();

    // AP hasarlarını sıfırla
    assemblyPoints.forEach(ap => ap.damage = 0);

    phase = PHASE.QUAKE;
    updateEpicenterLayer();
    setStatus(`☄ M${magnitude.toFixed(1)} depremi başlatıldı. Şok dalgaları hesaplanıyor...`);

    // 3 şok dalgası halkası (farklı zamanlarda başlar)
    const now = Date.now();
    shockwaves = [
        { startTime: now,       maxRadiusKm: magnitude * 6 },
        { startTime: now + 600, maxRadiusKm: magnitude * 6 },
        { startTime: now + 1200,maxRadiusKm: magnitude * 6 },
    ];

    shakeUntil = Date.now() + 1800; // 1.8 saniye sarsıntı

    setTimeout(applyDamage, 2200);
}

// ─────────────────────────────────────────────────────────────
// HASAR HESAPLAMA
// ─────────────────────────────────────────────────────────────
function applyDamage() {
    if (!epicenter) return;
    phase = PHASE.DAMAGE;
    updateEpicenterLayer();

    // AP hasar seviyelerini güncelle
    assemblyPoints.forEach(ap => {
        const distKm = haversineKm(epicenter.lat, epicenter.lon, ap.lat, ap.lon);
        const maxR = magnitude * 7; // hasar yarıçapı km
        if (distKm > maxR) { ap.damage = 0; return; }

        const peakPGA = Math.min(1, (magnitude - 4) / 5);
        let dmg = peakPGA * Math.exp(-distKm / (maxR * 0.4));
        if (ap.type === 'official') dmg *= 0.7; // resmi alanlar dayanıklı
        dmg *= 0.6 + Math.random() * 0.8;
        ap.damage = Math.min(1, dmg);
    });

    const highDmg = assemblyPoints.filter(ap => ap.damage > 0.5).length;
    const src = selectedQuakeId ? 'Gerçek deprem' : 'Manuel test';
    setStatus(`⚠ [${src}] ${highDmg} toplanma alanı hasar bölgesinde. "AI Analizi" butonuna basın.`);
    updateDamageLayer();
    updateAPTable(); // updateAPTable içinde updateAPLayer da çağrılır
}

// ─────────────────────────────────────────────────────────────
// AI ANALİZİ
// ─────────────────────────────────────────────────────────────
async function startAIAnalysis() {
    if (!epicenter) {
        setStatus('⚠ Önce listeden bir deprem seçin veya haritaya tıklayın.');
        return;
    }
    if (phase === PHASE.ANALYSIS) return;

    phase = PHASE.ANALYSIS;
    selectedAP = null;
    routeWaypoints = [];
    routeProgress = 0;
    isAnimatingRoute = false;
    setStatus('Görüntü yakalanıyor...');

    // Tam harita görüntüsü: Leaflet tiles + simülasyon overlay birleşimi
    const imageData = captureMapImage();
    // Bug #5 fix: Show warning when capture returns null (CORS tainted canvas)
    if (!imageData) {
        console.warn('[captureMapImage] Null — CORS tainted canvas, VLM görüntü göremeyecek');
        setStatus('⚠ Harita görüntüsü yakalanamadı (CORS) — algoritmik fallback kullanılacak...');
    }

    const payload = {
        image: imageData,
        epicenter: {
            lat: epicenter.lat, lon: epicenter.lon,
            magnitude: epicenter.magnitude,
            x: epicenter.lon, y: epicenter.lat,
        },
        user_location: {
            lat: userLat, lon: userLon,
            x: userLon,  y: userLat,
            z: 0,  // Backend Open-Elevation ile dolduracak
        },
        assembly_points: assemblyPoints.map(ap => ({
            id: ap.id, name: ap.name,
            lat: ap.lat, lon: ap.lon,
            x: ap.lon, y: ap.lat, z: ap.z || 0,
            capacity: ap.capacity,
            damage_level: parseFloat((ap.damage || 0).toFixed(3)),
        })),
    };

    let serverReachable = false;
    try {
        setStatus('Qwen2.5-VL-7B tool calling başlatılıyor (localhost:5050)...');
        const resp = await fetch('http://localhost:5050/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(45000),  // VLM inference için ekstra süre
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        aiResult = await resp.json();
        serverReachable = true;

        // Backend tool call sonucunu logla
        if (aiResult.tool_called) {
            console.log(`[AfetAI] Tool çağrıldı: ${aiResult.tool_called}`);
        }

    } catch (err) {
        console.warn('[AI Server]', err.message);
        setStatus('Sunucu yok → JS algoritmik fallback devreye girdi...');
        // JS tarafında Open-Elevation Z değerlerini çekecek (applyAIResult içinde)
        aiResult = localAlgorithmicFallback(payload);
    }

    phase = PHASE.RESULT;
    // Backend waypoint'lere Z ekledi mi? Eklediyse tekrar çekme.
    await applyAIResult(aiResult, serverReachable);
}

/**
 * Tam harita görüntüsü yakala:
 *   1. Koyu arka plan (CartoDB Dark tema rengi)
 *   2. Leaflet tile canvas'ı (CORS izin verirse)
 *   3. Simülasyon overlay (hasar bölgeleri, AP'ler, rota)
 *
 * Model tile'lara değil, kırmızı hasar alanlarına + renkli AP ikonlarına
 * ve koordinat metnine bakarak karar verir.
 */
function captureMapImage() {
    const W = overlay.width, H = overlay.height;
    const composite = document.createElement('canvas');
    composite.width = W; composite.height = H;
    const ctx = composite.getContext('2d');

    // 1. Koyu arka plan
    ctx.fillStyle = '#1a1b2e';
    ctx.fillRect(0, 0, W, H);

    // 2. Leaflet tile canvas'ı (CORS engeli yoksa)
    //    CartoDB tiles cross-origin olduğundan tainted canvas hatası gelebilir.
    //    try/catch ile geçiyoruz — model overlay'den zaten hasar bölgelerini görebilir.
    try {
        const leafletCanvas = document.querySelector('#map-container .leaflet-layer canvas');
        if (leafletCanvas) ctx.drawImage(leafletCanvas, 0, 0, W, H);
    } catch (_) { /* CORS bloğu — beklenen, devam */ }

    // 3. Simülasyon overlay (hasar, AP, epicenter, rota)
    try {
        ctx.drawImage(overlay, 0, 0);
    } catch (_) { /* ignore */ }

    try { return composite.toDataURL('image/png'); }
    catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// AI SONUCU UYGULA
// ─────────────────────────────────────────────────────────────
/**
 * AI (veya fallback) sonucunu uygula.
 *
 * serverReachable=true → backend zaten Open-Elevation'dan Z değerlerini doldurdu,
 *                         frontend tekrar çekmez.
 * serverReachable=false → JS fallback'teyiz, Z değerlerini biz çekeceğiz.
 */
async function applyAIResult(result, serverReachable = false) {
    // Seçilen AP'yi belirle
    const selId = result.selected_assembly?.id;
    selectedAP = assemblyPoints.find(ap => ap.id === selId) || assemblyPoints[0];
    if (!selectedAP) { setStatus('⚠ Toplanma alanı belirlenemedi.'); return; }

    // ── 1. Rota waypoint'lerini belirle ──────────────────────
    // Backend zaten OSRM rotası döndüyse tekrar çekme (hız kazancı)
    let osrmOk = false;
    if (result.osrm_used && result.waypoints?.length > 2) {
        // Backend OSRM kullandı — direkt waypoint'leri al
        routeWaypoints = result.waypoints.map((wp, i) => ({
            lat:   wp.lat ?? wp.y ?? 0,
            lon:   wp.lon ?? wp.x ?? 0,
            z:     wp.z ?? 0,
            label: wp.label ?? (i === 0 ? 'BAŞLANGIÇ' : (i === result.waypoints.length-1 ? 'TOPLANMA' : `WP-${String(i).padStart(2,'0')}`)),
            x:     wp.x ?? wp.lon ?? 0,
            y:     wp.y ?? wp.lat ?? 0,
            danger: wp.danger || false,
        }));
        osrmOk = true;
        setStatus(`✓ Backend OSRM rotası: ${routeWaypoints.length} yol noktası`);
    } else {
        // Backend OSRM kullanmadı — frontend OSRM dene
        setStatus('OSRM ile gerçek yol rotası hesaplanıyor...');
        try {
            const osrmWpts = await fetchOSRMRoute(
                userLat, userLon,
                selectedAP.lat, selectedAP.lon
            );
            routeWaypoints = osrmWpts;
            osrmOk = true;
            setStatus(`✓ OSRM rotası: ${routeWaypoints.length} yol noktası`);
        } catch (err) {
            console.warn('[OSRM+Valhalla]', err.message, '— backend /api/route deneniyor...');
            setStatus('Routing servisleri ulaşılamadı — backend deneniyor...');

            // Backend /api/route endpoint'i dene (sunucu-taraflı OSRM çağrısı)
            let backendOk = false;
            try {
                const routeResp = await fetch('http://localhost:5050/api/route', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        from: { lat: userLat, lon: userLon },
                        to:   { lat: selectedAP.lat, lon: selectedAP.lon },
                        epicenter: epicenter
                            ? { lat: epicenter.lat, lon: epicenter.lon, magnitude: epicenter.magnitude }
                            : null,
                    }),
                    signal: AbortSignal.timeout(15000),
                });
                if (routeResp.ok) {
                    const rd = await routeResp.json();
                    if (rd.waypoints?.length > 2) {
                        routeWaypoints = rd.waypoints.map((wp, i) => ({
                            lat:   wp.lat ?? 0,
                            lon:   wp.lon ?? 0,
                            x:     wp.lon ?? 0,
                            y:     wp.lat ?? 0,
                            z:     wp.z ?? 0,
                            label: wp.label ?? (i === 0 ? 'BAŞLANGIÇ' : (i === rd.waypoints.length-1 ? 'TOPLANMA' : `WP-${String(i).padStart(2,'0')}`)),
                            danger: wp.danger || false,
                        }));
                        osrmOk = true;
                        backendOk = true;
                        setStatus(`✓ Backend rota: ${routeWaypoints.length} yol noktası`);
                    }
                }
            } catch (backendErr) {
                console.warn('[Backend route]', backendErr.message);
            }

            if (!backendOk) {
                setStatus('⚠ Tüm routing seçenekleri başarısız — düz hat kullanılıyor (yol verisi yok)');
                const raw = result.waypoints?.length
                    ? result.waypoints
                    : buildWaypoints({ lat: userLat, lon: userLon }, selectedAP, epicenter);
                routeWaypoints = raw.map((wp, i) => ({
                    lat:   wp.lat ?? wp.y ?? 0,
                    lon:   wp.lon ?? wp.x ?? 0,
                    z:     wp.z ?? 0,
                    label: wp.label ?? (i === 0 ? 'BAŞLANGIÇ' : (i === raw.length-1 ? 'TOPLANMA' : `WP-${String(i).padStart(2,'0')}`)),
                    x:     wp.x ?? wp.lon ?? 0,
                    y:     wp.y ?? wp.lat ?? 0,
                    danger: false,
                }));
            }
        }
    }

    // ── 2. Her segmentin hasar bölgesinde olup olmadığını işaretle
    if (epicenter) markDangerSegments(routeWaypoints);

    // ── 3. Open-Elevation ile Z değerleri ─────────────────────
    // Backend zaten Z doldurduysa atla
    const needsZ = !serverReachable || routeWaypoints.some(wp => wp.z === 0);
    if (needsZ) {
        setStatus('Open-Elevation SRTM Z değerleri alınıyor...');
        await fetchWaypointElevationsSparse(routeWaypoints);
    }

    routeWaypoints.forEach(wp => { wp.x = wp.lon; wp.y = wp.lat; wp.z = wp.z || 0; });

    // ── 4. Animasyonu başlat ───────────────────────────────────
    routeLabelsAdded = false;
    routeProgress = 0;
    isAnimatingRoute = true;
    // OSRM çok nokta verir — animasyonu hızlandır
    routeAnimSpeed = osrmOk ? Math.max(2, Math.floor(routeWaypoints.length / 80)) : 1;

    renderAIPanel(result, osrmOk);
    renderWaypointTable(routeWaypoints);

    const dangerCount = routeWaypoints.filter(wp => wp.danger).length;
    const toolInfo = result.tool_called ? ` [${result.tool_called}]` : '';
    setStatus(
        `✅ ${selectedAP.name} seçildi — ${routeWaypoints.length} yol noktası` +
        (dangerCount ? ` ⚠ ${dangerCount} tehlikeli segment` : '') +
        toolInfo
    );

    // Diğer AP rotaları + AFAD rotalarını aynı anda başlat
    updateAPLayer();
    showAllAPRoutes();
    drawAFADRoutes();
    drawHospitalRoutes();

    // RAG verisi analiz sonucuna eklenebilir (analyze endpoint'ten geldiyse)
    if (result.rag) {
        ragData = result.rag;
        updateAFADLayer(ragData.afad_stations || []);
        updateHospitalLayer(ragData.hospitals || []);
        updateRAGPanel(ragData);
    }
}

// ─────────────────────────────────────────────────────────────
// OSRM — Gerçek yol ağı üzerinden rota
// ─────────────────────────────────────────────────────────────
/**
 * OSRM public API (foot profili — yaya, depremde araç yolu güvensiz olabilir)
 * Döndürdüğü GeoJSON koordinatlar gerçek OSM yollarını takip eder.
 *
 * Fallback chain:
 *   1. router.project-osrm.org  (yavaş ama güvenilir)
 *   2. routing.openstreetmap.de (alternatif)
 */
async function fetchOSRMRoute(fromLat, fromLon, toLat, toLon) {
    // Her iki OSRM endpoint'ini PARALEL dene — hangisi önce cevap verirse onu kullan
    const endpoints = [
        `https://router.project-osrm.org/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}`,
        `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}`,
    ];
    const params = '?overview=full&geometries=geojson&steps=false';

    const osrmResults = await Promise.allSettled(
        endpoints.map(base =>
            fetch(base + params, { signal: AbortSignal.timeout(12000) })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                .then(data => {
                    if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.message || 'Rota yok');
                    return data;
                })
        )
    );

    const osrmSuccess = osrmResults.find(r => r.status === 'fulfilled');
    if (osrmSuccess) {
        const route   = osrmSuccess.value.routes[0];
        const coords  = route.geometry.coordinates; // [lon, lat]
        const distKm  = (route.distance / 1000).toFixed(2);
        const durMin  = Math.round(route.duration / 60);
        console.log(`[OSRM] ✓ ${coords.length} nokta | ${distKm} km | ~${durMin} dk yürüyüş`);
        const seyrelt = seyreltCoords(coords, 300);
        return seyrelt.map((c, i) => ({
            lat: c[1], lon: c[0], x: c[0], y: c[1], z: 0,
            label: i === 0 ? 'BAŞLANGIÇ' : (i === seyrelt.length-1 ? 'TOPLANMA' : `WP-${String(i).padStart(2,'0')}`),
            danger: false, _distKm: distKm, _durMin: durMin,
        }));
    }

    // OSRM başarısız — Valhalla ile dene (OSM Community ücretsiz)
    console.warn('[OSRM] Her iki endpoint başarısız — Valhalla deneniyor...');
    return fetchValhallaRoute(fromLat, fromLon, toLat, toLon);
}

/** Valhalla pedestrian routing — OSM community public instance */
async function fetchValhallaRoute(fromLat, fromLon, toLat, toLon) {
    const body = {
        locations: [
            { lon: fromLon, lat: fromLat },
            { lon: toLon,   lat: toLat   },
        ],
        costing: 'pedestrian',
        directions_options: { units: 'km' },
    };
    const resp = await fetch('https://valhalla1.openstreetmap.de/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Valhalla HTTP ${resp.status}`);
    const data = await resp.json();

    if (!data.trip?.legs?.[0]) throw new Error('Valhalla rota yok');
    const leg     = data.trip.legs[0];
    const coords  = decodePolyline6(leg.shape); // [lat, lon]
    const distKm  = data.trip.summary.length.toFixed(2);
    const durMin  = Math.round(data.trip.summary.time / 60);
    console.log(`[Valhalla] ✓ ${coords.length} nokta | ${distKm} km | ~${durMin} dk yürüyüş`);

    const seyrelt = seyreltCoords(coords.map(c => [c[1], c[0]]), 300); // [lon, lat] formatına çevir
    return seyrelt.map((c, i) => ({
        lat: c[1], lon: c[0], x: c[0], y: c[1], z: 0,
        label: i === 0 ? 'BAŞLANGIÇ' : (i === seyrelt.length-1 ? 'TOPLANMA' : `WP-${String(i).padStart(2,'0')}`),
        danger: false, _distKm: distKm, _durMin: durMin,
    }));
}

/** Valhalla'nın precision=6 polyline formatını çöz → [[lat, lon], ...] */
function decodePolyline6(encoded) {
    let index = 0, lat = 0, lng = 0;
    const result = [];
    while (index < encoded.length) {
        let b, shift = 0, val = 0;
        do { b = encoded.charCodeAt(index++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += (val & 1) ? ~(val >> 1) : (val >> 1);
        shift = 0; val = 0;
        do { b = encoded.charCodeAt(index++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += (val & 1) ? ~(val >> 1) : (val >> 1);
        result.push([lat / 1e6, lng / 1e6]);
    }
    return result;
}

/**
 * Rota noktalarını maxPoints'e kadar seyrelt.
 * Başlangıç ve bitiş noktaları her zaman korunur.
 */
function seyreltCoords(coords, maxPoints) {
    if (coords.length <= maxPoints) return coords;
    const step = Math.ceil(coords.length / maxPoints);
    const result = coords.filter((_, i) => i % step === 0);
    // Son nokta eksikse ekle
    const last = coords[coords.length - 1];
    if (result[result.length - 1] !== last) result.push(last);
    return result;
}

/**
 * Her waypoint'in hasar bölgesinde olup olmadığını işaretle.
 * danger=true → drawRoute() kırmızı çizer.
 */
function markDangerSegments(waypoints) {
    if (!epicenter) return;
    const maxR  = epicenter.magnitude * 7;  // km — tam hasar yarıçapı
    const heavyR = maxR * 0.45;             // ağır hasar iç bölge

    waypoints.forEach(wp => {
        const d = haversineKm(wp.lat, wp.lon, epicenter.lat, epicenter.lon);
        if (d < heavyR) {
            wp.danger = 'high';    // kırmızı
        } else if (d < maxR * 0.7) {
            wp.danger = 'medium';  // turuncu
        } else {
            wp.danger = false;     // güvenli — cyan
        }
    });
}

/**
 * Seyreltilmiş subset ile Open-Elevation sorgula,
 * araya interpolasyon uygula (max 100 API isteği).
 */
async function fetchWaypointElevationsSparse(waypoints) {
    const MAX_API = 80;
    if (waypoints.length === 0) return;

    let queryPts, indices;
    if (waypoints.length <= MAX_API) {
        queryPts = waypoints;
        indices  = waypoints.map((_, i) => i);
    } else {
        // Eşit aralıklı örnekleme
        const step = Math.ceil(waypoints.length / MAX_API);
        indices  = waypoints.reduce((acc, _, i) => (i % step === 0 ? [...acc, i] : acc), []);
        if (indices[indices.length - 1] !== waypoints.length - 1) indices.push(waypoints.length - 1);
        queryPts = indices.map(i => waypoints[i]);
    }

    try {
        const resp = await fetch('https://api.open-elevation.com/api/v1/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations: queryPts.map(wp => ({ latitude: wp.lat, longitude: wp.lon })) }),
            signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json();
        (data.results || []).forEach((r, j) => {
            waypoints[indices[j]].z = Math.max(0, r.elevation ?? 0);
        });

        // Ara noktaları lineer interpolasyonla doldur
        for (let i = 0; i < indices.length - 1; i++) {
            const a = indices[i], b = indices[i + 1];
            const za = waypoints[a].z, zb = waypoints[b].z;
            for (let k = a + 1; k < b; k++) {
                const t = (k - a) / (b - a);
                waypoints[k].z = Math.round(za + (zb - za) * t);
            }
        }
    } catch {
        waypoints.forEach(wp => { if (!wp.z) wp.z = Math.floor(15 + Math.random() * 60); });
    }
}

// ─────────────────────────────────────────────────────────────
// ALGORİTMİK FALLBACK (sunucu yoksa)
// ─────────────────────────────────────────────────────────────
function localAlgorithmicFallback(payload) {
    const aps = payload.assembly_points;
    const user = payload.user_location;
    const epi  = payload.epicenter;

    // Risk skoru: mesafe + hasar cezası
    const safe = aps.filter(ap => ap.damage_level < 0.5);
    const pool = safe.length ? safe : aps;
    const best = pool.reduce((prev, cur) => {
        const dU = haversineKm(cur.lat ?? cur.y, cur.lon ?? cur.x, user.lat ?? user.y, user.lon ?? user.x);
        const pen = cur.damage_level * 3;
        const pU  = haversineKm(prev.lat ?? prev.y, prev.lon ?? prev.x, user.lat ?? user.y, user.lon ?? user.x);
        return (dU + pen) < (pU + prev.damage_level * 3) ? cur : prev;
    });

    const wpts = buildWaypoints(
        { lat: user.lat ?? user.y, lon: user.lon ?? user.x },
        { lat: best.lat ?? best.y, lon: best.lon ?? best.x },
        epi
    );

    const dist = haversineKm(best.lat ?? best.y, best.lon ?? best.x, user.lat ?? user.y, user.lon ?? user.x);

    return {
        model: 'Algoritmik Fallback (JS — mlx-vlm sunucusu yok)',
        selected_assembly: best,
        reason: `${best.name} seçildi. Hasar: %${(best.damage_level*100).toFixed(0)}, mesafe: ${dist.toFixed(1)} km, kapasite: ${(best.capacity||'?').toLocaleString()} kişi.`,
        risk_assessment: `M${epi.magnitude.toFixed(1)} depremi bölgede yapısal hasar oluşturdu. Seçilen alan güvenli mesafede.`,
        route_notes: 'Hasarlı bölgelerden uzak durun. Z değeri 30m\'den yüksek artışlarda hız kısıtlayın. WP-01–WP-02 arası dikkat.',
        waypoints: wpts,
    };
}

function buildWaypoints(from, to, epi, n = 8) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        let lat = from.lat + (to.lat - from.lat) * t;
        let lon = from.lon + (to.lon - from.lon) * t;

        // Epimerkeze ~1.5km yakınsa hafif saptır
        const dEpi = haversineKm(lat, lon, epi.lat, epi.lon);
        if (dEpi < 1.5 && dEpi > 0) {
            // Bug #12 fix: Deterministic offset — use position-based angle instead of random
            const angle = Math.atan2(lat - epi.lat, lon - epi.lon) + (t - 0.5) * 0.3;
            const push = 0.006 * (1 - t);
            lat += Math.cos(angle) * push;
            lon += Math.sin(angle) * push;
        }

        pts.push({
            lat: parseFloat(lat.toFixed(6)),
            lon: parseFloat(lon.toFixed(6)),
            x: parseFloat(lon.toFixed(6)),
            y: parseFloat(lat.toFixed(6)),
            z: 0, // fetchWaypointElevations ile doldurulacak
            label: i === 0 ? 'BAŞLANGIÇ' : (i === n ? 'TOPLANMA' : `WP-${String(i).padStart(2,'0')}`),
        });
    }
    return pts;
}

// ─────────────────────────────────────────────────────────────
// RENDER DÖNGÜSÜ
// ─────────────────────────────────────────────────────────────
function startRenderLoop() {
    function loop() {
        drawFrame();
        animFrame = requestAnimationFrame(loop);
    }
    loop();
}

function drawFrame() {
    const W = overlay.width, H = overlay.height;
    octx.clearRect(0, 0, W, H);
    if (!map) return;

    // Sarsıntı efekti (canvas transform — sadece şok dalgasını etkiler)
    const shaking = Date.now() < shakeUntil;
    if (shaking) {
        const rem = (shakeUntil - Date.now()) / 2000;
        octx.save();
        octx.translate(
            (Math.random() - 0.5) * rem * 14,
            (Math.random() - 0.5) * rem * 14
        );
    }

    // Canvas'ta SADECE şok dalgası (animasyonlu, kısa süreli)
    drawShockwaves();

    if (shaking) octx.restore();

    // Rota animasyonu — canvas üzerinde çiz (hızlı, anlık)
    if (routeWaypoints.length > 0 && isAnimatingRoute) {
        routeProgress += routeAnimSpeed ?? 0.6;
        if (routeProgress >= routeWaypoints.length) {
            routeProgress = routeWaypoints.length;
            isAnimatingRoute = false;
            // Animasyon bitti → kalıcı SVG rotayı Leaflet layer'a çiz (drift yok)
            updateRouteLayer(true);
        } else {
            // Animasyon devam ediyor → canvas'ta çiz (hızlı, kısa süreli drift kabul)
            drawRoute();
        }
    }

    // HUD (kanvas — coğrafi konum değil, piksel bazlı, OK)
    drawHUD();
}

// ─────────────────────────────────────────────────────────────
// ÇİZİM YARDIMCILARI
// ─────────────────────────────────────────────────────────────

/** Koordinatı Leaflet'in piksel sistemine çevir */
function ll2px(lat, lon) {
    const pt = map.latLngToContainerPoint(L.latLng(lat, lon));
    return { x: pt.x, y: pt.y };
}

/** Kilometre → mevcut zoom'daki piksel sayısı */
function kmToPx(km, lat) {
    const zoom = map.getZoom();
    const metersPerPx = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom);
    return (km * 1000) / metersPerPx;
}

function drawShockwaves() {
    if (!epicenter) return;
    const now = Date.now();
    const { x: ex, y: ey } = ll2px(epicenter.lat, epicenter.lon);
    const maxPx = kmToPx(epicenter.magnitude * 6, epicenter.lat);
    const duration = 2000; // ms per wave

    shockwaves.forEach(sw => {
        if (now < sw.startTime) return;
        const elapsed = (now - sw.startTime) % (duration * 2);
        const t = Math.min(elapsed / duration, 1);
        const r = t * maxPx;
        const alpha = (1 - t) * 0.7;

        octx.beginPath();
        octx.arc(ex, ey, r, 0, Math.PI * 2);
        octx.strokeStyle = `rgba(255,50,60,${alpha})`;
        octx.lineWidth = 3 * (1 - t);
        octx.stroke();
    });
}

function drawDamageZones() {
    if (!epicenter) return;
    const { x: ex, y: ey } = ll2px(epicenter.lat, epicenter.lon);
    const maxR = epicenter.magnitude * 7; // km

    // Halkalı renk geçişi
    const zones = [
        { rFrac: 1.0, color: 'rgba(255,30,50,0.18)'  },
        { rFrac: 0.7, color: 'rgba(255,80,20,0.22)'  },
        { rFrac: 0.45,color: 'rgba(255,150,30,0.25)' },
        { rFrac: 0.25,color: 'rgba(255,220,50,0.20)' },
    ];

    zones.forEach(z => {
        const r = kmToPx(maxR * z.rFrac, epicenter.lat);
        octx.beginPath();
        octx.arc(ex, ey, r, 0, Math.PI * 2);
        octx.fillStyle = z.color;
        octx.fill();
    });

    // Kenarlık
    const r = kmToPx(maxR, epicenter.lat);
    octx.beginPath();
    octx.arc(ex, ey, r, 0, Math.PI * 2);
    octx.strokeStyle = 'rgba(255,50,50,0.5)';
    octx.lineWidth = 1.5;
    octx.setLineDash([6, 4]);
    octx.stroke();
    octx.setLineDash([]);
}

function drawAssemblyPoints() {
    const now = Date.now();
    const iconSize = 14;

    assemblyPoints.forEach(ap => {
        const { x, y } = ll2px(ap.lat, ap.lon);
        const dmg = ap.damage || 0;
        const isSelected = selectedAP && selectedAP.id === ap.id;

        const color = isSelected
            ? '#00ff88'
            : dmg > 0.6 ? '#ef4444'
            : dmg > 0.3 ? '#f59e0b'
            : '#00cc66';

        // Seçiliyse animasyonlu halo
        if (isSelected) {
            const pulse = 0.5 + 0.5 * Math.sin(now / 280);
            octx.beginPath();
            octx.arc(x, y, iconSize + 10 + pulse * 6, 0, Math.PI * 2);
            octx.strokeStyle = `rgba(0,255,136,${0.35 + pulse * 0.35})`;
            octx.lineWidth = 2;
            octx.stroke();
        }

        // Dış halo
        octx.beginPath();
        octx.arc(x, y, iconSize + 4, 0, Math.PI * 2);
        octx.fillStyle = isSelected ? 'rgba(0,255,136,0.18)' : (dmg < 0.3 ? 'rgba(0,200,80,0.15)' : 'rgba(239,68,68,0.18)');
        octx.fill();

        // İç daire
        octx.beginPath();
        octx.arc(x, y, iconSize, 0, Math.PI * 2);
        octx.fillStyle = color;
        octx.fill();

        // ID
        octx.font = `bold 11px "JetBrains Mono"`;
        octx.textAlign = 'center';
        octx.textBaseline = 'middle';
        octx.fillStyle = '#0a0f1e';
        octx.fillText(ap.id, x, y);

        // Etiket
        octx.font = '10px "JetBrains Mono"';
        octx.fillStyle = color;
        octx.fillText(ap.name.split(/[ ,]/)[0], x, y + iconSize + 9);
    });
}

function drawUserMarker() {
    const { x, y } = ll2px(userLat, userLon);
    const now = Date.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 450);

    octx.beginPath();
    octx.arc(x, y, 14 + pulse * 5, 0, Math.PI * 2);
    octx.strokeStyle = `rgba(0,170,255,${0.3 + pulse * 0.3})`;
    octx.lineWidth = 1.5;
    octx.stroke();

    octx.beginPath();
    octx.arc(x, y, 9, 0, Math.PI * 2);
    octx.fillStyle = '#0099ee';
    octx.shadowColor = '#00aaff';
    octx.shadowBlur = 14;
    octx.fill();
    octx.shadowBlur = 0;

    octx.font = '11px Inter';
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillStyle = '#fff';
    octx.fillText('📍', x, y);
}

// ─────────────────────────────────────────────────────────────
// LEAFLET KATMAN GÜNCELLEYİCİLER
// Zoom / pan'de haritayla birlikte doğru hareket eder.
// ─────────────────────────────────────────────────────────────

function updateDamageLayer() {
    if (!damageLayer) return;
    damageLayer.clearLayers();
    if (!epicenter || phase < PHASE.DAMAGE) return;
    const maxR = epicenter.magnitude * 7 * 1000; // metre
    [
        { f: 1.00, c: '#ff1e32', o: 0.18 },
        { f: 0.70, c: '#ff5014', o: 0.22 },
        { f: 0.45, c: '#ff9600', o: 0.25 },
        { f: 0.25, c: '#ffdc32', o: 0.20 },
    ].forEach(z => L.circle([epicenter.lat, epicenter.lon], {
        radius: maxR * z.f, fillColor: z.c, fillOpacity: z.o,
        color: 'transparent', weight: 0, interactive: false,
    }).addTo(damageLayer));
    // Dış çerçeve
    L.circle([epicenter.lat, epicenter.lon], {
        radius: maxR, fillOpacity: 0,
        color: 'rgba(255,50,50,0.5)', weight: 1.5,
        dashArray: '6 4', interactive: false,
    }).addTo(damageLayer);
}

function updateAPLayer() {
    if (!apLayer) return;
    apLayer.clearLayers();
    assemblyPoints.forEach(ap => {
        const dmg = ap.damage || 0;
        const isSel = selectedAP && selectedAP.id === ap.id;
        const col = isSel ? '#00ff88'
            : dmg > 0.6 ? '#ef4444'
            : dmg > 0.3 ? '#f59e0b'
            : '#00cc66';
        const shortName = ap.name.split(/[ ,]/)[0];
        const icon = L.divIcon({
            html: `<div class="l-ap-dot${isSel ? ' sel' : ''}" style="background:${col};">
                       <span>${ap.id}</span>
                   </div>
                   <div class="l-ap-lbl" style="color:${col};">${shortName}</div>`,
            className: 'l-ap-wrap',
            iconSize:   [28, 28],
            iconAnchor: [14, 14],
        });
        L.marker([ap.lat, ap.lon], { icon })
            .bindTooltip(
                `<strong>${ap.name}</strong><br>Kapasite: ${ap.capacity}<br>` +
                `Hasar: ${(dmg * 100).toFixed(0)}% · Z: ${ap.z}m`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .on('click', () => { selectedAP = ap; updateAPLayer(); updateAPTable(); })
            .addTo(apLayer);
    });
}

function updateEpicenterLayer() {
    if (!epicenterLayer) return;
    epicenterLayer.clearLayers();
    if (!epicenter || phase < PHASE.QUAKE) return;
    const icon = L.divIcon({
        html: `<div class="l-epi-dot">☄</div>
               <div class="l-epi-mag">M${epicenter.magnitude.toFixed(1)}</div>`,
        className: 'l-epi-wrap',
        iconSize:   [32, 32],
        iconAnchor: [16, 16],
    });
    L.marker([epicenter.lat, epicenter.lon], { icon, interactive: false })
        .addTo(epicenterLayer);
}

function updateUserLayer() {
    if (!userLayer) return;
    userLayer.clearLayers();
    const icon = L.divIcon({
        html: `<div class="l-user-ring"></div><div class="l-user-dot"></div>`,
        className: 'l-user-wrap',
        iconSize:   [24, 24],
        iconAnchor: [12, 12],
    });
    L.marker([userLat, userLon], { icon, interactive: false }).addTo(userLayer);
}

/** Rota animasyonu bittikten sonra tamamlanmış rotayı Leaflet polyline olarak çizer */
function updateRouteLayer(withLabels = false) {
    if (!routeLineLayer) return;
    routeLineLayer.clearLayers();
    const limit = Math.floor(routeProgress);
    if (limit < 2) return;

    // Renk gruplarına göre segmentler oluştur
    const groups = { safe: [], medium: [], high: [] };
    let curSeg = null, curKey = null;

    for (let i = 0; i < limit; i++) {
        const wp  = routeWaypoints[i];
        const pt  = [wp.lat, wp.lon];
        const key = wp.danger === 'high' ? 'high' : wp.danger === 'medium' ? 'medium' : 'safe';
        if (key !== curKey) {
            if (curSeg && curSeg.length > 1) { curSeg.push(pt); groups[curKey].push(curSeg); }
            curSeg = [pt]; curKey = key;
        } else { curSeg.push(pt); }
    }
    if (curSeg && curSeg.length > 1) groups[curKey].push(curSeg);

    const palette = { safe: '#00d4ff', medium: '#ff9f0a', high: '#ff3b5c' };
    ['safe', 'medium', 'high'].forEach(k => {
        if (!groups[k].length) return;
        // Glow (kalın, saydam)
        L.polyline(groups[k], { color: palette[k], weight: 8,   opacity: 0.22, interactive: false }).addTo(routeLineLayer);
        // Ana çizgi
        L.polyline(groups[k], { color: palette[k], weight: 2.5, opacity: 0.95, interactive: false }).addTo(routeLineLayer);
    });

    // Animasyon başı (animasyon sırasında çağrıldıysa)
    if (isAnimatingRoute && limit > 0) {
        const head = routeWaypoints[limit - 1];
        L.circleMarker([head.lat, head.lon], {
            radius: 6, fillColor: '#fff', color: '#00d4ff',
            weight: 2, fillOpacity: 1, interactive: false,
        }).addTo(routeLineLayer);
    }

    // Waypoint etiketleri (sadece animasyon bitince)
    if (withLabels) {
        const step = Math.max(1, Math.floor(routeWaypoints.length / 6));
        routeWaypoints.forEach((wp, i) => {
            const isEnd = i === 0 || i === routeWaypoints.length - 1;
            if (!isEnd && i % step !== 0) return;
            const cx = (wp.x ?? wp.lon).toFixed(4);
            const cy = (wp.y ?? wp.lat).toFixed(4);
            const coordTxt = `X${cx}° Y${cy}° Z${wp.z}m`;
            const icon = L.divIcon({
                html: `<div class="l-wp-box${isEnd ? ' end' : ''}">
                           <div class="l-wp-name">${wp.label || `WP${i}`}</div>
                           <div class="l-wp-coord">${coordTxt}</div>
                       </div>`,
                className: 'l-wp-wrap',
                iconSize:   null,
                iconAnchor: [0, 30],
            });
            L.marker([wp.lat, wp.lon], { icon, interactive: false }).addTo(routeLineLayer);
        });
    }
}

function clearAllLayers() {
    damageLayer?.clearLayers();
    apLayer?.clearLayers();
    epicenterLayer?.clearLayers();
    routeLineLayer?.clearLayers();
    apRoutesLayer?.clearLayers();
    routeLabelsLayer?.clearLayers();
    afadRouteLayer?.clearLayers();
    hospitalRouteLayer?.clearLayers();
    // Bug #22 fix: Clear earthquake markers on reset
    earthquakeLayer?.clearLayers();
    // Bug #14 fix: Clear RAG markers on reset
    afadLayer?.clearLayers();
    hospitalLayer?.clearLayers();
    if (routeLines) {
        ['highG','high','medG','med','safeG','safe'].forEach(k => routeLines[k].setLatLngs([]));
        if (map?.hasLayer(routeLines.head)) routeLines.head.remove();
    }
    routeLabelsAdded = false;
    // Bug #9 fix: Abort any in-flight AP route fetches
    if (apRouteAbort) { apRouteAbort.abort(); apRouteAbort = null; }
}

// ─────────────────────────────────────────────────────────────
// (Eski canvas çizimleri — yalnızca drawShockwaves + drawHUD aktif)
// ─────────────────────────────────────────────────────────────

function drawEpicenter() {
    const { x, y } = ll2px(epicenter.lat, epicenter.lon);
    const now = Date.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);

    octx.beginPath();
    octx.arc(x, y, 11 + pulse * 5, 0, Math.PI * 2);
    octx.strokeStyle = `rgba(255,30,60,${0.6 + pulse * 0.35})`;
    octx.lineWidth = 2;
    octx.stroke();

    octx.beginPath();
    octx.arc(x, y, 9, 0, Math.PI * 2);
    octx.fillStyle = '#ff1e3c';
    octx.shadowColor = '#ff1e3c';
    octx.shadowBlur = 18;
    octx.fill();
    octx.shadowBlur = 0;

    octx.font = 'bold 10px Inter';
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillStyle = '#fff';
    octx.fillText('☄', x, y);

    octx.font = 'bold 10px "JetBrains Mono"';
    octx.fillStyle = '#ff6b6b';
    octx.fillText(`M${epicenter.magnitude.toFixed(1)}`, x, y + 20);
}

function drawRoute() {
    const limit = Math.floor(routeProgress);
    if (limit < 2) return;

    // danger seviyesine göre renk
    function segmentColor(danger) {
        if (danger === 'high')   return { base: '#ff3b5c', glow: '#ff3b5c' };
        if (danger === 'medium') return { base: '#ff9f0a', glow: '#ff9f0a' };
        return                           { base: '#00d4ff', glow: '#00d4ff' };
    }

    // Segmentleri grup grupla aynı renkte birleştir — her renk değişiminde yeni path
    octx.lineCap  = 'round';
    octx.lineJoin = 'round';

    for (let pass = 0; pass < 2; pass++) {
        // pass 0 → glow (kalın, yarı saydam), pass 1 → ana çizgi
        let groupStart = 0;
        let currentDanger = routeWaypoints[0].danger;

        const flushSegment = (end) => {
            if (end <= groupStart) return;
            const { base, glow } = segmentColor(currentDanger);
            if (pass === 0) {
                octx.lineWidth   = 7;
                octx.shadowBlur  = 18;
                octx.shadowColor = glow;
                octx.strokeStyle = glow.replace(')', ',0.35)').replace('rgb', 'rgba');
                // rgba renk için hex → rgba dönüşümü
                octx.strokeStyle = hexToRgba(glow, 0.35);
            } else {
                octx.lineWidth   = 2.5;
                octx.shadowBlur  = 0;
                octx.strokeStyle = base;
            }
            octx.beginPath();
            const p0 = ll2px(routeWaypoints[groupStart].lat, routeWaypoints[groupStart].lon);
            octx.moveTo(p0.x, p0.y);
            for (let k = groupStart + 1; k <= end; k++) {
                const { x, y } = ll2px(routeWaypoints[k].lat, routeWaypoints[k].lon);
                octx.lineTo(x, y);
            }
            octx.stroke();
            octx.shadowBlur = 0;
        };

        for (let i = 1; i < limit; i++) {
            const d = routeWaypoints[i].danger;
            if (d !== currentDanger) {
                flushSegment(i - 1);
                groupStart   = i - 1; // overlap: son nokta yeni grubun başlangıcı
                currentDanger = d;
            }
        }
        flushSegment(limit - 1);
    }

    // Waypoint noktaları — danger renginde
    for (let i = 0; i < limit; i++) {
        const { x, y } = ll2px(routeWaypoints[i].lat, routeWaypoints[i].lon);
        const { base } = segmentColor(routeWaypoints[i].danger);
        octx.beginPath();
        octx.arc(x, y, 2.5, 0, Math.PI * 2);
        octx.fillStyle = base;
        octx.fill();
    }

    // Animasyonlu baş
    if (isAnimatingRoute && limit > 0 && limit < routeWaypoints.length) {
        const head = routeWaypoints[limit - 1];
        const { x, y } = ll2px(head.lat, head.lon);
        const { glow } = segmentColor(head.danger);
        octx.beginPath();
        octx.arc(x, y, 5.5, 0, Math.PI * 2);
        octx.fillStyle = '#fff';
        octx.shadowColor = glow;
        octx.shadowBlur  = 22;
        octx.fill();
        octx.shadowBlur = 0;
    }
}

function hexToRgba(hex, alpha) {
    // '#rrggbb' → 'rgba(r,g,b,a)'
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function drawWaypointLabels() {
    if (!routeWaypoints.length) return;

    routeWaypoints.forEach((wp, i) => {
        if (i % 2 !== 0 && i !== 0 && i !== routeWaypoints.length - 1) return; // seyreltme
        const { x, y } = ll2px(wp.lat, wp.lon);
        const isEnd = i === 0 || i === routeWaypoints.length - 1;

        const label    = wp.label;
        const coordTxt = `X${wp.x?.toFixed(4) ?? wp.lon?.toFixed(4)}° Y${wp.y?.toFixed(4) ?? wp.lat?.toFixed(4)}° Z${wp.z}m`;

        octx.font = 'bold 9px "JetBrains Mono"';
        const boxW = Math.max(label.length * 6 + 12, coordTxt.length * 5.5 + 12);
        const boxH = 28;
        const bx = x - boxW / 2;
        const by = y - boxH - 16;

        octx.fillStyle = 'rgba(6,8,26,0.9)';
        octx.beginPath();
        octx.roundRect(bx, by, boxW, boxH, 4);
        octx.fill();
        octx.strokeStyle = isEnd ? '#00ff88' : 'rgba(0,212,255,0.4)';
        octx.lineWidth = 0.8;
        octx.stroke();

        octx.textAlign = 'center'; octx.textBaseline = 'top';
        octx.fillStyle = isEnd ? '#00ff88' : '#00d4ff';
        octx.fillText(label, x, by + 3);

        octx.font = '8px "JetBrains Mono"';
        octx.fillStyle = '#8892b0';
        octx.fillText(coordTxt, x, by + 14);

        // Bağlantı çizgisi
        octx.beginPath();
        octx.moveTo(x, by + boxH); octx.lineTo(x, y - 4);
        octx.strokeStyle = isEnd ? 'rgba(0,255,136,0.35)' : 'rgba(0,212,255,0.3)';
        octx.lineWidth = 0.6;
        octx.stroke();
    });
}

function drawHUD() {
    const W = overlay.width;
    const hudH = 36;
    const hudW = Math.min(380, W - 20);
    const hx = W / 2 - hudW / 2;
    const hy = overlay.height - hudH - 50; // alt kontrol çubuğunun üstü

    octx.fillStyle = 'rgba(6,8,26,0.82)';
    octx.beginPath();
    octx.roundRect(hx, hy, hudW, hudH, 8);
    octx.fill();
    octx.strokeStyle = 'rgba(0,212,255,0.2)';
    octx.lineWidth = 1;
    octx.stroke();

    octx.font = 'bold 10px "JetBrains Mono"';
    octx.textAlign = 'left'; octx.textBaseline = 'middle';

    if (phase === PHASE.IDLE) {
        octx.fillStyle = '#8892b0';
        octx.fillText('🛰️  Mahalle aratın / haritaya tıklayın → epimerkez seçin', hx + 12, hy + hudH / 2);
    } else if (phase === PHASE.QUAKE) {
        octx.fillStyle = '#ff3b5c';
        octx.fillText(`☄  M${epicenter?.magnitude.toFixed(1)} depremi simüle ediliyor...`, hx + 12, hy + hudH / 2);
    } else if (phase === PHASE.DAMAGE) {
        const n = assemblyPoints.filter(ap => ap.damage > 0.5).length;
        octx.fillStyle = '#f59e0b';
        octx.fillText(`⚠  ${n} AP hasar bölgesinde — "AI Analizi" butonuna basın`, hx + 12, hy + hudH / 2);
    } else if (phase === PHASE.ANALYSIS) {
        octx.fillStyle = '#00d4ff';
        octx.fillText('⏳  Qwen2.5-VL analizi devam ediyor...', hx + 12, hy + hudH / 2);
    } else if (phase === PHASE.RESULT && selectedAP) {
        octx.fillStyle = '#00ff88';
        octx.fillText(`✅  ${selectedAP.name} — ${routeWaypoints.length} WP — gerçek Z verisi`, hx + 12, hy + hudH / 2);
    }
}

// ─────────────────────────────────────────────────────────────
// UI PANEL GÜNCELLEMELERİ
// ─────────────────────────────────────────────────────────────
function setStatus(msg) {
    const el = document.getElementById('simStatus');
    if (el) el.textContent = msg;
}

function updateAPTable() {
    const tbody = document.getElementById('apTableBody');
    if (!tbody) return;
    if (assemblyPoints.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-3 small">OSM verisi yükleniyor...</td></tr>';
        return;
    }
    tbody.innerHTML = assemblyPoints.map(ap => {
        const d = ap.damage || 0;
        const pct = (d * 100).toFixed(0);
        const cls = d > 0.6 ? 'danger' : d > 0.3 ? 'warning' : 'success';
        const isSelected = selectedAP && selectedAP.id === ap.id;
        return `<tr style="${isSelected ? 'background:rgba(0,255,136,0.06)' : ''}">
            <td class="font-monospace" style="color:var(--color-primary);">AP-0${ap.id}</td>
            <td>${isSelected ? '<i class="fa-solid fa-circle-check text-success me-1"></i>' : ''}${ap.name}</td>
            <td class="text-center"><span class="badge bg-${cls}" style="font-size:0.7rem;">%${pct}</span></td>
            <td class="text-muted-custom">${ap.capacity >= 1000 ? (ap.capacity/1000).toFixed(1)+'K' : ap.capacity}</td>
        </tr>`;
    }).join('');
    updateAPLayer(); // Harita üzerindeki işaretleri de güncelle
}

function renderAIPanel(result, osrmOk) {
    const panel = document.getElementById('aiResultPanel');
    if (panel) panel.classList.remove('d-none');
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
    set('aiModelBadge',  result.model);
    set('aiReason',      result.reason);
    set('aiRisk',        result.risk_assessment);
    set('aiRouteNotes',  result.route_notes);
    set('aiAFADGuidance', result.afad_guidance);
    set('aiHospitalNote', result.hospital_note);

    // Rota kaynağını göster
    const routeSrcEl = document.getElementById('aiRouteSrc');
    if (routeSrcEl) {
        routeSrcEl.textContent = osrmOk ? '🛣 OSRM (gerçek yollar)' : '📐 Düz çizgi (fallback)';
        routeSrcEl.className   = osrmOk ? 'badge bg-success bg-opacity-20 text-success' : 'badge bg-secondary bg-opacity-20 text-secondary';
    }

    updateAPTable(); // seçilen AP'yi vurgula
}

function renderWaypointTable(waypoints) {
    const tbody = document.getElementById('waypointTableBody');
    if (!tbody) return;
    tbody.innerHTML = waypoints.map(wp => `
        <tr>
            <td style="color:${wp.label === 'BAŞLANGIÇ' || wp.label === 'TOPLANMA' ? 'var(--color-success)' : 'var(--color-primary)'}">
                ${wp.label}
            </td>
            <td>${(wp.x ?? wp.lon)?.toFixed(6)}</td>
            <td>${(wp.y ?? wp.lat)?.toFixed(6)}</td>
            <td style="color:var(--color-accent);">${wp.z}m</td>
        </tr>`).join('');
}

function checkServerStatus() {
    const badge = document.getElementById('serverStatusBadge');
    if (!badge) return;
    fetch('http://localhost:5050/api/status', { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then(d => {
            if (d.mlx_available) {
                const short = d.model?.split('/').pop() ?? 'Model aktif';
                badge.textContent = `● ${short}`;
                badge.className = 'badge bg-success font-monospace';
                badge.style.fontSize = '0.7rem';
            } else if (d.mlx_installed) {
                badge.textContent = '● Model seçilmedi';
                badge.className = 'badge bg-warning text-dark font-monospace';
                badge.style.fontSize = '0.7rem';
            } else {
                badge.textContent = '● JS fallback';
                badge.className = 'badge bg-secondary font-monospace';
                badge.style.fontSize = '0.7rem';
            }
            // Navbar model adını güncelle
            const nav = document.getElementById('navModelName');
            if (nav) nav.textContent = d.model ? d.model.split('/').pop() : 'Model Seç';
        })
        .catch(() => {
            badge.textContent = '● Sunucu kapalı';
            badge.className = 'badge bg-secondary font-monospace';
            badge.style.fontSize = '0.7rem';
        });
}

// ─────────────────────────────────────────────────────────────
// MODEL SEÇİCİ
// ─────────────────────────────────────────────────────────────
function initModelSelector() {
    const btnCustom  = document.getElementById('btnLoadCustom');
    const btnUnload  = document.getElementById('btnUnloadModel');
    const customInp  = document.getElementById('customModelInput');

    // Modal açıldığında model listesini yükle
    const modal = document.getElementById('modelModal');
    if (modal) {
        modal.addEventListener('show.bs.modal', refreshModelModal);
    }

    if (btnCustom) {
        btnCustom.addEventListener('click', () => {
            const path = customInp?.value?.trim();
            if (path) loadModel(path);
        });
    }
    if (customInp) {
        customInp.addEventListener('keydown', e => {
            if (e.key === 'Enter') { const p = customInp.value.trim(); if (p) loadModel(p); }
        });
    }
    if (btnUnload) {
        btnUnload.addEventListener('click', unloadModel);
    }
}

async function refreshModelModal() {
    setModalStatus('loading', 'Sunucu durumu kontrol ediliyor...');
    try {
        const [statusResp, modelsResp] = await Promise.all([
            fetch('http://localhost:5050/api/status', { signal: AbortSignal.timeout(4000) }),
            fetch('http://localhost:5050/api/models',  { signal: AbortSignal.timeout(4000) }),
        ]);
        const status = await statusResp.json();
        const data   = await modelsResp.json();

        if (!status.mlx_installed) {
            setModalStatus('warn', 'mlx-vlm kurulu değil — pip install mlx-vlm (Apple Silicon gerekli)');
        } else if (status.mlx_available) {
            setModalStatus('ok', `Aktif: ${status.model}`);
        } else {
            setModalStatus('idle', 'mlx-vlm kurulu — bir model seçin');
        }

        renderModelList(data.local || [], data.suggested || [], status.model);
        updateLoadedModelInfo(status.model);

    } catch {
        setModalStatus('error', 'Sunucu kapalı — python server.py çalıştırın');
        renderModelList([], [], null);
    }
}

function renderModelList(localModels, suggestedModels, currentModel) {
    const container = document.getElementById('modelList');
    if (!container) return;

    const speedColor = { 'Hızlı': '#00ff88', 'Orta': '#f59e0b', 'Yavaş': '#ef4444' };

    function makeCard(m) {
        const isActive = m.id === currentModel;
        const localBadge = m.local
            ? `<span class="model-badge" style="background:rgba(0,255,136,0.15);color:#00ff88;">💾 Yerel</span>`
            : '';
        return `
        <div class="col-md-6">
            <div class="model-card ${isActive ? 'active' : ''}" onclick="loadModel('${m.id}')">
                <div class="d-flex justify-content-between align-items-start mb-1">
                    <span class="model-name">${m.name}</span>
                    <div class="d-flex gap-1 flex-wrap">
                        ${isActive ? '<span class="model-badge bg-success bg-opacity-20 text-success">Aktif</span>' : ''}
                        ${localBadge}
                        ${m.speed !== '—' ? `<span class="model-badge" style="background:rgba(0,0,0,0.3);color:${speedColor[m.speed] || '#8892b0'};">${m.speed}</span>` : ''}
                    </div>
                </div>
                <div class="model-id mb-1">${m.id}</div>
                <div class="d-flex justify-content-between model-meta">
                    <span>${m.notes}</span>
                    <span style="color:var(--color-accent);">${m.size}</span>
                </div>
            </div>
        </div>`;
    }

    let html = '';

    if (localModels.length > 0) {
        html += `<div class="col-12 mb-1">
            <div style="font-size:0.72rem;font-weight:700;color:#00ff88;letter-spacing:1px;">
                <i class="fa-solid fa-hard-drive me-1"></i>YEREL MODELLER (indirme gerekmez)
            </div>
        </div>`;
        html += localModels.map(makeCard).join('');
    }

    if (suggestedModels.length > 0) {
        html += `<div class="col-12 mb-1 ${localModels.length > 0 ? 'mt-3' : ''}">
            <div style="font-size:0.72rem;font-weight:700;color:#8892b0;letter-spacing:1px;">
                <i class="fa-solid fa-cloud-arrow-down me-1"></i>İNDİRİLEBİLİR MODELLER
            </div>
        </div>`;
        html += suggestedModels.map(makeCard).join('');
    }

    if (!html) {
        html = '<div class="col-12 text-muted small text-center py-2">Model listesi alınamadı.</div>';
    }

    container.innerHTML = html;
}

async function loadModel(modelPath) {
    setModalStatus('loading', `Yükleniyor: ${modelPath} ...`);

    // Yükleniyor animasyonu — ilgili karta da ekle
    document.querySelectorAll('.model-card').forEach(el => {
        el.classList.remove('active');
        if (el.innerHTML.includes(modelPath)) el.classList.add('loading');
    });

    try {
        const resp = await fetch('http://localhost:5050/api/load-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelPath }),
            signal: AbortSignal.timeout(300000), // 5 dk — büyük modeller uzun sürer
        });
        const data = await resp.json();

        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

        setModalStatus('ok', `✓ Model hazır: ${data.model}`);
        updateLoadedModelInfo(data.model);
        await refreshModelModal();  // listeyi yenile
        checkServerStatus();         // navbar badge'i güncelle

    } catch (err) {
        setModalStatus('error', `Hata: ${err.message}`);
        document.querySelectorAll('.model-card').forEach(el => el.classList.remove('loading'));
    }
}

async function unloadModel() {
    try {
        await fetch('http://localhost:5050/api/unload-model', {
            method: 'POST', signal: AbortSignal.timeout(5000)
        });
        updateLoadedModelInfo(null);
        await refreshModelModal();
        checkServerStatus();
    } catch (err) {
        setModalStatus('error', `Kaldırılamadı: ${err.message}`);
    }
}

function setModalStatus(type, msg) {
    const bar  = document.getElementById('modelStatusBar');
    const icon = document.getElementById('modelStatusIcon');
    const text = document.getElementById('modelStatusText');
    if (!bar || !icon || !text) return;

    text.textContent = msg;
    icon.className = '';

    const cfg = {
        loading: { bg: 'rgba(0,212,255,0.06)', border: 'rgba(0,212,255,0.2)',  icon: 'fa-solid fa-circle-notch fa-spin text-info' },
        ok:      { bg: 'rgba(0,255,136,0.06)', border: 'rgba(0,255,136,0.2)',  icon: 'fa-solid fa-check-circle text-success' },
        warn:    { bg: 'rgba(255,200,50,0.06)',border: 'rgba(255,200,50,0.2)', icon: 'fa-solid fa-triangle-exclamation text-warning' },
        error:   { bg: 'rgba(255,59,92,0.06)', border: 'rgba(255,59,92,0.2)',  icon: 'fa-solid fa-xmark-circle text-danger' },
        idle:    { bg: 'rgba(0,0,0,0.2)',       border: 'var(--color-border)',  icon: 'fa-solid fa-circle-info text-muted' },
    };
    const c = cfg[type] || cfg.idle;
    bar.style.background = c.bg;
    bar.style.border     = `1px solid ${c.border}`;
    icon.className       = c.icon;
}

function updateLoadedModelInfo(modelId) {
    const box    = document.getElementById('loadedModelInfo');
    const idSpan = document.getElementById('loadedModelId');
    if (!box || !idSpan) return;
    if (modelId) {
        box.classList.remove('d-none');
        idSpan.textContent = modelId;
    } else {
        box.classList.add('d-none');
    }
}

function fullReset(_resetMap = true) {
    phase = PHASE.IDLE;
    epicenter = null;
    shockwaves = [];
    shakeUntil = 0;
    selectedAP = null;
    aiResult = null;
    routeWaypoints = [];
    routeProgress = 0;
    isAnimatingRoute = false;
    assemblyPoints.forEach(ap => ap.damage = 0);

    clearAllLayers();

    const panel = document.getElementById('aiResultPanel');
    if (panel) panel.classList.add('d-none');
    const tbody = document.getElementById('waypointTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-3 small">AI analizi tamamlandıktan sonra görünür.</td></tr>';

    updateAPTable(); // updateAPLayer içinde çağrılır
    setStatus('Sıfırlandı. Listeden gerçek bir deprem seçin veya haritaya tıklayın.');
}

// ─────────────────────────────────────────────────────────────
// YARDIMCI — Haversine mesafesi (km)
// ─────────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// ROTA — Canvas Renderer polyline güncelleme
// ─────────────────────────────────────────────────────────────

/** Waypoint'leri danger anahtarına göre segment dizilerine böl */
function buildRouteSegments(limit) {
    const segs = { safe: [], medium: [], high: [] };
    let curKey = null, curSeg = null;

    for (let i = 0; i < limit; i++) {
        const wp  = routeWaypoints[i];
        const pt  = [wp.lat, wp.lon];
        const key = wp.danger === 'high' ? 'high' : wp.danger === 'medium' ? 'medium' : 'safe';

        if (key !== curKey) {
            // Eski segmentin son noktasını overlap olarak ekle
            if (curSeg) { curSeg.push(pt); if (curSeg.length > 1) segs[curKey].push(curSeg); }
            curSeg = [pt];
            curKey = key;
        } else {
            if (!curSeg) curSeg = [];
            curSeg.push(pt);
        }
    }
    if (curSeg && curSeg.length > 1) segs[curKey].push(curSeg);
    return segs;
}

/** Her frame çağrılır — pre-oluşturulmuş polylineleri günceller (DOM yaratmaz) */
function refreshRoutePolylines() {
    if (!routeLines) return;
    const limit = Math.floor(routeProgress);

    if (limit < 2) {
        ['highG','high','medG','med','safeG','safe'].forEach(k => routeLines[k].setLatLngs([]));
        if (map?.hasLayer(routeLines.head)) routeLines.head.remove();
        return;
    }

    const segs = buildRouteSegments(limit);

    routeLines.highG.setLatLngs(segs.high);
    routeLines.high.setLatLngs(segs.high);
    routeLines.medG.setLatLngs(segs.medium);
    routeLines.med.setLatLngs(segs.medium);
    routeLines.safeG.setLatLngs(segs.safe);
    routeLines.safe.setLatLngs(segs.safe);

    // Animasyon başı (hareket eden top)
    if (isAnimatingRoute && limit > 0) {
        const head = routeWaypoints[Math.min(limit - 1, routeWaypoints.length - 1)];
        // Baş rengi mevcut segmentin danger'ına göre
        const hcol = head.danger === 'high' ? '#ff3b5c' : head.danger === 'medium' ? '#ff9f0a' : '#00d4ff';
        routeLines.head.setStyle({ color: hcol });
        routeLines.head.setLatLng([head.lat, head.lon]);
        if (!map.hasLayer(routeLines.head)) routeLines.head.addTo(map);
    } else {
        if (map?.hasLayer(routeLines.head)) routeLines.head.remove();
    }
}

/** Animasyon bittikten sonra bir kez çağrılır — waypoint etiketleri SVG katmanına eklenir */
function refreshRouteLabels() {
    if (!routeLabelsLayer) return;
    routeLabelsLayer.clearLayers();
    const n = routeWaypoints.length;
    if (n < 2) return;
    const step = Math.max(1, Math.floor(n / 5));

    routeWaypoints.forEach((wp, i) => {
        const isEnd = i === 0 || i === n - 1;
        if (!isEnd && i % step !== 0) return;
        const cx = (wp.x ?? wp.lon).toFixed(4);
        const cy = (wp.y ?? wp.lat).toFixed(4);
        const icon = L.divIcon({
            html: `<div class="l-wp-box${isEnd ? ' end' : ''}">
                       <div class="l-wp-name">${wp.label || `WP${i}`}</div>
                       <div class="l-wp-coord">X${cx}° Y${cy}° Z${wp.z}m</div>
                   </div>`,
            className: 'l-wp-wrap',
            iconSize:   null,
            iconAnchor: [0, 30],
        });
        L.marker([wp.lat, wp.lon], { icon, interactive: false }).addTo(routeLabelsLayer);
    });
}

// Toplanma alanı rotaları için ayırt edici renk paleti (hasar bölgesi olmasa bile farklı renkler)
const AP_ROUTE_COLORS = [
    '#00d4ff', // cyan
    '#00ff88', // yeşil
    '#a78bfa', // mor
    '#fbbf24', // sarı
    '#34d399', // zümrüt
    '#60a5fa', // mavi
    '#f472b6', // pembe
    '#fb923c', // turuncu
];

/** Tüm toplanma alanlarına kullanıcı konumundan gerçek yol rotaları çizer */
async function showAllAPRoutes() {
    if (!apRoutesLayer) return;
    apRoutesLayer.clearLayers();

    const cr = L.canvas({ padding: 0.5 });
    // selectedAP varsa o hariç (ana rota zaten çiziliyor), yoksa hepsi
    const targets = assemblyPoints.filter(ap =>
        (!selectedAP || ap.id !== selectedAP.id) && ap.damage < 0.9
    );

    // Sıralı OSRM istekleri (paralel gönderilirse rate limit riski)
    for (let idx = 0; idx < targets.length; idx++) {
        const ap = targets[idx];
        try {
            const pts = await fetchOSRMRoute(userLat, userLon, ap.lat, ap.lon);
            if (!pts || pts.length < 2) continue;
            const latlngs = pts.map(p => [p.lat, p.lon]);

            // Hasar yüksekse kırmızı, aksi halde AP'ye özgü renk
            const col   = ap.damage > 0.5 ? '#ef4444'
                        : ap.damage > 0.3 ? '#f59e0b'
                        : AP_ROUTE_COLORS[idx % AP_ROUTE_COLORS.length];
            const alpha = selectedAP ? 0.45 : 0.75;

            // Glow efekti
            L.polyline(latlngs, {
                renderer: cr, color: col, weight: 8, opacity: 0.13,
                dashArray: null, interactive: false,
            }).addTo(apRoutesLayer);
            // Ana çizgi
            L.polyline(latlngs, {
                renderer: cr, color: col, weight: 2.5, opacity: alpha,
                dashArray: '6 5', interactive: false,
            }).addTo(apRoutesLayer);
            // Varış noktası marker
            L.circleMarker([ap.lat, ap.lon], {
                renderer: cr, radius: 7,
                fillColor: col, color: '#fff',
                weight: 2, fillOpacity: 0.95,
                interactive: true,
            })
            .bindTooltip(
                `<strong>${ap.name}</strong><br>Kapasite: ${ap.capacity?.toLocaleString() || '?'}`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .addTo(apRoutesLayer);
        } catch { /* routing ulaşılamadı — atla */ }
    }
}

// ─────────────────────────────────────────────────────────────
// RAG — AFAD İSTASYONLARI + HASTANELER (MongoDB / Overpass)
// ─────────────────────────────────────────────────────────────

/** Backend'den RAG verisini çek, katmanları güncelle */
async function fetchAndApplyRAG(lat, lon) {
    try {
        const resp = await fetch('http://localhost:5050/api/rag-context', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ lat, lon }),
            signal:  AbortSignal.timeout(35000),
        });
        if (!resp.ok) return;
        ragData = await resp.json();
        updateAFADLayer(ragData.afad_stations || []);
        updateHospitalLayer(ragData.hospitals || []);
        updateRAGPanel(ragData);
        console.log('[RAG]', ragData.afad_stations?.length, 'AFAD,',
                    ragData.hospitals?.length, 'hastane yüklendi');
    } catch (err) {
        console.warn('[RAG] Sunucu kapalı — statik veri yükleniyor:', err.message);
        // Backend yokken statik AFAD + hastane verisi ile devam et
        const clat = centerLat || userLat;
        const clon = centerLon || userLon;
        const staticData = getStaticDataForArea(clat, clon, 80);
        if (staticData.afad_stations.length || staticData.hospitals.length) {
            ragData = {
                afad_stations: staticData.afad_stations,
                hospitals:     staticData.hospitals,
                fire_stations: [],
                seeded_at:     new Date().toISOString().replace('T',' ').slice(0,19),
            };
            updateAFADLayer(ragData.afad_stations);
            updateHospitalLayer(ragData.hospitals);
            updateRAGPanel(ragData);
            console.log('[Statik RAG]', ragData.afad_stations.length, 'AFAD,', ragData.hospitals.length, 'hastane');
        }
    }
}

function updateAFADLayer(stations) {
    if (!afadLayer) return;
    afadLayer.clearLayers();
    stations.forEach(s => {
        const shortName = s.name.split(' ').slice(0, 3).join(' ');
        const icon = L.divIcon({
            html: `<div class="l-afad-dot"><i class="fa-solid fa-shield-halved"></i></div>
                   <div class="l-afad-lbl">${shortName}</div>`,
            className: 'l-afad-wrap',
            iconSize:   [28, 28],
            iconAnchor: [14, 14],
        });
        L.marker([s.lat, s.lon], { icon })
            .bindTooltip(
                `<strong>🚨 ${s.name}</strong><br>AFAD İstasyonu`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .addTo(afadLayer);
    });
}

function updateHospitalLayer(hospitals) {
    if (!hospitalLayer) return;
    hospitalLayer.clearLayers();
    hospitals.forEach(h => {
        const shortName = h.name.split(/[ ,]/)[0];
        const icon = L.divIcon({
            html: `<div class="l-hosp-dot">+</div>
                   <div class="l-hosp-lbl">${shortName}</div>`,
            className: 'l-hosp-wrap',
            iconSize:   [22, 22],
            iconAnchor: [11, 11],
        });
        L.marker([h.lat, h.lon], { icon })
            .bindTooltip(
                `<strong>🏥 ${h.name}</strong><br>Hastane`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .addTo(hospitalLayer);
    });
}

/** AFAD istasyonlarından toplanma alanlarına gerçek yol rotaları çiz */
async function drawAFADRoutes() {
    if (!afadRouteLayer || !ragData?.afad_stations?.length) return;
    afadRouteLayer.clearLayers();

    // Hedef: seçili AP varsa o, yoksa hasarsız AP'lerin tümü
    const targetAPs = selectedAP
        ? [selectedAP]
        : assemblyPoints.filter(ap => ap.damage < 0.6).slice(0, 3);

    if (targetAPs.length === 0) return;

    for (const station of ragData.afad_stations.slice(0, 5)) {
        // Her AFAD istasyonu için en yakın hedef AP'yi seç
        const target = targetAPs.reduce((best, ap) => {
            const d = haversineKm(station.lat, station.lon, ap.lat, ap.lon);
            return (!best || d < best.d) ? { ap, d } : best;
        }, null)?.ap || targetAPs[0];

        try {
            const pts = await fetchOSRMRoute(station.lat, station.lon, target.lat, target.lon);
            if (!pts || pts.length < 2) continue;
            const latlngs = pts.map(p => [p.lat, p.lon]);

            // Glow efekti
            L.polyline(latlngs, { color: '#ff7f00', weight: 9, opacity: 0.1,
                                   dashArray: null, interactive: false }).addTo(afadRouteLayer);
            // Ana çizgi
            L.polyline(latlngs, { color: '#ff7f00', weight: 2.5, opacity: 0.75,
                                   dashArray: '7 4', interactive: false })
             .bindTooltip(
                 `<strong>🚨 ${station.name}</strong> → ${target.name}`,
                 { className: 'leaflet-tooltip-dark', sticky: true }
             )
             .addTo(afadRouteLayer);

            // AFAD istasyonu marker
            L.circleMarker([station.lat, station.lon], {
                radius: 6, fillColor: '#ff7f00', color: '#fff',
                weight: 2, fillOpacity: 1, interactive: true,
            })
            .bindTooltip(
                `<strong>🚨 ${station.name}</strong><br>AFAD İstasyonu`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .addTo(afadRouteLayer);
        } catch { /* routing ulaşılamadı */ }
    }
}

/**
 * Hastanelerden en yakın toplanma alanına gerçek yol rotası çiz.
 * Renk: kırmızı/crimson (#dc143c) — AFAD turuncu, AP yeşil/sarı
 */
async function drawHospitalRoutes() {
    if (!hospitalRouteLayer || !ragData?.hospitals?.length) return;
    hospitalRouteLayer.clearLayers();

    const targetAPs = selectedAP
        ? [selectedAP]
        : assemblyPoints.filter(ap => ap.damage < 0.6).slice(0, 3);
    if (targetAPs.length === 0) return;

    const cr = L.canvas({ padding: 0.5 });

    for (const hosp of ragData.hospitals.slice(0, 5)) {
        const target = targetAPs.reduce((best, ap) => {
            const d = haversineKm(hosp.lat, hosp.lon, ap.lat, ap.lon);
            return (!best || d < best.d) ? { ap, d } : best;
        }, null)?.ap || targetAPs[0];

        try {
            const pts = await fetchOSRMRoute(hosp.lat, hosp.lon, target.lat, target.lon);
            if (!pts || pts.length < 2) continue;
            const latlngs = pts.map(p => [p.lat, p.lon]);

            // Glow
            L.polyline(latlngs, { renderer: cr, color: '#dc143c', weight: 9, opacity: 0.1,
                                   dashArray: null, interactive: false }).addTo(hospitalRouteLayer);
            // Ana çizgi
            L.polyline(latlngs, { renderer: cr, color: '#dc143c', weight: 2.5, opacity: 0.8,
                                   dashArray: '4 6', interactive: false })
             .bindTooltip(
                 `<strong>🏥 ${hosp.name}</strong> → ${target.name}`,
                 { className: 'leaflet-tooltip-dark', sticky: true }
             )
             .addTo(hospitalRouteLayer);

            // Hastane marker
            L.circleMarker([hosp.lat, hosp.lon], {
                renderer: cr, radius: 7,
                fillColor: '#dc143c', color: '#fff',
                weight: 2, fillOpacity: 1, interactive: true,
            })
            .bindTooltip(
                `<strong>🏥 ${hosp.name}</strong><br>Hastane`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .addTo(hospitalRouteLayer);
        } catch { /* routing ulaşılamadı */ }
    }
}

/** RAG panelini güncelle */
function updateRAGPanel(rag) {
    const hospEl = document.getElementById('ragHospitalList');
    const afadEl = document.getElementById('ragAFADList');
    const badge  = document.getElementById('ragStatusBadge');

    if (badge) {
        const t = rag.seeded_at ? new Date(rag.seeded_at + 'Z').toLocaleTimeString('tr-TR') : '–';
        badge.textContent = `✓ ${t}`;
        badge.className   = 'badge bg-success bg-opacity-20 text-success ms-auto font-monospace';
        badge.style.fontSize = '0.63rem';
    }

    if (hospEl) {
        const list = (rag.hospitals || []).slice(0, 5);
        hospEl.innerHTML = list.length
            ? list.map(h => `
                <div class="rag-item">
                    <span class="rag-icon">🏥</span>
                    <span class="rag-name">${h.name}</span>
                </div>`).join('')
            : '<div class="text-muted small">Hastane verisi yok</div>';
    }

    if (afadEl) {
        const list = (rag.afad_stations || []).slice(0, 4);
        afadEl.innerHTML = list.length
            ? list.map(a => `
                <div class="rag-item">
                    <span class="rag-icon">🚨</span>
                    <span class="rag-name">${a.name}</span>
                </div>`).join('')
            : '<div class="text-muted small">AFAD istasyon verisi yok</div>';
    }
}

// ─────────────────────────────────────────────────────────────
// KALP ATIŞI + ANALİZ KUYRUĞU — M4.6+ otomatik sıralı analiz
// ─────────────────────────────────────────────────────────────

function initHeartbeat() {
    const btn = document.getElementById('btnProcessNext');
    if (btn) btn.addEventListener('click', () => processNextInQueue(true));
    startHeartbeatTimer();
}

function buildAnalysisQueue() {
    const newQueue = recentQuakes
        .filter(q => q.mag >= 4.6)
        .sort((a, b) => b.mag - a.mag);  // büyüklüğe göre azalan
    // Kuyruk boyutu değiştiyse cursoru sıfırla, yoksa devam ettir
    if (newQueue.length !== analysisQueue.length) {
        queueCursor = 0;
    }
    analysisQueue = newQueue;
    updateQueueUI();
}

function startHeartbeatTimer() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatCountdown = HEARTBEAT_SEC;
    heartbeatTimer = setInterval(() => {
        heartbeatCountdown--;
        if (heartbeatCountdown <= 0) {
            heartbeatCountdown = HEARTBEAT_SEC;
            processNextInQueue(false);
        }
        updateHeartbeatUI();
    }, 1000);
}

function processNextInQueue(manual = false) {
    if (!analysisQueue.length) {
        setStatus('⚠ M4.6+ deprem kuyruğu boş — veri yenileniyor...');
        fetchRecentEarthquakes();
        return;
    }
    if (phase === PHASE.ANALYSIS) {
        setStatus('⏳ Analiz devam ediyor, sıra bekliyor...');
        return;
    }

    const q = analysisQueue[queueCursor % analysisQueue.length];
    queueCursor++;
    updateQueueUI();

    selectEarthquake(q.id);

    // AP yükleme + hasar hesabı bitmesini bekle, sonra AI başlat
    setTimeout(() => {
        if (phase === PHASE.DAMAGE) startAIAnalysis();
    }, 5500);

    if (manual) {
        // Manuel tetiklemede geri sayımı sıfırla
        heartbeatCountdown = HEARTBEAT_SEC;
        updateHeartbeatUI();
    }
}

function updateHeartbeatUI() {
    const el = document.getElementById('heartbeatCountdown');
    if (!el) return;
    const m = Math.floor(heartbeatCountdown / 60);
    const s = heartbeatCountdown % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function updateQueueUI() {
    const countEl = document.getElementById('queueCount');
    const listEl  = document.getElementById('queueList');
    if (countEl) countEl.textContent = `${analysisQueue.length}`;

    if (!listEl) return;
    if (!analysisQueue.length) {
        listEl.innerHTML = `<div class="text-muted text-center py-2 small" style="font-size:0.72rem;">
            M4.6+ deprem yok</div>`;
        return;
    }

    const lastProcessed = queueCursor > 0 ? (queueCursor - 1) % analysisQueue.length : -1;

    listEl.innerHTML = analysisQueue.slice(0, 7).map((q, i) => {
        const col = magColor(q.mag);
        const isCur = i === lastProcessed;
        const shortPlace = q.place.replace(/^\d+\s*km\s+\w+\s+of\s+/i, '').split(',')[0];
        return `<div class="quake-item${isCur ? ' quake-selected' : ''}" onclick="selectEarthquake('${q.id}')">
            <span class="quake-mag" style="background:${col}22;color:${col};border:1px solid ${col}55;">
                M${q.mag.toFixed(1)}
            </span>
            <div class="quake-info">
                <div class="quake-place" title="${q.place}">${shortPlace}</div>
                <div class="quake-meta">${timeAgo(q.time)} · ${q.depth.toFixed(0)} km</div>
            </div>
            ${isCur ? '<i class="fa-solid fa-arrow-right text-primary fa-xs flex-shrink-0"></i>' : `<span class="text-muted font-monospace flex-shrink-0" style="font-size:0.62rem;">#${i+1}</span>`}
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// GERÇEK DEPREM VERİSİ — USGS FDSN API
// Türkiye ve çevresi (35.5–42.5°N, 25.5–45.5°E)
// ─────────────────────────────────────────────────────────────

function initEarthquakePanel() {
    const filterSel = document.getElementById('quakeMagFilter');
    const btnRefresh = document.getElementById('btnRefreshQuakes');

    if (filterSel) {
        filterSel.addEventListener('change', () => {
            quakeMagFilter = parseFloat(filterSel.value);
            renderEarthquakeList();
        });
    }
    if (btnRefresh) {
        btnRefresh.addEventListener('click', fetchRecentEarthquakes);
    }

    fetchRecentEarthquakes();

    // Her 5 dakikada bir otomatik yenile
    quakeRefreshTimer = setInterval(fetchRecentEarthquakes, 5 * 60 * 1000);
}

async function fetchRecentEarthquakes() {
    setQuakeListStatus('loading');
    const minLat = 35.5, maxLat = 42.5, minLon = 25.5, maxLon = 45.5;
    // Son 60 günü kapsayan ISO tarih (eski depremleri de göster)
    const starttime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query' +
        '?format=geojson' +
        `&minmagnitude=2.5` +
        `&starttime=${starttime}` +
        `&minlatitude=${minLat}&maxlatitude=${maxLat}` +
        `&minlongitude=${minLon}&maxlongitude=${maxLon}` +
        `&orderby=magnitude&limit=500`;
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(18000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        recentQuakes = (data.features || [])
            .filter(f => {
                // Türkiye sınırları içinde filtrele (yaklaşık bbox)
                const lat = f.geometry.coordinates[1];
                const lon = f.geometry.coordinates[0];
                return lat >= 35.8 && lat <= 42.2 && lon >= 25.8 && lon <= 44.8;
            })
            .map(f => ({
                id:    f.id,
                mag:   f.properties.mag ?? 0,
                place: f.properties.place || 'Bilinmeyen',
                time:  f.properties.time,
                depth: f.geometry.coordinates[2] ?? 0,
                lat:   f.geometry.coordinates[1],
                lon:   f.geometry.coordinates[0],
            }));
        setQuakeListStatus('ok');
        renderEarthquakeList();
        renderEarthquakeMarkers();
        buildAnalysisQueue(); // M4.6+ kuyruğunu oluştur
    } catch (err) {
        console.warn('[USGS]', err.message);
        setQuakeListStatus('error', 'USGS API erişilemiyor — internet bağlantısını kontrol edin');
    }
}

function magColor(mag) {
    if (mag >= 6.5) return '#ff1744';
    if (mag >= 5.5) return '#ff3b5c';
    if (mag >= 5.0) return '#ff6414';
    if (mag >= 4.0) return '#ff9f0a';
    if (mag >= 3.0) return '#f5e642';
    if (mag >= 2.0) return '#a8ff78';
    return '#00ff88';
}

function timeAgo(ms) {
    const diff = Date.now() - ms;
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'şimdi';
    if (m < 60) return `${m} dk önce`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} sa önce`;
    return `${Math.floor(h / 24)} gün önce`;
}

function renderEarthquakeList() {
    const body = document.getElementById('quakeListBody');
    if (!body) return;

    const filtered = recentQuakes.filter(q => q.mag >= quakeMagFilter);

    if (!filtered.length) {
        body.innerHTML = `<div class="text-muted text-center py-4 small">
            M${quakeMagFilter}+ deprem yok (son 30 gün)
        </div>`;
        return;
    }

    body.innerHTML = filtered.map(q => {
        const col = magColor(q.mag);
        const sel = q.id === selectedQuakeId ? 'quake-selected' : '';
        // USGS yer adı: "45 km NE of Antakya, Turkey" veya "Buldan, Turkey"
        // Mesafe+yön önekini temizle, virgülden önceki şehri al
        const shortPlace = q.place
            .replace(/^\d+(\.\d+)?\s*km\s+[\w\s]+\s+of\s+/i, '')  // "45 km NE of " ve "32 km ESE of "
            .split(',')[0]
            .trim()
            .replace(/\bTurkey\b/i, '')   // Sadece "Turkey" kalırsa temizle
            .trim() || q.place;
        return `<div class="quake-item ${sel}" onclick="selectEarthquake('${q.id}')">
            <span class="quake-mag" style="background:${col}22;color:${col};border:1px solid ${col}55;">
                M${q.mag.toFixed(1)}
            </span>
            <div class="quake-info">
                <div class="quake-place" title="${q.place}">${shortPlace}</div>
                <div class="quake-meta">${timeAgo(q.time)} · ${q.depth.toFixed(0)} km derinlik</div>
            </div>
        </div>`;
    }).join('');
}

function renderEarthquakeMarkers() {
    if (!map) return;

    if (!earthquakeLayer) {
        earthquakeLayer = L.layerGroup().addTo(map);
    } else {
        earthquakeLayer.clearLayers();
    }

    // En küçük depremleri önce çiz, büyükler üste gelsin
    const sorted = [...recentQuakes].sort((a, b) => a.mag - b.mag);
    sorted.forEach(q => {
        if (q.mag < 1.0) return;
        const col = magColor(q.mag);
        const r   = Math.max(4, Math.min(22, q.mag * 3.5));
        const circle = L.circleMarker([q.lat, q.lon], {
            radius:      r,
            fillColor:   col,
            color:       col,
            weight:      1,
            fillOpacity: q.mag >= 4 ? 0.75 : 0.45,
            opacity:     0.85,
        });
        circle.bindTooltip(
            `<strong>M${q.mag.toFixed(1)}</strong><br>${q.place}<br>` +
            `Derinlik: ${q.depth.toFixed(0)} km · ${timeAgo(q.time)}`,
            { sticky: true, className: 'leaflet-tooltip-dark' }
        );
        circle.on('click', () => selectEarthquake(q.id));
        earthquakeLayer.addLayer(circle);
    });
}

async function selectEarthquake(id) {
    const q = recentQuakes.find(eq => eq.id === id);
    if (!q) return;
    if (phase === PHASE.ANALYSIS) {
        setStatus('⏳ AI analizi sürüyor, lütfen bekleyin.');
        return;
    }

    selectedQuakeId = id;
    renderEarthquakeList(); // seçili vurgula

    // Büyüklük güncelle
    magnitude = Math.max(1.0, q.mag);
    const slider  = document.getElementById('magSlider');
    const display = document.getElementById('magDisplay');
    // Bug #8 fix: Clamp slider to its actual range, show real mag in display
    if (slider)  slider.value      = Math.min(9.0, Math.max(parseFloat(slider.min || '4.5'), magnitude));
    if (display) display.textContent = `M${magnitude.toFixed(1)}`;

    // Harita merkezi + fly
    centerLat = q.lat;
    centerLon = q.lon;
    userLat   = q.lat;
    userLon   = q.lon;
    map.flyTo([q.lat, q.lon], 13, { duration: 1.5 });

    // HUD — kısa yer adı
    const hudName = q.place.replace(/^\d+(\.\d+)?\s*km\s+[\w\s]+\s+of\s+/i, '').split(',').slice(0, 2).join(', ');
    updateHUD(hudName, q.lat, q.lon);
    updateUserLayer();

    // Sıfırla
    selectedAP     = null;
    routeWaypoints = [];
    routeProgress  = 0;
    isAnimatingRoute = false;
    aiResult       = null;
    shockwaves     = [];
    assemblyPoints.forEach(ap => ap.damage = 0);
    clearAllLayers();
    const aiPanel = document.getElementById('aiResultPanel');
    if (aiPanel) aiPanel.classList.add('d-none');

    // Epimerkez + animasyon başlat
    epicenter = { lat: q.lat, lon: q.lon, magnitude };
    phase     = PHASE.QUAKE;
    updateEpicenterLayer();

    const now = Date.now();
    shockwaves = [
        { startTime: now,        maxRadiusKm: magnitude * 6 },
        { startTime: now + 600,  maxRadiusKm: magnitude * 6 },
        { startTime: now + 1200, maxRadiusKm: magnitude * 6 },
    ];
    shakeUntil = Date.now() + 2000;

    const localTime = new Date(q.time).toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
    setStatus(
        `⚡ M${magnitude.toFixed(1)} — ${q.place} | ` +
        `Derinlik: ${q.depth.toFixed(0)} km | ${localTime} | ` +
        `Toplanma alanları yükleniyor...`
    );

    // AP yükleme + hasar (minimum animasyon süresiyle)
    const t0 = Date.now();
    await fetchOSMAssemblyPoints(q.lat, q.lon);
    const elapsed = Date.now() - t0;
    if (elapsed < 2200) await delay(2200 - elapsed);

    applyDamage();

    // Toplanma alanlarına rotaları güncelle (hasar durumu değişti)
    showAllAPRoutes().catch(err => console.warn('[AP routes]', err));

    // RAG: AFAD + hastane verisi arka planda çek → geldikten sonra AFAD rotaları
    fetchAndApplyRAG(q.lat, q.lon)
        .then(() => { drawAFADRoutes(); drawHospitalRoutes(); })
        .catch(err => console.warn('[RAG/AFAD]', err));
}

function setQuakeListStatus(state, msg) {
    const el = document.getElementById('quakeListStatus');
    if (!el) return;
    if (state === 'loading') {
        el.innerHTML = `<i class="fa-solid fa-spinner fa-spin me-1"></i> USGS'den çekiliyor...`;
        el.style.color = 'var(--color-muted)';
    } else if (state === 'error') {
        el.innerHTML = `<i class="fa-solid fa-triangle-exclamation me-1"></i> ${msg}`;
        el.style.color = '#f59e0b';
    } else {
        const count = recentQuakes.filter(q => q.mag >= quakeMagFilter).length;
        el.innerHTML =
            `<i class="fa-solid fa-check-circle me-1" style="color:var(--color-success);"></i>` +
            `${count} deprem · güncellendi ${new Date().toLocaleTimeString('tr-TR')}`;
        el.style.color = 'var(--color-muted)';
    }
}

// ─────────────────────────────────────────────────────────────
// UYDU TARAMA GÖRÜNTÜSÜ — 3 art arda tıklama ile tetiklenir
// ─────────────────────────────────────────────────────────────
function showSatelliteOverlay(latlng) {
    // Önceki popup varsa kapat
    if (satellitePopup) {
        map.closePopup(satellitePopup);
        satellitePopup = null;
    }
    satelliteClickCount = 0;

    const popupContent = `
        <div id="sat-popup-inner" style="
            cursor:pointer;
            user-select:none;
            text-align:center;
            font-family:'JetBrains Mono',monospace;
        ">
            <div style="
                font-size:0.7rem;
                color:#00d4ff;
                margin-bottom:6px;
                letter-spacing:1px;
                font-weight:700;
            ">
                <i class='fa-solid fa-satellite-dish'></i>
                &nbsp;SENTINEL-2 UYDU GÖRÜNTÜSÜ
            </div>
            <img
                src="satellite-scan.png"
                alt="Uydu Tarama"
                style="
                    width:240px;
                    height:180px;
                    object-fit:cover;
                    border-radius:8px;
                    border:2px solid rgba(0,212,255,0.4);
                    display:block;
                    margin:0 auto;
                "
            >
            <div id="sat-click-hint" style="
                margin-top:8px;
                font-size:0.68rem;
                color:#8892b0;
            ">
                <i class='fa-solid fa-brain' style='color:#a855f7;'></i>
                &nbsp;AI ile 2 kez tıkla → Bölgeyi tara
            </div>
            <div id="sat-click-counter" style="
                font-size:0.65rem;
                color:#ff9f0a;
                margin-top:4px;
                display:none;
            ">
                <i class='fa-solid fa-circle-notch fa-spin'></i>
                &nbsp;Tarama başlatılıyor... (1/2)
            </div>
        </div>
    `;

    satellitePopup = L.popup({
        maxWidth: 280,
        className: 'sat-popup-dark',
        closeButton: true,
        autoClose: false,
        closeOnClick: false,
    })
    .setLatLng(latlng)
    .setContent(popupContent)
    .openOn(map);

    // Popup açıldıktan sonra tıklama sayacını bağla
    satellitePopup.on('add', () => {
        setTimeout(() => {
            const inner = document.getElementById('sat-popup-inner');
            if (!inner) return;
            inner.addEventListener('click', () => {
                satelliteClickCount++;
                const counter = document.getElementById('sat-click-counter');
                const hint    = document.getElementById('sat-click-hint');
                if (satelliteClickCount === 1) {
                    if (counter) { counter.style.display = 'block'; }
                    if (hint)    { hint.style.display = 'none'; }
                } else if (satelliteClickCount >= 2) {
                    satelliteClickCount = 0;
                    triggerFireWarning(latlng);
                }
            });
        }, 100);
    });
}

async function triggerFireWarning(latlng) {
    if (satellitePopup) {
        map.closePopup(satellitePopup);
        satellitePopup = null;
    }

    // Tarama animasyonu göster
    const scanPopup = L.popup({
        maxWidth: 260, className: 'sat-popup-dark',
        closeButton: false, autoClose: false, closeOnClick: false,
    })
    .setLatLng(latlng)
    .setContent(`
        <div style="font-family:'JetBrains Mono',monospace;text-align:center;padding:8px 4px;">
            <div style="font-size:0.75rem;color:#00d4ff;font-weight:700;letter-spacing:1px;">
                <i class='fa-solid fa-satellite-dish fa-beat-fade'></i>
                &nbsp;NASA FIRMS SORGULANIYOR
            </div>
            <div style="margin-top:8px;font-size:0.65rem;color:#8892b0;">
                VIIRS NOAA-20 · 24h aktif yangın verisi
            </div>
            <div style="margin-top:6px;">
                <i class='fa-solid fa-circle-notch fa-spin' style='color:#ff9f0a;font-size:1.1rem;'></i>
            </div>
        </div>
    `)
    .openOn(map);

    // NASA FIRMS'ten gerçek yangın verisi çek
    let firmsData = null;
    try {
        const resp = await fetch('http://localhost:5050/api/fires', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: latlng.lat, lon: latlng.lng, radius: 1.5 }),
            signal: AbortSignal.timeout(25000),
        });
        if (resp.ok) firmsData = await resp.json();
    } catch (err) {
        console.warn('[FIRMS]', err.message);
    }

    map.closePopup(scanPopup);

    const fires      = firmsData?.fires || [];
    const source     = firmsData?.source || 'NASA FIRMS';
    const hasRealFire = fires.length > 0;

    // Harita üzerinde gerçek yangın noktalarını çiz
    const fireMarkersLayer = L.layerGroup().addTo(map);
    if (hasRealFire) {
        fires.forEach(f => {
            const r = Math.max(150, Math.min(800, (f.frp || 1) * 30));
            const col = f.confidence >= 70 ? '#ff3b5c' : f.confidence >= 50 ? '#ff9f0a' : '#f59e0b';
            L.circle([f.lat, f.lon], {
                radius: r, color: col, fillColor: col,
                fillOpacity: 0.18, weight: 1.5, dashArray: '4,3',
            })
            .bindTooltip(
                `🔥 <b>${source}</b><br>` +
                `Parlaklık: ${f.brightness}K · FRP: ${f.frp} MW<br>` +
                `Güven: %${f.confidence} · ${f.satellite}<br>` +
                `${f.date} ${f.time} UTC · ${f.daynight === 'D' ? 'Gündüz' : 'Gece'}`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .addTo(fireMarkersLayer);
        });
    }

    // Merkez nokta işareti
    L.circle(latlng, {
        radius: hasRealFire ? 200 : 350,
        color: '#ff3b5c', fillColor: '#ff3b5c',
        fillOpacity: 0.12, weight: 2, dashArray: '6,4',
    }).addTo(fireMarkersLayer);

    setTimeout(() => { map.removeLayer(fireMarkersLayer); }, 60000);

    // Popup içeriği — gerçek veriye göre
    const nearest   = fires.sort((a, b) =>
        haversineKm(latlng.lat, latlng.lng, a.lat, a.lon) -
        haversineKm(latlng.lat, latlng.lng, b.lat, b.lon)
    )[0];
    const highConf  = fires.filter(f => f.confidence >= 70).length;

    const warningContent = hasRealFire
    ? `<div style="font-family:'JetBrains Mono',monospace;text-align:center;min-width:260px;">
        <div style="font-size:1.2rem;margin-bottom:5px;">🔥🔥🔥</div>
        <div style="font-size:0.83rem;font-weight:800;color:#ff3b5c;letter-spacing:1px;margin-bottom:3px;">
            YANGIN TESPİT EDİLDİ
        </div>
        <div style="font-size:0.68rem;color:#ff9f0a;margin-bottom:8px;">
            <i class='fa-solid fa-satellite-dish'></i> ${source}
        </div>
        <div style="font-size:0.67rem;color:#e2e8f0;line-height:1.6;text-align:left;
                    background:rgba(255,59,92,0.07);border:1px solid rgba(255,59,92,0.3);
                    border-radius:6px;padding:8px 10px;">
            <div><b style='color:#ff3b5c;'>● GERÇEK VERİ:</b> ${fires.length} aktif yangın noktası</div>
            <div>🎯 Yüksek güven: ${highConf} nokta</div>
            ${nearest ? `<div>📍 En yakın: ${haversineKm(latlng.lat, latlng.lng, nearest.lat, nearest.lon).toFixed(2)} km</div>
            <div>🌡️ Parlaklık: ${nearest.brightness}K · FRP: ${nearest.frp} MW</div>
            <div>🛰️ Uydu: ${nearest.satellite} · ${nearest.date}</div>` : ''}
            <div style='margin-top:4px;'>⚠️ Tahliye önerilir — acil müdahale gerekli.</div>
        </div>
        <div style='margin-top:7px;font-size:0.6rem;color:#8892b0;'>
            AfetAI · ${source} · ${new Date().toLocaleTimeString('tr-TR')}
        </div>
    </div>`
    : `<div style="font-family:'JetBrains Mono',monospace;text-align:center;min-width:250px;">
        <div style="font-size:0.83rem;font-weight:700;color:#00ff88;margin-bottom:6px;">
            ✓ BÖLGE TEMİZ
        </div>
        <div style="font-size:0.67rem;color:#e2e8f0;line-height:1.5;text-align:left;
                    background:rgba(0,255,136,0.06);border:1px solid rgba(0,255,136,0.2);
                    border-radius:6px;padding:8px 10px;">
            <div>📡 ${source}</div>
            <div>Son 24 saatte bu bölgede aktif yangın noktası tespit edilmedi.</div>
            <div style='margin-top:4px;'>📍 ${latlng.lat.toFixed(4)}°N, ${latlng.lng.toFixed(4)}°E</div>
        </div>
        <div style='margin-top:7px;font-size:0.6rem;color:#8892b0;'>
            AfetAI · ${source} · ${new Date().toLocaleTimeString('tr-TR')}
        </div>
    </div>`;

    L.popup({
        maxWidth: 310,
        className: `sat-popup-dark${hasRealFire ? ' fire-warning-popup' : ''}`,
        closeButton: true, autoClose: false, closeOnClick: false,
    })
    .setLatLng(latlng)
    .setContent(warningContent)
    .openOn(map);

    const status = document.getElementById('simStatus');
    if (status) {
        status.innerHTML = hasRealFire
            ? `<span style='color:#ff3b5c;font-weight:700;'>🔥 ${fires.length} YANGIN NOKTASI — ${latlng.lat.toFixed(4)}°N, ${latlng.lng.toFixed(4)}°E — ${source}</span>`
            : `<span style='color:#00ff88;'>✓ Temiz bölge — ${source} · 24h içinde yangın yok · ${latlng.lat.toFixed(4)}°N, ${latlng.lng.toFixed(4)}°E</span>`;
    }
}

// ─────────────────────────────────────────────────────────────
// NASA FIRMS — Global yangın katmanı (toggle)
// ─────────────────────────────────────────────────────────────
async function toggleFireLayer() {
    const btn = document.getElementById('btnFireLayer');
    if (fireLayerOn) {
        if (fireLayer)     { map.removeLayer(fireLayer);     fireLayer = null; }
        if (fireGibsLayer) { map.removeLayer(fireGibsLayer); fireGibsLayer = null; }
        fireLayerOn = false;
        if (btn) {
            btn.style.background = 'rgba(255,59,92,0.12)';
            btn.style.borderColor = 'rgba(255,59,92,0.3)';
            btn.innerHTML = '<i class="fa-solid fa-fire me-1"></i> Yangın Katmanı';
        }
        setStatus('Yangın katmanı kapatıldı.');
        return;
    }

    fireLayerOn = true;
    if (btn) {
        btn.style.background = 'rgba(255,59,92,0.35)';
        btn.style.borderColor = 'rgba(255,59,92,0.7)';
        btn.innerHTML = '<i class="fa-solid fa-fire fa-beat me-1"></i> Yangın Aktif';
    }
    setStatus('NASA FIRMS yangın verisi yükleniyor...');

    // 1. NASA GIBS MODIS tile katmanı (anlık görsel — API key gerekmez)
    const today = new Date().toISOString().slice(0, 10);
    fireGibsLayer = L.tileLayer(
        `https://gibs-a.earthdata.nasa.gov/wmts/epsg3857/best/` +
        `MODIS_Terra_ThermalAnomalies_Day/default/${today}/` +
        `GoogleMapsCompatible_Level6/{z}/{y}/{x}.jpg`,
        {
            attribution: 'NASA GIBS · MODIS Terra ThermalAnomalies',
            opacity: 0.65, maxZoom: 6, tileSize: 256,
            errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        }
    ).addTo(map);

    // 2. FIRMS nokta verileri — haritanın merkezine göre çek
    fireLayer = L.layerGroup().addTo(map);
    await loadFIRMSPoints(centerLat, centerLon);
}

async function loadFIRMSPoints(lat, lon) {
    if (!fireLayer) return;
    try {
        const resp = await fetch('http://localhost:5050/api/fires', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lon, radius: 5.0 }),
            signal: AbortSignal.timeout(25000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const fires = data.fires || [];

        fires.forEach(f => {
            const conf = f.confidence;
            const col  = conf >= 70 ? '#ff3b5c' : conf >= 50 ? '#ff9f0a' : '#f59e0b';
            const r    = Math.max(120, Math.min(600, (f.frp || 1) * 25));

            L.circle([f.lat, f.lon], {
                radius: r, color: col, fillColor: col,
                fillOpacity: 0.22, weight: 1.5,
            })
            .bindTooltip(
                `🔥 <b>${f.satellite}</b><br>` +
                `Parlaklık: ${f.brightness}K · FRP: ${f.frp} MW<br>` +
                `Güven: %${conf} · ${f.daynight === 'D' ? 'Gündüz' : 'Gece'}<br>` +
                `${f.date} ${f.time} UTC`,
                { className: 'leaflet-tooltip-dark', sticky: true }
            )
            .addTo(fireLayer);
        });

        const btn = document.getElementById('btnFireLayer');
        if (fires.length > 0) {
            setStatus(`🔥 ${fires.length} yangın noktası yüklendi (${data.source})`);
            if (btn) btn.title = `${fires.length} nokta · ${data.source}`;
        } else {
            setStatus(`✓ Bu bölgede son 24 saatte aktif yangın yok (${data.source})`);
        }
    } catch (err) {
        console.warn('[FIRMS layer]', err.message);
        setStatus('⚠ NASA FIRMS verisi alınamadı — sunucu çalışıyor mu?');
    }
}
