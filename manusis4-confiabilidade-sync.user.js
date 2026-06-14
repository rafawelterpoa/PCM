// ==UserScript==
// @name         Mills PCM — Sync Confiabilidade
// @namespace    https://rafawelterpoa.github.io/PCM
// @version      6.3
// @description  Sincroniza dados Manusis4 → Firebase PCM automaticamente a cada 1h
// @author       Mills PCM
// @match        https://mills.manusis4.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      mills-frota-default-rtdb.firebaseio.com
// @updateURL    https://rafawelterpoa.github.io/PCM/manusis4-confiabilidade-sync.user.js
// @downloadURL  https://rafawelterpoa.github.io/PCM/manusis4-confiabilidade-sync.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FB_URL = 'https://mills-frota-default-rtdb.firebaseio.com/pcm/confiabilidade.json';
  const COMPANY_ID = 76;
  const TIPO_CORRETIVA = [4, 399];
  const TIPO_PREVENTIVA = [1, 419];
  const TIPO_MTBF = [4, 399, 420]; // Corretiva + Garantia
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

  // Busca mapa completo vehicle_id → code (ex: 110719 → PCP01006)
  async function buscarMapaVeiculos() {
    const mapa = {};
    const primeiro = await fetch('/api/v1/vehicles?limit=25&page=1', { credentials: 'include' }).then(r => r.json());
    const total = primeiro.meta?.count || 0;
    const pages = Math.ceil(total / 25);
    primeiro.data?.forEach(v => { if (v.id && v.code) mapa[v.id] = v.code; });
    for (let p = 2; p <= pages; p += 10) {
      const lote = [];
      for (let i = p; i < Math.min(p + 10, pages + 1); i++)
        lote.push(fetch(`/api/v1/vehicles?limit=25&page=${i}`, { credentials: 'include' }).then(r => r.json()));
      const res = await Promise.all(lote);
      res.forEach(d => d.data?.forEach(v => { if (v.id && v.code) mapa[v.id] = v.code; }));
    }
    return mapa;
  }

  async function buscarTodos(endpoint, filtros, maxPag) {
    let todos = [], pagina = 1;
    const limite = maxPag || 50;
    while (true) {
      const d = await api(endpoint, { limit: 100, page: pagina, filter: filtros });
      if (!d.data || !d.data.length) break;
      todos = todos.concat(d.data);
      if (todos.length >= (d.meta?.count || 0) || d.data.length < 100) break;
      if (++pagina > limite) break;
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
      const ini90 = '2025-07-01 00:00:00'; // desde jul/2025

      const [prevAb, corrAb, emEx, pend] = await Promise.all([
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_PREVENTIVA, operator: 'in' }, { property: 'maint_order_status_id', value: [1, 2], operator: 'in' }] }),
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_CORRETIVA, operator: 'in' }, { property: 'maint_order_status_id', value: [1, 2], operator: 'in' }] }),
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: 3, operator: '=' }] }),
        api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: [1, 2, 3], operator: 'in' }] }),
      ]);

      atualizarBotao('⏳ Corretivas...', true);
      const corr90 = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_CORRETIVA, operator: 'in' }, { property: 'opened_at', value: ini90, operator: '>=' }], 200);

      atualizarBotao('⏳ Pendências...', true);
      const pendAll = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: [1, 2, 3], operator: 'in' }], 200);

      atualizarBotao('⏳ Tipos...', true);
      const tipos90 = await buscarTodos('maint_orders', [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'opened_at', value: ini90, operator: '>=' }], 200);

      atualizarBotao('⏳ OS Fechadas...', true);
      const fechadas90 = await buscarTodos('maint_orders', [
        { property: 'company_id', value: COMPANY_ID, operator: '=' },
        { property: 'closed_at', value: ini90, operator: '>=' }
      ], 200);

      atualizarBotao('⏳ Veículos...', true);
      const veicMapa = await buscarMapaVeiculos();

      const porEquip = {};
      corr90.forEach(os => { const v = os.vehicle_id || os.asset_id; if (!v) return; if (!porEquip[v]) porEquip[v] = { corretivas: 0, pendencias: 0, falhas_mtbf: 0 }; porEquip[v].corretivas++; });
      pendAll.forEach(os => { const v = os.vehicle_id || os.asset_id; if (!v) return; if (!porEquip[v]) porEquip[v] = { corretivas: 0, pendencias: 0, falhas_mtbf: 0 }; porEquip[v].pendencias++; });

      // MTBF: conta falhas (corretiva + garantia) por equipamento
      const mtbfEquip = {};
      tipos90.filter(os => TIPO_MTBF.includes(os.maint_service_type_id)).forEach(os => {
        const v = os.vehicle_id || os.asset_id; if (!v) return;
        mtbfEquip[v] = (mtbfEquip[v] || 0) + 1;
        if (porEquip[v]) porEquip[v].falhas_mtbf = mtbfEquip[v];
      });
      const HORAS_PERIODO = 90 * 24; // 2160h
      const mtbfValues = Object.values(mtbfEquip).filter(n => n > 0).map(n => HORAS_PERIODO / n);
      const mtbf = mtbfValues.length > 0 ? mtbfValues.reduce((a, b) => a + b, 0) / mtbfValues.length : 0;

      const tiposB = {}, natsB = {};
      tipos90.forEach(os => {
        if (os.maint_service_type_id) tiposB[os.maint_service_type_id] = (tiposB[os.maint_service_type_id] || 0) + 1;
        if (os.maint_service_nature_id) natsB[os.maint_service_nature_id] = (natsB[os.maint_service_nature_id] || 0) + 1;
      });

      // Calcula MTTR e horas paradas — só OS com datas válidas e tempo razoável
      const MAX_H_REPARO = 720;  // máx 30 dias de reparo por OS
      const MAX_H_PARADA = 1440; // máx 60 dias parado por OS
      let horasReparo = 0, horasParadas = 0, osComReparo = 0, osComParada = 0;
      fechadas90.forEach(os => {
        if (os.maint_started_at && os.maint_finished_at) {
          const h = (new Date(os.maint_finished_at) - new Date(os.maint_started_at)) / 3600000;
          if (h > 0 && h < MAX_H_REPARO) { horasReparo += h; osComReparo++; }
        }
        if (os.opened_at && os.closed_at) {
          const h = (new Date(os.closed_at) - new Date(os.opened_at)) / 3600000;
          if (h > 0 && h < MAX_H_PARADA) { horasParadas += h; osComParada++; }
        }
      });
      const mttr = osComReparo > 0 ? (horasReparo / osComReparo) : 0;

      const dados = {
        last_sync: agora.toISOString(),
        periodo_dias: 90,
        resumo: {
          preventivas_abertas: prevAb.meta?.count || 0,
          corretivas_abertas: corrAb.meta?.count || 0,
          em_execucao: emEx.meta?.count || 0,
          pendencias_total: pend.meta?.count || 0,
          total_corretivas_90d: corr90.length,
          horas_paradas_90d: horasParadas.toFixed(1),
          horas_reparo_90d: horasReparo.toFixed(1),
          mttr_medio_h: parseFloat(mttr.toFixed(1)),
          mtbf_medio_h: parseFloat(mtbf.toFixed(1)),
          os_fechadas_90d: fechadas90.length
        },
        tipos_manutencao: tiposB,
        naturezas: natsB,
        veiculos_mapa: veicMapa,
        ranking_corretivas: Object.entries(porEquip).filter(([, v]) => v.corretivas > 0).sort((a, b) => b[1].corretivas - a[1].corretivas).slice(0, 20).map(([id, v]) => ({ vehicle_id: parseInt(id), code: veicMapa[id] || ('ID ' + id), ...v })),
        ranking_pendencias: Object.entries(porEquip).filter(([, v]) => v.pendencias > 0).sort((a, b) => b[1].pendencias - a[1].pendencias).slice(0, 20).map(([id, v]) => ({ vehicle_id: parseInt(id), code: veicMapa[id] || ('ID ' + id), ...v }))
      };

      // Proteção: não sobrescreve dados bons com sync vazia (ex: 401 antes do login)
      const totalOS = dados.resumo.preventivas_abertas + dados.resumo.corretivas_abertas + dados.resumo.em_execucao;
      if (totalOS === 0) {
        log('⚠ Sync abortada: zero OS abertas — provável 401 (não logado)');
        atualizarBotao('⚠ Não logado', false);
        setTimeout(() => atualizarBotao('⚙ PCM Sync', false), 4000);
        return;
      }

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
