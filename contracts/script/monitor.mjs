#!/usr/bin/env node
// Hourly checks of the live Bursar deployment on Robinhood Chain, read over public RPC.
//
//   node contracts/script/monitor.mjs
//
// Reads the live record under contracts/deployments, asks the chain, prints one line per check as
// `ok`, `warn`, `alert` or `skip`, and exits 1 when any line is an alert. RHC_RPC_URL, when set,
// is tried first; the chain's public endpoint and dRPC follow. BURSAR_ALERT_WEBHOOK, when set,
// receives the warnings and alerts. FACILITATOR_GAS_FLOAT names the facilitator's relayer address,
// which the record does not carry; without it that check is skipped. BURSAR_RECORD points at a
// record other than the live one.
//
// viem is resolved from packages/core, so `pnpm install --frozen-lockfile --filter @bursar/core`
// from the repository root is all a bare checkout needs. docs/RUNBOOK.md says what to do about
// each line.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Two hourly runs overlap, so nothing that happened between runs is missed.
const EVENT_LOOKBACK_SECONDS = 2 * 3600;
// dRPC's free plan refuses eth_getLogs over 10,000 blocks; the chain's own endpoint takes more.
const LOG_CHUNK_BLOCKS = 10_000n;
// An approved proposal lapses 14 days after its delay ends; say so with two days to go.
const PROPOSAL_EXPIRY_WARN_SECONDS = 2 * 86_400;
// The facilitator's own default reserve (FACILITATOR_GAS_FLOAT_MINIMUM_ETH); health degrades below it.
const FACILITATOR_FLOAT_MIN_ETH = 0.004;
// The relayer's /health turns ok false below 0.0005 ETH. A gas drop is 0.00015 ETH, twenty an
// hour at most, so 0.002 ETH is about one hour of drops.
const RELAYER_ALERT_ETH = 0.0005;
const RELAYER_WARN_ETH = 0.002;
// RESOLVER_MIN_GAS_WEI's default: the resolver service warns under 0.0001 ETH per key. The postman
// and the keeper send about as often.
const SERVICE_KEY_MIN_ETH = 0.0001;
// A pause or an unpause has to be paid for by the key that sends it.
const GOVERNANCE_KEY_MIN_ETH = 0.0002;
// Deposits refuse at the cap by design; four fifths full is early notice.
const POOL_FILL_WARN_BPS = 8_000n;
// The association-set provider posts at most once every ten minutes.
const ROOT_LAG_SECONDS = 600;
// Draws refuse once debt reaches cash; nine tenths utilisation is the notice.
const CREDIT_UTILISATION_WARN_BPS = 9_000n;
// Twenty minutes before a reveal window closes with quorum unmet is when the backup runner acts.
const DISPUTE_WINDOW_WARN_SECONDS = 20 * 60;
// The resolver service's own watchdog: a dispute still open an hour after its reveal window.
const DISPUTE_STUCK_SECONDS = 3600;
// The solvency service posts once a day; two days without a root means it is down.
const SOLVENCY_MAX_AGE_SECONDS = 2 * 86_400;

const CHAIN_ID = 4663;
const RPCS = [process.env.RHC_RPC_URL, 'https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'].filter(Boolean);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const viem = await loadViem();
const { createPublicClient, fallback, http, parseAbi, formatEther, decodeEventLog, toFunctionSelector, getAddress } = viem;

const record = loadRecord();
const client = createPublicClient({
  transport: fallback(RPCS.map((url) => http(url, { timeout: 20_000, retryCount: 2 })), { rank: false }),
});

