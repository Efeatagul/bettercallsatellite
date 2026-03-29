/* ========================================
   AfetAI — app.js
   
   Geliştirici: İ.Ç.
   Son güncelleme: 2026-03-27
   
   TODO: Lottie animasyonları entegre
   edilecek — şimdilik CSS spinner yeterli.
   
   NOT: Canvas demo'da grid boyutu 40x25.
   Daha yüksek çözünürlük (80x50) mobil
   cihazlarda 30fps altına düşürüyor,
   bu yüzden şimdilik bu seviyede bıraktık.
   ======================================== */

document.addEventListener('DOMContentLoaded', () => {
  // -- Page Loader: 500ms sonra kaldır
  const loader = document.getElementById('pageLoader');
  if (loader) {
    setTimeout(() => loader.classList.add('loaded'), 500);
  }

  // -- AOS kütüphanesi
  if (typeof AOS !== 'undefined') {
    AOS.init({ duration: 700, easing: 'ease-out-cubic', once: true, offset: 40 });
  }

  // -- Navbar scroll: transparent → glass
  initNavbarScroll();

  // -- Active nav link (URL bazlı)
  highlightActiveNav();

  // -- Typewriter (sadece index.html hero)
  const typeEl = document.getElementById('typewriter');
  if (typeEl) initTypewriter(typeEl);

  // -- Hero particle canvas
  if (document.getElementById('hero-canvas')) initHeroCanvas();

  // -- Chart.js (ozet.html)
  if (document.getElementById('accuracyChart')) initCharts();

  // -- Demo canvas (teknoloji.html)
  if (document.getElementById('demo-canvas')) initDemoCanvas();
});

/* ═══════════════════════════════════════
   NAVBAR — Scroll ile transparent → glass
   
   Performans notu: scroll event'i throttle
   etmedik çünkü classList.toggle zaten
   çok hafif bir operasyon. 60fps'de sorun yok.
   ═══════════════════════════════════════ */
function initNavbarScroll() {
  const nav = document.getElementById('navbar');
  if (!nav) return;
  const check = () => nav.classList.toggle('scrolled', window.scrollY > 50);
  window.addEventListener('scroll', check);
  check(); // ilk yüklemede kontrol
}

function highlightActiveNav() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.navbar-nav .nav-link').forEach(link => {
    const href = link.getAttribute('href');
    if (href === page || (page === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
}

/* ═══════════════════════════════════════
   TYPEWRITER
   
   Yazma hızı: 60-100ms arası rastgele
   jitter eklendi — sabit hızda yazım
   çok mekanik duruyordu.
   ═══════════════════════════════════════ */
function initTypewriter(el) {
  const phrases = [
    'Afet Müdahale Sistemi',
    'Hatay Mikro-Rota Analizi',
    'Uydu SAR Veri İşleme',
    'A* Hibrit Rota Motoru'
  ];

  let pi = 0, ci = 0, deleting = false;

  function tick() {
    const word = phrases[pi];
    if (!deleting) {
      el.textContent = word.substring(0, ++ci);
      if (ci === word.length) { deleting = true; return setTimeout(tick, 2200); }
      return setTimeout(tick, 55 + Math.random() * 45);
    }
    el.textContent = word.substring(0, --ci);
    if (ci === 0) { deleting = false; pi = (pi + 1) % phrases.length; return setTimeout(tick, 350); }
    setTimeout(tick, 28);
  }
  tick();
}

/* ═══════════════════════════════════════
   HERO PARTICLE CANVAS
   
   Parçacık sayısı viewport alanına göre
   dinamik hesaplanıyor (max 70). Düşük
   DPI ekranlarda performans sorunu yok
   ama 4K monitörlerde parçacık sayısı
   artırılabilir — şimdilik cap'ledik.
   ═══════════════════════════════════════ */
function initHeroCanvas() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, particles = [], gridLines = [];
  let mouseX = -1, mouseY = -1;

  function resize() {
    w = canvas.width = canvas.parentElement.offsetWidth;
    h = canvas.height = canvas.parentElement.offsetHeight;
    createParticles();
    createGrid();
  }

  function createParticles() {
    particles = [];
    // Viewport alanına orantılı parçacık sayısı
    const count = Math.min(70, Math.floor(w * h / 14000));
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w, y: Math.random() * h,
        r: Math.random() * 1.8 + 0.4,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        alpha: Math.random() * 0.4 + 0.15
      });
    }
  }

  function createGrid() {
    gridLines = [];
    const step = 55;
    for (let x = 0; x < w; x += step) gridLines.push({ x1: x, y1: 0, x2: x, y2: h });
    for (let y = 0; y < h; y += step) gridLines.push({ x1: 0, y1: y, x2: w, y2: y });
  }

  canvas.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect();
    mouseX = e.clientX - r.left; mouseY = e.clientY - r.top;
  });
  canvas.addEventListener('mouseleave', () => { mouseX = mouseY = -1; });

  function draw() {
    ctx.clearRect(0, 0, w, h);

    // Arka plan grid
    ctx.strokeStyle = 'rgba(0,212,255,0.03)';
    ctx.lineWidth = 0.5;
    for (const l of gridLines) {
      ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke();
    }

    // Mouse radial glow
    if (mouseX > 0) {
      const g = ctx.createRadialGradient(mouseX, mouseY, 0, mouseX, mouseY, 140);
      g.addColorStop(0, 'rgba(0,212,255,0.07)'); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }

    // Parçacıklar + mouse repulsion
    for (const p of particles) {
      if (mouseX > 0) {
        const dx = p.x - mouseX, dy = p.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 90) { p.x += dx * 0.018; p.y += dy * 0.018; }
      }
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,212,255,${p.alpha})`; ctx.fill();
    }

    // Bağlantı çizgileri (spatial proximity)
    // TODO: QuadTree ile optimize edilebilir ama <70 parçacık için brute-force yeterli
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 120) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0,212,255,${0.08 * (1 - d / 120)})`;
          ctx.lineWidth = 0.5; ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }

  resize(); draw();
  window.addEventListener('resize', resize);
}

