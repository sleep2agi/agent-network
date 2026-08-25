# SideThread HTTP contract v1

This directory is the authoritative, vendorable wire contract shared by the
Hub and App. Public JSON uses `sideThreadId`/`question`; internal
`side_chat_id`/`question_text` names never cross the HTTP or SSE boundary.

Routes are `POST /api/side-threads`, `GET /api/side-threads`,
`GET /api/side-threads/:sideThreadId`, `GET /:sideThreadId/events`, and
`POST /:sideThreadId/{cancel,retry,archive,purge,bring-back}`. Capability is
`GET /api/side-threads/capability` with `alias` or `nodeId`, plus `networkId`,
`sourceThreadId`, `boundaryKind`, and `boundaryTurnId`.

Create and retry bodies call owner-readable text `question`. Optional record
fields are always present as JSON `null`; optional error correlation fields
are absent. A supported capability always includes its exact `context`.
Only a completed bring-back receipt makes `broughtBack` true.