const timelockAbi = parseAbi([
  'function proposalCount() view returns (uint256)',
  'function getProposal(uint256) view returns ((address target, bytes data, uint64 createdAt, uint64 executeAfter, bool executed, bool cancelled))',
  'function approvals(uint256) view returns (uint256)',
  'function canExecute(uint256) view returns (bool, bytes4)',
  'function GRACE_PERIOD() view returns (uint64)',
  'function timelockPeriod() view returns (uint64)',
  'function guardian() view returns (address)',
  'function getSigners() view returns (address[3])',
  'event ProposalCreated(uint256 indexed id, address indexed target, bytes data, uint64 executeAfter)',
  'event ProposalApproved(uint256 indexed id, address indexed signer, uint256 approvals)',
  'event ProposalExecuted(uint256 indexed id)',
  'event ProposalCancelled(uint256 indexed id, address indexed signer)',
  'event ProposalVetoed(uint256 indexed id, address indexed signer, uint256 vetoes)',
  'event SignerUpdated(uint256 indexed index, address indexed from, address indexed to)',
  'event GuardianUpdated(address indexed from, address indexed to)',
  'event GuardianPaused(address indexed target, address indexed guardian)',
  'event GuardianPauseSkipped(address indexed target, address indexed guardian, bytes reason)',
]);
const pausableAbi = parseAbi(['function paused() view returns (bool)']);
const escrowAbi = parseAbi([
  'function nextId() view returns (uint256)',
  'function getLock(uint256) view returns ((address payer, address payee, address disputer, bytes32 capabilityId, bytes32 inputCommit, bytes32 outputCommit, string inputURI, string outputURI, uint128 amount, uint64 deadline, uint64 releasedAt, uint128 bond, uint64 disputedAt, uint8 status, bool counted))',
]);
const oracleAbi = parseAbi([
  'function disputeIdOf(uint256) view returns (uint256)',
  'function getDispute(uint256) view returns ((uint256 escrowId, uint64 openedAt, uint64 commitEndsAt, uint64 revealEndsAt, uint8 commitCount, uint8 revealCount, uint8 medianScore, uint16 refundBps, uint8 rewardShares, uint8 status))',
  'function config() view returns ((uint64 commitWindow, uint64 revealWindow, uint64 unbondingPeriod, uint8 quorum, uint8 maxVoters, uint8 maxDeviation, uint16 slashBps))',
]);
const feedAbi = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const assetRegistryAbi = parseAbi([
  'function get(address) view returns ((address feed, uint32 tradeStaleness, uint32 valuationStaleness, uint16 bandBps, uint16 haircutBps, uint16 collateralHaircutBps, uint8 decimals, bool eligible, bool isStock, bool isTreasury, uint128 perTradeCap, uint128 perMandateCap, uint128 totalCap, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) pool))',
]);
const vaultAbi = parseAbi([
  'function tierOf(address) view returns (uint8)',
  'function tiers() view returns ((uint16 sessionHaircutBps, uint16 afterHoursHaircutBps, uint32 sessionStaleness, uint32 valuationStaleness, string name)[])',
]);
const creditPoolAbi = parseAbi([
  'function cash() view returns (uint256)',
  'function totalDebt() view returns (uint256)',
  'function utilisationBps() view returns (uint256)',
  'function badDebt() view returns (uint256)',
  'function totalDebtCap() view returns (uint128)',
  'function perMandateCap() view returns (uint128)',
]);
const shieldedPoolAbi = parseAbi([
  'function poolValue() view returns (uint256)',
  'function MAX_TOTAL() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function dead() view returns (bool)',
  'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)',
]);
const entrypointAbi = parseAbi([
  'function latestRoot() view returns (uint256)',
  'function associationSets(uint256) view returns (uint256 root, string ipfsCID, uint256 timestamp)',
]);
const solvencyAbi = parseAbi([
  'function latestEpoch() view returns (uint64)',
  'function epochs(uint64) view returns ((bytes32 root, uint128 liabilities, uint128 assets, uint64 asOfBlock, uint64 postedAt))',
]);
const buybackAbi = parseAbi([
  'function ceilingSetAt() view returns (uint64)',
  'function maxCeilingAge() view returns (uint64)',
  'function params() view returns ((uint128 spendPerCallMicroUsd, uint128 maxSpendPerWindowMicroUsd, uint128 minSpendMicroUsd, uint128 maxPriceMicroUsdPerBrsr, uint64 window, uint64 minInterval))',
]);
const vestingAbi = parseAbi(['function admin() view returns (address)']);

