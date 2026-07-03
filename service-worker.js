/**
 * Re:Bin Service Worker v1.1.0
 *
 * 전략:
 * - HTML/JS/CSS: stale-while-revalidate (최신 버전 백그라운드 받기)
 * - 이미지/아이콘: cache-first
 * - API/외부 요청: network-first
 *
 * 푸시 알림: 정식 도입 시 활성화 (현재는 placeholder)
 */

const CACHE_VERSION = 'rebin-v2.6.0';
const RUNTIME_CACHE = 'rebin-runtime-v2.6.0';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './data-layer.js',
  './region-data.js',
  './ui.js',
  './app.js',
  './garden.js',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
];

// ============================================================
// INSTALL
// ============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] precache failed', err))
  );
});

// ============================================================
// ACTIVATE — 이전 버전 캐시 정리
// ============================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(n => n !== CACHE_VERSION && n !== RUNTIME_CACHE)
          .map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

// ============================================================
// FETCH
//
// v2.0.1: HTML/JS/CSS는 network-first로 전환.
//   기존 stale-while-revalidate는 옛 캐시를 먼저 보여줘서
//   업데이트 후에도 구버전 화면이 남고, 파일별 갱신 시점이 달라
//   옛 HTML + 새 JS가 섞이는 문제가 있었다.
//   network-first면 온라인일 때 항상 최신을 받고, 오프라인이면 캐시로 폴백.
//   거의 바뀌지 않는 이미지/아이콘만 cache-first 유지.
// ============================================================
const IMAGE_RE = /\.(png|jpg|jpeg|svg|webp|ico|gif)$/i;

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET 요청만 캐시
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 외부 도메인 (API 등) — network-first
  if (url.origin !== location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 이미지/아이콘 — cache-first (거의 변하지 않음)
  if (IMAGE_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // HTML/JS/CSS 및 그 외 — network-first (항상 최신 보장)
  event.respondWith(networkFirst(req));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    throw e;
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

// ============================================================
// PUSH (placeholder — 정식 도입 시 활성화)
// ============================================================
self.addEventListener('push', (event) => {
  const data = (() => {
    try { return event.data ? event.data.json() : {}; }
    catch { return { title: 'Re:Bin', body: event.data ? event.data.text() : '' }; }
  })();

  const title = data.title || 'Re:Bin';
  const options = {
    body: data.body || '새로운 알림이 있습니다',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: data.data || {},
    vibrate: [100, 50, 100],
    tag: data.tag || 'rebin-notification',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(location.origin) && 'focus' in client) {
          if (client.url.endsWith(path)) return client.focus();
          return client.navigate(path).then(c => c.focus());
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(path);
    })
  );
});

// ============================================================
// MESSAGE — skipWaiting 트리거
// ============================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
