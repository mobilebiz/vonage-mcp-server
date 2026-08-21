# Vonage MCP Server

English | [日本語](README.md)

An MCP (Model Context Protocol) server that exposes Vonage SMS and Voice to AI
agents, with guardrails designed for a hostile agent.

This is an **open-source reference implementation**. You deploy it yourself with
your own Vonage credentials — this project never holds them.

> **Regulatory guidance in this repository targets use within Japan.** The
> Japanese README carries the compliance notes, sender ID rules and delivery
> caveats that apply there. If you operate elsewhere, you are responsible for
> checking your local regulations, carrier behaviour and the Vonage terms of
> service yourself.

---

## Threat model

**We assume an attacker can drive the agent through prompt injection. The agent
is not a trusted principal.**

Sending an SMS or placing a call cannot be undone, costs money, and reaches a
real person. A design that is safe only when the agent behaves correctly is not
safe. The guardrails here aim to bound the damage when it does not.

Consequences you will notice immediately:

- **No tools are exposed by default.** You opt in per capability.
- **Only Japanese destinations are allowed by default.** You opt in per country
  calling code.
- **CORS is closed by default**, and the HTTP server binds loopback unless you
  configure authentication.
- Values that cannot be interpreted **fail at startup** rather than falling back
  to a default.

---

## Requirements

- Node.js 22 or later
- A Vonage application ID and private key

## Install

```sh
npm install
npm run build
```

## Run

**stdio** (Claude Desktop, local agents):

```sh
node --env-file=.env dist/index.js
```

**Streamable HTTP**:

```sh
node --env-file=.env dist/http-server.js
```

> Run a **single instance**. Rate limits, delivery status and webhook replay
> detection live in process memory. With several instances the rate limit
> loosens by the number of instances, and status lookups miss webhooks that
> landed on another one. On Cloud Run, set `--max-instances=1`.

---

## Tools

Each tool belongs to a capability that is **off by default**.

| Tool | Capability | What it does |
| --- | --- | --- |
| `send_sms` | `ENABLE_SMS` | Send one SMS |
| `get_sms_status` | `ENABLE_SMS` | Read a delivery status received by webhook |
| `bulk_sms_from_csv` | `ENABLE_BULK_SMS` | Send many SMS from CSV |
| `make_voice_call` | `ENABLE_VOICE` | Place a call that reads a message aloud |
| `get_call_status` | `ENABLE_VOICE` | Read a call's status, price and duration |

Tools whose capability is off are **not listed** in `tools/list`, so an agent
never sees them.

Every billable tool takes `dry_run`. Call it first: it runs the full validation
path, reports what would happen — including the **estimated segment count** for
SMS and the **enforced maximum duration** for calls — and consumes no quota.

---

## Configuration

All values are parsed strictly. Booleans accept **only** `true` or `false`,
case-sensitively; `1`, `yes`, `on` and `True` are startup errors. Integers must
be plain decimal. Every problem found is reported at once.

### Credentials

| Variable | Default | Notes |
| --- | --- | --- |
| `VONAGE_APPLICATION_ID` | — | Required once any capability is on. **Not a secret** — it is a public identifier and must never be used for authentication |
| `VONAGE_PRIVATE_KEY_PATH` | `./private.key` | |
| `VONAGE_VOICE_FROM` | — | Required when `ENABLE_VOICE=true` |

### Capabilities

| Variable | Default |
| --- | --- |
| `ENABLE_SMS` | `false` |
| `ENABLE_BULK_SMS` | `false` |
| `ENABLE_VOICE` | `false` |

`ENABLE_BULK_SMS` is separate from `ENABLE_SMS` because the blast radius differs
by orders of magnitude: one message versus hundreds per call.

### Destination guardrails

| Variable | Default | Notes |
| --- | --- | --- |
| `ALLOWED_COUNTRY_CODES` | `81` | ITU calling codes, comma separated. `*` removes the restriction. Codes that do not exist are a startup error |
| `ALLOWED_NUMBERS` | unset — no restriction | Explicit destination allowlist. If set with no valid entry, **everything is denied** |
| `ALLOW_PREMIUM_NUMBERS` | `false` | Permits Japanese premium-rate ranges (`0990`, `0570`, `0180`) |

Emergency numbers (`110`, `119`, `118`) are **always blocked** and no
environment variable relaxes that.

> **`ALLOWED_COUNTRY_CODES` is not an IRSF defence.** Calling codes are not
> countries: `+1` covers the US, Canada and much of the Caribbean, so allowing
> the US also allows high-risk destinations sharing that code. Real protection
> comes from `ALLOWED_NUMBERS` and from **spend limits and region restrictions
> configured in your Vonage account** — the only layer that still applies if this
> server is bypassed entirely.

### Rate limiting

Consumption is counted in **messages sent**, not tool calls. A bulk send
consumes one unit per row and is all-or-nothing.

