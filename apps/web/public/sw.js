// Claude 管制室の Service Worker：プッシュ通知の表示と、通知を押したときに画面を開く処理だけを行う
// （画面のキャッシュはしない。常に最新の状態を Mac Mini から取る）

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Claude 管制室", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Claude 管制室", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ("navigate" in w) await w.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
