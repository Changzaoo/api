// ============================================================
//  Gerenciador de apps dinâmicos — painel Nexus Bridge
// ------------------------------------------------------------
//  Permite ao admin criar apps externos com chaves nxs_,
//  definir permissões por datasource e revogar chaves.
// ============================================================

import { apiFetch } from "./api.js";

// Apps gerados recebem acesso total de leitura/escrita a todos os
// datasources (era o estado padrão dos checkboxes). Para restringir,
// edite a coluna `data` da linha na tabela nexus_apps do Supabase.
const FULL_ACCESS = {
  "firestore-garden":   { read: ["*"], write: ["*"] },
  "firestore-postflow": { read: ["*"], write: ["*"] },
  "supabase":           { read: ["*"], write: ["*"] },
};

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- lista ----------

export async function loadApps() {
  const list = $("apps-list");
  try {
    const { apps } = await apiFetch("/v1/admin/apps").then((r) => r.json());
    if (!apps.length) {
      list.innerHTML = '<span class="muted">Nenhum app dinâmico registrado ainda.</span>';
      return;
    }
    list.innerHTML = `
      <table class="apps-table">
        <thead><tr>
          <th>ID</th><th>Nome</th><th>Prefixo da chave</th>
          <th>Datasources</th><th></th>
        </tr></thead>
        <tbody>
          ${apps.map(appRow).join("")}
        </tbody>
      </table>`;
    list.querySelectorAll("[data-revoke]").forEach((btn) => {
      btn.addEventListener("click", () => confirmRevoke(btn.dataset.revoke, btn.dataset.name));
    });
  } catch (e) {
    list.innerHTML = `<span class="error">Erro ao carregar apps: ${esc(e.message)}</span>`;
  }
}

function appRow(app) {
  const dsList = Object.entries(app.data || {})
    .map(([ds, p]) => {
      const r = p.read?.length ? "R" : "";
      const w = p.write?.length ? "W" : "";
      return `<span class="ds-tag">${esc(ds.replace("firestore-", ""))}<sup>${r}${w}</sup></span>`;
    })
    .join(" ") || '<span class="muted">—</span>';

  return `<tr>
    <td><code>${esc(app.id)}</code></td>
    <td>${esc(app.name)}</td>
    <td><code class="key-prefix">${esc(app.keyPrefix)}…</code></td>
    <td>${dsList}</td>
    <td><button class="ghost sm danger" data-revoke="${esc(app.id)}" data-name="${esc(app.name)}">Revogar</button></td>
  </tr>`;
}

async function confirmRevoke(id, name) {
  if (!confirm(`Revogar chave do app "${name}" (${id})? O backend que usa esta chave perderá acesso imediatamente.`)) return;
  try {
    await apiFetch(`/v1/admin/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadApps();
  } catch (e) {
    alert("Erro ao revogar: " + e.message);
  }
}

// ---------- modais ----------

function openNewAppModal() {
  $("app-id").value = "";
  $("app-name").value = "";
  $("app-form-error").hidden = true;
  $("app-modal").hidden = false;
  $("app-id").focus();
}

function closeNewAppModal() {
  $("app-modal").hidden = true;
}

async function submitNewApp() {
  const id = $("app-id").value.trim();
  const name = $("app-name").value.trim();
  const errEl = $("app-form-error");
  errEl.hidden = true;

  if (!id) { errEl.textContent = "ID obrigatório."; errEl.hidden = false; return; }
  if (!name) { errEl.textContent = "Nome obrigatório."; errEl.hidden = false; return; }

  $("app-submit").disabled = true;
  try {
    const res = await apiFetch("/v1/admin/apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, data: FULL_ACCESS, allow: [] }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const { key } = await res.json();
    closeNewAppModal();
    showKeyModal(key);
    await loadApps();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
  } finally {
    $("app-submit").disabled = false;
  }
}

function showKeyModal(key) {
  $("key-value").textContent = key;
  $("key-modal").hidden = false;
}

function closeKeyModal() {
  $("key-value").textContent = "";
  $("key-modal").hidden = true;
}

// ---------- inicialização ----------

export function initAppsManager() {
  $("new-app-btn").addEventListener("click", openNewAppModal);
  $("app-cancel").addEventListener("click", closeNewAppModal);
  $("app-submit").addEventListener("click", submitNewApp);
  $("key-close").addEventListener("click", closeKeyModal);

  $("key-copy").addEventListener("click", () => {
    navigator.clipboard.writeText($("key-value").textContent).catch(() => {});
    $("key-copy").textContent = "Copiado!";
    setTimeout(() => { $("key-copy").textContent = "Copiar"; }, 2000);
  });

  // Fecha modal ao clicar fora.
  $("app-modal").addEventListener("click", (e) => {
    if (e.target === $("app-modal")) closeNewAppModal();
  });
  $("key-modal").addEventListener("click", (e) => {
    if (e.target === $("key-modal")) closeKeyModal();
  });

  loadApps();
}
