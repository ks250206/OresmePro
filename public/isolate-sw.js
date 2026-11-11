// Python needs SharedArrayBuffer, which browsers only allow on "cross-origin
// isolated" pages. Isolation is normally switched on by two response headers.
// On hosts where headers cannot be configured (plain static file servers),
// this service worker adds them to every response instead.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(
    fetch(request).then((response) => {
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
    }),
  );
});
