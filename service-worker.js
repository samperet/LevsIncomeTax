const CACHE_NAME = "levs-income-tax-v2";
const ASSETS = [
  "./",
  "admin/",
  "index.html",
  "lev-office-background.jpg",
  "lev-icon.svg",
  "site.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const adminPath = new URL("admin/", self.registration.scope).href;
      const existing = clients.find((client) => client.url.includes("/admin") || client.url.includes("admin=1"));

      if (existing) {
        existing.focus();
        return;
      }

      return self.clients.openWindow(adminPath);
    })
  );
});
