import { execFileSync } from 'node:child_process';

import { RHC_MAINNET, deploymentForChain, explorerTxUrl } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { RELAY_API, isSettled, relayApi, sourceChain } from '../src/relay';
import type { FundingQuote, SourceChain } from '../src/relay';

/**
 * Fund a mandate from Base or Arc at a terminal, through Relay, with the same quote the console
 * uses.
 *
 *   npx tsx scripts/relay-fund.ts quote --from base --amount 0.50 --mandate 0x… --user 0x…
 *   npx tsx scripts/relay-fund.ts send  --from base --amount 0.50 --mandate 0x… --keystore <path> --password-file <path>
 *   npx tsx scripts/relay-fund.ts watch --request 0x…
 *
 * `send` signs each step with Foundry's `cast`, which reads the keystore itself: no key is read,
 * printed or held by this script. The password file is the one `cast` takes; its path is given,
 * never its content.
 */
const args = new Map<string, string>();
const [command = 'quote', ...rest] = process.argv.slice(2);
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i];
  const value = rest[i + 1];
  if (key !== undefined && key.startsWith('--') && value !== undefined) args.set(key.slice(2), value);
}

const relay = relayApi({ base: RELAY_API });
const record = deploymentForChain(RHC_MAINNET.chainId);
const destination = { chainId: RHC_MAINNET.chainId, currency: record.settlementAsset };

function need(name: string): string {
  const value = args.get(name);
  if (value === undefined) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return value;
}

function source(): SourceChain {
  const chain = sourceChain(need('from'));
  if (chain === undefined || chain.vm !== 'evm') {
    console.error('--from has to be base or arc; Solana is signed on Relay with a Solana wallet.');
    process.exit(2);
  }
  return chain;
}

function atomic(decimal: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0').slice(0, decimals) || '0');
}

function money(value: bigint, decimals: number): string {
  const text = value.toString().padStart(decimals + 1, '0');
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(/(\.\d{2}\d*?)0+$/, '$1');
}

function describe(quote: FundingQuote, chain: SourceChain): void {
  console.log(`request   ${quote.requestId}`);
  console.log(`you send  ${money(quote.source.amount, chain.usdc.decimals)} USDC on ${chain.name}`);
  console.log(`arrives   ${money(quote.arrives.expected, 6)} USDG (at least ${money(quote.arrives.minimum, 6)})`);
  console.log(`costs     $${money(quote.fees.total, 6)} (Relay $${money(quote.fees.relay, 6)}, network $${money(quote.fees.gas, 6)})`);
  console.log(`takes     about ${quote.seconds}s after the deposit confirms`);
  for (const step of quote.steps) {
    for (const call of step.calls) {
      console.log(`step      ${step.id}: to ${call.to} value ${call.value} gas ${call.gas ?? 'estimate'} data ${call.data.length / 2 - 1} bytes`);
    }
  }
}

async function watch(requestId: Hex, chain: SourceChain | undefined): Promise<void> {
  for (;;) {
    const status = await relay.status(requestId);
    console.log(`${new Date().toISOString()}  ${status.phase}${status.failReason === undefined ? '' : ` (${status.failReason})`}`);
    if (isSettled(status)) {
      for (const hash of status.inTxHashes) console.log(`deposit   ${chain === undefined ? hash : chain.explorerTx(hash)}`);
      for (const hash of status.txHashes) {
        console.log(`${status.phase === 'success' ? 'landed' : 'refund'}    ${status.phase === 'success' ? explorerTxUrl(RHC_MAINNET, hash as Hex) : chain === undefined ? hash : chain.explorerTx(hash)}`);
      }
      console.log(`relay     https://relay.link/transaction/${requestId}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function cast(argv: readonly string[]): string {
  return execFileSync('cast', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

async function main(): Promise<void> {
  if (command === 'watch') {
    await watch(need('request') as Hex, sourceChain(args.get('from') ?? '') );
    return;
  }

  const chain = source();
  const mandate = need('mandate') as Address;
  const amount = atomic(need('amount'), chain.usdc.decimals);

  if (command === 'quote') {
    describe(await relay.quote({ user: need('user'), recipient: mandate, source: chain, amount, destination }), chain);
    return;
  }

  if (command !== 'send') {
    console.error('command has to be quote, send or watch');
    process.exit(2);
  }

  const keystore = need('keystore');
  const passwordFile = args.get('password-file') ?? process.env['ETH_PASSWORD'];
  if (passwordFile === undefined) {
    console.error('--password-file (or ETH_PASSWORD, a path) is required to sign');
    process.exit(2);
  }
  const signer = ['--keystore', keystore, '--password-file', passwordFile];
  const user = cast(['wallet', 'address', ...signer]) as Address;
  const rpc = chain.wagmi?.rpcUrls.default.http[0];
  if (rpc === undefined) throw new Error(`${chain.name} has no endpoint recorded`);

  const quote = await relay.quote({ user, recipient: mandate, source: chain, amount, destination });
  describe(quote, chain);

  for (const step of quote.steps) {
    for (const call of step.calls) {
      console.log(`signing   ${step.id} on ${chain.name} as ${user}`);
      const receipt = cast([
        'send',
        '--rpc-url',
        rpc,
        ...signer,
        '--json',
        ...(call.gas === undefined ? [] : ['--gas-limit', ((call.gas * 12n) / 10n).toString()]),
        '--value',
        call.value.toString(),
        call.to,
        call.data,
      ]);
      const parsed = JSON.parse(receipt) as { transactionHash: Hex; status: string };
      console.log(`sent      ${chain.explorerTx(parsed.transactionHash)} (${parsed.status})`);
      if (parsed.status !== '0x1') throw new Error(`${step.id} reverted`);
    }
  }

  await watch(quote.requestId, chain);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
