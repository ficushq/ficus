# Ficus mobile companion

The native Ficus companion connects to a Ficus instance. The web app also works in mobile browsers.

## Pairing & authentication

Use your instance's HTTPS address and its device-pairing flow. Each connection has its own server credentials; connecting to one server does not grant access to another. A designated demo instance can also let app-store reviewers pair without an account; see [demo-access.md](demo-access.md).

## Consultant chat

The native companion can connect to consultant chats on a paired Ficus server. The same chats are available through the included web app.

## Streaming

The companion uses the paired server's live connection. Reverse proxies must forward WebSocket upgrades; see [reverse proxy setup](reverse-proxy.md).

## Push notifications (APNs)

Native iOS push requires credentials for the native app's Apple push service. Self-hosters do not receive those credentials. The included PWA supports Web Push through your own server; see [notifications](notifications.md).
