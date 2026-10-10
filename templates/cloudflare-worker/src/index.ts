import { paymentOf, withBursar } from '@bursar/provider-worker';
import type { BursarEnv } from '@bursar/provider-worker';

/**
 * One priced route. An agent that calls it without paying gets a 402 with the price; one that pays
 * gets the result, and the payment settles through Bursar. Everything else passes through free.
 */
export default {
  fetch: withBursar<BursarEnv>(async (request) => {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/render') {
      const { prompt = '' } = (await request.json().catch(() => ({}))) as { prompt?: string };
      const payment = paymentOf(request);
      return Response.json({
        rendered: `a stub render of "${prompt}"`,
        paidBy: payment?.payer,
        lock: payment?.lock?.id.toString(),
      });
    }

    return Response.json({
      service: 'bursar-provider',
      priced: ['POST /render'],
      pay: 'Call POST /render. The 402 names the price and where to pay it.',
    });
  }),
};
