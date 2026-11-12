// The service worker of OresmePro. It does two things.
//
// 1. Python needs SharedArrayBuffer, which browsers only allow on "cross-origin
//    isolated" pages. Isolation is normally switched on by two response
//    headers. On hosts where headers cannot be configured (plain static file
//    servers), this worker adds them to every response instead.
//
// 2. It keeps what the app is made of, so that an installed OresmePro starts
//    without a network: the page and its scripts, and Python itself. Packages
//    that Python fetches later (SciPy, say) are kept from their first use.
//
// The page registers this file as sw.js?app=<build>&python=<version>. A new
// build is a new URL, so a new worker, which lets go of the old build's files.
const params = new URL(self.location.href).searchParams;
const SHELL = `oresme-app-${params.get("app") ?? "dev"}`;
const PYTHON = `oresme-python-${params.get("python") ?? "dev"}`;

// A kept file answers any request for its URL. Servers that send "Vary:
// Origin" would otherwise make the copy fetched here (which has no Origin
// header) invisible to the page's own requests for scripts (which have one).
const SAME_URL = { ignoreVary: true };

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("oresme-") && name !== SHELL && name !== PYTHON) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

/** The same response with the headers that isolate the page. */
function isolated(response) {
  // Opaque responses cannot be re-wrapped; pass them through untouched.
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Which cache a request belongs in, or null if it is not kept. */
function cacheFor(request, url) {
  if (request.method !== "GET") return null;
  if (url.origin === self.location.origin) {
    return url.pathname.includes("/pyodide/") ? PYTHON : SHELL;
  }
  // Packages of the Pyodide distribution, from its CDN: versioned, so they never change.
  return url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/pyodide/") ? PYTHON : null;
}

async function keep(cacheName, request, response) {
  if (response.ok) {
    try {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    } catch {
      // Out of room, or a request that cannot be stored: carry on without it.
    }
  }
  return response;
}

async function respond(request) {
  const url = new URL(request.url);
  const cacheName = cacheFor(request, url);
  if (!cacheName) return fetch(request);
  const cache = await caches.open(cacheName);
  // The page itself comes from the network when there is one, so that a new
  // build is picked up; everything else is named after its content or version.
  if (request.mode === "navigate") {
    try {
      return await keep(cacheName, request, await fetch(request));
    } catch {
      const saved =
        (await cache.match(request, SAME_URL)) ??
        (await cache.match(new URL("./", self.location.href), SAME_URL));
      if (saved) return saved;
      throw new Error("OresmePro is offline and has not been opened here before.");
    }
  }
  const saved = await cache.match(request, SAME_URL);
  return saved ?? keep(cacheName, request, await fetch(request));
}

// The page lists what it loaded before this worker was in charge (on a first
// visit, everything), and what Python is made of: keep those too.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "keep" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    (async () => {
      let kept = 0;
      for (const url of event.data.urls) {
        try {
          const request = new Request(url);
          const cacheName = cacheFor(request, new URL(request.url));
          if (!cacheName) continue;
          const cache = await caches.open(cacheName);
          if (!(await cache.match(request, SAME_URL)))
            await keep(cacheName, request, await fetch(request));
          kept += 1;
        } catch {
          // One file that cannot be fetched does not stop the rest.
        }
      }
      event.source?.postMessage({ type: "kept", count: kept });
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(respond(request).then(isolated));
});
