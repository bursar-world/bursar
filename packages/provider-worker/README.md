# @bursar/provider-worker

Charge agents for a Cloudflare Worker route. Wrap the fetch handler, name the prices, deploy.

```ts
import { paymentOf, withBursar } from '@bursar/provider-worker';

export default {
  fetch: withBursar(async (request) => {
    const payment = paymentOf(request);
    return Response.json({ rendered: 'a koi', paidBy: payment?.payer });
  }),
};
```

A request to a priced route with no payment is answered `402 Payment Required` with the price in
USDG on Robinhood Chain, following [x402](https://www.x402.org). A request carrying a payment is
verified with the Bursar facilitator before the handler runs, settled after it answers, and the
response goes out with the settlement in its headers. A route with no price passes through.

Agents pay with `@bursar/sdk`: `mandate.fetch(url, { capability, lane: 'mandate' })` reads the 402,
pays from the mandate's own escrow inside the limits its principal set, and retries. Nothing the
mandate refuses is paid.

## Install

```
npm install @bursar/provider-worker
```

Node 22 or newer to build; the worker itself runs on Cloudflare's runtime with the `nodejs_compat`
compatibility flag. The template at
[`templates/cloudflare-worker`](https://github.com/bursar-world/bursar/tree/main/templates/cloudflare-worker)
is a complete project, and `npm create @bursar/provider my-api` copies it.

## Configuration

Everything comes from the worker's environment. The first three go in `wrangler.toml` under
`[vars]`; the secrets go in with `wrangler secret put`.

| Variable | Required | What it is |
|---|---|---|
| `BURSAR_PROVIDER` | yes | The address the escrow pays. It has to be listed on the registry; the [provider desk](https://app.bursar.world/providers) does that. |
| `BURSAR_CAPABILITY` | yes | The capability each call falls under, `service:render:1` for example. A payer's mandate has to allow it. |
| `BURSAR_PRICES` | yes | `METHOD /path=price` entries separated by commas or newlines, prices in USDG with up to six decimals. `*` as the method prices every method; a path ending in `*` prices everything under it. The first match wins. |
| `BURSAR_FACILITATOR_TOKEN` | secret | The bearer token the facilitator issued you. The hosted facilitator answers providers that hold one. |
| `BURSAR_FACILITATOR_URL` | no | Defaults to `https://facilitator.bursar.world`. |
| `BURSAR_PROVIDER_KEY` | secret, optional | The provider's own key. With it the worker releases each escrow lock it serves, which is what pays you. Without it the locks stay open for the provider desk or the sidecar to release. |
| `BURSAR_RPC_URL` | no | The endpoint releases are sent through. Defaults to a keyless public one. |
| `BURSAR_SCHEMES` | no | `escrow`, `exact`, or both. Defaults to both, escrow first. |

A missing or malformed variable answers `500` with the variable named, so a misconfigured deploy
says what to fix instead of refusing every payment.

## What happens on a paid call

1. The route's price is looked up. No price, no charge: the handler runs as it would without this package.
2. No payment header: the 402 carries the offer twice, as the x402 v2 `PAYMENT-REQUIRED` header and as a JSON body with the v1 spelling alongside, so a client of either version reads it.
3. A payment header: the terms the payer echoes are checked against the worker's own offer, and it is the worker's copy that goes to the facilitator, so a payer cannot lower the price on the way back. The request body's SHA-256 travels with it, which holds the payment to this request.
4. `POST /verify`. A lock the facilitator's endpoint does not see yet is asked about again, twice, before the payment is refused. A refusal is a 402 with the facilitator's reason.
5. The handler runs. `paymentOf(request)` names the payer, the amount, the scheme and the lock. A response that is not a success is returned as it is and nothing is settled: on the escrow scheme the lock goes back to the payer at its deadline, on `exact` nothing was ever moved.
6. `POST /settle`. The response goes out with `PAYMENT-RESPONSE` (`X-PAYMENT-RESPONSE` for v1) carrying the transaction and the payer. A settlement that failed is a 402 with the reason. One the facilitator did not answer is reported as `settlement_unconfirmed`, never as a refusal: the facilitator broadcasts before it answers, and a dropped connection can leave a transfer that is mining.
7. With `BURSAR_PROVIDER_KEY`, the lock is released after the response is sent, committed to the bytes that were served, on the escrow the lock is in. A release that fails is logged and the lock stays open; nothing the payer sees changes.

## The two schemes

**`escrow`** is paid by the mandate account itself. Its `spend` locks the price in escrow for your
address, inside every limit the principal set, and the payment names that lock. The facilitator
reads the lock rather than redeeming a signature, and settlement broadcasts nothing. You are paid
when the lock is released.

**`exact`** is paid from the agent's own wallet with an EIP-3009 USDG transfer that settlement
broadcasts. Each payment is checked on its own; the mandate's daily and monthly windows do not
count it.

## Testing

`pnpm test` runs the suite on `workerd`, the runtime Cloudflare deploys to, through Miniflare, with
the facilitator and the chain standing in. The bundled worker is about 460 KB, 136 KB compressed.
