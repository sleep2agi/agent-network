# Multi-user and permissions

Starting with Hub 0.9.0-preview.68, the server has two behaviors that are already live: which Agents a member can access, and a human-to-human direct-message API inside one network.

User management, registration, and direct messages in the desktop and mobile apps are not released. They are coming in an app release. Do not treat those three as screens you can already open. Existing accounts, tokens, and the four network roles stay as described in [Accounts, Tokens & Roles](/en/guide/account-system). CLI registration and invite codes are unchanged.

## Which Agents a member can access

A member or viewer added from this version on has `agent_access` `granted` by default: until Agents are granted one by one, they see none in that network. Members who were already in the network before the upgrade stay on `all`, so the upgrade does not change what they can see. Owners, admins, and Hub admins are not limited by this rule.

The network owner or admin, or a Hub admin, replaces the grant list through the API. A grant means the person can see that Agent and talk to it. It does not let them change its config, rules, or logs. The rule and the fields are in [Users & Agent Access Endpoints](/en/api/rest-admin#users-agent-access-endpoints).

## Human-to-human messages

Two users in the same network can message each other with these endpoints. User tokens only:

- `POST /api/dm`
- `GET /api/dm`
- `GET /api/dm/threads`

The app does not have this screen yet. Fields and errors are in [the same section](/en/api/rest-admin#human-dm).

## A node token cannot administer accounts

From this version on, a node token (`ntok_`) cannot call the account, token, network, or member administration endpoints. Those return 403 `user_token_required`. A node can rename only itself: the network the token is bound to, and the old alias must be the node that token represents. Renaming any other node requires a user token. The API reference marks the affected endpoints with "requires a user token".

## See also

- [Accounts, Tokens & Roles](/en/guide/account-system)
- [REST: Administration](/en/api/rest-admin)
- [REST API reference](/en/api/rest)
