// ============================================================
//  Explorador de dados — leitura via Data API (read).
//  Lista datasources disponíveis e consulta coleções/tabelas.
// ============================================================

import { getJSON } from "./api.js";

export function initExplorer() {
  const dsSel = document.getElementById("ds");
  const resInput = document.getElementById("resource");
  const limitInput = document.getElementById("qlimit");
  const runBtn = document.getElementById("run");
  const out = document.getElementById("exp-out");

  // Popula o seletor de datasources (catálogo do principal).
  getJSON("/v1/data/").then(({ datasources }) => {
    dsSel.innerHTML = "";
    for (const d of datasources) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${d.label}${d.ready ? "" : " (offline)"}`;
      opt.disabled = !d.ready;
      dsSel.appendChild(opt);
    }
  }).catch((e) => { out.textContent = "falha ao listar datasources: " + e.message; });

  async function run() {
    const ds = dsSel.value;
    const resource = resInput.value.trim();
    const limit = Math.max(1, Math.min(200, Number(limitInput.value) || 20));
    if (!ds || !resource) { out.textContent = "informe datasource e recurso."; return; }
    out.textContent = "consultando…";
    out.classList.add("muted");
    try {
      const data = await getJSON(`/v1/data/${encodeURIComponent(ds)}/${encodeURIComponent(resource)}?limit=${limit}`);
      renderTable(out, data.items || []);
    } catch (e) {
      out.classList.add("muted");
      out.textContent = "erro: " + e.message;
    }
  }

  runBtn.addEventListener("click", run);
  resInput.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
}

function renderTable(out, items) {
  out.classList.remove("muted");
  if (!items.length) { out.textContent = "nenhum registro."; return; }
  const cols = [...new Set(items.flatMap((it) => Object.keys(it)))].slice(0, 12);
  const esc = (v) => String(v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : v))
    .replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const head = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const rows = items.map((it) => `<tr>${cols.map((c) => `<td title="${esc(it[c])}">${esc(it[c])}</td>`).join("")}</tr>`).join("");
  out.innerHTML = `<table class="grid"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}
