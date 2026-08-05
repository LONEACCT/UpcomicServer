self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'UPCOMIC', body: event.data ? event.data.text() : 'New update' };
  }

  var title = data.title || 'UPCOMIC';
  var options = {
    body: data.body || '',
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';
  event.waitUntil(clients.openWindow(url));
});
