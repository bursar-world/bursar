# A stock x402 client pays a Robinhood Chain endpoint in USDG

Two processes from the reference x402 packages, with Bursar as the facilitator. `server.ts` is an
Express endpoint that charges one cent in USDG for `GET /quote`. `pay.ts` is the reference client
paying it. Nothing in the client knows Robinhood Chain; the server's 402 names `eip155:4663`, the
USDG address and the domain to sign under, and the client signs it like any other chain.

```
pnpm install
PAY_TO=0xYourAddress pnpm --filter @bursar/example-x402-rhc server
EVM_PRIVATE_KEY=0x... pnpm --filter @bursar/example-x402-rhc pay
```

The payer needs USDG on Robinhood Chain and no ETH: the facilitator's relayer pays the gas. The
client prints the paid response, the settlement the facilitator reported, and a link to the
transaction on the explorer.

`FACILITATOR_URL` overrides the facilitator (default `https://facilitator.bursar.world/x402`),
`PORT` the server's port (default 4021), and `RESOURCE_URL` the endpoint the client pays
(default `http://127.0.0.1:4021/quote`).

The server quotes USDG through `robinhoodChainMoneyParser` from `@bursar/x402`. Once the upstream
default-asset table carries Robinhood Chain (`docs/bullish/x402-rhc.patch`), `price: "$0.01"`
resolves without it.
