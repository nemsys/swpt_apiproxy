# Security and bug review: swpt_apiproxy

| | |
|---|---|
| Reviewed commit | `34f5d73` (2025-02-22) |
| Review date | 2026-10-26 |
| Scope | `server.js` (sharded routing, enumerate-chain rewriting, random ID reservation, configuration loading and reloading) |
| Method | Manual code review; findings reproduced by running the proxy (Node 22) against local test upstream servers |

This document covers the issues **fixed in this pull request**, plus
review notes.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| BUG-1 | Medium | A duplicated route in the configuration file crashes the proxy, including on hot reload | Fixed |
| SEC-1 | Low | Unbounded request body buffering for random ID reservation | Fixed |

## BUG-1: Duplicated route crashes the proxy (Medium, fixed)

**Where:** `ServersConfig.buildServersTree`.

**Problem.** The error message for a duplicated route was built with
`this.dots(server.route)`. `server` is not the loop variable
(`serverRoute`). It resolves to the module's global HTTP `server`
object, whose `route` is `undefined`, so `dots()` throws a
`TypeError`. `loadServersConfig` catches only `ConfigError`, so the
`TypeError` propagates:

- at startup, the proxy exits;
- on **hot reload** (`fs.watchFile`), the exception escapes the watcher
  callback and crashes the **running** proxy. A typo while editing the
  configuration file takes down the whole Web API.

```
0.#  http://127.0.0.1:18081/
0.#  http://127.0.0.1:18082/
1.#  http://127.0.0.1:18081/

TypeError: Cannot read properties of undefined (reading 'split')
    at ServersConfig.dots (server.js:181:14)
    at ServersConfig.buildServersTree (server.js:154:57)
```

**Fix.** The message uses `serverRoute.route`. The proxy now logs
`Configuration error: duplicated route "0"` and keeps running.

## SEC-1: Unbounded body buffering for reservation requests (Low, fixed)

**Where:** `processRequestBody`, used for `POST /debtors/.debtor-reserve`
and `POST /creditors/.creditor-reserve`.

**Problem.** The proxy buffers the whole request body in memory, with
no size limit, before forwarding it (possibly several times) to a
randomly chosen shard. A client could send a very large body and make
the proxy use a lot of memory. In the reference deployment, nginx's
default `client_max_body_size` (1 MiB) limits this, but the proxy
should not depend on it.

**Fix.** The body is limited to `APIPROXY_MAX_BODY_SIZE` bytes (default
65536, documented in `README.md`). Bigger requests get a 413 response
and the connection is closed. Other requests are streamed by
`http-proxy` and are not affected.

```
POST /debtors/.debtor-reserve  with 2 bytes    → 200 (forwarded)
POST /debtors/.debtor-reserve  with 200000 B   → 413, proxy keeps running
```

## Review notes

- **A failed reload removes the routing table.** On reload,
  `serversConfig = loadServersConfig(...)` replaces the running
  configuration with `undefined` when the new file is invalid. Every
  request then gets a 502 until the file is fixed. Keeping the last
  valid configuration is a safer default, if that matches the intended
  behavior.
- **Sharded routing** uses the same MD5-based sharding key as the
  backends. Misrouted requests (for example during a shard split) are
  rejected by the backends' own `is_valid_*_id` checks.
- **Enumerate-chain rewriting** validates the backend's
  `ObjectReferencesPage` response and breaks the chain when the
  configuration version changes, as documented.
- Upstream servers must use `http://` URLs. The proxy is meant to run
  inside a trusted network, behind the authenticating gateway.

## Tests

The repository has no automated tests. Both fixes were verified
manually by running the proxy against local upstream servers, and
`node --check server.js` passes.
