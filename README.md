# github-core-clone-01 — a GitHub-compatible git forge

A standalone GitHub-compatible git forge in one Node 22 process, standard library only
(`node:http`, `node:zlib`, `node:crypto`). No dependencies, no git binary, no network
beyond the trial suite.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, including introspection, Relay node ids, mutations and cursor pagination |
| `POST /mcp` | Model Context Protocol over streamable HTTP (revision 2026-07-28 `server/discover`, plus the legacy `initialize` handshake): `create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`, `create_pull_request`, `merge_pull_request` |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack protocol v2 (with a v0 fallback) and receive-pack v0, with pkt-line framing, packfile read/write, delta resolution for thin packs, and fast-forward-only ref updates |
| anything else | 404 `{"message": "Not Found"}` |

Everything lives in one in-memory store, so REST, GraphQL, MCP and git all read and write
the same repositories, issues and pull requests. All state is deterministic: fixed
timestamps, ids and numbers assigned in creation order, no wall clock in any exported state.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22, which strips TypeScript types on its own.
The lifecycle (`main.ts`) binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`,
polls `/done` until the suite finishes, then exits 0.

## Layout

- `main.ts`: the entry <-> env lifecycle. Kept as the kit's starter ships it.
- `app.ts`: the whole forge — git wire protocol, REST v3, GraphQL v4 and MCP.
- `LICENSE` (MIT), `README.md`: this file.
