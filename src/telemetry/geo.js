// ============================================================
//  Geolocalização de telemetria
// ------------------------------------------------------------
//  - geoForIp(ip): IP do cliente -> { lat, lng, city, country }
//    via GeoLite2 offline (geoip-lite). Cacheado; IPs privados/locais
//    são marcados como { private:true }.
//  - serverLocations(): posições dos servidores/datasources (datacenters).
//    Ajustáveis via env GEO_OVERRIDES (JSON) se a região real diferir.
// ============================================================

import geoip from "geoip-lite";

// Datacenters conhecidos. lat/lng aproximados da região.
const DEFAULTS = {
  bridge:               { lat: 45.60, lng: -120.50, label: "Bridge · Render Oregon (US)", kind: "bridge" },
  supabase:             { lat: -23.55, lng: -46.63, label: "Supabase · São Paulo (sa-east-1)", kind: "src" },
  "firestore-garden":   { lat: 41.26, lng: -95.86, label: "Firestore garden · us-central", kind: "src" },
  "firestore-postflow": { lat: 41.26, lng: -95.86, label: "Firestore postflow · us-central", kind: "src" },
  midia:                { lat: 45.60, lng: -120.50, label: "Mídia · Render Oregon (US)", kind: "app" },
};

let SERVER_GEO = DEFAULTS;
try {
  if (process.env.GEO_OVERRIDES) {
    SERVER_GEO = { ...DEFAULTS, ...JSON.parse(process.env.GEO_OVERRIDES) };
  }
} catch {
  console.warn("[geo] GEO_OVERRIDES inválido (esperado JSON) — usando padrões.");
}

/** Posições dos servidores/datasources para o mapa do painel. */
export function serverLocations() {
  return SERVER_GEO;
}

const cache = new Map();
// IPv4/IPv6 privados, loopback, link-local.
const PRIVATE = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i;

/** Geolocaliza um IP. Retorna {lat,lng,city,country,region} ou {private:true} ou null. */
export function geoForIp(ip) {
  if (!ip) return null;
  const clean = String(ip).replace(/^::ffff:/, "").trim();
  if (!clean) return null;
  if (PRIVATE.test(clean)) return { private: true, lat: null, lng: null, city: "local", country: "—" };
  if (cache.has(clean)) return cache.get(clean);
  let geo = null;
  try {
    const r = geoip.lookup(clean);
    if (r && Array.isArray(r.ll)) {
      geo = { lat: r.ll[0], lng: r.ll[1], city: r.city || null, country: r.country || null, region: r.region || null };
    }
  } catch {
    /* lookup falho nunca derruba a telemetria */
  }
  cache.set(clean, geo);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return geo;
}
