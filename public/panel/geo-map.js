// ============================================================
//  Globo 3D de telemetria (globe.gl / three.js)
// ------------------------------------------------------------
//  Globo escuro com os servidores/datasources (posições fixas de
//  /v1/geo) e os clientes (geolocalizados por IP nos eventos), com
//  arcos animados cliente → Bridge → fonte. Auto-rotação.
// ============================================================

const COL = { bridge: "#7c5cff", app: "#36e0c8", src: "#ffb648", err: "#ff5d6c" };

export class GeoMap {
  constructor(el) {
    this.el = el;
    this.ready = false;
    this.world = null;
    this.servers = {};
    this.clients = new Map();   // "lat,lng" -> ponto do cliente
    this.points = [];           // servidores + clientes
    this.arcs = [];
    this._ro = null;
  }

  /** Inicializa o globo com as posições dos servidores. Idempotente. */
  init(servers) {
    if (this.ready || typeof Globe === "undefined") return;
    this.servers = servers || {};

    for (const [id, s] of Object.entries(this.servers)) {
      if (!s || typeof s.lat !== "number" || typeof s.lng !== "number") continue;
      this.points.push({
        lat: s.lat, lng: s.lng,
        color: s.kind === "bridge" ? COL.bridge : (s.kind === "src" ? COL.src : COL.app),
        r: s.kind === "bridge" ? 0.95 : 0.6,
        label: s.label || id, server: true,
      });
    }

    // Arcos permanentes Bridge <-> fontes: a "corrente" sempre fluindo.
    const bb = this.servers.bridge;
    if (bb && typeof bb.lat === "number") {
      for (const [id, s] of Object.entries(this.servers)) {
        if (id === "bridge" || !s || typeof s.lat !== "number") continue;
        this.arcs.push({
          startLat: bb.lat, startLng: bb.lng, endLat: s.lat, endLng: s.lng,
          color: s.kind === "src" ? COL.src : COL.app, persist: true,
        });
      }
    }

    this.world = Globe()(this.el)
      .globeImageUrl("//unpkg.com/three-globe/example/img/earth-dark.jpg")
      .bumpImageUrl("//unpkg.com/three-globe/example/img/earth-topology.png")
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true).atmosphereColor("#7c5cff").atmosphereAltitude(0.2)
      .pointsData(this.points)
      .pointLat("lat").pointLng("lng").pointColor("color").pointRadius("r").pointAltitude(0.012)
      .pointLabel("label")
      .arcsData(this.arcs)
      .arcStartLat("startLat").arcStartLng("startLng").arcEndLat("endLat").arcEndLng("endLng")
      .arcColor("color").arcStroke(0.5).arcAltitudeAutoScale(0.45)
      .arcDashLength(0.45).arcDashGap(0.25).arcDashInitialGap(() => Math.random()).arcDashAnimateTime(1500)
      .arcsTransitionDuration(0);

    this.world.pointOfView({ lat: 8, lng: -55, altitude: 2.4 }, 0);
    const c = this.world.controls();
    if (c) { c.autoRotate = true; c.autoRotateSpeed = 0.45; c.enableZoom = true; }

    this._size();
    this._ro = new ResizeObserver(() => this._size());
    this._ro.observe(this.el);
    this.ready = true;
  }

  _size() {
    if (!this.world) return;
    const r = this.el.getBoundingClientRect();
    if (r.width && r.height) this.world.width(r.width).height(r.height);
  }

  /** Chamado quando a aba do globo fica visível (remede o canvas). */
  refresh() { this._size(); }

  /** Recebe um evento de telemetria e plota o cliente + arcos. */
  push(evt) {
    if (!this.ready) return;
    const g = evt && evt.geo;
    if (!g || g.private || typeof g.lat !== "number" || typeof g.lng !== "number") return;

    const key = g.lat.toFixed(1) + "," + g.lng.toFixed(1);
    let c = this.clients.get(key);
    if (!c) {
      const who = evt.principal?.id || "anon";
      const place = [g.city, g.country].filter(Boolean).join(", ") || "—";
      c = { lat: g.lat, lng: g.lng, color: COL.app, r: 0.4, who, place, count: 0, label: "" };
      this.clients.set(key, c);
      this.points.push(c);
    }
    c.count += 1;
    c.r = Math.min(1.1, 0.35 + Math.log2(c.count + 1) * 0.16);
    c.label = `${c.who} · ${c.place} · ${c.count} req`;
    this.world.pointsData(this.points);

    const b = this.servers.bridge;
    if (b && typeof b.lat === "number") {
      this._arc(g.lat, g.lng, b.lat, b.lng, evt.ok === false ? COL.err : COL.app);
      const dest = evt.datasource && this.servers[evt.datasource];
      if (dest && typeof dest.lat === "number") this._arc(b.lat, b.lng, dest.lat, dest.lng, COL.src);
    }
  }

  _arc(sLat, sLng, eLat, eLng, color) {
    this.arcs.push({ startLat: sLat, startLng: sLng, endLat: eLat, endLng: eLng, color, born: performance.now() });
    const now = performance.now();
    const persist = this.arcs.filter((a) => a.persist);
    let trans = this.arcs.filter((a) => !a.persist && now - a.born < 5000);
    if (trans.length > 60) trans = trans.slice(-60);
    this.arcs = [...persist, ...trans];
    this.world.arcsData(this.arcs);
  }

  destroy() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this.ready = false;
  }
}
