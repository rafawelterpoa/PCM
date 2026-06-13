// ==UserScript==
// @name         Mills PCM — Sync Confiabilidade
// @namespace    https://rafawelterpoa.github.io/PCM
// @version      4.0
// @description  Sincroniza dados Manusis4 → Firebase PCM automaticamente a cada 1h
// @author       Mills PCM
// @match        https://mills.manusis4.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      mills-frota-default-rtdb.firebaseio.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FB_URL = 'https://mills-frota-default-rtdb.firebaseio.com/pcm/confiabilidade.json';
  const COMPANY_ID = 76;
  const TIPO_CORRETIVA = [4, 399];
  const TIPO_PREVENTIVA = [1, 419];
  const INTERVALO_H = 1;

  function log(msg) { console.log('[PCM Sync]', msg); }

  // Requisição à API do Manusis4 (mesma origem — sem CORS)
  async function api(path, params = {}) {
    const qs = Object.entries(params).map(([k, v]) =>
      k === 'filter' ? `filter=${encodeURIComponent(JSON.stringify(v))}` : `${k}=${v}`
    ).join('&');
    const r = await fetch('/api/v1/' + path + (qs ? '?' + qs : ''), { credentials: 'include' });
    return r.json();
  }

  // Salva no Firebase via GM_xmlhttpRequest (bypassa proxy corporativo)
  function fbSalvar(dados) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'PUT',
        url: FB_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(dados),
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) resolve(r);
          else reject(new Error('Firebase status: ' + r.status));
        },
        onerror: (e) => reject(new Error('Firebase erro: ' + JSON.stringify(e)))
      });
    });
  }

  async function buscarTodos(endpoint, filtros) {
    let todos = [], pagina = 1;
    while (true) {
      const d = await api(endpoint, { limit: 100, start: (pagina - 1) * 100, filter: filtros });
      if (!d.data || !d.data.length) break;
      todos = todos.concat(d.data);
      if (todos.length >= (d.meta?.count || 0) || d.data.length < 100) break;
      if (++pagina > 30) break;
    }
    return todos;
  }

  function atualizarBotao(txt, disabled = false) {
    const btn = document.getElementById('pcm-sync-btn');
    if (btn) { btn.textContent = txt; btn.disabled = disabled; }
  }

  async function sincronizar() {
    atualizarBotao('⏳ Coletando...', true);
    try {
      const agora = new Date();
      const h90 = new Date(agora); h90.setDate(h90.getDate() - 90);
      const ini90 = h90.toISOString().slice(0, 19).replace('T', ' ');

      const [prevAb, corrAb, emEx, pend] = await Promise.all([
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_PREVENTIVA, operator: 'in' }, { property: 'maint_order_status_id', value: [1, 2], operator: 'in' }] }),
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_CORRETIVA, operator: 'in' }, { property: 'maint_order_status_id', value: [1, 2], operator: 'in' }] }),
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: 3, operator: '=' }] }),
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: [1, 2, 3], operator: 'in' }] }),
      ]);

      atualizarBotao('⏳ Corretivas...', true);
      const corr90 = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_CORRETIVA, operator: 'in' }, { property: 'opened_at', value: ini90, operator: '>=' }]);

      atualizarBotao('⏳ Pendências...', true);
      const pendAll = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: [1, 2, 3], operator: 'in' }]);

      atualizarBotao('⏳ Tipos...', true);
      const tipos90 = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'opened_at', value: ini90, operator: '>=' }]);

      const porEquip = {};
      corr90.forEach(os => { const v = os.vehicle_id || os.asset_id; if (!v) return; if (!porEquip[v]) porEquip[v] = { corretivas: 0, pendencias: 0 }; porEquip[v].corretivas++; });
      pendAll.forEach(os => { const v = os.vehicle_id || os.asset_id; if (!v) return; if (!porEquip[v]) porEquip[v] = { corretivas: 0, pendencias: 0 }; porEquip[v].pendencias++; });

      const tiposB = {}, natsB = {};
      tipos90.forEach(os => {
        if (os.maint_service_type_id) tiposB[os.maint_service_type_id] = (tiposB[os.maint_service_type_id] || 0) + 1;
        if (os.maint_service_nature_id) natsB[os.maint_service_nature_id] = (natsB[os.maint_service_nature_id] || 0) + 1;
      });

      const dados = {
        last_sync: agora.toISOString(),
        periodo_dias: 90,
        resumo: {
          preventivas_abertas: prevAb.meta?.count || 0,
          corretivas_abertas: corrAb.meta?.count || 0,
          em_execucao: emEx.meta?.count || 0,
          pendencias_total: pend.meta?.count || 0,
          total_corretivas_90d: corr90.length,
          horas_paradas_90d: '0.0', horas_reparo_90d: '0.0', mttr_medio_h: 0, os_fechadas_90d: 0
        },
        tipos_manutencao: tiposB,
        naturezas: natsB,
        ranking_corretivas: Object.entries(porEquip).filter(([, v]) => v.corretivas > 0).sort((a, b) => b[1].corretivas - a[1].corretivas).slice(0, 20).map(([id, v]) => ({ vehicle_id: parseInt(id), ...v })),
        ranking_pendencias: Object.entries(porEquip).filter(([, v]) => v.pendencias > 0).sort((a, b) => b[1].pendencias - a[1].pendencias).slice(0, 20).map(([id, v]) => ({ vehicle_id: parseInt(id), ...v }))
      };

      atualizarBotao('⏳ Salvando...', true);
      await fbSalvar(dados);

      const hora = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      GM_setValue('last_sync', agora.toISOString());
      atualizarBotao('✅ ' + hora, false);
      setTimeout(() => atualizarBotao('⚙ PCM Sync', false), 5000);
      log('✅ Sincronização concluída: ' + hora);

    } catch (e) {
      log('❌ Erro: ' + e.message);
      atualizarBotao('❌ Erro', false);
      setTimeout(() => atualizarBotao('⚙ PCM Sync', false), 4000);
    }
  }

  function adicionarBotao() {
    if (document.getElementById('pcm-sync-btn')) return;

    const lastSync = GM_getValue('last_sync', null);
    const label = lastSync
      ? '✅ ' + new Date(lastSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : '⚙ PCM Sync';

    const btn = document.createElement('button');
    btn.id = 'pcm-sync-btn';
    btn.textContent = label;
    btn.title = 'Sincroniza dados com PCM (automático a cada 1h)';
    btn.style.cssText = 'position:fixed;bottom:20px;left:20px;background:#F37021;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    btn.onclick = () => sincronizar();
    document.body.appendChild(btn);

    // Sync automático a cada 1h
    setInterval(() => sincronizar(), INTERVALO_H * 60 * 60 * 1000);
    log('✅ Sync automático ativado — a cada ' + INTERVALO_H + 'h');

    // Primeira sync ao abrir (se não sincronizou nas últimas 1h)
    if (!lastSync || (Date.now() - new Date(lastSync).getTime()) > INTERVALO_H * 60 * 60 * 1000) {
      setTimeout(() => sincronizar(), 3000);
    }
  }

  const wait = setInterval(() => {
    if (typeof Suite !== 'undefined') { clearInterval(wait); adicionarBotao(); }
  }, 1000);

})();
