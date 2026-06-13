// ==UserScript==
// @name         Mills PCM — Sync Confiabilidade
// @namespace    https://rafawelterpoa.github.io/PCM
// @version      3.0
// @description  Coleta dados do Manusis4 e baixa JSON para importar no PCM (a cada 1h)
// @author       Mills PCM
// @match        https://mills.manusis4.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const COMPANY_ID = 76;
  const TIPO_CORRETIVA = [4, 399];
  const TIPO_PREVENTIVA = [1, 419];
  const INTERVALO_H = 1;

  function log(msg) { console.log('[PCM Sync]', msg); }

  async function api(path, params = {}) {
    const qs = Object.entries(params).map(([k, v]) =>
      k === 'filter' ? `filter=${encodeURIComponent(JSON.stringify(v))}` : `${k}=${v}`
    ).join('&');
    const r = await fetch('/api/v1/' + path + (qs ? '?' + qs : ''), { credentials: 'include' });
    return r.json();
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

  function downloadJSON(dados) {
    const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pcm-confiabilidade.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

      atualizarBotao('⏳ Corretivas...');
      const corr90 = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_CORRETIVA, operator: 'in' }, { property: 'opened_at', value: ini90, operator: '>=' }]);

      atualizarBotao('⏳ Pendências...');
      const pendAll = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: [1, 2, 3], operator: 'in' }]);

      atualizarBotao('⏳ Tipos...');
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

      downloadJSON(dados);
      const hora = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      atualizarBotao('✅ ' + hora + ' — Importe no PCM', false);
      setTimeout(() => atualizarBotao('⚙ PCM Sync', false), 10000);
      log('✅ JSON baixado! Importe em Confiabilidade no PCM.');
    } catch (e) {
      log('Erro: ' + e.message);
      atualizarBotao('❌ Erro — tente novamente', false);
      setTimeout(() => atualizarBotao('⚙ PCM Sync', false), 4000);
    }
  }

  function adicionarBotao() {
    if (document.getElementById('pcm-sync-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'pcm-sync-btn';
    btn.textContent = '⚙ PCM Sync';
    btn.title = `Baixa dados para importar no PCM (automático a cada ${INTERVALO_H}h)`;
    btn.style.cssText = 'position:fixed;bottom:20px;left:20px;background:#F37021;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    btn.onclick = () => sincronizar();
    document.body.appendChild(btn);
    setInterval(() => sincronizar(), INTERVALO_H * 60 * 60 * 1000);
    log('✅ PCM Sync configurado — a cada ' + INTERVALO_H + 'h');
  }

  const wait = setInterval(() => {
    if (typeof Suite !== 'undefined') { clearInterval(wait); adicionarBotao(); }
  }, 1000);
})();
