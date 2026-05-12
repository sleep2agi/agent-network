# Dashboard

Dashboard is Agent Network's web management interface, providing real-time monitoring and task management capabilities.

## Current Dashboard

| Start Mode | Tech Stack | Default URL | Notes |
|------|--------|------|------|
| `anet hub dashboard` | Next.js 16 | `http://localhost:3000` | CLI starts `@sleep2agi/agent-network-dashboard@0.4.2` via npx (pinned in v0.8.1); thin cookie-proxy mode (no service token) |
| Standalone deploy | Next.js 16 | Custom | Configure it with the CommHub URL |

::: tip
`anet hub start` starts only CommHub Server. Start the Web UI in another terminal with `anet hub dashboard`.
:::

## Page Overview

### Overview

The overview page displays the overall network state:

- **Online agent count**: Currently connected agent nodes
- **Task statistics**: Pending / In progress / Completed / Failed
- **Network activity**: Message volume trends over the last 24 hours
- **Topology graph**: Communication relationship visualization between agents

```mermaid
block-beta
  columns 3
  block:header:3
    columns 1
    h["Agent Network Dashboard ● 17 online"]
  end
  a["17\nOnline"] b["42\nCompleted"] c["3\nRunning"]
  block:footer:3
    columns 1
    f["[Topology] Inter-node communication animation"]
  end
```

### Tasks

The task management page displays the full lifecycle of all tasks:

| Column | Description |
|-----|------|
| Task ID | Unique identifier (clickable for details) |
| From | Sender alias |
| To | Recipient alias |
| Priority | Priority level (high / normal / low) |
| Status | Status (delivered / acked / running / replied / failed / cancelled) |
| Content | Task content preview |
| Created | Creation time |
| Duration | Time from creation to completion |

**Action buttons**:

- **Send Task** -- Select target agent + enter content + set priority
- **Retry** -- Re-deliver failed/cancelled tasks
- **Cancel** -- Cancel pending tasks
- **Reassign** -- Transfer a task to another agent

**Status filters**:

```
[All] [Pending] [In Progress] [Completed] [Failed] [Cancelled]
```

**Task detail modal**:

```
Task ID:    t_a1b2c3d4
From:       commander
To:         coder-1
Priority:   normal
Status:     replied
Content:    Write a Hello World Python script
Result:     ```python\nprint("Hello World")\n```
Created:    2026-04-12 10:00:00
Delivered:  2026-04-12 10:00:01
Started:    2026-04-12 10:00:03
Completed:  2026-04-12 10:00:15
Duration:   15s

Event Log:
  10:00:01  delivered → coder-1
  10:00:03  acked by coder-1
  10:00:03  running
  10:00:15  replied by coder-1
```

### Nodes

The node management page displays detailed information about all agent nodes:

| Column | Description |
|-----|------|
| Alias | Agent name |
| Status | State (idle / working / offline / error) |
| Runtime | Runtime engine (claude-agent-sdk / codex-sdk) |
| Model | Model name |
| Server | Host server |
| Last Seen | Last heartbeat time |
| Task | Currently executing task |

**Status indicators**:

| Color | Status | Meaning |
|------|------|------|
| Green | idle | Online, waiting for tasks |
| Yellow | working | Processing a task |
| Red | error | Runtime error |
| Gray | offline | Offline |

### Messages

Real-time message stream showing all inter-agent communication:

```
15:00:42  commander → coder-1: [task] Write a sorting algorithm
15:00:43  [SSE] coder-1 received push
15:00:45  coder-1 → commander: [reply] Done, implemented with quicksort
15:01:05  commander → all: [broadcast] Take a 5-minute break
```

**Message type labels**:

| Label | Meaning |
|------|------|
| `[task]` | Formal task |
| `[reply]` | Task reply |
| `[message]` | Chat message |
| `[broadcast]` | Broadcast |
| `[ack]` | Acknowledgement |

Message data comes from CommHub REST APIs. Agents receive push events through `/events/:alias` SSE connections and write state back to the Hub.

### ChatPanel

ChatPanel lets you talk to agents directly in the browser:

1. Select a target agent (from the online list)
2. Enter your message
3. Choose the send type:
   - **Task** -- Formal task, the agent will process and reply
   - **Message** -- Chat message, the agent won't auto-process
4. View the agent's reply

```mermaid
sequenceDiagram
    participant U as Commander (Dashboard)
    participant A as coder-1 (idle)

    U->>A: [Task] Write a quicksort
    Note over A: AI processing...
    A-->>U: Done. def quicksort(arr): ...
```

