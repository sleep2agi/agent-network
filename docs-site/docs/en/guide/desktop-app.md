# Desktop and Mobile Clients

The Agent Network desktop app (macOS / Windows) is the **human** end of the network: sign in to a Hub, see every agent on it, dispatch tasks like chat messages, receive replies and files. It shares its source with the mobile app and talks to the same Hub.

Downloads and release notes are on the [home page](/en/); this page is about using it.

## Accounts and Hubs

- **Several accounts side by side**: Settings → Accounts & Hub keeps any number of Hub accounts (say, `admin` on the company Hub plus the built-in Local workspace); click a row to switch. `· current` marks the account the main window is using.
- **One window per account** (0.2.56+): the "New window" button on an account row opens a **full** workspace window (agents, chats, settings) signed in as that account, titled "account · hub host · Agent Network". The main window keeps its account; both windows stay online and can chat at the same time. Clicking again for the same account focuses the existing window.
  ::: tip Why not a second app instance
  Two processes would fight over the same local data folder and the local Hub's port, so "multiple instances" became multiple windows.
  :::
- **Local workspace**: the desktop app bundles a local Hub (Settings → Local Hub shows status, address, version; restart / stop / open logs / back up now). Pick it and you need no server at all; app upgrades migrate the local Hub and roll back to the pre-upgrade data if migration fails.
- Credentials live in the system keychain; a lost credential is recreated with a notice instead of wiping the data.

## Chat and files

- Open an agent from the list to send text, images and files; attachments in an agent's reply (PDF, PPTX, Markdown, HTML, video…) show inside the **reply bubble**.
- **You choose where downloads go** (0.2.55+): clicking an attachment opens the system Save As dialog and remembers the last folder; hold Option/Alt while clicking to save straight to Downloads. "Download original" on images works the same way.
- **Detached chat windows**: a conversation can be popped out into its own window; they are restored when you reopen the app.
- **Unread badges**: each row in the agent list shows how many messages that agent sent you (including replies to your tasks); opening the chat and reaching the bottom clears it.
  With Hub `0.9.0-preview.51` or newer the count comes from the Hub and is the same on every device; older Hubs fall back to a local estimate.

## Servers and the local daemon

The Servers page shows the Hub overview, nodes, events and logs, and is where you **create nodes**. Creating a node needs a machine running a **daemon** (an agent-node with the `host_supervisor` role); the desktop app makes that one click:

1. Servers → pick a server → "Rescan": checks Node / npm / anet / agent-node / daemon on this machine.
2. Install what is missing: "Install" puts `@sleep2agi/agent-network` and `@sleep2agi/agent-node` into the app's **private folder** (your global npm is untouched) and downloads a private Node if there is none.
3. "Re-register and start the local daemon": stops any old daemon of the same name, starts a new one with the private agent-node, and the "Hub view" row confirms the Hub actually lists it as a daemon.

Requirements: agent-network ≥ `2.3.0-preview.77`, Hub ≥ `0.9.0-preview.50`; the installer satisfies them for you.

## Updates

Settings → About → "Software update" checks for a new version; when there is one the main window shows the release notes and, on confirmation, downloads, installs and relaunches (the local Hub is stopped first and restarted with the new version). The update feed is `https://anet.sh/desktop/update/latest.json`.

## Browser and phone: the Dashboard PWA and client shells {#dashboard-shells}

You can also use the [Dashboard](/en/guide/dashboard) without the desktop app. It has a few **thin shells** (source in [sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard); the authoritative document is that repository's `docs/mobile-app.md`). The shells re-implement nothing: authentication, data, uploads and realtime stay in the Dashboard and CommHub, so **you need a reachable Dashboard URL first**.

- **PWA (the cheapest option)**: open the Dashboard over **HTTPS** and the browser offers "Add to Home Screen" / "Install app". Plain HTTP will not do (a PWA needs a secure context), except `http://127.0.0.1` for local work.
- **iOS / Android (Capacitor)**: a WebView shell you build yourself with Xcode or Android Studio. A phone is a different device and cannot reach your computer's loopback address, so give it an HTTPS URL it can reach: `export ANET_DASHBOARD_URL="https://your-dashboard.example.com"`.
- **Electron desktop shell**: `npm run app:desktop` inside the dashboard repository. It is not the desktop app described on this page; for ready-made macOS / Windows installers, use the desktop app above.

Which one: just a look from your phone → PWA; for people who do not use a terminal → the desktop app; push notifications, camera and other system features → Capacitor.

## Related

- [Dashboard](/en/guide/dashboard), [CLI Commands](/en/guide/cli).
