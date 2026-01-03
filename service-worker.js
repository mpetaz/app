// TipsterAI Service Worker v3.5.2 - Force Cache Root
// IMPORTANTE: Incrementare VERSION ogni volta che si fanno modifiche significative!
const VERSION = '3.5.12';
const CACHE_NAME = `tipsterai-v${VERSION}`;

// Solo assets statici che cambiano raramente
// NON includere index.html - deve essere sempre fresh dalla rete!
const STATIC_ASSETS = [
    '/logo.png',
    '/icon-192.png',
    '/icon-512.png',
    '/manifest.webmanifest',
    '/',
    '/index.html',
    '/css/app.css',
    '/js/app.js',
    '/js/pwa.js'
];

// Install - cache solo assets statici (NO HTML!)
self.addEventListener('install', event => {
    console.log(`[SW] Installing v${VERSION}...`);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                console.log('[SW] Skip waiting - taking over immediately');
                return self.skipWaiting();
            })
            .catch(err => console.log('[SW] Cache failed:', err))
    );
});

// Activate - pulisci TUTTE le vecchie cache e prendi controllo
self.addEventListener('activate', event => {
    console.log(`[SW] Activating v${VERSION}...`);
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => {
            console.log('[SW] Claiming all clients');
            return self.clients.claim();
        }).then(() => {
            // Notifica tutti i client che c'è un nuovo SW
            return self.clients.matchAll().then(clients => {
                clients.forEach(client => {
                    client.postMessage({ type: 'SW_UPDATED', version: VERSION });
                });
            });
        })
    );
});

// Fetch - NETWORK FIRST per HTML, cache solo per assets
self.addEventListener('fetch', event => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Skip Firebase/API requests - sempre dalla rete
    if (url.hostname.includes('firebaseio.com') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('gstatic.com') ||
        url.hostname.includes('cloudfunctions.net')) {
        return;
    }

    // Skip chrome-extension e altri schemi non-http
    if (!url.protocol.startsWith('http')) {
        return;
    }

    // Per HTML: SEMPRE dalla rete, NO cache
    if (event.request.headers.get('accept')?.includes('text/html') ||
        url.pathname === '/' ||
        url.pathname.endsWith('.html')) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // NETWORK FIRST: Se ok, clona e aggiorna cache per la prossima volta (FIX per PWA)
                    if (response.status === 200) {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(event.request, responseClone);
                        }).catch(err => console.log('[SW] Cache update error:', err));
                    }
                    return response;
                })
                .catch(() => {
                    // OFFLINE: Mostra versione in cache
                    return caches.match(event.request)
                        .then(response => {
                            // Fallback a root se la pagina specifica non c'è
                            return response || caches.match('/') || caches.match('/index.html');
                        });
                })
        );
        return;
    }

    // Per altri assets: Network first con cache fallback
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache solo risposte valide E solo URL http/https (no chrome-extension!)
                const requestUrl = event.request.url;
                if (response.status === 200 && requestUrl.startsWith('http')) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    }).catch(err => {
                        // Ignora errori di cache (es. quota superata)
                        console.log('[SW] Cache put error (ignored):', err.message);
                    });
                }
                return response;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});

// Handle messages
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
    if (event.data === 'getVersion') {
        event.source.postMessage({ type: 'VERSION', version: VERSION });
    }
});

console.log(`[SW] Service Worker v${VERSION} loaded`);
