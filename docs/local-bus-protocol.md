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


## `createTabGroup` / `createTabGroupResult`

Authenticated peers may ask Tabloupe to place matching open tabs into a real Firefox tab group. Tabloupe honors this frame only on authenticated connections; legacy connections ignore it. The daemon forwards both `createTabGroup` and `createTabGroupResult` frames between authenticated clients; it does not interpret the tab URLs, grouping result, or error code.

Request:

```json
{"type":"createTabGroup","schemaVersion":1,"payload":{"requestId":"0123456789abcdef0123456789abcdef","title":"zotio staging","color":"blue","match":{"urls":["https://example.com/a","https://example.com/b#notes"]},"windowId":null}}
```

`payload.requestId` is a 32-character lowercase hex string echoed in the result. `title` is required, trimmed, and capped at 128 characters. `color` is optional; when present it must be one of Firefox's tab-group color names (`blue`, `cyan`, `green`, `orange`, `pink`, `purple`, `red`, `yellow`). Invalid or absent colors are omitted from the tab-group update. `match.urls` is required and must contain 1 to 64 URL strings. `windowId` is optional; `null` or absence means Tabloupe uses the window of the first matched tab.

Matching is against normal browser windows only. Tabloupe first matches tabs by exact `tab.url` string. For request URLs with no exact match, it retries with URL fragments stripped from both the requested URL and open tab URLs. If several tabs match one requested URL, all matching tabs are considered. The target window is the supplied `windowId`, or otherwise the window of the first matched tab. Matched tabs in other windows are skipped with `cross_window`; v1 never moves tabs across windows. Pinned tabs are skipped with `pinned`. Tabs already in a different group in the target window are skipped with `already_grouped_elsewhere`.

If a group with the same title already exists in the target window, Tabloupe merges tabs into that group and preserves its existing title and color. Tabs already in that target group count as grouped, making repeated requests idempotent.

Result:

```json
{"type":"createTabGroupResult","schemaVersion":1,"payload":{"requestId":"0123456789abcdef0123456789abcdef","ok":true,"groupId":123,"windowId":45,"grouped":["https://example.com/a"],"skipped":[{"url":"https://example.com/b#notes","reason":"not_found"}],"error":null}}
```

`ok` is true when at least one matched tab is in the requested target group after handling the request. `grouped` lists the URLs of tabs that were grouped or were already in the target group. `skipped` entries use one of these stable reasons: `not_found`, `pinned`, `cross_window`, or `already_grouped_elsewhere`.

Stable `error` codes:

- `invalid_payload`: the frame had a usable `requestId` but failed validation.
- `no_tabs_matched`: no requested tab could be placed in the target group.
- `group_failed`: Firefox rejected the tab-group operation.

## `calendarEvents`

Phase 4 consumers use daemon-published active calendar events. Tabloupe ignores this frame in the current phase.

```json
{"type":"calendarEvents","schemaVersion":1,"payload":{"events":[{"id":"event-123","title":"Planning","calendar":"Work","start":"2026-07-07T09:00:00Z","end":"2026-07-07T09:30:00Z"}]}}
```

`events` is the set of currently active events (`start <= now < end`) and is pushed after auth/connect and whenever the set changes.

## Legacy behavior

Old daemons (or any peer) send no `hello` first frame. Tabloupe only downgrades to legacy when no `busToken` is stored: it marks the connection `legacy (unpaired)`, processes existing `focus`, `focusCatalog`, and `groupTabsResult` frames unchanged, publishes `lensState`, and ignores inbound `activateView` and `createTabGroup`. If a `busToken` *is* configured, skipping `hello` is a protocol violation — Tabloupe closes the socket and reports `pairing_failed` instead of downgrading, so a peer cannot bypass pairing by omitting the handshake.

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
