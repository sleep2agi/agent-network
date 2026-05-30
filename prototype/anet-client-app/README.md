# anet-client-app — Agent Network user-facing PWA prototype

> RFC: [`docs/rfcs/RFC-022-agent-network-client-app.md`](../../docs/rfcs/RFC-022-agent-network-client-app.md)
> Status: MVP skeleton (Phase 1)
> Stack: React + Vite + TypeScript PWA
> Author: 通信SDK马

A mobile-and-desktop **PWA** that lets users log in to commhub, browse online agents, chat one-on-one, and observe what an agent is doing in real time. Zero new server endpoints — purely consumes existing commhub HTTP + SSE.

## What's inside

| Page | Purpose | Endpoints used |
|---|---|---|
| `/login` | Email + password sign-in. After login, picks the first network and provisions an `ntok_` for SSE. | `POST /api/auth/login`, `GET /api/networks`, `POST /api/auth/node-token` |
| `/` (NodeList) | List of online agents with status, runtime, current task. Auto-polls every 5s. | `GET /api/status` |
| `/chat/:alias` (Chat) | Send tasks to a single agent, see replies in real time via SSE, optional Live Log via tmux capture-pane. | `POST /api/task`, `GET /api/messages`, `GET /events/<my-alias>` (fetch+ReadableStream), `GET /api/tmux/:alias` |

## Run locally

```bash
# 1. install deps (Node.js 20+ or Bun)
cd prototype/anet-client-app
npm install        # or: bun install

# 2. point at a commhub server (defaults to http://localhost:9200)
export VITE_COMMHUB_URL=http://localhost:9200

# 3. dev server with hot reload
npm run dev        # or: bun run dev
# → open http://localhost:5173 in browser or on phone (LAN)
```

> **Do not point at the production hub (47.116.5.73)** — red line. Bring up a local commhub for testing:
>
> ```bash
> cd server
> bun install
> bun run dev   # listens on :9200
> ```

## Build for static deploy

```bash
npm run build
# → dist/ is a vanilla static site, upload to Vercel / Netlify / GitHub Pages / S3
```

Build-time env:

| Var | Default | Meaning |
|---|---|---|
| `VITE_COMMHUB_URL` | `http://localhost:9200` | Origin of the commhub server you want the app to talk to. |

## Notes for prototype scope

- **Auth model**: `utok_` is stored in `localStorage` as `anet:utok`. `ntok_` (network-scoped, needed for SSE) is provisioned at login time for the first network the user belongs to. Multi-network switching is a Phase 2 follow-up.
- **SSE transport**: Uses `fetch()` + `ReadableStream` instead of `EventSource` so it can pass `Authorization: Bearer ntok_…` (EventSource cannot set headers).
- **Live log**: Polls `GET /api/tmux/:alias` every 3 seconds. Requires `COMMHUB_ENABLE_TMUX=1` on the server. Falls back to an "unavailable" hint if the hub is not configured for tmux capture.
- **No service worker / offline**: PWA manifest + auto-update is wired (`vite-plugin-pwa`) so the app is installable, but offline caching of the chat stream is Phase 2.
- **No push notifications**: Web Push is Phase 2. Phase 3 will wrap with Capacitor for native iOS / Android push.

## Roadmap (per RFC-022)

| Phase | Scope |
|---|---|
| 1 (this skeleton) | Login + node list + chat + live log |
| 2 | Web Push, offline cache, multi-network switcher, self-register via invite link |
| 3 | Capacitor wrap → iOS / Android app store; Tauri wrap → desktop native |

## Project structure

```
prototype/anet-client-app/
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx          # root render + router
    ├── App.tsx           # route + topbar
    ├── api.ts            # commhub HTTP / SSE client
    ├── auth.ts           # token + user store (Zustand)
    ├── styles.css        # minimal dark theme
    ├── pages/
    │   ├── Login.tsx
    │   ├── NodeList.tsx
    │   └── Chat.tsx
    └── components/
        └── LiveLog.tsx
```

## License

Apache-2.0 (same as repo).
