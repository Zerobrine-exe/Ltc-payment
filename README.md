# LTC Payment Gateway API

A public API for verifying Litecoin (LTC) payments on-chain. Give it an address, an expected amount, and a deadline — it tells you whether a matching payment has been confirmed.

This document is written for AI agents / automated clients integrating with the API.

## Base URL

```
https://<your-domain>/api
```

Replace `<your-domain>` with this project's actual domain (development preview domain or published production domain).

## Authentication

Every request must include a valid API key using **one** of these methods:

- Header: `x-api-key: <secret>`
- Query parameter: `?key=<secret>`

Requests without a valid key receive `401 Unauthorized`.

The secret value is configured server-side as the `LTC_PAYMENT_API_SECRET` environment variable. Ask the project owner for the current value if you don't have it.

## Endpoint

### `GET /api/private/:address/:amount/:beforetime`

Checks whether a payment matching the given criteria has arrived at the given LTC address.

**Path parameters:**

| Param | Type | Description |
|---|---|---|
| `address` | string | The Litecoin address to watch (legacy `L...`, `M...`, or bech32 `ltc1...`) |
| `amount` | number | Expected payment amount, in LTC (e.g. `0.05`) |
| `beforetime` | number | Unix timestamp the payment must arrive before. Accepts seconds or milliseconds (values below `10000000000` are treated as seconds) |

**Example request:**

```bash
curl "https://<your-domain>/api/private/ltc1qexampleaddress0000000000000000000/0.05/1783190400" \
  -H "x-api-key: <secret>"
```

## Response

All responses are JSON with a `status` field. HTTP status is `200` for all recognized payment states; only auth/validation/upstream failures use non-200 codes.

| `status` | Meaning |
|---|---|
| `confirmed` | A matching payment was found with at least 1 confirmation |
| `pending` | A matching payment was found on-chain but hasn't reached the confirmation threshold yet |
| `waiting` | No matching payment yet, and the deadline hasn't passed |
| `expired` | The deadline passed with no matching payment |
| `error` | Bad request or upstream failure (see HTTP status code) |

**Example — confirmed:**

```json
{
  "status": "confirmed",
  "message": "Payment confirmed",
  "address": "ltc1qexampleaddress0000000000000000000",
  "expectedAmountLtc": 0.05,
  "receivedAmountLtc": 0.0501,
  "txHash": "94b48a5e4fc305e6724d71d5d7edcf7c7b00a835639abab5466cd445b14c9ee1",
  "confirmations": 3
}
```

**Example — pending:**

```json
{
  "status": "pending",
  "message": "Payment detected, waiting for confirmations (0/1)",
  "address": "ltc1qexampleaddress0000000000000000000",
  "expectedAmountLtc": 0.05,
  "receivedAmountLtc": 0.0501,
  "txHash": "94b48a5e4fc305e6724d71d5d7edcf7c7b00a835639abab5466cd445b14c9ee1",
  "confirmations": 0
}
```

**Example — waiting / expired:**

```json
{
  "status": "expired",
  "message": "No matching payment received before the deadline",
  "address": "ltc1qexampleaddress0000000000000000000",
  "expectedAmountLtc": 0.05,
  "beforeTime": "2026-07-03T00:00:00.000Z"
}
```

**Error responses:**

| HTTP status | Meaning |
|---|---|
| `400` | Invalid `address`, `amount`, or `beforetime` |
| `401` | Missing or incorrect API key |
| `502` | Upstream blockchain data provider unreachable |
| `500` | Unexpected internal error |

## Matching rules

- **Amount tolerance:** a received payment counts as a match if it's within **5%** of the expected amount (minimum tolerance of 1000 litoshis), to account for network fee rounding. This is an "almost equal" match, not an exact-value match.
- **Confirmation threshold:** a payment is `confirmed` once it has **at least 1 confirmation** on-chain. Before that, it's reported as `pending`.

## Recommended polling pattern

1. Generate/display the LTC address, expected amount, and a deadline (e.g. now + 30 minutes) to the payer.
2. Poll `GET /api/private/:address/:amount/:beforetime` every 15–30 seconds.
3. Stop polling once you receive `confirmed` (success) or `expired` (failure) — `waiting` and `pending` mean keep polling.

## Rate limits

This API relies on a public blockchain data provider with its own rate limits (roughly 200 requests/hour, ~3/sec). Avoid polling more frequently than every 15 seconds per address.

## Health check

`GET /api/healthz` — returns `{ "status": "ok" }` when the service is up. No API key required.
