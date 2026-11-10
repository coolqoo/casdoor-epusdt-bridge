# Casdoor Epusdt Bridge

A small, stateless Cloudflare Worker connecting Casdoor's built-in **GC** payment provider to Epusdt's **GMPay v2** API. No database, KV, queue, scheduled job, or Hedge dependency is required.

```text
Application → Casdoor Order / Coupon → GC → Bridge → GMPay cashier
GMPay notification → Bridge → signed GC notification → Casdoor
```

## Setup

Use Node.js 24, run `npm ci`, `npm run typecheck`, and `npm test`. Set the public HTTPS `BRIDGE_ORIGIN` in `wrangler.jsonc`. Copy `.dev.vars.example` to `.dev.vars` for local development. For production, upload `MERCHANTS_JSON` as a Worker secret (`npx wrangler secret put MERCHANTS_JSON`), then run `npm run deploy`.

Each key in `MERCHANTS_JSON` is an independent integration. Its settings are:

| Field | Purpose |
| --- | --- |
| `gcClientId`, `gcSecret` | Independent credentials entered in Casdoor's GC provider |
| `casdoorOrigin`, `organization` | Fixed Casdoor HTTPS origin and organization |
| `gmpayOrigin`, `gmpayPid`, `gmpaySecret` | Epusdt HTTPS origin and merchant credentials |
| `currency` | Fixed uppercase currency, e.g. `USD` |
| `returnOrigins` | Optional additional trusted HTTPS origins for payment returns |

Configure Casdoor's GC provider with host `https://bridge.example.com/gc/<integration-key>`, client ID `gcClientId`, and secret `gcSecret`. Use ordinary products in the configured currency. Casdoor's GC wire format does **not carry currency**, so products must match the integration's configured currency. The Bridge never performs currency conversion.

The reference baseline is Casdoor v4.26.0 and Epusdt/GMPay v2.0.0. See the [GC implementation](https://github.com/casdoor/casdoor/blob/v4.26.0/pp/gc.go) and [GMPay API documentation](https://epusdt.com/guide/integration/gmpay.html).

## Protocol and reliability

`POST /gc/:integration` accepts GC 1.4 `OrderCreate` JSON (including `text/plain` JSON bodies). It validates the GC MD5 signature, fixed notification target and trusted return origin, and submits an HMAC-SHA256 signed GMPay form. Successful responses carry the actual hosted cashier URL returned by GMPay.

GMPay's 32-character order ID is the first 32 hexadecimal characters of SHA-256 over `integration + NUL + Casdoor payment name`. The original payment name, amount in cents and an HMAC context proof are carried in the notification URL. There is no mapping table; distinct integration keys produce distinct order IDs, including when they use the same GMPay account.

`POST /gmpay/notify/:integration/:payment/:cents/:proof` verifies the context, GMPay signature, merchant, order, amount, status and the gateway's authoritative payment details. It then sends a signed GC form to the fixed Casdoor payment endpoint. Only HTTP 200 with Casdoor's `success` acknowledgement becomes HTTP 200 with plain text `ok`. Otherwise it returns an error, allowing GMPay's existing durable notification worker to retry. Casdoor owns payment and coupon idempotency.

Forwarded Casdoor notifications include `?organization=<configured organization>`. Casdoor uses this explicit organization to attribute anonymous payment audit events, allowing an organization-scoped payment webhook (`singleOrgOnly=true`). The value comes only from the integration configuration; the original GC `notify_url` is still validated against the fixed native payment path. See Casdoor's [audit attribution](https://github.com/casdoor/casdoor/blob/v4.26.0/routers/record.go).

**Order creation is not transparently retryable.** GMPay v2.0.0 rejects an existing `order_id` instead of returning its cashier URL. A duplicate or unknown upstream result is returned as an explicit error; this Worker never generates a replacement ID or pretends that creation succeeded. The application should retain a confirmed Casdoor payment URL and reuse it, and surface unknown creation outcomes for reconciliation. [Gateway implementation](https://github.com/GMWalletApp/epusdt/blob/v2.0.0/src/model/service/order_service.go).

Recovery after the gateway's configured notification retry window uses its existing administrative replay tools. There is no additional retry store in this Worker. GC invoice requests are explicitly unsupported; refunds, free-order settlement, subscriptions and coupon rules remain the responsibility of Casdoor/application code.

`GET /healthz` reports the Worker version. Error responses expose stable codes without merchant secrets. Do not place production credentials in source, example configuration, URLs or logs.

## Development

`npm test` uses independent Node crypto checks for the GC/GMPay signatures and covers unicode encoding, order conversion, uncertain creation, repeated notifications, Casdoor failure/recovery, amount/currency mismatch and cross-integration replay. `npm run typecheck` checks the standalone Worker and tests. Configure your own routes and secrets before deploying; this repository contains only placeholder domains and credentials.

MIT licensed.
