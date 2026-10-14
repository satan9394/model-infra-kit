# Embed integration guide (UI-202 / EVO-G145)

The dashboard ships four embeddable routes that a host application can place in
an `<iframe>`:

| Route              | Content                                            |
| ------------------ | -------------------------------------------------- |
| `/embed/overview`  | Cost range, request/token totals, provider buckets |
| `/embed/trends`    | Daily token and cost trend                          |
| `/embed/logs`      | Request log table and diagnostics drawer            |
| `/embed/pricing`   | Effective price table and manual overrides          |

Embed routes render no sidebar and no main footer, default to a **7-day** range
(overridable with the familiar `range`/`from`/`to` query parameters), and keep
the SSE live updates of the full dashboard.

This guide covers the optional `postMessage` bridge that lets a host size the
frame to its content (no inner scrollbar) and mirror the dashboard theme.

## 1. Enabling cross-origin hosts

The embed only accepts bridge messages from:

1. its **own origin** (same-origin embedding, always allowed), and
2. origins listed in the `MIK_EMBED_ALLOWED_ORIGINS` environment variable.

```bash
# Comma-separated. Never use "*".
MIK_EMBED_ALLOWED_ORIGINS="https://console.example.com,https://admin.example.com" \
  pnpm --filter @mik/dashboard start
```

If the variable is unset, only same-origin hosts are accepted. The wildcard
`*` is rejected at parse time, so it can never widen the allow-list by mistake.

## 2. Message schema

All messages are plain JSON objects sent through `postMessage`.

### Host → Embed

```ts
// Handshake. `targetOrigin` must equal the origin you post from.
{ type: "MIK_EMBED_INIT", targetOrigin: "https://console.example.com", theme?: "dark" | "light", dateRange?: "today" | "7d" | "30d" }

// Switch the dashboard theme after the handshake.
{ type: "MIK_EMBED_SET_THEME", theme: "dark" | "light" }
```

`dateRange` is applied to the embed's own URL (`?range=…`) and replaces the
default 7-day window. Only the three dashboard presets are accepted; a custom
window must use the embed URL's `from`/`to` parameters instead. A value outside
the vocabulary is rejected with reason `payload`.

### Embed → Host

```ts
{ type: "MIK_EMBED_READY", version: "1.0" }
{ type: "MIK_EMBED_RESIZE", height: 812, width: 1200 }
{ type: "MIK_EMBED_ERROR", code: "origin" | "target" | "shape" | "sensitive" | "payload", message: "…" }
```

`MIK_EMBED_RESIZE` is emitted with the real content box (the maximum of the
document and body metrics) whenever a `ResizeObserver` fires, so the host can
set the iframe height and avoid a double scrollbar.

## 3. Host example

```html
<iframe id="mik-embed" src="https://mik.example.com/embed/overview" style="width:100%;border:0" title="Model Infra Kit"></iframe>
<script>
  const HOST_ORIGIN = "https://console.example.com";
  const EMBED_ORIGIN = "https://mik.example.com";
  const frame = document.getElementById("mik-embed");

  window.addEventListener("message", (event) => {
    // Only trust the frame's own origin, and only this exact frame.
    if (event.origin !== EMBED_ORIGIN || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "MIK_EMBED_RESIZE") {
      frame.style.height = `${data.height}px`;
    } else if (data.type === "MIK_EMBED_READY") {
      console.info("mik embed ready", data.version);
    } else if (data.type === "MIK_EMBED_ERROR") {
      console.warn("mik embed rejected a message", data.code);
    }
  });

  // Wait for the frame to load before the handshake: the embed can only answer
  // messages once its client bundle has mounted its listener.
  frame.addEventListener("load", () => {
    frame.contentWindow.postMessage(
      { type: "MIK_EMBED_INIT", targetOrigin: HOST_ORIGIN, theme: "dark", dateRange: "7d" },
      EMBED_ORIGIN,
    );
  });
</script>
```

## 4. Security rules (enforced by the embed)

- **Origin allow-list.** A message from any origin other than the embed's own
  origin or `MIK_EMBED_ALLOWED_ORIGINS` is dropped. The embed never replies to
  an untrusted origin — no bounce, no error echo.
- **Pinned `targetOrigin`.** `MIK_EMBED_INIT.targetOrigin` must equal the origin
  the message came from; otherwise the handshake is rejected with reason
  `target`. A host cannot talk the embed into posting to somebody else.
- **Negotiated origin.** After a successful handshake only that origin may keep
  talking; later messages from any other origin are rejected with
  `negotiated-origin`.
- **No secrets.** Inbound messages containing token/secret/password/api-key/
  authorization/cookie keys (at any nesting depth) are rejected with reason
  `sensitive`. Outbound frames only ever carry a version, a size or a theme —
  never credentials or request payloads.
- **Strict shapes.** Unknown types, non-object payloads and invalid enum or
  string values (for example a `dateRange` outside `today`/`7d`/`30d`) are
  rejected with `shape` or `payload`.
- **Never `*`.** The embed always posts to the negotiated origin. Hosts must do
  the same and must not use `*` as `targetOrigin`.

## 5. Theming

- `MIK_EMBED_INIT.theme` applies a theme on handshake.
- `MIK_EMBED_SET_THEME` switches it later.
- The embed writes the preference through the same store as the dashboard's
  theme switch, so the choice survives a reload.

## 6. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| No `MIK_EMBED_READY` | The host posted `INIT` before the iframe `load` event, or the origin is not in `MIK_EMBED_ALLOWED_ORIGINS`. |
| `MIK_EMBED_ERROR` with `origin` | The host origin is missing from `MIK_EMBED_ALLOWED_ORIGINS`. |
| `MIK_EMBED_ERROR` with `target` | `INIT.targetOrigin` did not match the host origin. |
| `MIK_EMBED_ERROR` with `sensitive` | The host attached a token-like field; remove it. |
| The iframe keeps its own scrollbar | The host ignored `MIK_EMBED_RESIZE`; set the frame height from the message. |
| Message ignored only after the first one | The host posts from a different origin than the one it negotiated with. |
