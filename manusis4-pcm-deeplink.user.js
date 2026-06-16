// ==UserScript==
// @name         Mills PCM — Abrir OS diretamente
// @namespace    https://rafawelterpoa.github.io/PCM
// @version      1.0
// @description  Abre a OS do Manusis4 diretamente quando chamado pelo PCM via parâmetro pcm_os=ID
// @author       Mills PCM
// @match        https://mills.manusis4.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  // Lê o ID da OS passado pelo PCM na URL (?pcm_os=2842603)
  function getOsId() {
    const match = window.location.href.match(/[?&]pcm_os=(\d+)/);
    return match ? match[1] : null;
  }

  function abrirOS(id, tentativas) {
    tentativas = tentativas || 0;
    if (tentativas > 40) {
      console.warn('[PCM] Timeout — app não carregou para abrir OS', id);
      return;
    }

    try {
      const app = window.Suite && window.Suite.getApplication && window.Suite.getApplication();
      const ctrl = app && app.getController('MaintOrders');
      const Model = window.Ext && window.Ext.ModelManager && window.Ext.ModelManager.getModel('Suite.model.MaintOrder');

      if (ctrl && Model) {
        console.log('[PCM] Abrindo OS ID:', id);
        window.Ext.Ajax.request({
          url: '/api/v1/maint_orders/' + id,
          success: function(response) {
            const json = window.Ext.decode(response.responseText);
            const rec = new Model(json.data || json);
            ctrl.openMaintOrderEdit(rec);
            console.log('[PCM] OS aberta com sucesso!');
          },
          failure: function() {
            console.warn('[PCM] Falha ao carregar OS', id);
          }
        });
        return;
      }
    } catch(e) {
      // App ainda não carregou
    }

    setTimeout(() => abrirOS(id, tentativas + 1), 500);
  }

  const osId = getOsId();
  if (osId) {
    console.log('[PCM] Deep-link detectado, aguardando app carregar... OS ID:', osId);
    // Aguarda 1s para o app iniciar e depois tenta
    setTimeout(() => abrirOS(osId), 1000);
  }
})();
