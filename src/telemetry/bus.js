// ============================================================
//  Event bus de telemetria (em memória)
// ------------------------------------------------------------
//  Um único EventEmitter por processo. Cada requisição medida vira
//  um evento "flow". Mantém um buffer circular dos últimos N eventos
//  para replay imediato quando um cliente SSE conecta (backlog).
// ============================================================

import { EventEmitter } from "node:events";

const BUFFER_SIZE = Number(process.env.TELEMETRY_BUFFER) || 200;

class TelemetryBus extends EventEmitter {
  constructor(size = BUFFER_SIZE) {
    super();
    this.setMaxListeners(0); // muitos clientes SSE podem assinar
    this.size = size;
    /** @type {object[]} buffer circular dos últimos eventos */
    this.buffer = [];
  }

  /** Publica um evento de fluxo: guarda no buffer e emite para os assinantes. */
  publish(evt) {
    this.buffer.push(evt);
    if (this.buffer.length > this.size) this.buffer.shift();
    this.emit("flow", evt);
  }

  /** Últimos eventos (para replay no connect). */
  backlog() {
    return this.buffer.slice();
  }
}

export const bus = new TelemetryBus();