| Variable | Default | Unit |
| --- | --- | --- |
| `RATE_LIMIT_PER_HOUR` | `5` | Messages and calls combined |
| `SMS_RATE_LIMIT_PER_HOUR` | unlimited | Messages, SMS only |
| `VOICE_RATE_LIMIT_PER_HOUR` | unlimited | Calls only |
| `SMS_SEGMENT_LIMIT_PER_HOUR` | unlimited | **Segments** — the billed unit |
| `SMS_MAX_SEGMENTS` | `3` | Segments allowed in one message |
| `BULK_MAX_ROWS` | `100` | CSV rows per call |
| `DISABLE_RATE_LIMIT` | `false` | Dangerous. Warns on every startup |

> **`RATE_LIMIT_PER_HOUR=0` and `BULK_MAX_ROWS=0` mean "deny everything", not
> "unlimited".** An administrator reaching for `0` as a kill switch used to get
> the opposite. For unlimited, set `DISABLE_RATE_LIMIT=true`.

**SMS is billed per segment, not per message.** A segment holds 160 characters
in GSM-7 but only 70 in UCS-2, and **one non-ASCII character switches the whole
body to UCS-2**. So `RATE_LIMIT_PER_HOUR=5` permits up to
`5 × SMS_MAX_SEGMENTS` segments of billing. Use
`SMS_SEGMENT_LIMIT_PER_HOUR` to cap the cost itself.

### HTTP transport

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | unset | Bearer token for `/mcp`. Minimum 16 characters |
| `TRUST_UPSTREAM_AUTH` | `false` | Delegate auth to Cloud Run IAM, an API gateway, etc. |
| `BIND_HOST` | `0.0.0.0` with auth, `127.0.0.1` without | |
| `PORT` | `3000` | |
| `ALLOWED_ORIGINS` | unset — **all cross-origin denied** | CORS allowlist |
| `ALLOWED_HOSTS` | loopback names when bound to loopback | Host header allowlist (DNS rebinding) |

Without authentication the server **binds loopback**. Asking for an external
`BIND_HOST` without authentication fails at startup. Per-request localhost
detection is deliberately not used: behind Cloud Run or a reverse proxy the peer
address is `127.0.0.1`, so every external request would look local.

### Webhooks

| Variable | Default | Notes |
| --- | --- | --- |
| `VONAGE_API_SIGNATURE_SECRET` | — | Signed JWT verification. **Recommended** |
| `VONAGE_WEBHOOK_SECRET` | — | Shared secret fallback, used only when the signature secret is unset |
| `WEBHOOK_MAX_AGE_SECONDS` | `300` | Tolerance for `iat` / `exp` |

Signed webhooks must carry `payload_hash`, `iat` and `jti`, all verified. A
missing claim is rejected rather than skipped — otherwise removing a claim would
disable the check. With a signature secret configured there is **no fallback** to
the shared secret, so an attacker cannot downgrade by dropping the header.

If neither secret is set, the webhook endpoint returns `503` and is disabled.

---

## Endpoints

| Path | Authentication |
| --- | --- |
| `GET /health` | none |
| `POST /webhooks/*` | Vonage signature |
| `ALL /mcp` | Host check, then bearer token or upstream IAM |

`/mcp` speaks **Streamable HTTP**. Per the specification, POST requests need
`Accept: application/json, text/event-stream`.

```sh
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The server is **stateless**: it issues no `Mcp-Session-Id`. Session state would
live in process memory and break as soon as a request reached a different
replica, and requiring sticky sessions would narrow where this can run. Nothing
here needs a session — every tool completes in one request.

Errors arrive in two shapes. Schema violations are rejected by the MCP SDK
against `inputSchema` and surface as JSON-RPC `-32602`. Guardrail failures reach
the handler and come back as a result with `isError: true`, carrying `reason`
and `suggestion`.

---

## Delivery is not guaranteed

A successful response means **Vonage accepted the message**, not that it
arrived. This matters more than usual for Japanese destinations, where networks
may silently drop messages containing URLs as an anti-phishing measure and the
criteria are not published — the API still returns success.

When that applies, responses carry `delivery_warning`. Check `get_sms_status`
for the delivery result, and do not report "sent" as "delivered".

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests in English are
welcome.

Security issues: **do not open a public issue.** See [SECURITY.md](SECURITY.md).

## Vonage accounts

You need your own Vonage application. Sign up at
[developer.vonage.com](https://developer.vonage.com/sign-up).

Customers in Japan can sign up through a
[Japanese-language application page](https://kwcplus.kddi-web.com/application/vonage)
offering local support and billing. **This server works identically either
way** — no signup route is required or enforced.

## License

[Apache License 2.0](LICENSE)

Copyright 2026 Global Internet Japan, Inc.

Maintained by [Global Internet Japan, Inc.](https://www.gij.com/) as a Vonage
reseller. We do **not** operate this as a hosted service.