// Every setter a proposal can carry, so a pending proposal prints as a call and not as calldata.
const SETTERS = [
  'setCurve((uint128,uint128,uint128))', 'transferAdmin(address)', 'acceptAdmin()', 'pause()', 'unpause()',
  'setConfig((uint64,uint64,uint64,uint8,uint8,uint8,uint16))', 'setSlashSink(address)', 'slash(address,uint128)', 'evict(address)',
  'setMinStake(uint128)', 'setSlashBps(uint16)', 'setSlasher(address)', 'setBlacklistRoot(bytes32)', 'clearBlacklist(address)',
  'slash(address,uint256,bytes32)', 'sweep(address,address,uint256)',
  'setTiers((uint256,uint16)[])', 'setUnbondingPeriod(uint64)', 'setUnbondWindow(uint64)', 'setMaxExitHold(uint64)',
  'setSlashLimit(uint16,uint64)', 'setMinBond(uint256)', 'setBondFloor(address,uint256)', 'setBondingDenied(address,bool)',
  'setCreditManager(address)', 'setTreasury(address)',
  'setParams((uint128,uint128,uint128,uint128,uint64,uint64))', 'setKeeper(address)', 'setMaxCeilingAge(uint64)', 'sweep(address,uint256)',
  'initializePool(uint160)', 'removeLiquidity(int24,int24,uint128,uint256,uint256,address)', 'transferOwnership(address)', 'acceptOwnership()',
  'setEligible(address,bool)', 'setAdapter(address,bool)', 'setCaps(uint128,uint128)', 'setRates(uint16,uint16)', 'setLender(address)',
  'setParams((uint64,uint64,uint16))', 'setAssetTier(address,uint8)', 'setPoster(address)', 'revoke(address)', 'sweep()',
  'updateSigner(uint256,address)', 'setGuardian(address)', 'transfer(address,uint256)',
  'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'upgradeToAndCall(address,bytes)', 'windDownPool(address)',
  'registerPool(address,address,uint256,uint256,uint256)', 'removePool(address)', 'updatePoolConfiguration(address,uint256,uint256,uint256)',
  'withdrawFees(address,address)',
];
const selectorNames = new Map(SETTERS.map((signature) => [toFunctionSelector(`function ${signature}`), signature.slice(0, signature.indexOf('('))]));

const lines = [];
const blockCache = new Map();
const report = (level, check, detail) => {
  lines.push({ level, check, detail });
  console.log(`${level.padEnd(5)} ${check}: ${detail}`);
};

const head = await client.getBlock();
const now = Number(head.timestamp);
const names = contractNames(record);

