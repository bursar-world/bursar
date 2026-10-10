import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { ROBINHOOD_CHAIN, usdgSpendControl } from '@bursar/x402';

/**
 * A stock x402 client paying the endpoint in server.ts.
 *
 * One line is specific to Robinhood Chain: the client's spend controls allow USDG, which the
 * reference client refuses until the upstream default-asset table carries it. The rest is the
 * reference client as shipped. It registers the EVM scheme for every eip155 network, the server's
 * 402 names eip155:4663 and the domain to sign under, and the client signs it like any other chain.
 *
 *   EVM_PRIVATE_KEY=0x... pnpm --filter @bursar/example-x402-rhc pay
 */
export type Signer = { readonly address: `0x${string}`; signTypedData: ReturnType<typeof privateKeyToAccount>['signTypedData'] };

export type Paid = {
  readonly status: number;
  readonly body: unknown;
  readonly transaction: string;
  readonly network: string;
  readonly payer: string;
  readonly explorer: string;
};

export async function pay(signer: Signer, url: string): Promise<Paid> {
  const client = new x402Client().register('eip155:*', new ExactEvmScheme(signer));
  client.setSpendControls({ allowedAssets: [usdgSpendControl('$1')] });
  const http = new x402HTTPClient(client);
  const response = await wrapFetchWithPayment(fetch, client)(url);
  const body: unknown = await response.clone().json().catch(() => null);
  const settled = http.getPaymentSettleResponse((name) => response.headers.get(name));
  return {
    status: response.status,
    body,
    transaction: settled.transaction,
    network: settled.network,
    payer: settled.payer ?? signer.address,
    explorer: `${ROBINHOOD_CHAIN.explorer}/tx/${settled.transaction}`,
  };
}

function startedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  const key = process.env['EVM_PRIVATE_KEY'];
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('EVM_PRIVATE_KEY must be the payer key, as 0x followed by 64 hex characters. It needs USDG on Robinhood Chain and no ETH.');
    process.exit(1);
  }
  const url = process.env['RESOURCE_URL'] ?? 'http://127.0.0.1:4021/quote';
  const paid = await pay(privateKeyToAccount(key as `0x${string}`), url);
  console.log(JSON.stringify(paid, null, 2));
}
