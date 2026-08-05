/* eslint-disable no-undef, no-unused-vars */
// Service Worker for Draco-X2 Notifications
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle push notifications (if any) or background sync notifications
self.addEventListener('push', (event) => {
  let data = { title: 'Thông báo mới', content: 'Có thông báo mới từ hệ thống.' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Thông báo mới', content: event.data.text() };
    }
  }

  const options = {
    body: data.content,
    icon: 'https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285783/logo_app_va9ksb.png',
    badge: 'https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285783/logo_app_va9ksb.png',
    vibrate: [100, 50, 100],
    data: data,
    tag: 'dracox2-bg-notification',
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Handle click on notification to open custom links
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const deepLink = event.notification.data?.linkTo || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Find open window and navigate
      for (const client of clientList) {
        if ('navigate' in client) {
          client.focus();
          return client.navigate(deepLink);
        }
      }
      
      // If none is open, open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(deepLink);
      }
    })
  );
});
