# 0007: Use fragment-token sharing URLs + bearer header for API auth

- Status: Accepted
- Date: 2026-05-24
- Deciders: @houyili
- Related: Round 8 open-source remediation R3, [docs/security.md](../security.md)

## Context

The dashboard exposes a small HTTP API on `127.0.0.1:18902` plus an
optional Cloudflare or ngrok tunnel for remote viewing. From the start
the design used a per-install bearer token to gate access through the
tunnel.

Pre-v0.1.2 the frontend implementation did the following:

1. A shared link arrived with `#token=<value>` in the URL fragment.
   Fragments are not sent in HTTP request lines, which is good.
2. The frontend read the fragment, saved the token, and then attached
   it as `?token=<value>` query string on every subsequent API call.

Step 2 leaked the token back into the request line. Even though the
initial HTML request was safe, every API call after it carried the token
in the request URI, which proxies log, browser history records, and
referer headers can expose. The fragment-only intent of the sharing URL
was effectively defeated by the second-stage transport.

## Decision

Sharing URLs continue to put the token in the URL fragment
(`https://<host>/#token=<value>`).

The frontend's `authFetch` helper reads the token from the fragment once
on load and attaches it to every subsequent API call as
`Authorization: Bearer <token>`. The query-string path is no longer used
by the frontend.

The server still accepts `?token=<value>` as a fallback for backwards
compatibility with shell scripts and pre-v0.1.2 shared links. The
canonical sharing URL format is the fragment form, and that is what the
"copy share link" UI emits.

## Consequences

What becomes easier:

- The token never appears in the request line of an API call. Proxy
  logs, browser history, and referer headers do not carry it.
- The frontend's auth path is one well-known idiom (Authorization
  header) that any HTTP client — `curl`, `httpie`, language-native HTTP
  libraries — already understands.
- The same code path works with or without a tunnel.

What becomes harder:

- Every API call now requires a tiny per-request header construction
  step. The cost is negligible.
- The server has two accepted auth surfaces (header and query string)
  during the deprecation window. The query-string path is documented
  and tested but emits a header `X-Auth-Source: query` so usage can be
  observed and eventually retired.

What we accept:

- A short window of dual-accept on the server, then a future ADR will
  retire the query-string path once we are confident no operator is
  still relying on it.
