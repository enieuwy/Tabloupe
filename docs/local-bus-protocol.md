# Local bus protocol

Tabloupe connects out to the local `mac-command-centre` WebSocket server at `ws://127.0.0.1:8767`. Frames are UTF-8 JSON text. Versioned frames carry `schemaVersion: 1`.

## Pairing handshake

The daemon generates and persists a 64-character lowercase hex pairing token. The HMAC key is the UTF-8 bytes of that hex string. Every new connection starts in an unauthenticated state.

1. Daemon sends the first frame with a fresh 16-byte nonce encoded as 32 lowercase hex characters:

```json
{"type":"hello","schemaVersion":1,"payload":{"nonce":"0123456789abcdeffedcba9876543210","authRequired":true}}
```

2. Client replies with its own fresh 16-byte nonce and a client MAC:

```json
{"type":"auth","schemaVersion":1,"payload":{"clientNonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mac":"<hex HMAC-SHA256>"}}
```

Client MAC input string:

```text
tabloupe-client|<daemon nonce>|<client nonce>
```

3. On success, daemon replies with a server MAC:

```json
{"type":"authOk","schemaVersion":1,"payload":{"mac":"<hex HMAC-SHA256>"}}
```

Server MAC input string:

```text
tabloupe-server|<client nonce>|<daemon nonce>
```

4. On failure, daemon sends and closes:

```json
{"type":"authFail","schemaVersion":1}
```

The client verifies the `authOk` MAC before trusting later frames. If the daemon sends `hello` but Tabloupe has no valid token, Tabloupe closes the socket and reports pairing required. If WebCrypto is unavailable, Tabloupe cannot authenticate and treats an auth-required `hello` as pairing failed.

## `lensState`

Tabloupe publishes the current persisted lens state once the socket reaches authenticated or legacy mode, and after each successful persisted activation. Transient per-window views are not published.

```json
{"type":"lensState","schemaVersion":1,"payload":{"activeView":{"kind":"lens","lensId":"lens_work"},"lens":{"id":"lens_work","name":"Work","icon":"briefcase","color":"#0060df"},"lastActivation":{"trigger":"manual","at":1783450000000}}}
```

For All Groups, `activeView` is `{"kind":"all"}` and `lens` is `null`.

## `activateView`

Authenticated peers may ask Tabloupe to activate a view. Tabloupe honors this frame only on authenticated connections; legacy connections ignore it.

By lens id:

```json
{"type":"activateView","schemaVersion":1,"payload":{"view":{"kind":"lens","lensId":"lens_work"}}}
```

By unique lens name, matched case-insensitively:

```json
{"type":"activateView","schemaVersion":1,"payload":{"view":{"kind":"lens","name":"Work"}}}
```

All Groups:

```json
{"type":"activateView","schemaVersion":1,"payload":{"view":{"kind":"all"}}}
```

The daemon forwards an `activateView` frame received from one authenticated client to all other authenticated clients; it does not interpret the view.

## `calendarEvents`

Phase 4 consumers use daemon-published active calendar events. Tabloupe ignores this frame in the current phase.

```json
{"type":"calendarEvents","schemaVersion":1,"payload":{"events":[{"id":"event-123","title":"Planning","calendar":"Work","start":"2026-07-07T09:00:00Z","end":"2026-07-07T09:30:00Z"}]}}
```

`events` is the set of currently active events (`start <= now < end`) and is pushed after auth/connect and whenever the set changes.

## Legacy behavior

Old daemons send no `hello` first frame. When Tabloupe sees any other first frame, it marks the connection `legacy (unpaired)`, processes existing `focus`, `focusCatalog`, and `groupTabsResult` frames unchanged, publishes `lensState`, and ignores inbound `activateView`.

Old Tabloupe versions cannot authenticate to a new daemon. The daemon closes those sockets after its auth deadline; users must update and pair.

## Node example

```js
const WebSocket = require("ws"), crypto = require("node:crypto");
const token = process.argv[2];
const h = (s) => crypto.createHmac("sha256", Buffer.from(token, "utf8")).update(s).digest("hex");
const ws = new WebSocket("ws://127.0.0.1:8767");
let clientNonce, daemonNonce;
ws.on("message", (buf) => {
  const msg = JSON.parse(buf);
  if (msg.type === "hello") { daemonNonce = msg.payload.nonce; clientNonce = crypto.randomBytes(16).toString("hex"); ws.send(JSON.stringify({ type: "auth", schemaVersion: 1, payload: { clientNonce, mac: h(`tabloupe-client|${daemonNonce}|${clientNonce}`) } })); }
  if (msg.type === "authOk" && msg.payload.mac === h(`tabloupe-server|${clientNonce}|${daemonNonce}`)) ws.send(JSON.stringify({ type: "activateView", schemaVersion: 1, payload: { view: { kind: "all" } } }));
});
```
