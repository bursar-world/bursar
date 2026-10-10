import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ROBINHOOD_CHAIN, robinhoodChainMoneyParser } from '@bursar/x402';

/**
 * A Robinhood Chain endpoint that charges one cent in USDG, built on the reference x402 packages.
 *
 * Two lines make it Robinhood Chain: the facilitator, which is Bursar's keyless surface, and the
 * money parser, which turns "$0.01" into USDG at the EIP-712 domain the token publishes. Both come
 * from @bursar/x402; the upstream default-asset table makes the parser unnecessary once it carries
 * the chain (docs/bullish/x402-rhc.patch).
 *
 *   PAY_TO=0x... pnpm --filter @bursar/example-x402-rhc server
 */
const payTo = process.env['PAY_TO'];
if (payTo === undefined || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
  console.error('PAY_TO must be the address that is paid, as 0x followed by 40 hex characters.');
  process.exit(1);
}
const facilitatorUrl = process.env['FACILITATOR_URL'] ?? ROBINHOOD_CHAIN.facilitator;
const port = Number(process.env['PORT'] ?? 4021);

const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
const server = new x402ResourceServer(facilitator).register(
  ROBINHOOD_CHAIN.network,
  new ExactEvmScheme().registerMoneyParser(robinhoodChainMoneyParser),
);

const app = express();
app.use(
  paymentMiddleware(
    {
      'GET /quote': {
        accepts: [{ scheme: 'exact', price: '$0.01', network: ROBINHOOD_CHAIN.network, payTo }],
        description: 'One quote, one cent, in USDG on Robinhood Chain.',
        mimeType: 'application/json',
      },
    },
    server,
  ),
);

app.get('/quote', (_request, response) => {
  response.json({ quote: 'the koi swims upstream', asset: 'USDG', network: ROBINHOOD_CHAIN.network });
});

app.listen(port, () => {
  console.log(`charging $0.01 in USDG for GET /quote on http://127.0.0.1:${port}, settled by ${facilitatorUrl}`);
});
