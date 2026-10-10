import { paymentOf, withBursar } from '../src/index.js';
import type { BursarEnv } from '../src/index.js';

/** The worker under test: one priced route that echoes what it was paid, one that fails, one free. */
export default {
  fetch: withBursar<BursarEnv>(
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/free') return Response.json({ free: true });
      if (url.pathname === '/fail') return new Response('broken', { status: 500 });
      const body = (await request.json()) as { prompt?: string };
      const payment = paymentOf(request);
      return Response.json({
        rendered: body.prompt ?? null,
        payer: payment?.payer ?? null,
        scheme: payment?.scheme ?? null,
        amount: payment?.amount.toString() ?? null,
        lock: payment?.lock?.id.toString() ?? null,
      });
    },
    { unseenRetryMs: 10 },
  ),
};