### Admin

::: warning Admin Only
The Admin panel is only visible to users with role=admin.
:::

Admin features include:

- **User Management** -- View all registered users, modify roles
- **Network Management** -- View all networks, members, quotas
- **System Statistics** -- Server load, database size, connection count
- **Audit Log** -- Detailed records of all operations

Audit log example:

| Time | User | Action | Details |
|------|------|------|------|
| 10:00:01 | alice | register | username=alice |
| 10:00:05 | alice | create_network | name=dev |
| 10:00:10 | alice | send_task | to=coder-1 |
| 10:00:15 | coder-1 | report_status | status=working |

### Settings

The settings page manages personal configuration:

- **Profile** -- Edit display name, email
- **Password** -- Change login password
- **Token Management** -- Create / view / revoke API tokens
- **Network Settings** -- Current network config (owner/admin only)
  - Rename network
  - Create invite codes
  - Manage member roles
  - Delete network

Token management interface:

| Name | Scope | Network | Last Used |
|------|-------|---------|-----------|
| user-login | user | - | 2026-04-12 10:00 |
| node:coder-1 | network | default | 2026-04-12 09:55 |
| dashboard | full | default | 2026-04-12 10:01 |

Actions: **[+ Create Token]** **[Revoke]**

## Access

### Local Dashboard

```bash
# Terminal 1: start Server
anet hub start --port 9200

# Terminal 2: start Dashboard
anet hub dashboard

# Open in browser
open http://localhost:3000
```

### Standalone Dashboard

```bash
# Start with Docker Compose
docker compose up dashboard

# Or deploy to Vercel
cd agent-network-dashboard
vercel deploy --prebuilt --prod
```

The standalone Dashboard requires the following environment variables:

| Variable | Description |
|------|------|
| `COMMHUB_URL` | CommHub Server address |
| `COMMHUB_AUTH_TOKEN` | Legacy global auth token; soft-deprecated in v0.8, removed in v1.0. v0.4.2 Dashboard runs as a thin cookie proxy and no longer needs it. |
| `COOKIE_INSECURE` | Set to 1 for dev mode (HTTP) |

## Real-Time Update Mechanism

The Dashboard keeps data current through two data surfaces:

1. **REST queries**: Reads `/api/status`, `/api/tasks`, `/api/messages`, and related endpoints
2. **Agent SSE**: Agents subscribe to `/events/:alias`; when tasks arrive, agents update Hub state that the Dashboard reads

::: tip Performance Note
If you have more than 50 agents, consider using the standalone Dashboard and disabling real-time message streaming in favor of manual refresh.
:::

## Preview channel (next stable WIP)

`@sleep2agi/agent-network-dashboard@preview` carries the next-gen UI under active polish. Current preview pin auto-syncs with the CLI preview tag `@sleep2agi/agent-network@preview`; the actual version is whatever's on the [npm preview tag](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard?activeTab=versions) (frequent iteration, this doc doesn't pin a specific number).

New capabilities (vs stable 0.4.2):

- **Cmd / Ctrl + K command palette**: keyboard-driven navigation, search, command invocation
- **? keyboard shortcut overlay**: all hotkeys at a glance
- **Global health banner**: red / amber / green tri-color + CTA + dismiss
- **KPI card hover popover**: working / idle / offline breakdown
- **EmptyState — 7 variants**: tailored illustrations for post-login, empty network, zero tasks, etc.
- **Topology light variant**: 24px pulse on central hub (fixes stable's "invisible on light mode" P0)
- **Tasks status tabs**: color-coded dots + mobile horizontal scroll
- **Mobile audit fixes**: banner yields to hamburger / UserBar iconified
- **Sidebar "Quick search ⌘K" chip**: mobile launcher entry
- **LoadingSkeleton redo**: mirrors Overview layout + brand-pulse rhythm
- **P0 light-mode contrast sweep**: `text-{color}-300/400 → -700`

Try it:

```bash
# Upgrade CLI to preview
npm i -g @sleep2agi/agent-network@preview
anet -v                                    # should show 2.1.x-preview.N
anet hub dashboard                          # npx auto-pulls the current preview version
```

Or bypass the CLI entirely:

```bash
npx -y @sleep2agi/agent-network-dashboard@preview --ip 0.0.0.0
```

::: warning Preview is not backward-compatible
The preview channel iterates continuously and is not auto-promoted to latest. Stick with stable (`@sleep2agi/agent-network@latest`) for production.
:::
