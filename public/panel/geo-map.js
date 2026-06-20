// ============================================================
//  Mapa-múndi de telemetria (Leaflet, tema escuro)
// ------------------------------------------------------------
//  Plota os servidores/datasources (posições fixas de /v1/geo) e os
//  clientes (geolocalizados por IP nos eventos de fluxo), com arcos
//  animados cliente → Bridge → fonte de dados. Cores iguais ao grafo.
// ============================================================

const COL = { bridge: "#7c5cff", app: "#36e0c8", src: "#ffb648", err: "#ff5d6c" };

export class GeoMap {
  constructor(el) {
    this.el = el;
    this.ready = false;
    this.map = null;
    this.bridge = null;             // {lat,lng} do nó Bridge
    this.servers = {};
    this.serverMarkers = new Map();
    this.clients = new Map();       // "lat,lng" -> { marker, count, who, place }
    this.arcs = [];
    this._raf = null;
  }

  /** Inicializa o mapa com as posições dos servidores. Idempotente. */
  init(servers) {
    if (this.ready || typeof L === "undefined") return;
    this.servers = servers || {};

    this.map = L.map(this.el, {
      worldCopyJump: true, minZoom: 1, maxZoom: 8,
      zoomControl: false, attributionControl: true,
      scrollWheelZoom: true,
    }).setView([5, -50], 2);
    L.control.zoom({ position: "bottomleft" }).addTo(this.map);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 19,
      attribution: "&copy; OpenStreetMap &copy; CARTO",
    }).addTo(this.map);

    const b = this.servers.bridge;
    if (b && typeof b.lat === "number") this.bridge = { lat: b.lat, lng: b.lng };

    for (const [id, s] of Object.entries(this.servers)) {
      if (!s || typeof s.lat !== "number" || typeof s.lng !== "number") continue;
      const color = s.kind === "bridge" ? COL.bridge : (s.kind === "src" ? COL.src : COL.app);
      const m = L.circleMarker([s.lat, s.lng], {
        radius: s.kind === "bridge" ? 11 : 7,
        color, fillColor: color, fillOpacity: 0.85, weight: 2,
      }).addTo(this.map);
      m.bindTooltip(s.label || id, { direction: "top", opacity: 0.95 });
      this.serverMarkers.set(id, m);
    }

    this.ready = true;
    this._tick();
  }

  /** Leaflet precisa remedir quando o container fica visível. */
  refresh() { if (this.map) this.map.invalidateSize(); }

  /** Recebe um evento de telemetria e plota o cliente + arcos. */
  push(evt) {
    if (!this.ready || !this.bridge) return;
    const g = evt && evt.geo;
    if (!g || g.private || typeof g.lat !== "number" || typeof g.lng !== "number") return;

    const key = g.lat.toFixed(1) + "," + g.lng.toFixed(1);
    let c = this.clients.get(key);
    if (!c) {
      const who = evt.principal?.id || "anon";
      const place = [g.city, g.country].filter(Boolean).join(", ") || "—";
      const marker = L.circleMarker([g.lat, g.lng], {
        radius: 5, color: COL.app, fillColor: COL.app, fillOpacity: 0.8, weight: 1.5,
      }).addTo(this.map);
      c = { marker, count: 0, who, place };
      this.clients.set(key, c);
    }
    c.count += 1;
    c.marker.setStyle({ radius: Math.min(13, 4 + Math.log2(c.count + 1) * 2) });
    c.marker.bindTooltip(`${c.who} · ${c.place} · ${c.count} req`, { direction: "top", opacity: 0.95 });

    const okColor = evt.ok === false ? COL.err : COL.app;
    this._arc([g.lat, g.lng], [this.bridge.lat, this.bridge.lng], okColor);
    const dest = evt.datasource && this.servers[evt.datasource];
    if (dest && typeof dest.lat === "number") {
      this._arc([this.bridge.lat, this.bridge.lng], [dest.lat, dest.lng], COL.src);
    }
  }

  _arc(from, to, color) {
    const pts = this._curve(from, to, 24);
    const line = L.polyline(pts, { color, weight: 1.4, opacity: 0.5 }).addTo(this.map);
    const dot = L.circleMarker(from, { radius: 3.5, color, fillColor: color, fillOpacity: 1, weight: 0 }).addTo(this.map);
    this.arcs.push({ line, dot, pts, born: performance.now() });
    while (this.arcs.length > 80) {
      const old = this.arcs.shift();
      this.map.removeLayer(old.line); this.map.removeLayer(old.dot);
    }
  }

  // Curva quadrática (bezier) entre dois pontos, erguida na perpendicular.
  _curve(a, b, n) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const dist = Math.hypot(dx, dy) || 1;
    const lift = Math.min(dist * 0.25, 28);
    const cx = mx + (-dy / dist) * lift;
    const cy = my + (dx / dist) * lift;
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([
        u * u * a[0] + 2 * u * t * cx + t * t * b[0],
        u * u * a[1] + 2 * u * t * cy + t * t * b[1],
      ]);
    }
    return out;
  }

  _tick() {
    const now = performance.now();
    const LIFE = 1600;
    this.arcs = this.arcs.filter((arc) => {
      const age = now - arc.born;
      if (age > LIFE + 120) { this.map.removeLayer(arc.line); this.map.removeLayer(arc.dot); return false; }
      const t = Math.min(1, age / LIFE);
      const idx = Math.min(arc.pts.length - 1, Math.floor(t * (arc.pts.length - 1)));
      arc.dot.setLatLng(arc.pts[idx]);
      const fade = 1 - t;
      arc.line.setStyle({ opacity: 0.5 * fade });
      arc.dot.setStyle({ fillOpacity: fade });
      return true;
    });
    this._raf = requestAnimationFrame(() => this._tick());
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.map) { this.map.remove(); this.map = null; }
    this.ready = false;
  }
}
