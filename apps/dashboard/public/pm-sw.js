self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'Persistent Memory', body: event.data ? event.data.text() : '' }
  }

  const title = payload.title || 'Persistent Memory'
  const options = {
    body: payload.body || '',
    data: {
      url: payload.data?.url || '/',
      type: payload.data?.type || 'notification',
    },
  }
  if (typeof payload.tag === 'string' && payload.tag.trim()) options.tag = payload.tag

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) return client.navigate(targetUrl)
        return undefined
      }
    }
    return self.clients.openWindow(targetUrl)
  })())
})
