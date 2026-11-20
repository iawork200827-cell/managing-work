// Service worker mínimo para poder instalar la app en el celular.
// No guarda nada en caché: siempre carga la versión más nueva desde internet.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
