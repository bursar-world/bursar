/**
 * Reads the live deployment through the same code the browser uses and prints what a surface
 * would render. Run it after changing anything in src/chain or src/state.
 *
 *   pnpm --filter @bursar/web probe
 *
 * Watch the call count at the end. One batched read is one request; a fan-out shows up
 * here long before it shows up as a queue in front of a customer.
 */
import { probeProviders, rhcPool } from '../src/chain/client';
import { readSystem } from '../src/chain/reader';
import { readToken } from '../src/chain/token';
import { predictMandate, randomSalt, readMandateSummaries } from '../src/chain/mandates';
import { DAY_SECONDS, MONTH_SECONDS } from '../src/chain/limits';
import { CHAIN_ID } from '../src/chain/rhc';
import { evaluateAsset, evaluateConnectivity, evaluateFunding, evaluateMandate, evaluatePermission } from '../src/state/evaluate';
import { formatBrsr, formatEth, usdExact } from '../src/money';
import { micro } from '@bursar/core';

const MANDATE = '0x03fEbcEC31155466637d9958d4d15A1671E53a9D' as const;
const PRINCIPAL = '0x46c93a0e4dBFaFc6100a88123885ff9A11025F4e' as const;
const AGENT = '0x3164F1EaA42C769e40Aec0a43e8C51ec2c0EBe03' as const;
const MERCHANT = '0x780de139902298C8E6687572fC99B32A33144AA7' as const;

async function main(): Promise<void> {
  const providers = await probeProviders();
  for (const provider of providers) {
    console.log(`${provider.name.padEnd(9)} ${provider.reachable ? 'up' : 'down'} chain ${provider.chainId} block ${provider.blockNumber} ${provider.latencyMs}ms`);
  }

  const before = requestCount();
  const snapshot = await readSystem({
    mandate: MANDATE,
    principal: PRINCIPAL,
    agent: AGENT,
    merchant: MERCHANT,
    capability: 'doc.summarize:1',
    // Inside the documented account's per-payment cap, so the run prints the five states as a
    // working mandate reads. Raise it past the cap to watch the refusal get named instead.
    amount: micro(50_000n),
    gasPayer: AGENT,
  });
  const spent = requestCount() - before;

  console.log(`\n${snapshot.calls} reads, ${spent} request${spent === 1 ? '' : 's'}, ${snapshot.failures} failed, block ${snapshot.blockNumber}, chain clock ${snapshot.chainTime?.toISOString()}`);
  console.log(`mandate holds ${snapshot.funding.mandateBalance === undefined ? 'unread' : usdExact(snapshot.funding.mandateBalance)}, signer holds ${snapshot.funding.gasBalance === undefined ? 'unread' : formatEth(snapshot.funding.gasBalance)} for fees`);
  console.log(`provider ${snapshot.provider?.name ?? 'unread'} active=${snapshot.provider?.active} score=${snapshot.provider?.score} cap=${snapshot.provider?.maxPerJob}`);
  console.log(`preview allowed=${snapshot.permission?.preview?.allowed} reason=${snapshot.permission?.preview?.reason ?? '-'}\n`);

  const states = [
    evaluateConnectivity(providers, CHAIN_ID, snapshot.blockNumber, new Date(), false),
    evaluateAsset(snapshot, new Date(), false),
    evaluateMandate(snapshot, new Date(), false, MANDATE),
    evaluatePermission(snapshot, new Date(), false),
    evaluateFunding(snapshot, new Date(), false),
  ];

  for (const state of states) {
    console.log(`${state.label.padEnd(13)} ${state.level.toUpperCase().padEnd(15)} ${state.headline}`);
    console.log(`${''.padEnd(29)}${state.detail}`);
    if (state.nextAction) console.log(`${''.padEnd(29)}-> ${state.nextAction.owner}: ${state.nextAction.label}`);
    console.log();
  }

  const listBefore = requestCount();
  const summaries = await readMandateSummaries(PRINCIPAL);
  console.log(`\n${summaries.length} mandate(s) for the principal in ${requestCount() - listBefore} request(s)`);
  for (const summary of summaries.slice(0, 5)) {
    console.log(`  ${summary.address} holds ${usdExact(summary.balance)}, ${usdExact(summary.dailyRemaining)} left today, v${summary.version}${summary.paused ? ', paused' : ''}${summary.revoked ? ', revoked' : ''}`);
  }

  const predicted = await predictMandate({
    principal: PRINCIPAL,
    agent: AGENT,
    salt: randomSalt(),
    limits: {
      perCallCap: micro(2_000_000n),
      dailyCap: micro(5_000_000n),
      monthlyCap: micro(50_000_000n),
      dailyWindow: DAY_SECONDS,
      monthlyWindow: MONTH_SECONDS,
      approvalThreshold: micro(2_500_000n),
    },
  });
  console.log(`  next mandate would deploy at ${predicted}\n`);

  const tokenBefore = requestCount();
  const token = await readToken(PRINCIPAL);
  console.log(`token read in ${requestCount() - tokenBefore} request(s), block ${token.blockNumber}`);
  console.log(`  supply        ${token.totalSupply === undefined ? 'unread' : formatBrsr(token.totalSupply, { maxDecimals: 0 })} BRSR`);
  console.log(
    `  staked        ${token.pool?.totalStaked === undefined ? 'unread' : formatBrsr(token.pool.totalStaked)} BRSR across ${token.pool?.totalShares ?? 0n} shares`,
  );
  console.log(`  buyback holds ${token.buyback?.available === undefined ? 'unread' : usdExact(token.buyback.available)}`);
}

function requestCount(): number {
  return rhcPool()
    .status()
    .reduce((total, provider) => total + provider.requests, 0);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