/* ═══════════════════════════════════════
   CHART.JS — ozet.html istatistikleri
   
   Radar chart + bar chart ile model
   performans metriklerini gösteriyoruz.
   Neon renk paleti dark temaya uyumlu.
   ═══════════════════════════════════════ */
function initCharts() {
  // -- Doğruluk Radar Chart
  const accCtx = document.getElementById('accuracyChart');
  if (accCtx) {
    new Chart(accCtx, {
      type: 'radar',
      data: {
        labels: ['Bina Hasarı', 'Sel Tespiti', 'Yol Çökmesi', 'Heyelan', 'Yangın', 'Sağlam Alan'],
        datasets: [{
          label: 'F1-Score (%)',
          data: [94.2, 91.8, 89.5, 87.1, 92.7, 96.3],
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0,212,255,0.1)',
          pointBackgroundColor: '#00d4ff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          r: {
            beginAtZero: true, max: 100, min: 70,
            grid: { color: 'rgba(255,255,255,0.06)' },
            angleLines: { color: 'rgba(255,255,255,0.06)' },
            pointLabels: { color: '#8892b0', font: { size: 11 } },
            ticks: { display: false }
          }
        },
        plugins: {
          legend: { labels: { color: '#8892b0' } }
        }
      }
    });
  }

  // -- İşlem Süresi Bar Chart
  const perfCtx = document.getElementById('performanceChart');
  if (perfCtx) {
    new Chart(perfCtx, {
      type: 'bar',
      data: {
        labels: ['Veri İndirme', 'Ön-İşleme', 'AI Segmentasyon', 'Risk Matrisi', 'Rota Hesaplama'],
        datasets: [{
          label: 'Süre (ms)',
          data: [1200, 340, 890, 45, 118],
          backgroundColor: [
            'rgba(0,212,255,0.6)', 'rgba(168,85,247,0.6)',
            'rgba(255,107,53,0.6)', 'rgba(0,255,136,0.6)',
            'rgba(255,59,92,0.6)'
          ],
          borderWidth: 0, borderRadius: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8892b0' } },
          y: { grid: { display: false }, ticks: { color: '#8892b0', font: { size: 11 } } }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }
}

/* ═══════════════════════════════════════
   DEMO CANVAS — A* Rota Simülasyonu
   
   Grid: 40 sütun x 25 satır
   Cell boyutu viewport'a göre dinamik.
   
   Ağırlık formülü:
   cost = moveCost * (1 + riskScore * 10)
   
   riskScore >0.9 olan hücreler duvar olarak
   işaretleniyor — aksi halde A* bu hücrelerin
   içinden geçmeye çalışıyor ve rota
   tehlikeli bölgelerden sapıyordu.
   
   Diagonal hareket √2 maliyetli (1.414).
   ═══════════════════════════════════════ */
function initDemoCanvas() {
  const canvas = document.getElementById('demo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const GRID_COLS = 40, GRID_ROWS = 25;
  let cellW, cellH;
  let terrainGrid = [], riskMatrix = [];
  let scanProgress = 0, isScanning = false;
  let routeBuffer = [], routeCursor = 0, isDrawingRoute = false;

  // Kurtarma üssü ve hedef noktası
  const rescueBase = { c: 2, r: 2 };
  const targetPoint = { c: GRID_COLS - 3, r: GRID_ROWS - 3 };

  // Loading / Error overlay kontrolü
  const statusOverlay = document.getElementById('demoStatusOverlay');
  const statusText = document.getElementById('demoStatusText');
  const statusIcon = document.getElementById('demoStatusIcon');

  function showStatus(msg, icon, isError) {
    if (!statusOverlay) return;
    statusOverlay.classList.remove('hidden');
    if (statusText) statusText.textContent = msg;
    if (statusIcon) {
      statusIcon.className = isError
        ? 'fa-solid fa-triangle-exclamation text-warning fs-1 mb-3'
        : 'fa-solid fa-satellite-dish text-primary fs-1 mb-3 fa-beat-fade';
    }
  }
  function hideStatus() {
    if (statusOverlay) statusOverlay.classList.add('hidden');
  }

  function resize() {
    canvas.width = canvas.parentElement.offsetWidth;
    canvas.height = canvas.parentElement.offsetHeight;
    cellW = canvas.width / GRID_COLS;
    cellH = canvas.height / GRID_ROWS;
  }

  /* -- Sahte uydu verisi oluşturma --
     Gerçek projede bu kısım Sentinel-2 API'den
     tile olarak gelecek. Şimdilik prosedürel
     harita üretiyoruz. */
  function generateSatelliteData() {
    terrainGrid = []; riskMatrix = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      terrainGrid[r] = []; riskMatrix[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        terrainGrid[r][c] = 0; riskMatrix[r][c] = 0;
      }
    }

    // Ana yol ağı (OpenStreetMap benzeri)
    [4, 9, 14, 19].forEach(rr => { for (let c = 0; c < GRID_COLS; c++) terrainGrid[rr][c] = 4; });
    [5, 12, 19, 26, 33].forEach(cc => { for (let r = 0; r < GRID_ROWS; r++) terrainGrid[r][cc] = 4; });

    // Yapı alanları
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (terrainGrid[r][c] === 0 && Math.random() < 0.55) terrainGrid[r][c] = 1;
      }
    }

    // Hasar kümeleri — Hatay senaryosu bazlı
    const damageClusters = [
      { c: 8, r: 7, label: 'Antakya merkez' },
      { c: 22, r: 12, label: 'İskenderun bölgesi' },
      { c: 15, r: 18, label: 'Samandağ kıyı' },
      { c: 30, r: 6, label: 'Kırıkhan' },
      { c: 10, r: 20, label: 'Defne ilçesi' }
    ];
    for (const cluster of damageClusters) {
      const radius = 2 + Math.floor(Math.random() * 3);
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = cluster.r + dr, nc = cluster.c + dc;
          if (nr >= 0 && nr < GRID_ROWS && nc >= 0 && nc < GRID_COLS
              && Math.sqrt(dr * dr + dc * dc) <= radius) {
            terrainGrid[nr][nc] = 2; // hasar
          }
        }
      }
    }

    // Sel bölgeleri
    const floodZones = [
      { c: 16, r: 5, label: 'Asi nehri taşkını' },
      { c: 35, r: 18, label: 'Kıyı sel alanı' }
    ];
    for (const zone of floodZones) {
      const radius = 2 + Math.floor(Math.random() * 2);
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = zone.r + dr, nc = zone.c + dc;
          if (nr >= 0 && nr < GRID_ROWS && nc >= 0 && nc < GRID_COLS
              && Math.sqrt(dr * dr + dc * dc) <= radius) {
            terrainGrid[nr][nc] = 3; // sel
          }
        }
      }
    }

    terrainGrid[rescueBase.r][rescueBase.c] = 4;
    terrainGrid[targetPoint.r][targetPoint.c] = 4;
    buildRiskMatrix();
  }

  /* Risk matrisi: her hücreye 0-1 arası skor
     Gerçek sistemde bu skorlar U-Net çıktısından
     geliyor. Burada terrain tipine göre sabit. */
  function buildRiskMatrix() {
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        switch (terrainGrid[r][c]) {
          case 0: riskMatrix[r][c] = 0.10; break; // açık alan
          case 1: riskMatrix[r][c] = 0.30; break; // bina
          case 2: riskMatrix[r][c] = 0.95; break; // yıkım
          case 3: riskMatrix[r][c] = 0.85; break; // sel
          case 4: riskMatrix[r][c] = 0.05; break; // yol
        }
      }
    }
  }

  function renderTerrain(showHeatmap) {
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const x = c * cellW, y = r * cellH;
        if (showHeatmap && (r * GRID_COLS + c) < scanProgress) {
          const risk = riskMatrix[r][c];
          if (risk > 0.8) ctx.fillStyle = `rgba(255,59,92,${0.4 + risk * 0.4})`;
          else if (risk > 0.5) ctx.fillStyle = `rgba(255,107,53,${0.3 + risk * 0.3})`;
          else if (risk > 0.2) ctx.fillStyle = `rgba(255,200,50,${0.15 + risk * 0.15})`;
          else ctx.fillStyle = `rgba(0,255,136,${0.15 + (1 - risk) * 0.15})`;
        } else {
          switch (terrainGrid[r][c]) {
            case 0: ctx.fillStyle = `hsl(${140 + Math.random() * 20},25%,${18 + Math.random() * 8}%)`; break;
            case 1: ctx.fillStyle = `hsl(220,10%,${25 + Math.random() * 10}%)`; break;
            case 2: ctx.fillStyle = `hsl(${15 + Math.random() * 10},30%,${22 + Math.random() * 8}%)`; break;
            case 3: ctx.fillStyle = `hsl(${200 + Math.random() * 15},50%,${20 + Math.random() * 10}%)`; break;
            case 4: ctx.fillStyle = `hsl(0,0%,${30 + Math.random() * 5}%)`; break;
          }
        }
        ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
        ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 0.3;
        ctx.strokeRect(x, y, cellW, cellH);
      }
    }
  }

  function renderMarkers() {
    const sz = Math.min(cellW, cellH);
    // Kurtarma üssü
    const sx = rescueBase.c * cellW + cellW / 2, sy = rescueBase.r * cellH + cellH / 2;
    ctx.beginPath(); ctx.arc(sx, sy, sz * 0.8, 0, Math.PI * 2); ctx.fillStyle = 'rgba(168,85,247,0.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(sx, sy, sz * 0.5, 0, Math.PI * 2); ctx.fillStyle = '#a855f7'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.floor(sz * 0.6)}px Inter`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🏥', sx, sy);

    // Hedef nokta
    const ex = targetPoint.c * cellW + cellW / 2, ey = targetPoint.r * cellH + cellH / 2;
    ctx.beginPath(); ctx.arc(ex, ey, sz * 0.8, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,59,92,0.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(ex, ey, sz * 0.5, 0, Math.PI * 2); ctx.fillStyle = '#ff3b5c'; ctx.fill();
    ctx.fillText('🆘', ex, ey);
  }

  function renderRoute() {
    if (routeBuffer.length < 2) return;
    const drawUntil = isDrawingRoute ? routeCursor : routeBuffer.length;

    ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 14;
    ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 3.5;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(routeBuffer[0].c * cellW + cellW / 2, routeBuffer[0].r * cellH + cellH / 2);
    for (let i = 1; i < drawUntil && i < routeBuffer.length; i++) {
      ctx.lineTo(routeBuffer[i].c * cellW + cellW / 2, routeBuffer[i].r * cellH + cellH / 2);
    }
    ctx.stroke(); ctx.shadowBlur = 0;

    // Waypoint noktaları
    for (let i = 0; i < drawUntil && i < routeBuffer.length; i++) {
      ctx.beginPath();
      ctx.arc(routeBuffer[i].c * cellW + cellW / 2, routeBuffer[i].r * cellH + cellH / 2, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#00d4ff'; ctx.fill();
    }

    // Animasyonlu baş noktası
    if (isDrawingRoute && routeCursor > 0 && routeCursor < routeBuffer.length) {
      const head = routeBuffer[routeCursor - 1];
      ctx.beginPath();
      ctx.arc(head.c * cellW + cellW / 2, head.r * cellH + cellH / 2, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 20;
      ctx.fill(); ctx.shadowBlur = 0;
    }
  }

  /* ── A* Pathfinding ──
     Maliyet fonksiyonu: moveCost * (1 + risk * 10)
     
     Diagonal ağırlık: √2 ≈ 1.414
     Risk >0.9 → geçilmez (duvar)
     
     Heuristic: Manhattan distance
     (Euclidean daha iyi sonuç verebilir ama
     hesaplama maliyeti grid bu boyutta
     ihmal edilebilir düzeyde fark yaratıyor) */
  function computeRoute(start, end) {
    const openSet = [start];
    const cameFrom = {};
    const gScore = {}, fScore = {};
    const key = n => `${n.r},${n.c}`;

    for (let r = 0; r < GRID_ROWS; r++)
      for (let c = 0; c < GRID_COLS; c++) {
        gScore[`${r},${c}`] = Infinity;
        fScore[`${r},${c}`] = Infinity;
      }

    gScore[key(start)] = 0;
    fScore[key(start)] = Math.abs(start.r - end.r) + Math.abs(start.c - end.c);
    const closedSet = new Set();

    while (openSet.length > 0) {
      openSet.sort((a, b) => (fScore[key(a)] || Infinity) - (fScore[key(b)] || Infinity));
      const current = openSet.shift();
      const ck = key(current);

      if (current.r === end.r && current.c === end.c) {
        // Rota reconstruct
        const path = [current]; let k = ck;
        while (cameFrom[k]) {
          const prev = cameFrom[k];
          path.unshift(prev);
          k = key(prev);
        }
        return path;
      }

      closedSet.add(ck);

      // 8 yönlü komşuluk (king moves)
      const neighbors = [
        { dr: -1, dc: 0 }, { dr: 1, dc: 0 }, { dr: 0, dc: -1 }, { dr: 0, dc: 1 },
        { dr: -1, dc: -1 }, { dr: -1, dc: 1 }, { dr: 1, dc: -1 }, { dr: 1, dc: 1 }
      ];

      for (const n of neighbors) {
        const nr = current.r + n.dr, nc = current.c + n.dc;
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
        const nk = `${nr},${nc}`;
        if (closedSet.has(nk)) continue;

        const risk = riskMatrix[nr][nc];
        if (risk > 0.9) continue; // duvar eşiği

        const moveCost = (n.dr !== 0 && n.dc !== 0) ? 1.414 : 1;
        const tentativeG = gScore[ck] + moveCost * (1 + risk * 10);

        if (tentativeG < gScore[nk]) {
          cameFrom[nk] = current;
          gScore[nk] = tentativeG;
          fScore[nk] = tentativeG + Math.abs(nr - end.r) + Math.abs(nc - end.c);
          if (!openSet.some(o => o.r === nr && o.c === nc))
            openSet.push({ r: nr, c: nc });
        }
      }
    }
    return []; // rota bulunamadı
  }

  function startAnalysis() {
    if (isScanning) return;
    showStatus('Uydu verisi alınıyor...', 'satellite-dish', false);
    // Simüle: 800ms "indirme" sonra tarama başla
    setTimeout(() => {
      hideStatus();
      isScanning = true; scanProgress = 0;
      routeBuffer = []; routeCursor = 0; isDrawingRoute = false;
      const total = GRID_ROWS * GRID_COLS;
      function step() {
        scanProgress += 15;
        if (scanProgress >= total) {
          scanProgress = total; isScanning = false;
          setTimeout(startRouting, 400);
          return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }, 800);
  }

  function startRouting() {
    showStatus('Rota hesaplanıyor (A*)...', 'route', false);
    // Küçük gecikme — gerçek hesaplama simülasyonu
    setTimeout(() => {
      routeBuffer = computeRoute(rescueBase, targetPoint);
      if (routeBuffer.length === 0) {
        // ERROR STATE
        showStatus('Hedefe ulaşılabilir rota bulunamadı — farklı senaryo deneyin.', 'warning', true);
        return;
      }
      hideStatus();
      routeCursor = 0; isDrawingRoute = true;
      function step() {
        routeCursor += 2;
        if (routeCursor >= routeBuffer.length) {
          routeCursor = routeBuffer.length; isDrawingRoute = false; return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }, 500);
  }

  function resetSimulation() {
    scanProgress = 0; isScanning = false;
    routeBuffer = []; routeCursor = 0; isDrawingRoute = false;
    generateSatelliteData();
    hideStatus();
  }

  // -- Ana render döngüsü --
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    renderTerrain(scanProgress > 0);
    renderMarkers();
    if (routeBuffer.length > 0) renderRoute();

    // Tarama çizgisi animasyonu
    if (isScanning) {
      const scanRow = Math.floor(scanProgress / GRID_COLS);
      const y = scanRow * cellH;
      ctx.fillStyle = 'rgba(0,212,255,0.1)';
      ctx.fillRect(0, y, canvas.width, cellH * 2);
      const grad = ctx.createLinearGradient(0, y - 2, 0, y + 2);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(0.5, 'rgba(0,212,255,0.6)');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(0, y - 2, canvas.width, 4);
    }

    // HUD overlay
    ctx.fillStyle = 'rgba(6,8,26,0.75)';
    const hudW = 280, hudH = 36, hudX = 10, hudY = 10;
    ctx.beginPath(); ctx.roundRect(hudX, hudY, hudW, hudH, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(0,212,255,0.15)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';

    const total = GRID_ROWS * GRID_COLS;
    if (isScanning) {
      const pct = Math.floor((scanProgress / total) * 100);
      ctx.fillStyle = '#00d4ff';
      ctx.fillText(`⏳ AI Tarama: %${pct}  |  ${Math.floor(scanProgress)} / ${total} px`, hudX + 12, hudY + hudH / 2);
      ctx.fillStyle = 'rgba(0,212,255,0.12)';
      ctx.fillRect(hudX, hudY + hudH - 3, hudW, 3);
      ctx.fillStyle = '#00d4ff';
      ctx.fillRect(hudX, hudY + hudH - 3, hudW * (pct / 100), 3);
    } else if (isDrawingRoute) {
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('🗺️ Rota çiziliyor...', hudX + 12, hudY + hudH / 2);
    } else if (routeBuffer.length > 0) {
      ctx.fillStyle = '#00ff88';
      ctx.fillText(`✅ Rota: ${routeBuffer.length} waypoint  |  ~${(routeBuffer.length * 0.118).toFixed(0)}ms`, hudX + 12, hudY + hudH / 2);
    } else if (scanProgress > 0) {
      ctx.fillStyle = '#00d4ff';
      ctx.fillText('✅ Analiz tamamlandı — rota bekleniyor', hudX + 12, hudY + hudH / 2);
    } else {
      ctx.fillStyle = '#8892b0';
      ctx.fillText("🛰️ Analiz Et'e basarak taramayı başlatın", hudX + 12, hudY + hudH / 2);
    }

    requestAnimationFrame(render);
  }

  // Buton event listener'ları
  const btnA = document.getElementById('btnAnalyze');
  const btnR = document.getElementById('btnRoute');
  const btnX = document.getElementById('btnReset');
  if (btnA) btnA.addEventListener('click', () => { resetSimulation(); setTimeout(startAnalysis, 200); });
  if (btnR) btnR.addEventListener('click', () => {
    if (scanProgress >= GRID_ROWS * GRID_COLS) { routeBuffer = []; routeCursor = 0; startRouting(); }
    else startAnalysis();
  });
  if (btnX) btnX.addEventListener('click', resetSimulation);

  resize(); generateSatelliteData(); render();
  window.addEventListener('resize', () => { resize(); generateSatelliteData(); });
}
