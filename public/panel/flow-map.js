// ============================================================
//  Mapa de fluxo de dados ao vivo (Canvas)
// ------------------------------------------------------------
//  Desenha: CONSUMIDORES (apps/admin que chamam) → BRIDGE →
//  FONTES (datasources/targets). Cada requisição medida vira um
//  "pacote" animado que percorre o caminho, com tamanho/cor
//  proporcionais aos BYTES REAIS daquela troca. Erros em vermelho.
// ============================================================

import { humanBytes } from "./api.js";

const COL = {
  app: "#36e0c8", bridge: "#7c5cff", src: "#ffb648", err: "#ff5d6c",
  line: "#1d2a44", txt: "#dce6f5", muted: "#7888a8",
};

const LABELS = {
  "firestore-garden": "Firestore garden",
  "firestore-postflow": "Firestore postflow",
  supabase: "Supabase",
};

export class FlowMap {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.left = new Map();   // consumidores
    this.right = new Map();  // fontes
    this.packets = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.bridgePulse = 0;
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._raf = requestAnimationFrame(() => this._tick());
  }

  _resize() {
    const r = this.cv.getBoundingClientRect();
    this.W = Math.max(320, r.width);
    this.H = Math.max(320, r.height);
    this.cv.width = this.W * this.dpr;
    this.cv.height = this.H * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._layout();
  }

  _layout() {
    this.bridge = { x: this.W * 0.5, y: this.H * 0.52, r: 30 };
    const place = (map, x) => {
      const ids = [...map.values()];
      const gap = this.H / (ids.length + 1);
      ids.forEach((n, i) => { n.x = x; n.y = gap * (i + 1); });
    };
    place(this.left, this.W * 0.15);
    place(this.right, this.W * 0.85);
  }

  _node(map, id, label, color) {
    let n = map.get(id);
    if (!n) {
      n = { id, label, color, x: 0, y: 0, glow: 0 };
      map.set(id, n);
      this._layout();
    }
    n.glow = 1;
    return n;
  }

  /** Recebe um evento de telemetria e cria o pacote correspondente. */
  push(evt) {
    const who = evt.principal?.id || "anon";
    const origin = this._node(this.left, who, who, COL.app);

    let dest = null;
    if (evt.kind === "data" && evt.datasource) {
      dest = this._node(this.right, evt.datasource, LABELS[evt.datasource] || evt.datasource, COL.src);
    } else if (evt.kind === "proxy" && evt.target) {
      dest = this._node(this.right, "app:" + evt.target, evt.target, COL.app);
    }

    const bytes = (evt.bytesIn || 0) + (evt.bytesOut || 0);
    this.packets.push({
      from: origin, to: dest, bytes, ok: evt.ok !== false,
      t: 0, speed: 0.012 + Math.random() * 0.006,
      r: Math.max(2.5, Math.min(11, 2.5 + Math.log10(bytes + 1) * 2.2)),
      label: humanBytes(bytes),
    });
    if (this.packets.length > 220) this.packets.splice(0, this.packets.length - 220);
    this.bridgePulse = 1;
  }

  _ptAlong(p) {
    // Caminho: origem -> bridge -> destino (ou só origem -> bridge).
    const a = p.from, b = this.bridge, c = p.to;
    if (!c) {
      return { x: a.x + (b.x - a.x) * p.t, y: a.y + (b.y - a.y) * p.t };
    }
    if (p.t < 0.5) {
      const t = p.t / 0.5;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    const t = (p.t - 0.5) / 0.5;
    return { x: b.x + (c.x - b.x) * t, y: b.y + (c.y - b.y) * t };
  }

  _edge(a, b, active) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = active ? "rgba(124,92,255,.35)" : "rgba(29,42,68,.7)";
    ctx.lineWidth = active ? 1.6 : 1;
    ctx.stroke();
  }

  _dot(n, baseColor) {
    const ctx = this.ctx;
    const glow = n.glow || 0;
    ctx.beginPath();
    ctx.arc(n.x, n.y, 7 + glow * 3, 0, Math.PI * 2);
    ctx.fillStyle = baseColor;
    ctx.shadowBlur = 12 + glow * 18;
    ctx.shadowColor = baseColor;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COL.txt;
    ctx.font = "11px ui-sans-serif, system-ui";
    const isLeft = this.left.has(n.id);
    ctx.textAlign = isLeft ? "right" : "left";
    ctx.fillText(n.label, n.x + (isLeft ? -14 : 14), n.y + 3);
  }

  _tick() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);

    // arestas
    for (const n of this.left.values()) this._edge(n, this.bridge, n.glow > 0.05);
    for (const n of this.right.values()) this._edge(this.bridge, n, n.glow > 0.05);

    // nós
    for (const n of this.left.values()) { this._dot(n, COL.app); n.glow *= 0.94; }
    for (const n of this.right.values()) { this._dot(n, n.color); n.glow *= 0.94; }

    // bridge
    const bp = this.bridgePulse;
    ctx.beginPath();
    ctx.arc(this.bridge.x, this.bridge.y, this.bridge.r + bp * 8, 0, Math.PI * 2);
    ctx.fillStyle = COL.bridge;
    ctx.shadowBlur = 24 + bp * 30; ctx.shadowColor = COL.bridge;
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff"; ctx.font = "700 13px ui-sans-serif, system-ui"; ctx.textAlign = "center";
    ctx.fillText("BRIDGE", this.bridge.x, this.bridge.y + 4);
    this.bridgePulse *= 0.9;

    // pacotes
    for (const p of this.packets) {
      p.t += p.speed;
      const pt = this._ptAlong(p);
      const color = p.ok ? (p.t < 0.5 ? COL.app : (p.to ? p.to.color : COL.bridge)) : COL.err;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowBlur = 14; ctx.shadowColor = color;
      ctx.fill(); ctx.shadowBlur = 0;
      // rótulo de bytes nos pacotes maiores
      if (p.r > 5) {
        ctx.fillStyle = COL.txt; ctx.font = "10px ui-sans-serif"; ctx.textAlign = "center";
        ctx.fillText(p.label, pt.x, pt.y - p.r - 3);
      }
    }
    this.packets = this.packets.filter((p) => p.t < 1);

    this._raf = requestAnimationFrame(() => this._tick());
  }

  destroy() { cancelAnimationFrame(this._raf); }
}
