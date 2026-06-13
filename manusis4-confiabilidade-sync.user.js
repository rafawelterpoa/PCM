// ==UserScript==
// @name         Mills PCM — Sync Confiabilidade
// @namespace    https://rafawelterpoa.github.io/PCM
// @version      1.0
// @description  Sincroniza dados de confiabilidade do Manusis4 para o Firebase do PCM
// @author       Mills PCM
// @match        https://mills.manusis4.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FB_BASE = 'https://mills-frota-default-rtdb.firebaseio.com/pcm/confiabilidade';
  const COMPANY_ID = 76; // Mills

  // IDs dos tipos de manutenção
  const TIPO_CORRETIVA = [4, 399];       // Corretiva, Corretiva Programada
  const TIPO_PREVENTIVA = [1, 419];      // Preventive, Preventiva
  const STATUS_ABERTA = 1;
  const STATUS_PROGRAMADA = 2;
  const STATUS_EM_EXECUCAO = 3;
  const STATUS_FECHADA = 4;
  const STATUS_CANCELADA = 5;

  function log(msg) { console.log('[PCM Confiab]', msg); }

  async function api(path, params = {}) {
    const base = '/api/v1/' + path;
    const qs = Object.entries(params).map(([k, v]) =>
      k === 'filter' ? `filter=${encodeURIComponent(JSON.stringify(v))}` : `${k}=${v}`
    ).join('&');
    const r = await fetch(base + (qs ? '?' + qs : ''), { credentials: 'include' });
    return r.json();
  }

  async function fbPut(path, data) {
    await fetch(`${FB_BASE}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  async function buscarTodos(endpoint, filtros, campos) {
    let todos = [], pagina = 1, limite = 100;
    while (true) {
      const d = await api(endpoint, { limit: limite, start: (pagina - 1) * limite, filter: filtros });
      if (!d.data || !d.data.length) break;
      todos = todos.concat(d.data);
      if (todos.length >= d.meta?.count || d.data.length < limite) break;
      pagina++;
      if (pagina > 50) break; // segurança: máximo 5000 registros
    }
    return todos;
  }

  async function sincronizar() {
    log('Iniciando sincronização...');
    const agora = new Date();
    const hoje = agora.toISOString().slice(0, 10);
    const h90dias = new Date(agora); h90dias.setDate(h90dias.getDate() - 90);
    const inicio90 = h90dias.toISOString().slice(0, 19).replace('T', ' ');

    // ── 1. Resumo de OS abertas ──
    log('Buscando resumo...');
    const [prevAbertas, corrAbertas, emExec, pendentes] = await Promise.all([
      api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_PREVENTIVA, operator: 'in' }, { property: 'maint_order_status_id', value: [STATUS_ABERTA, STATUS_PROGRAMADA], operator: 'in' }] }),
      api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_service_type_id', value: TIPO_CORRETIVA, operator: 'in' }, { property: 'maint_order_status_id', value: [STATUS_ABERTA, STATUS_PROGRAMADA], operator: 'in' }] }),
      api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: STATUS_EM_EXECUCAO, operator: '=' }] }),
      api('maint_orders', { limit: 1, filter: [{ property: 'company_id', value: COMPANY_ID, operator: '=' }, { property: 'maint_order_status_id', value: [STATUS_ABERTA, STATUS_PROGRAMADA, STATUS_EM_EXECUCAO], operator: 'in' }] }),
    ]);

    // ── 2. OS fechadas nos últimos 90 dias para MTTR/MTBF ──
    log('Buscando OS fechadas 90 dias...');
    const fechadas90 = await buscarTodos('maint_orders', [
      { property: 'company_id', value: COMPANY_ID, operator: '=' },
      { property: 'maint_order_status_id', value: STATUS_FECHADA, operator: '=' },
      { property: 'closed_at', value: inicio90, operator: '>=' },
      { property: 'maint_started_at', value: null, operator: 'isnotnull' },
      { property: 'maint_finished_at', value: null, operator: 'isnotnull' }
    ]);

    // ── 3. Ranking de corretivas por equipamento (90 dias) ──
    log('Buscando corretivas 90 dias...');
    const corretivas90 = await buscarTodos('maint_orders', [
      { property: 'company_id', value: COMPANY_ID, operator: '=' },
      { property: 'maint_service_type_id', value: TIPO_CORRETIVA, operator: 'in' },
      { property: 'opened_at', value: inicio90, operator: '>=' }
    ]);

    // ── 4. Pendências por equipamento ──
    log('Buscando pendências...');
    const pendencias = await buscarTodos('maint_orders', [
      { property: 'company_id', value: COMPANY_ID, operator: '=' },
      { property: 'maint_order_status_id', value: [STATUS_ABERTA, STATUS_PROGRAMADA, STATUS_EM_EXECUCAO], operator: 'in' }
    ]);

    // ── 5. Breakdown por tipo de manutenção (90 dias) ──
    log('Buscando tipos...');
    const tiposOs = await buscarTodos('maint_orders', [
      { property: 'company_id', value: COMPANY_ID, operator: '=' },
      { property: 'opened_at', value: inicio90, operator: '>=' }
    ]);

    // ── Calcular MTTR e horas paradas ──
    let totalRepairH = 0, countRepair = 0, totalDowntimeH = 0;
    const porEquip = {};

    fechadas90.forEach(os => {
      const veId = os.vehicle_id || os.asset_id;
      if (!veId) return;
      if (!porEquip[veId]) porEquip[veId] = { corretivas: 0, pendencias: 0, repair_h: 0, downtime_h: 0, count_repair: 0 };

      if (os.maint_started_at && os.maint_finished_at) {
        const h = (new Date(os.maint_finished_at) - new Date(os.maint_started_at)) / 3600000;
        totalRepairH += h; countRepair++;
        porEquip[veId].repair_h += h;
        porEquip[veId].count_repair++;
      }
      if (os.downtime_started_at && os.downtime_finished_at) {
        const h = (new Date(os.downtime_finished_at) - new Date(os.downtime_started_at)) / 3600000;
        totalDowntimeH += h;
        porEquip[veId].downtime_h += h;
      }
    });

    corretivas90.forEach(os => {
      const veId = os.vehicle_id || os.asset_id;
      if (!veId) return;
      if (!porEquip[veId]) porEquip[veId] = { corretivas: 0, pendencias: 0, repair_h: 0, downtime_h: 0, count_repair: 0 };
      porEquip[veId].corretivas++;
    });

    pendencias.forEach(os => {
      const veId = os.vehicle_id || os.asset_id;
      if (!veId) return;
      if (!porEquip[veId]) porEquip[veId] = { corretivas: 0, pendencias: 0, repair_h: 0, downtime_h: 0, count_repair: 0 };
      porEquip[veId].pendencias++;
    });

    // Ranking top 20 corretivas
    const rankingCorretivas = Object.entries(porEquip)
      .filter(([, v]) => v.corretivas > 0)
      .sort((a, b) => b[1].corretivas - a[1].corretivas)
      .slice(0, 20)
      .map(([veId, v]) => ({ vehicle_id: parseInt(veId), ...v }));

    // Ranking top 20 pendências
    const rankingPendencias = Object.entries(porEquip)
      .filter(([, v]) => v.pendencias > 0)
      .sort((a, b) => b[1].pendencias - a[1].pendencias)
      .slice(0, 20)
      .map(([veId, v]) => ({ vehicle_id: parseInt(veId), ...v }));

    // Breakdown tipos de manutenção
    const tiposBreakdown = {};
    tiposOs.forEach(os => {
      const t = os.maint_service_type_id;
      if (!tiposBreakdown[t]) tiposBreakdown[t] = 0;
      tiposBreakdown[t]++;
    });

    // Naturezas breakdown
    const naturezasBreakdown = {};
    tiposOs.forEach(os => {
      const n = os.maint_service_nature_id;
      if (!n) return;
      if (!naturezasBreakdown[n]) naturezasBreakdown[n] = 0;
      naturezasBreakdown[n]++;
    });

    // MTTR médio
    const mttr = countRepair > 0 ? (totalRepairH / countRepair).toFixed(1) : 0;

    // ── Salvar no Firebase ──
    const payload = {
      last_sync: agora.toISOString(),
      periodo_dias: 90,
      resumo: {
        preventivas_abertas: prevAbertas.meta?.count || 0,
        corretivas_abertas: corrAbertas.meta?.count || 0,
        em_execucao: emExec.meta?.count || 0,
        pendencias_total: pendentes.meta?.count || 0,
        os_fechadas_90d: fechadas90.length,
        horas_paradas_90d: totalDowntimeH.toFixed(1),
        horas_reparo_90d: totalRepairH.toFixed(1),
        mttr_medio_h: mttr,
        total_corretivas_90d: corretivas90.length
      },
      tipos_manutencao: tiposBreakdown,
      naturezas: naturezasBreakdown,
      ranking_corretivas: rankingCorretivas,
      ranking_pendencias: rankingPendencias
    };

    await fbPut('', payload);
    log('✅ Sincronização concluída!');
    showNotificacao('✅ Confiabilidade sincronizada com PCM');
  }

  function showNotificacao(msg) {
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#004042;color:#6BFAC7;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.3)';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 4000);
  }

  function adicionarBotao() {
    if (document.getElementById('pcm-sync-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'pcm-sync-btn';
    btn.textContent = '⚙ PCM Sync';
    btn.style.cssText = 'position:fixed;bottom:20px;left:20px;background:#F37021;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    btn.onclick = async () => {
      btn.textContent = '⏳ Sincronizando...';
      btn.disabled = true;
      await sincronizar();
      btn.textContent = '✅ Sincronizado';
      setTimeout(() => { btn.textContent = '⚙ PCM Sync'; btn.disabled = false; }, 3000);
    };
    document.body.appendChild(btn);
  }

  // Aguarda app carregar e adiciona botão
  const wait = setInterval(() => {
    if (typeof Suite !== 'undefined') {
      clearInterval(wait);
      adicionarBotao();
      // Auto-sync na abertura (se quiser, descomente):
      // sincronizar();
    }
  }, 1000);

})();
