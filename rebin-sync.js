(function () {
  'use strict';

  function getServerUrl() {
    try {
      const stored = localStorage.getItem('rebin_server_url');
      if (stored) return stored;
    } catch (e) {}
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'http://localhost:3000';
    }
    if (location.protocol === 'file:') return null;
    return null;
  }

  const SERVER_URL = getServerUrl();
  const HAS_SERVER = !!SERVER_URL;

  let ws = null;
  let reconnectTimer = null;
  let lastUid = null;
  let connecting = false;

  function connect(rfidUid) {
    if (!HAS_SERVER) {
      console.log('[Sync] 서버 미설정 — 오프라인 모드 (localStorage만 사용)');
      return;
    }
    if (connecting) return;
    if (ws && ws.readyState === WebSocket.OPEN && lastUid === rfidUid) return;

    connecting = true;
    lastUid = rfidUid;

    const wsProto = SERVER_URL.startsWith('https://') ? 'wss:' : 'ws:';
    const wsHost = SERVER_URL.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProto}//${wsHost}/ws/realtime?uid=${rfidUid}`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[Sync] WebSocket 생성 실패:', e.message);
      connecting = false;
      return;
    }

    ws.onopen = () => {
      console.log('[Sync] 서버 연결됨:', wsUrl);
      connecting = false;
      clearTimeout(reconnectTimer);
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'measurement' && window.RebinAPI) {
          await window.RebinAPI.addEmission(data.weight_kg, { source: 'device' });
          if (window.toast) {
            window.toast(`측정됨: ${data.weight_kg.toFixed(2)}kg`, 'success', 3000);
          }
          if (window.refreshHomeView) window.refreshHomeView();
          window.dispatchEvent(new CustomEvent('rebin:measurement', { detail: data }));
        } else if (data.type === 'connected') {
          console.log('[Sync] 핸드셰이크 OK:', data.uid);
        }
      } catch (e) {
        console.error('[Sync] 메시지 처리 실패:', e);
      }
    };

    ws.onerror = (e) => {
      console.warn('[Sync] WebSocket 에러');
      connecting = false;
    };

    ws.onclose = () => {
      console.log('[Sync] 연결 종료, 5초 후 재연결...');
      connecting = false;
      if (lastUid) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect(lastUid), 5000);
      }
    };
  }

  function disconnect() {
    lastUid = null;
    clearTimeout(reconnectTimer);
    if (ws) ws.close();
    ws = null;
  }

  async function syncFromServer(rfidUid) {
    if (!HAS_SERVER || !window.RebinAPI) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/v1/measurements?uid=${rfidUid}&limit=1000`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.measurements || data.measurements.length === 0) return;

      const existing = await window.RebinAPI.getEmissions();
      const existingDates = new Set(existing.map(e => e.date));

      const newOnes = data.measurements.filter(m => !existingDates.has(m.date));
      if (newOnes.length === 0) return;

      const records = newOnes.map(m => ({
        date: m.date,
        weightKg: m.weightKg,
        type: 'general',
        source: 'device',
      }));
      await window.RebinAPI.addEmissionsBulk(records);
      console.log(`[Sync] ${newOnes.length}건 서버 데이터 가져옴`);
    } catch (e) {
      console.warn('[Sync] 서버 fetch 실패:', e.message);
    }
  }

  window.RebinSync = {
    serverUrl: SERVER_URL,
    hasServer: HAS_SERVER,
    connect, disconnect, syncFromServer,
    setServerUrl(url) {
      try { localStorage.setItem('rebin_server_url', url); location.reload(); } catch (e) {}
    },
  };

  window.addEventListener('load', async () => {
    if (!HAS_SERVER) return;
    setTimeout(async () => {
      if (window.RebinAPI) {
        const user = await window.RebinAPI.getUser();
        if (user && user.rfidId) {
          syncFromServer(user.rfidId);
          connect(user.rfidId);
        }
      }
    }, 1000);
  });
})();
