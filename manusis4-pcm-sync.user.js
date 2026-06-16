// ==UserScript==
// @name         Mills PCM — Sync Máquinas Paradas
// @namespace    https://rafawelterpoa.github.io/PCM
// @version      1.0
// @description  Busca OMs com máquinas paradas no Manusis4 e envia ao Firebase PCM
// @author       Mills PCM
// @match        https://mills.manusis4.com/*
// @grant        GM_xmlhttpRequest
// @connect      mills.manusis4.com
// @connect      mills-frota-default-rtdb.firebaseio.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FB_URL  = 'https://mills-frota-default-rtdb.firebaseio.com/pcm/confiabilidade/maquinas_paradas.json';
  const API_URL = 'https://mills.manusis4.com/api/v1/maint_orders';
  const PAGE_SIZE = 100;

  let _panel   = null;
  let _syncing = false;
  let _log     = [];

  // ── Captura token da sessão ───────────────────────────────────────
  function getToken() {
    const m = document.cookie.match(/token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ── Requisição autenticada ────────────────────────────────────────
  function apiGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          Authorization: 'Token token=' + getToken(),
          Accept: 'application/json',
        },
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error('Parse error: ' + r.responseText.substring(0, 80))); }
        },
        onerror: e => reject(new Error('Erro de rede')),
      });
    });
  }

  // ── Envia ao Firebase ─────────────────────────────────────────────
  function fbPut(data) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'PUT',
        url: FB_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(data),
        onload: resolve,
        onerror: reject,
      });
    });
  }

  // ── Busca todas as OMs paradas (paginando) ────────────────────────
  async function fetchParadas() {
    // Filtros: não cancelada + não fechada + need_asset_stop=true
    // OU: não cancelada + não fechada + tem reserva (frota_reserva)
    const filtroImpacto = JSON.stringify([
      { id: 'need_asset_stop', property: 'need_asset_stop', value: true,  anyMatch: null, joins: null, operator: '=' },
      { id: 'closed_at',       property: 'closed_at',       value: null,  anyMatch: null, joins: null, operator: 'null' },
      { id: 'cancelled_at',    property: 'cancelled_at',    value: null,  anyMatch: null, joins: null, operator: 'null' },
    ]);

    let page = 1;
    let total = null;
    const items = [];

    while (true) {
      const url = API_URL
        + '?serializer_type=grid'
        + '&page=' + page
        + '&start=' + ((page - 1) * PAGE_SIZE)
        + '&limit=' + PAGE_SIZE
        + '&filter=' + encodeURIComponent(filtroImpacto);

      addLog('  ↳ Página ' + page + (total ? ' / ~' + Math.ceil(total / PAGE_SIZE) : '') + '...');
      updatePanel();

      const res = await apiGet(url);
      const rows = res.data || [];
      if (total === null) total = res.meta?.count || 0;

      items.push(...rows);
      addLog('  ✓ ' + items.length + ' / ' + total);
      updatePanel();

      if (rows.length < PAGE_SIZE || items.length >= total) break;
      page++;
    }

    return items;
  }

  // ── Normaliza os dados para o Firebase ───────────────────────────
  function normalizar(oms) {
    return oms.map(o => ({
      id:            o.id,
      om:            o.order_number || o.custom_number || '',
      tag:           o.vehicle_code || o.tag_number || '',
      vehicle_id:    o.vehicle_id,
      localizacao:   [o.second_loc_name, o.third_loc_name, o.fourth_loc_name].filter(Boolean).join(' — '),
      status:        o.maint_order_status_name || '',
      inicio_parada: o.downtime_started_at || o.opened_at || '',
      fechado_em:    o.closed_at || null,
      descricao:     o.description || '',
      modelo:        o.vehicle_model || '',
      solicitante:   o.user_text || '',
      encarregado:   o.employee_team_name || '',
      data_prevista: o.est_finish_at || null,
      impacto:       o.need_asset_stop || false,
      frota_reserva: o.reserve_vehicle_code || null,
    }));
  }

  // ── Sync principal ────────────────────────────────────────────────
  async function syncParadas() {
    if (_syncing) { addLog('⏳ Já sincronizando...'); return; }
    const token = getToken();
    if (!token) { addLog('❌ Token não encontrado — faça login no Manusis4'); updatePanel(); return; }

    _syncing = true;
    updatePanel();
    addLog('🔄 Buscando máquinas paradas...');
    updatePanel();

    try {
      const oms = await fetchParadas();
      addLog('📦 ' + oms.length + ' OMs encontradas');
      updatePanel();

      const itens = normalizar(oms);
      await fbPut({
        items:       itens,
        total:       itens.length,
        importado_em: new Date().toISOString(),
      });

      addLog('💾 Salvo no Firebase!');
      addLog('✅ Concluído — ' + itens.length + ' paradas');
    } catch (e) {
      addLog('❌ Erro: ' + (e.message || '').substring(0, 80));
    }

    _syncing = false;
    updatePanel();
  }

  // ── UI ────────────────────────────────────────────────────────────
  function addLog(msg) {
    _log.unshift('[' + new Date().toLocaleTimeString('pt-BR') + '] ' + msg);
    if (_log.length > 30) _log.length = 30;
  }

  function updatePanel() {
    if (!_panel) return;
    const token = getToken();
    const status = _panel.querySelector('#mpcm-status');
    const logEl  = _panel.querySelector('#mpcm-log');
    const btn    = _panel.querySelector('#mpcm-btn');
    if (status) status.textContent = token ? '🟢 Sessão OK' : '🔴 Sem sessão';
    if (logEl)  logEl.textContent  = _log.slice(0, 12).join('\n');
    if (btn) {
      btn.disabled    = !token || _syncing;
      btn.textContent = _syncing ? '⏳ Sincronizando...' : '▶ Sync Paradas';
    }
  }

  function createPanel() {
    const div = document.createElement('div');
    div.id = 'mpcm-panel';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="color:#F37021;font-size:13px">⚙ PCM Sync</strong>
        <span id="mpcm-status" style="font-size:10px">🔴 Sem sessão</span>
      </div>
      <div style="font-size:10px;opacity:.6;margin-bottom:6px">Máquinas Paradas → Firebase</div>
      <button id="mpcm-btn" disabled style="
        width:100%;padding:7px;background:#F37021;color:#fff;
        border:none;border-radius:5px;cursor:pointer;font-weight:bold;
        margin-bottom:8px;font-size:12px;
      ">▶ Sync Paradas</button>
      <pre id="mpcm-log" style="
        font-size:10px;max-height:160px;overflow-y:auto;
        margin:0;white-space:pre-wrap;opacity:.75;line-height:1.4;
      "></pre>
      <div id="mpcm-toggle" style="text-align:right;margin-top:4px;font-size:10px;cursor:pointer;opacity:.4">minimizar</div>
    `;
    div.style.cssText = `
      position:fixed;bottom:20px;left:20px;z-index:2147483647;
      background:#0f0f1a;color:#eee;padding:12px 14px;
      border-radius:10px;font-family:monospace;font-size:12px;
      width:260px;box-shadow:0 4px 28px rgba(0,0,0,.7);
      border:1px solid #F37021;
    `;
    document.body.appendChild(div);

    div.querySelector('#mpcm-btn').addEventListener('click', syncParadas);

    let minimized = false;
    div.querySelector('#mpcm-toggle').addEventListener('click', () => {
      minimized = !minimized;
      div.querySelector('#mpcm-log').style.display = minimized ? 'none' : '';
      div.querySelector('#mpcm-btn').style.display = minimized ? 'none' : '';
      div.querySelector('#mpcm-toggle').textContent = minimized ? 'expandir' : 'minimizar';
      div.style.width = minimized ? 'auto' : '260px';
    });

    return div;
  }

  function init() {
    if (document.getElementById('mpcm-panel')) return;
    _panel = createPanel();
    addLog('PCM Sync carregado');
    updatePanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 2000));
  } else {
    setTimeout(init, 2000);
  }

})();
