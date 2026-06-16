// ==UserScript==
// @name         PCM — Power BI Sync
// @namespace    mills-pcm
// @version      1.0
// @description  Sincroniza dados Power BI → Firebase PCM (Máquinas Paradas, Manutenção Campo, Garantia, Avarias)
// @match        https://app.powerbi.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.powerbi.com
// @connect      mills-frota-default-rtdb.firebaseio.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const FB_BASE  = 'https://mills-frota-default-rtdb.firebaseio.com/pcm/bi_sync';
  const GROUP_ID = '5c562232-c632-4b4b-bf0b-391b8ba3e864';
  const PBI_API  = 'https://api.powerbi.com/v1.0/myorg';

  const REPORTS = [
    { id: 'a20495bb-1db6-4da5-9282-a4a03fe4a8db', key: 'maquinas_paradas',  label: 'Máquinas Paradas'  },
    { id: '983ed637-aeda-4685-b502-cca66244bdd3', key: 'manutencao_campo',   label: 'Manutenção Campo'  },
    { id: 'ce632330-2807-43b9-99a3-572983c1fa88', key: 'garantia',           label: 'Garantia'          },
    { id: '88dcd03d-5744-43be-a3db-d8a53d03031b', key: 'avarias',            label: 'Avarias'           },
  ];

  let _token   = null;
  let _panel   = null;
  let _syncing = false;
  let _log     = [];

  // ── Token Capture: fetch ──────────────────────────────────────────
  const _origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (...args) {
    try {
      const h = args[1]?.headers || {};
      const auth = (typeof h.get === 'function'
        ? h.get('Authorization')
        : (h['Authorization'] || h['authorization'])) || '';
      if (auth.startsWith('Bearer ') && auth.length > 200) {
        const t = auth.slice(7);
        if (t !== _token) { _token = t; addLog('🔑 Token capturado'); updatePanel(); }
      }
    } catch (_) {}
    return _origFetch.apply(unsafeWindow, args);
  };

  // ── Token Capture: XHR ───────────────────────────────────────────
  const _OrigXHR = unsafeWindow.XMLHttpRequest;
  unsafeWindow.XMLHttpRequest = function () {
    const xhr = new _OrigXHR();
    const origSet = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = function (name, value) {
      if ((name || '').toLowerCase() === 'authorization'
          && (value || '').startsWith('Bearer ')
          && value.length > 200) {
        const t = value.slice(7);
        if (t !== _token) { _token = t; addLog('🔑 Token (XHR)'); updatePanel(); }
      }
      return origSet(name, value);
    };
    return xhr;
  };

  // ── Power BI API helpers ─────────────────────────────────────────
  function pbiGet(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${PBI_API}/${path}`,
        headers: { Authorization: `Bearer ${_token}` },
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error(r.responseText.substring(0, 120))); }
        },
        onerror: reject,
      });
    });
  }

  function pbiPost(path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${PBI_API}/${path}`,
        headers: { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error(r.responseText.substring(0, 120))); }
        },
        onerror: reject,
      });
    });
  }

  // ── Firebase helper ───────────────────────────────────────────────
  function fbPut(path, data) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'PUT',
        url: `${FB_BASE}/${path}.json`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(data),
        onload: resolve,
        onerror: reject,
      });
    });
  }

  // ── DAX helpers ───────────────────────────────────────────────────
  async function getDatasetId(reportId) {
    const r = await pbiGet(`groups/${GROUP_ID}/reports/${reportId}`);
    if (!r.datasetId) throw new Error(`datasetId não encontrado: ${JSON.stringify(r).substring(0, 80)}`);
    return r.datasetId;
  }

  async function getTables(datasetId) {
    // Tenta INFO.TABLES() primeiro, depois $SYSTEM.TMSCHEMA_TABLES
    const queries = [
      'EVALUATE SELECTCOLUMNS(INFO.TABLES(), "Name", [Name])',
      'EVALUATE $SYSTEM.TMSCHEMA_TABLES',
    ];
    for (const query of queries) {
      try {
        const res = await pbiPost(`groups/${GROUP_ID}/datasets/${datasetId}/executeQueries`, {
          queries: [{ query }],
          serializerSettings: { includeNulls: true },
        });
        addLog(`  [debug] executeQueries resp: ${JSON.stringify(res).substring(0,120)}`);
        const rows = res?.results?.[0]?.tables?.[0]?.rows || [];
        if (rows.length > 0) {
          return rows
            .map(r => r['[Name]'] || r['Name'] || r['[TableID]'] || Object.values(r)[0])
            .filter(n => n && typeof n === 'string' && !n.startsWith('$') && !n.startsWith('DateTable'));
        }
      } catch (e) {
        addLog(`  [debug] query falhou: ${(e.message||'').substring(0,60)}`);
      }
    }
    return [];
  }

  async function getTableData(datasetId, tableName) {
    const res = await pbiPost(`groups/${GROUP_ID}/datasets/${datasetId}/executeQueries`, {
      queries: [{ query: `EVALUATE '${tableName.replace(/'/g, "''")}'` }],
      serializerSettings: { includeNulls: true },
    });
    const rows = res?.results?.[0]?.tables?.[0]?.rows || [];
    // Remove prefix "TableName[ColName]" → "ColName"
    return rows.map(row => {
      const clean = {};
      for (const [k, v] of Object.entries(row)) {
        const col = k.replace(/^[^\[]+\[/, '').replace(/\]$/, '');
        clean[col] = v;
      }
      return clean;
    });
  }

  // ── Sync all reports ──────────────────────────────────────────────
  async function syncAll() {
    addLog('🖱️ Botão clicado');
    updatePanel();

    if (!_token)   { addLog('❌ Sem token'); updatePanel(); return; }
    if (_syncing)  { addLog('⏳ Já sincronizando...'); return; }

    // Testa se GM_xmlhttpRequest está disponível
    if (typeof GM_xmlhttpRequest === 'undefined') {
      addLog('❌ GM_xmlhttpRequest indisponível');
      addLog('Verifique os grants do Tampermonkey');
      updatePanel();
      return;
    }

    _syncing = true;
    updatePanel();

    addLog('🔄 Iniciando sincronização...');

    for (const report of REPORTS) {
      addLog(`\n📊 ${report.label}`);
      updatePanel();
      try {
        const datasetId = await getDatasetId(report.id);
        const tables = await getTables(datasetId);
        addLog(`  ↳ ${tables.length} tabelas`);

        const payload = { _synced_at: new Date().toISOString() };

        for (const table of tables) {
          try {
            const data = await getTableData(datasetId, table);
            payload[table] = data;
            addLog(`  ✅ ${table} (${data.length} linhas)`);
          } catch (e) {
            addLog(`  ⚠️ ${table}: ${(e.message || '').substring(0, 50)}`);
          }
          updatePanel();
        }

        await fbPut(report.key, payload);
        addLog(`  💾 Salvo no Firebase`);
      } catch (e) {
        addLog(`  ❌ Erro: ${(e.message || '').substring(0, 70)}`);
      }
      updatePanel();
    }

    addLog('\n🏁 Concluído!');
    _syncing = false;
    updatePanel();
  }

  // ── UI ────────────────────────────────────────────────────────────
  function addLog(msg) {
    _log.unshift(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);
    if (_log.length > 50) _log.length = 50;
  }

  function updatePanel() {
    if (!_panel) return;
    const status = _panel.querySelector('#pcm-status');
    const logEl  = _panel.querySelector('#pcm-log');
    const btn    = _panel.querySelector('#pcm-btn');
    if (status) status.textContent = _token ? '🟢 Token OK' : '🔴 Aguardando token...';
    if (logEl)  logEl.textContent  = _log.slice(0, 15).join('\n');
    if (btn) {
      btn.disabled    = !_token || _syncing;
      btn.textContent = _syncing ? '⏳ Sincronizando...' : '▶ Sincronizar Agora';
    }
  }

  function createPanel() {
    const div = document.createElement('div');
    div.id = 'pcm-sync-panel';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="color:#00d4aa;font-size:13px">⚙ PCM Sync</strong>
        <span id="pcm-status" style="font-size:10px">🔴 Aguardando token...</span>
      </div>
      <div style="font-size:10px;opacity:.6;margin-bottom:6px">
        Máq. Paradas · Manut. Campo · Garantia · Avarias
      </div>
      <button id="pcm-btn" disabled style="
        width:100%;padding:7px;background:#00d4aa;color:#000;
        border:none;border-radius:5px;cursor:pointer;font-weight:bold;
        margin-bottom:8px;font-size:12px;
      ">▶ Sincronizar Agora</button>
      <pre id="pcm-log" style="
        font-size:10px;max-height:180px;overflow-y:auto;
        margin:0;white-space:pre-wrap;opacity:.75;line-height:1.4;
      "></pre>
      <div id="pcm-toggle" style="text-align:right;margin-top:4px;font-size:10px;cursor:pointer;opacity:.4">
        minimizar
      </div>
    `;
    div.style.cssText = `
      position:fixed;bottom:20px;right:20px;z-index:2147483647;
      background:#0f0f1a;color:#eee;padding:12px 14px;
      border-radius:10px;font-family:monospace;font-size:12px;
      width:270px;box-shadow:0 4px 28px rgba(0,0,0,.7);
      border:1px solid #00d4aa;
    `;
    document.body.appendChild(div);

    div.querySelector('#pcm-btn').addEventListener('click', syncAll);

    // minimizar/expandir
    let minimized = false;
    div.querySelector('#pcm-toggle').addEventListener('click', () => {
      minimized = !minimized;
      div.querySelector('#pcm-log').style.display  = minimized ? 'none' : '';
      div.querySelector('#pcm-btn').style.display  = minimized ? 'none' : '';
      div.querySelector('#pcm-toggle').textContent = minimized ? 'expandir' : 'minimizar';
      div.style.width = minimized ? 'auto' : '270px';
    });

    return div;
  }

  // Init
  function init() {
    if (document.getElementById('pcm-sync-panel')) return;
    _panel = createPanel();
    addLog('Script PCM Sync carregado');
    updatePanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500));
  } else {
    setTimeout(init, 1500);
  }

})();