for (const [name, check] of Object.entries({
  timelock: checkTimelocks,
  pauses: checkPauses,
  balances: checkBalances,
  'shielded pool': checkShieldedPool,
  'price feeds': checkFeeds,
  'credit pool': checkCreditPool,
  disputes: checkDisputes,
  buyback: checkBuyback,
  'solvency log': checkSolvency,
})) {
  try {
    await check();
  } catch (error) {
    report('alert', name, `could not read the chain: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

const alerts = lines.filter((l) => l.level === 'alert');
const warnings = lines.filter((l) => l.level === 'warn');
console.log(`${alerts.length} alert(s), ${warnings.length} warning(s), ${lines.length} checks, record ${record.network} at block ${head.number} (${iso(now)})`);
await notify();
process.exit(alerts.length === 0 ? 0 : 1);

async function checkTimelocks() {
  const live = record.contracts.AdminTimelock;
  await checkTimelock(live, 'timelock');
  // A 48-hour timelock deployed to take over is governance from the moment the old one offers it
  // anything, so its proposals count from the start.
  const next = record.governance48?.AdminTimelock;
  if (next && !same(next, live)) await checkTimelock(next, `48-hour timelock ${short(next)}`);
  // Vesting and the community allocation answer to the first set's timelock until the handover
  // lands, so a proposal there is part of this deployment's governance too.
  const vestingAdmin = await client.readContract({ address: record.token.Vesting, abi: vestingAbi, functionName: 'admin' });
  if (!same(vestingAdmin, live)) await checkTimelock(vestingAdmin, `vesting's timelock ${short(vestingAdmin)}`);
}

async function checkTimelock(address, label) {
  const tl = { address, abi: timelockAbi };
  const [count, grace, period] = await Promise.all([
    client.readContract({ ...tl, functionName: 'proposalCount' }),
    client.readContract({ ...tl, functionName: 'GRACE_PERIOD' }),
    client.readContract({ ...tl, functionName: 'timelockPeriod' }),
  ]);
  let executed = 0;
  let cancelled = 0;
  let lapsed = 0;
  let pending = 0;
  for (let id = 0n; id < count; id += 1n) {
    const p = await client.readContract({ ...tl, functionName: 'getProposal', args: [id] });
    if (p.executed) {
      executed += 1;
      continue;
    }
    if (p.cancelled) {
      cancelled += 1;
      continue;
    }
    const expiresAt = Number(p.executeAfter) + Number(grace);
    if (now > expiresAt) {
      lapsed += 1;
      continue;
    }
    pending += 1;
    const [approvals, [ready]] = await Promise.all([
      client.readContract({ ...tl, functionName: 'approvals', args: [id] }),
      client.readContract({ ...tl, functionName: 'canExecute', args: [id] }),
    ]);
    const call = `${names.get(p.target.toLowerCase()) ?? short(p.target)}.${selectorNames.get(p.data.slice(0, 10)) ?? p.data.slice(0, 10)}`;
    const when = ready
      ? `executable now, since ${iso(Number(p.executeAfter))}`
      : Number(p.executeAfter) > now
        ? `executable at ${iso(Number(p.executeAfter))} (in ${duration(Number(p.executeAfter) - now)})`
        : `waiting for a second approval`;
    const expiry = expiresAt - now < PROPOSAL_EXPIRY_WARN_SECONDS ? `, lapses in ${duration(expiresAt - now)}` : `, lapses ${iso(expiresAt)}`;
    report('warn', `${label} #${id}`, `${call} with ${approvals} of 2 approvals, created ${iso(Number(p.createdAt))}, ${when}${expiry}`);
  }
  if (pending === 0) {
    report('ok', label, `no pending proposals (${executed} executed, ${cancelled} cancelled, ${lapsed} lapsed), delay ${duration(Number(period))}`);
  }

  const from = await blockAt(now - EVENT_LOOKBACK_SECONDS);
  for (const log of await logs(address, from)) {
    let event;
    try {
      event = decodeEventLog({ abi: timelockAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const a = event.args;
    const at = `block ${log.blockNumber}`;
    switch (event.eventName) {
      case 'ProposalCreated':
        report('warn', `${label} event`, `ProposalCreated #${a.id} for ${names.get(a.target.toLowerCase()) ?? short(a.target)} at ${at}`);
        break;
      case 'ProposalExecuted':
        report('warn', `${label} event`, `ProposalExecuted #${a.id} at ${at}: run the post-deploy check`);
        break;
      case 'ProposalCancelled':
      case 'ProposalVetoed':
        report('warn', `${label} event`, `${event.eventName} #${a.id} by ${short(a.signer)} at ${at}`);
        break;
      case 'SignerUpdated':
        report('warn', `${label} event`, `signer ${a.index} changed from ${short(a.from)} to ${short(a.to)} at ${at}`);
        break;
      case 'GuardianUpdated':
        report('warn', `${label} event`, `guardian changed from ${short(a.from)} to ${short(a.to)} at ${at}`);
        break;
      case 'GuardianPaused':
        report('alert', `${label} event`, `guardian paused ${names.get(a.target.toLowerCase()) ?? short(a.target)} at ${at}`);
        break;
      case 'GuardianPauseSkipped':
        report('warn', `${label} event`, `guardian pause skipped ${names.get(a.target.toLowerCase()) ?? short(a.target)} at ${at}`);
        break;
      default:
    }
  }
}

async function checkPauses() {
  const targets = [
    ['Escrow', record.contracts.Escrow],
    ['OracleRegistry', record.contracts.OracleRegistry],
    ['AgentRegistry', record.contracts.AgentRegistry],
    ['Staking', record.token.Staking],
    ['Buyback', record.token.Buyback],
  ];
  const states = await Promise.all(targets.map(([, address]) => client.readContract({ address, abi: pausableAbi, functionName: 'paused' })));
  const paused = targets.filter((_, i) => states[i]).map(([name]) => name);
  if (paused.length === 0) report('ok', 'pauses', `none of ${targets.map(([n]) => n).join(', ')} is paused`);
  else report('alert', 'pauses', `${paused.join(', ')} paused: new locks and disputes refuse until an unpause proposal lands`);

  const shielded = record.privacy?.shielded;
  if (shielded) {
    const dead = await client.readContract({ address: shielded.ShieldedPool, abi: shieldedPoolAbi, functionName: 'dead' });
    if (dead) report('alert', 'shielded pool', 'wound down: it takes no deposits; withdrawals and ragequits still work');
  }
}

async function checkBalances() {
  const float = process.env.FACILITATOR_GAS_FLOAT?.trim();
  if (float) await balance('facilitator gas float', float, FACILITATOR_FLOAT_MIN_ETH, FACILITATOR_FLOAT_MIN_ETH);
  else report('skip', 'facilitator gas float', 'FACILITATOR_GAS_FLOAT is not set, so the facilitator relayer is not checked');

  const shielded = record.privacy?.shielded;
  if (shielded?.relayer) await balance('shielded relayer', shielded.relayer, RELAYER_WARN_ETH, RELAYER_ALERT_ETH);
  if (shielded?.aspPostman) await balance('association-set postman', shielded.aspPostman, SERVICE_KEY_MIN_ETH, SERVICE_KEY_MIN_ETH / 2);
  for (const [i, resolver] of (record.roles.resolvers ?? []).entries()) {
    await balance(`resolver ${i + 1}`, resolver, SERVICE_KEY_MIN_ETH, SERVICE_KEY_MIN_ETH / 2);
  }
  if (record.token.keeper && !(record.roles.resolvers ?? []).some((r) => same(r, record.token.keeper))) {
    await balance('buyback keeper', record.token.keeper, SERVICE_KEY_MIN_ETH, SERVICE_KEY_MIN_ETH / 2);
  }
  for (const [i, signer] of record.roles.timelockSigners.entries()) {
    await balance(`signer ${i + 1}`, signer, GOVERNANCE_KEY_MIN_ETH, GOVERNANCE_KEY_MIN_ETH / 2);
  }
  await balance('guardian', record.roles.guardian, GOVERNANCE_KEY_MIN_ETH, GOVERNANCE_KEY_MIN_ETH / 2);
  const incoming = record.governance48;
  if (incoming && !same(incoming.AdminTimelock, record.contracts.AdminTimelock)) {
    for (const [i, signer] of incoming.signers.entries()) {
      await balance(`48-hour signer ${i + 1}`, signer, GOVERNANCE_KEY_MIN_ETH, GOVERNANCE_KEY_MIN_ETH / 2);
    }
    if (!same(incoming.guardian, record.roles.guardian)) {
      await balance('48-hour guardian', incoming.guardian, GOVERNANCE_KEY_MIN_ETH, GOVERNANCE_KEY_MIN_ETH / 2);
    }
  }
}

async function balance(label, address, warnBelowEth, alertBelowEth) {
  const wei = await client.getBalance({ address: getAddress(address) });
  const eth = Number(formatEther(wei));
  const figure = `${short(address)} holds ${eth.toFixed(6)} ETH`;
  if (eth < alertBelowEth) report('alert', label, `${figure}, under the ${alertBelowEth} ETH floor: top it up`);
  else if (eth < warnBelowEth) report('warn', label, `${figure}, under ${warnBelowEth} ETH: top it up soon`);
  else report('ok', label, figure);
}

async function checkShieldedPool() {
  const shielded = record.privacy?.shielded;
  if (!shielded) {
    report('skip', 'shielded pool', 'the record names no shielded pool');
    return;
  }
  const pool = { address: shielded.ShieldedPool, abi: shieldedPoolAbi };
  const [value, cap, deposits] = await Promise.all([
    client.readContract({ ...pool, functionName: 'poolValue' }),
    client.readContract({ ...pool, functionName: 'MAX_TOTAL' }),
    client.readContract({ ...pool, functionName: 'nonce' }),
  ]);
  const fillBps = cap === 0n ? 0n : (value * 10_000n) / cap;
  const fill = `${usdg(value)} of ${usdg(cap)} USDG (${Number(fillBps) / 100}%) over ${deposits} deposit(s)`;
  report(fillBps >= POOL_FILL_WARN_BPS ? 'warn' : 'ok', 'shielded pool fill', fill);

  const root = await latestAssociationSet(shielded.Entrypoint);
  const from = await blockAt(now - EVENT_LOOKBACK_SECONDS);
  const recent = (await logs(shielded.ShieldedPool, from)).filter((log) => {
    try {
      return decodeEventLog({ abi: shieldedPoolAbi, data: log.data, topics: log.topics }).eventName === 'Deposited';
    } catch {
      return false;
    }
  });
  const lastDeposit = recent.length === 0 ? null : Number((await client.getBlock({ blockNumber: recent[recent.length - 1].blockNumber })).timestamp);

  if (root === null) {
    if (deposits > 0n) report('alert', 'association-set root', `none posted and the pool holds ${deposits} deposit(s): nothing can be withdrawn until the postman posts`);
    else report('ok', 'association-set root', 'none posted yet, and the pool has no deposits');
    return;
  }
  const rootAge = now - root.timestamp;
  if (lastDeposit !== null && lastDeposit > root.timestamp && now - lastDeposit > ROOT_LAG_SECONDS) {
    report('warn', 'association-set root', `last posted ${iso(root.timestamp)}, a deposit landed ${iso(lastDeposit)} and no root has followed it`);
  } else {
    report('ok', 'association-set root', `set ${root.index} posted ${iso(root.timestamp)} (${duration(rootAge)} ago)${lastDeposit === null ? ', no deposit in the last ' + duration(EVENT_LOOKBACK_SECONDS) : ''}`);
  }
}

async function latestAssociationSet(entrypoint) {
  const ep = { address: entrypoint, abi: entrypointAbi };
  try {
    await client.readContract({ ...ep, functionName: 'latestRoot' });
  } catch {
    return null;
  }
  // The sets array has no length getter, so the last index is found where the getter stops answering.
  const exists = async (i) => {
    try {
      await client.readContract({ ...ep, functionName: 'associationSets', args: [BigInt(i)] });
      return true;
    } catch {
      return false;
    }
  };
  let lo = 0;
  let hi = 1;
  while (await exists(hi)) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  const [root, , timestamp] = await client.readContract({ ...ep, functionName: 'associationSets', args: [BigInt(lo)] });
  return { index: lo, root, timestamp: Number(timestamp) };
}

async function checkFeeds() {
  const rwa = record.rwa;
  if (!rwa?.assets) {
    report('skip', 'price feeds', 'the record names no assets');
    return;
  }
  const tiers = rwa.collateral ? await client.readContract({ address: rwa.collateral.CollateralVault, abi: vaultAbi, functionName: 'tiers' }) : [];
  for (const [symbol, asset] of Object.entries(rwa.assets)) {
    const [config, tier, [, answer, , updatedAt]] = await Promise.all([
      client.readContract({ address: rwa.AssetRegistry, abi: assetRegistryAbi, functionName: 'get', args: [asset.address] }),
      rwa.collateral ? client.readContract({ address: rwa.collateral.CollateralVault, abi: vaultAbi, functionName: 'tierOf', args: [asset.address] }) : 0,
      client.readContract({ address: asset.feed, abi: feedAbi, functionName: 'latestRoundData' }),
    ]);
    const age = now - Number(updatedAt);
    const tradeBound = Number(config.tradeStaleness);
    // Collateral counts at the tier's bound; a parked treasury position at the registry's.
    const valuationBound = tier > 0 ? Number(tiers[tier - 1].valuationStaleness) : Number(config.valuationStaleness);
    const price = (Number(answer) / 1e8).toFixed(2);
    const figure = `${price} USD, updated ${iso(Number(updatedAt))} (${duration(age)} ago; trade bound ${duration(tradeBound)}, valuation bound ${duration(valuationBound)})`;
    if (age > valuationBound) report('alert', `feed ${symbol}`, `${figure}: positions count as zero and liquidation defers`);
    else if (age > tradeBound && inSession(now)) report('warn', `feed ${symbol}`, `${figure}: trades refuse inside the equities session`);
    else if (age > tradeBound) report('ok', `feed ${symbol}`, `${figure}: past the trade bound at the weekend, which is expected`);
    else report('ok', `feed ${symbol}`, figure);
  }
}

async function checkCreditPool() {
  const collateral = record.rwa?.collateral;
  if (!collateral) {
    report('skip', 'credit pool', 'the record names no credit pool');
    return;
  }
  const pool = { address: collateral.CreditPool, abi: creditPoolAbi };
  const [cash, debt, utilisation, badDebt, totalCap, perMandateCap] = await Promise.all(
    ['cash', 'totalDebt', 'utilisationBps', 'badDebt', 'totalDebtCap', 'perMandateCap'].map((functionName) => client.readContract({ ...pool, functionName })),
  );
  const figure = `cash ${usdg(cash)} USDG, debt ${usdg(debt)} of ${usdg(totalCap)} USDG cap, utilisation ${Number(utilisation) / 100}%, bad debt ${usdg(badDebt)} USDG`;
  if (badDebt > 0n) report('alert', 'credit pool', `${figure}: a line was written off and the lender carries the loss`);
  else if (utilisation >= CREDIT_UTILISATION_WARN_BPS) report('warn', 'credit pool', `${figure}: draws refuse once debt reaches cash`);
  else if (cash < perMandateCap) report('warn', 'credit pool', `${figure}: less cash than one full line of ${usdg(perMandateCap)} USDG`);
  else report('ok', 'credit pool', figure);
}

async function checkDisputes() {
  const escrow = { address: record.contracts.Escrow, abi: escrowAbi };
  const oracle = { address: record.contracts.OracleRegistry, abi: oracleAbi };
  const nextId = await client.readContract({ ...escrow, functionName: 'nextId' });
  const ids = [];
  for (let id = 1n; id < nextId; id += 1n) ids.push(id);
  const DISPUTED = 4;
  let open = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const locks = await client.multicall({
      contracts: batch.map((id) => ({ ...escrow, functionName: 'getLock', args: [id] })),
      allowFailure: false,
      multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
    });
    for (const [j, lock] of locks.entries()) {
      // A complaint after a release is recorded and never ruled on; only a held lock has a vote.
      if (Number(lock.status) !== DISPUTED || lock.releasedAt !== 0n) continue;
      open += 1;
      const disputeId = await client.readContract({ ...oracle, functionName: 'disputeIdOf', args: [batch[j]] });
      const d = await client.readContract({ ...oracle, functionName: 'getDispute', args: [disputeId] });
      const voting = Number(d.status) === 1 || Number(d.status) === 2;
      const left = Number(d.revealEndsAt) - now;
      const figure = `lock ${batch[j]} (${usdg(lock.amount)} USDG), dispute ${disputeId}: ${d.commitCount} committed, ${d.revealCount} revealed, reveal window ends ${iso(Number(d.revealEndsAt))}`;
      if (!voting) report('warn', 'dispute', `${figure}: vote closed with status ${d.status} and the lock is still disputed`);
      else if (left < 0 && -left > DISPUTE_STUCK_SECONDS) report('alert', 'dispute', `${figure}: window closed ${duration(-left)} ago, call finalize or failDispute`);
      else if (left < 0) report('warn', 'dispute', `${figure}: window closed, anyone can finalize or failDispute`);
      else if (left < DISPUTE_WINDOW_WARN_SECONDS && d.revealCount < 2) report('alert', 'dispute', `${figure}: ${duration(left)} left with fewer than two reveals, run the backup runner`);
      else report('warn', 'dispute', `${figure}: ${duration(left)} left`);
    }
  }
  if (open === 0) report('ok', 'disputes', `no open dispute across ${ids.length} lock(s)`);
}

async function checkBuyback() {
  const buyback = { address: record.token.Buyback, abi: buybackAbi };
  const [setAt, maxAge, params] = await Promise.all([
    client.readContract({ ...buyback, functionName: 'ceilingSetAt' }),
    client.readContract({ ...buyback, functionName: 'maxCeilingAge' }),
    client.readContract({ ...buyback, functionName: 'params' }),
  ]);
  const staleAt = Number(setAt) + Number(maxAge);
  const figure = `ceiling ${params.maxPriceMicroUsdPerBrsr} micro-USD per BRSR, set ${iso(Number(setAt))}, trusted until ${iso(staleAt)}`;
  if (params.maxPriceMicroUsdPerBrsr === 0n) report('warn', 'buyback', `${figure}: a zero ceiling refuses every buyback`);
  else if (now > staleAt) report('warn', 'buyback', `${figure}: stale, restate it with setParams`);
  else report('ok', 'buyback', figure);
}

async function checkSolvency() {
  const log = record.privacy?.SolvencyLog;
  if (!log) {
    report('skip', 'solvency log', 'the record names no solvency log');
    return;
  }
  const latest = await client.readContract({ address: log, abi: solvencyAbi, functionName: 'latestEpoch' });
  if (latest === 0n) {
    report('warn', 'solvency log', 'no epoch posted yet');
    return;
  }
  const epoch = await client.readContract({ address: log, abi: solvencyAbi, functionName: 'epochs', args: [latest] });
  const age = now - Number(epoch.postedAt);
  const figure = `epoch ${latest} posted ${iso(Number(epoch.postedAt))} (${duration(age)} ago), liabilities ${usdg(epoch.liabilities)} USDG against ${usdg(epoch.assets)} USDG held`;
  if (epoch.assets < epoch.liabilities) report('alert', 'solvency log', `${figure}: assets below liabilities`);
  else if (age > SOLVENCY_MAX_AGE_SECONDS) report('warn', 'solvency log', `${figure}: the daily post is overdue`);
  else report('ok', 'solvency log', figure);
}

async function logs(address, fromBlock) {
  const found = [];
  for (let from = fromBlock; from <= head.number; from += LOG_CHUNK_BLOCKS) {
    const to = from + LOG_CHUNK_BLOCKS - 1n < head.number ? from + LOG_CHUNK_BLOCKS - 1n : head.number;
    found.push(...(await client.getLogs({ address, fromBlock: from, toBlock: to })));
  }
  return found;
}

// The first block at or after `timestamp`, by bisection over block timestamps.
async function blockAt(timestamp) {
  if (blockCache.has(timestamp)) return blockCache.get(timestamp);
  let lo = 0n;
  let hi = head.number;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < timestamp) lo = mid + 1n;
    else hi = mid;
  }
  blockCache.set(timestamp, lo);
  return lo;
}

async function notify() {
  const webhook = process.env.BURSAR_ALERT_WEBHOOK?.trim();
  const noteworthy = lines.filter((l) => l.level === 'alert' || l.level === 'warn');
  if (!webhook || noteworthy.length === 0) return;
  const text = [
    `[monitor] ${alerts.length} alert(s), ${warnings.length} warning(s) on chain ${CHAIN_ID} at ${iso(now)}`,
    ...noteworthy.map((l) => `${l.level}: ${l.check}: ${l.detail}`),
  ]
    .join('\n')
    .slice(0, 1_900);
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`webhook answered ${response.status}`);
  } catch (error) {
    console.error(`webhook not reached: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The US equities 24/5 session as CollateralVault.inSession counts it: Monday 01:00 UTC to
// Saturday 00:00 UTC. Outside it a feed older than its trade bound is expected.
function inSession(ts) {
  const dow = (Math.floor(ts / 86_400) + 4) % 7;
  if (dow === 0 || dow === 6) return false;
  if (dow === 1 && ts % 86_400 < 3600) return false;
  return true;
}

function contractNames(r) {
  const map = new Map();
  const add = (name, address) => {
    if (typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) && !map.has(address.toLowerCase())) map.set(address.toLowerCase(), name);
  };
  for (const [name, address] of Object.entries(r.contracts ?? {})) add(name, address);
  if (r.governance48?.AdminTimelock) add('AdminTimelock48', r.governance48.AdminTimelock);
  if (r.governance48?.previous) add('previous AdminTimelock', r.governance48.previous);
  for (const [name, address] of Object.entries(r.token ?? {})) add(name, address);
  for (const [name, address] of Object.entries(r.rwa ?? {})) add(name, address);
  for (const [name, address] of Object.entries(r.rwa?.collateral ?? {})) add(name, address);
  for (const [name, address] of Object.entries(r.privacy ?? {})) add(name, address);
  for (const [name, address] of Object.entries(r.privacy?.shielded ?? {})) add(name, address);
  return map;
}

function loadRecord() {
  const dir = join(ROOT, 'contracts', 'deployments');
  const explicit = process.env.BURSAR_RECORD?.trim();
  const path = explicit ? resolve(explicit) : liveRecordPath(dir);
  const r = JSON.parse(readFileSync(path, 'utf8'));
  if (r.chainId !== CHAIN_ID) throw new Error(`${path} is for chain ${r.chainId}, and this monitor reads chain ${CHAIN_ID}`);
  return r;
}

function liveRecordPath(dir) {
  const live = readdirSync(dir)
    .filter((file) => file.endsWith('.json') && file !== 'schema.json')
    .map((file) => join(dir, file))
    .filter((path) => {
      const r = JSON.parse(readFileSync(path, 'utf8'));
      return r.status === 'live' && r.chainId === CHAIN_ID && !r.local;
    });
  if (live.length !== 1) throw new Error(`expected one live record for chain ${CHAIN_ID} under ${dir}, found ${live.length}`);
  return live[0];
}

// viem as @bursar/core resolves it, which pnpm installs under packages/core.
async function loadViem() {
  const corePackage = join(ROOT, 'packages', 'core', 'package.json');
  let manifest;
  try {
    manifest = createRequire(corePackage).resolve('viem/package.json');
  } catch {
    console.error('viem is not installed: run pnpm install --frozen-lockfile --filter @bursar/core from the repository root');
    process.exit(2);
  }
  const entry = JSON.parse(readFileSync(manifest, 'utf8')).exports['.'].import;
  return import(pathToFileURL(join(dirname(manifest), typeof entry === 'string' ? entry : entry.default)).href);
}

function usdg(micro) {
  return (Number(micro) / 1e6).toFixed(2);
}

function iso(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 2 * 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

function short(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function same(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
