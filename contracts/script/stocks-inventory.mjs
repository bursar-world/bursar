#!/usr/bin/env node
// Which Robinhood stocks Chainlink prices on Robinhood Chain, and what each would trade through.
//
// For every "Robinhood <TICKER> / USD" feed in Chainlink's directory: the token Robinhood's
// StockFactory deployed under that ticker, the feed's answer and age, the token's pause flags, every
// Uniswap v4 pool pairing it with USDG (from the PoolManager's Initialize logs), and for each
// hookless pool its in-range liquidity, its mid against the feed, and quotes for 0.90, 10 and 25
// USDG through the V4Quoter. Nothing is sent.
//
//   RHC_RPC_URL=https://… node contracts/script/stocks-inventory.mjs docs/bullish/stocks-32-inventory.json
//
// The endpoint has to answer eth_getLogs over 10,000 blocks (Chainstack does; dRPC's free plan
// does not). The scan walks the chain from the PoolManager's deployment, about 8,500 windows, and
// takes a few minutes. Addresses of Bursar's contracts, USDG, the PoolManager and the StateView
// come from the deployment record; the StockFactory and the quoter are Robinhood's and Uniswap's,
// named here because no record carries them.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC = process.env.RHC_RPC_URL;
if (!RPC) {
  console.error('set RHC_RPC_URL to an endpoint that answers eth_getLogs over 10,000 blocks');
  process.exit(2);
}
const OUT = process.argv[2];
const RECORD = process.env.BURSAR_RECORD ?? join(ROOT, 'contracts', 'deployments', 'rhc-mainnet-v6.json');
const FEEDS_URL = process.env.CHAINLINK_FEEDS_URL ?? 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';

// Robinhood's StockFactory (an ERC1967 proxy over `StockFactory`), which deploys every tokenized
// stock as a beacon proxy and emits `Deployed` for it. Uniswap's V4Quoter on the chain.
const STOCK_FACTORY = '0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046';
const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SCAN_FROM = 9_070n;
const WINDOW = 10_000n;
const CONCURRENCY = 12;

const BAND_BPS = 100n;
// Pools above this fee are spam; most of the thousands initialised with USDG charge 50% to 99.99%.
// They are counted and not read. A hooked pool is counted and not read either: the registry
// refuses it whatever its depth.
const MAX_FEE_READ = 10_000;
const TRADE_STALENESS = 93_600;
const QUOTE_SIZES = [900_000n, 10_000_000n, 25_000_000n];
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;

const viem = await loadViem();
const { createPublicClient, http, parseAbi, decodeEventLog, getAddress, defineChain } = viem;

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const USDG = getAddress(record.settlementAsset);
const POOL_MANAGER = getAddress(record.external.PoolManager);
const STATE_VIEW = getAddress(record.external.StateView);
const ACCESS_REGISTRY = getAddress(record.external.AccessRegistry);
const REGISTRY = getAddress(record.rwa.AssetRegistry);
const GUARD = getAddress(record.rwa.PriceGuard);

const chain = defineChain({
  id: record.chainId,
  name: record.network,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});
const client = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }), batch: { multicall: { batchSize: 200_000, wait: 0 } } });

const events = parseAbi([
  'event Deployed(bytes32 indexed uid, address stock, string name, string symbol)',
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);
const abi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function tokenPaused() view returns (bool)',
  'function oraclePaused() view returns (bool)',
  'function uiMultiplier() view returns (uint256)',
  'function paused() view returns (bool)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function description() view returns (string)',
  'function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)',
  'function getLiquidity(bytes32) view returns (uint128)',
  'function isRegistered(address) view returns (bool)',
  'function midE8(uint160, bool, uint8) pure returns (uint256)',
  'function tradePrice(address, address) view returns (uint256)',
  'function quoteExactInputSingle((( address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) view returns (uint256, uint256)',
]);

const head = await client.getBlockNumber();
const scanTo = process.env.STOCKS_SCAN_TO ? BigInt(process.env.STOCKS_SCAN_TO) : head;
const chainTime = Number((await client.getBlock({ blockNumber: head })).timestamp);
console.error(`chain ${record.chainId} at block ${head}, ${new Date(chainTime * 1000).toISOString()}`);

const only = process.env.STOCKS_ONLY?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const feeds = (await (await fetch(FEEDS_URL)).json())
  .map((feed) => ({ feed, symbol: /^Robinhood (\S+?)\s*(?:\/|-)\s*USD$/.exec(feed.name)?.[1] }))
  .filter((entry) => entry.symbol !== undefined && (only === undefined || only.includes(entry.symbol.toUpperCase())))
  .sort((a, b) => a.symbol.localeCompare(b.symbol));
console.error(`${feeds.length} Robinhood feeds in the directory`);

const usdgAddress = USDG.toLowerCase();
let scanHead = scanTo;
const { tokens, pools } = await scanned();
console.error(`${tokens.size} tokens from the StockFactory, ${pools.length} pools initialised with USDG on one side`);

const poolsOf = (token) => pools.filter((pool) => pool.currency0.toLowerCase() === token.toLowerCase() || pool.currency1.toLowerCase() === token.toLowerCase());

const accessPaused = await client.readContract({ address: ACCESS_REGISTRY, abi, functionName: 'paused' });
console.error(`access registry paused: ${accessPaused}`);
const assets = [];
for (const { feed, symbol } of feeds) {
  console.error(`reading ${symbol}`);
  const token = tokens.get(symbol);
  const entry = {
    symbol,
    name: token?.name ?? null,
    token: token?.address ?? null,
    feed: getAddress(feed.proxyAddress),
    feedHeartbeat: feed.heartbeat,
    feedDeviationPercent: feed.threshold,
  };
  if (token === undefined) {
    entry.note = 'no token under this ticker from the StockFactory';
    assets.push(entry);
    continue;
  }
  const all = poolsOf(token.address);
  const candidates = all.filter((pool) => pool.hooks === '0x0000000000000000000000000000000000000000' && pool.fee <= MAX_FEE_READ);
  console.error(`  ${all.length} pools, reading ${candidates.length}`);
  const reads = await client.multicall({
    allowFailure: true,
    batchSize: 200_000,
    contracts: [
      { address: feed.proxyAddress, abi, functionName: 'decimals' },
      { address: feed.proxyAddress, abi, functionName: 'latestRoundData' },
      { address: token.address, abi, functionName: 'decimals' },
      { address: token.address, abi, functionName: 'tokenPaused' },
      { address: token.address, abi, functionName: 'oraclePaused' },
      { address: token.address, abi, functionName: 'uiMultiplier' },
      { address: token.address, abi, functionName: 'totalSupply' },
      { address: REGISTRY, abi, functionName: 'isRegistered', args: [token.address] },
      ...candidates.flatMap((pool) => [
        { address: STATE_VIEW, abi, functionName: 'getSlot0', args: [pool.id] },
        { address: STATE_VIEW, abi, functionName: 'getLiquidity', args: [pool.id] },
      ]),
    ],
  });
  const value = (i) => (reads[i].status === 'success' ? reads[i].result : undefined);
  const [feedDecimals, round, decimals, tokenPaused, oraclePaused, uiMultiplier, totalSupply, listed] = [0, 1, 2, 3, 4, 5, 6, 7].map(value);
  const feedE8 = round === undefined || round[1] <= 0n ? 0n : round[1];
  const feedUpdatedAt = round === undefined ? 0 : Number(round[3]);
  const feedAge = feedUpdatedAt === 0 ? null : chainTime - feedUpdatedAt;
  Object.assign(entry, {
    feedDecimals,
    feedPriceE8: feedE8.toString(),
    feedPrice: feedE8 === 0n ? null : Number(feedE8) / 1e8,
    feedUpdatedAt: feedUpdatedAt === 0 ? null : new Date(feedUpdatedAt * 1000).toISOString(),
    feedAgeSeconds: feedAge,
    feedFresh: feedAge !== null && feedAge <= TRADE_STALENESS && feedE8 !== 0n,
    decimals,
    tokenPaused,
    oraclePaused,
    uiMultiplier: uiMultiplier?.toString() ?? null,
    totalSupply: totalSupply?.toString() ?? null,
    listed: listed === true,
    poolsInitialised: all.length,
    poolsHooked: all.filter((pool) => pool.hooks !== '0x0000000000000000000000000000000000000000').length,
    poolsAboveFeeCeiling: all.filter((pool) => pool.hooks === '0x0000000000000000000000000000000000000000' && pool.fee > MAX_FEE_READ).length,
    pools: [],
  });

  const open = [];
  candidates.forEach((pool, i) => {
    const slot0 = value(8 + 2 * i);
    const liquidity = value(9 + 2 * i);
    const assetIsCurrency0 = pool.currency0.toLowerCase() === token.address.toLowerCase();
    const sqrtPriceX96 = slot0?.[0] ?? 0n;
    const midE8 = sqrtPriceX96 === 0n ? 0n : midOf(sqrtPriceX96, assetIsCurrency0, decimals ?? 18);
    const view = {
      id: pool.id,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      hooks: pool.hooks,
      hookless: pool.hooks === '0x0000000000000000000000000000000000000000',
      initialisedAt: pool.block.toString(),
      sqrtPriceX96: sqrtPriceX96.toString(),
      liquidity: (liquidity ?? 0n).toString(),
      midE8: midE8.toString(),
      mid: midE8 === 0n ? null : Number(midE8) / 1e8,
      midVsFeedBps: midE8 === 0n || feedE8 === 0n ? null : Number(deviationBps(midE8, feedE8)),
      quotes: {},
    };
    entry.pools.push(view);
    if (view.hookless && (liquidity ?? 0n) > 0n && sqrtPriceX96 !== 0n) open.push({ pool, view, assetIsCurrency0, liquidity, sqrtPriceX96 });
  });

  console.error(`  ${open.length} open hookless pools, quoting`);
  if (open.length > 0) {
    const quotes = await client.multicall({
      allowFailure: true,
      batchSize: 200_000,
      contracts: open.flatMap(({ pool, assetIsCurrency0 }) =>
        QUOTE_SIZES.map((amount) => ({
          address: QUOTER,
          abi,
          functionName: 'quoteExactInputSingle',
          args: [{ poolKey: { currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }, zeroForOne: !assetIsCurrency0, exactAmount: amount, hookData: '0x' }],
        })),
      ),
    });
    open.forEach(({ pool, view, assetIsCurrency0, liquidity, sqrtPriceX96 }, i) => {
      QUOTE_SIZES.forEach((amount, j) => {
        const q = quotes[i * QUOTE_SIZES.length + j];
        const label = (Number(amount) / 1e6).toString();
        if (q.status !== 'success' || q.result[0] === 0n) {
          view.quotes[label] = { amountOut: null, reason: q.status === 'success' ? 'nothing out' : shortError(q.error) };
          return;
        }
        const amountOut = q.result[0];
        const effE8 = (amount * 10n ** BigInt((decimals ?? 18) + 2)) / amountOut;
        const after = sqrtAfter(sqrtPriceX96, liquidity, amount, pool.fee, assetIsCurrency0);
        const afterE8 = midOf(after, assetIsCurrency0, decimals ?? 18);
        view.quotes[label] = {
          amountOut: amountOut.toString(),
          effectivePrice: Number(effE8) / 1e8,
          effectiveVsFeedBps: feedE8 === 0n ? null : Number(deviationBps(effE8, feedE8)),
          midAfterVsFeedBps: feedE8 === 0n ? null : Number(deviationBps(afterE8, feedE8)),
        };
      });
      view.bandDepthUsdg = feedE8 === 0n ? null : Number(bandDepth(sqrtPriceX96, liquidity, pool.fee, assetIsCurrency0, feedE8, decimals ?? 18)) / 1e6;
      const q25 = view.quotes['25'];
      view.usable =
        view.midVsFeedBps !== null &&
        view.midVsFeedBps <= Number(BAND_BPS) &&
        q25.amountOut !== null &&
        q25.effectiveVsFeedBps <= Number(BAND_BPS) &&
        q25.midAfterVsFeedBps <= Number(BAND_BPS);
    });
  }

  const usable = entry.pools.filter((pool) => pool.usable);
  usable.sort((a, b) => Number(b.quotes['25'].amountOut) - Number(a.quotes['25'].amountOut));
  entry.bestPool = usable[0]?.id ?? null;
  entry.poolUsable = usable.length > 0;
  entry.tradable = entry.feedFresh && tokenPaused === false && oraclePaused === false && accessPaused === false;
  if (entry.listed) {
    try {
      await client.readContract({ address: GUARD, abi, functionName: 'tradePrice', args: [token.address, MULTICALL3] });
      entry.guardTradesNow = true;
    } catch (error) {
      entry.guardTradesNow = false;
      entry.guardRefusal = shortError(error);
    }
  }
  assets.push(entry);
  console.error(`${symbol.padEnd(6)} ${all.length} pools, ${entry.pools.length} read, ${usable.length} usable${entry.listed ? ', listed' : ''}`);
}

const inventory = {
  measuredAt: new Date(chainTime * 1000).toISOString(),
  block: head.toString(),
  scannedToBlock: scanHead.toString(),
  chainId: record.chainId,
  usdg: USDG,
  poolManager: POOL_MANAGER,
  stateView: STATE_VIEW,
  quoter: getAddress(QUOTER),
  stockFactory: getAddress(STOCK_FACTORY),
  accessRegistry: ACCESS_REGISTRY,
  accessRegistryPaused: accessPaused,
  bandBps: Number(BAND_BPS),
  tradeStalenessSeconds: TRADE_STALENESS,
  depthNote: 'bandDepthUsdg and midAfterVsFeedBps hold the in-range liquidity constant; a range that ends inside the band makes them optimistic.',
  counts: {
    feeds: assets.length,
    withToken: assets.filter((a) => a.token).length,
    withUsablePool: assets.filter((a) => a.poolUsable).length,
    listed: assets.filter((a) => a.listed).length,
  },
  assets,
};
const json = JSON.stringify(inventory, null, 2);
if (OUT) writeFileSync(OUT, json + '\n');
else console.log(json);
console.error(table(inventory));

/** The scan, or the copy of it STOCKS_SCAN_CACHE names when that file exists; written there after a scan. */
async function scanned() {
  const cache = process.env.STOCKS_SCAN_CACHE;
  if (cache) {
    try {
      const saved = JSON.parse(readFileSync(cache, 'utf8'));
      console.error(`scan read from ${cache}, taken at block ${saved.head}`);
      scanHead = BigInt(saved.head);
      return { tokens: new Map(saved.tokens.map(([symbol, t]) => [symbol, { ...t, block: BigInt(t.block) }])), pools: saved.pools.map((p) => ({ ...p, block: BigInt(p.block) })) };
    } catch {}
  }
  const result = await scan();
  if (cache) {
    writeFileSync(cache, JSON.stringify({ head: head.toString(), tokens: [...result.tokens].map(([symbol, t]) => [symbol, { ...t, block: t.block.toString() }]), pools: result.pools.map((p) => ({ ...p, block: p.block.toString() })) }));
  }
  return result;
}

async function scan() {
  const tokens = new Map();
  const pools = [];
  const windows = [];
  for (let from = SCAN_FROM; from <= scanTo; from += WINDOW) windows.push([from, from + WINDOW - 1n > scanTo ? scanTo : from + WINDOW - 1n]);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < windows.length) {
      const [fromBlock, toBlock] = windows[next++];
      const logs = await withRetry(() =>
        client.getLogs({ address: [STOCK_FACTORY, POOL_MANAGER], events, fromBlock, toBlock }),
      );
      for (const log of logs) {
        const { eventName, args } = decodeEventLog({ abi: events, data: log.data, topics: log.topics });
        if (eventName === 'Deployed' && log.address.toLowerCase() === STOCK_FACTORY.toLowerCase()) {
          tokens.set(args.symbol, { address: getAddress(args.stock), name: args.name, uid: args.uid, block: log.blockNumber });
        } else if (eventName === 'Initialize' && log.address.toLowerCase() === POOL_MANAGER.toLowerCase()) {
          if (args.currency0.toLowerCase() !== usdgAddress && args.currency1.toLowerCase() !== usdgAddress) continue;
          pools.push({ id: args.id, currency0: getAddress(args.currency0), currency1: getAddress(args.currency1), fee: args.fee, tickSpacing: args.tickSpacing, hooks: getAddress(args.hooks), block: log.blockNumber });
        }
      }
      done += 1;
      if (done % 500 === 0) console.error(`scanned ${done} of ${windows.length} windows`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  pools.sort((a, b) => Number(a.block - b.block));
  return { tokens, pools };
}

async function withRetry(call, tries = 5) {
  for (let i = 1; ; i += 1) {
    try {
      return await call();
    } catch (error) {
      if (i === tries) throw error;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

/** The guard's `midE8`: USDG per whole token with eight decimals, from the pool's sqrt price. */
function midOf(sqrtPriceX96, assetIsCurrency0, decimals) {
  const scale = 10n ** BigInt(decimals + 2);
  const p = sqrtPriceX96 * sqrtPriceX96;
  return assetIsCurrency0 ? (p * scale) / Q192 : (Q192 * scale) / p;
}

/** Where the sqrt price lands after `usdgIn` of USDG is swapped in, with the in-range liquidity held constant. */
function sqrtAfter(sqrtPriceX96, liquidity, usdgIn, fee, assetIsCurrency0) {
  const net = (usdgIn * (1_000_000n - BigInt(fee))) / 1_000_000n;
  if (assetIsCurrency0) return sqrtPriceX96 + (net * Q96) / liquidity;
  return (liquidity * sqrtPriceX96 * Q96) / (liquidity * Q96 + net * sqrtPriceX96);
}

/** USDG that can be spent before the mid sits `BAND_BPS` above the feed; zero when it already does. */
function bandDepth(sqrtPriceX96, liquidity, fee, assetIsCurrency0, feedE8, decimals) {
  const scale = 10n ** BigInt(decimals + 2);
  const targetE8 = (feedE8 * (10_000n + BAND_BPS)) / 10_000n;
  const target = assetIsCurrency0 ? isqrt((targetE8 * Q192) / scale) : isqrt((Q192 * scale) / targetE8);
  let net;
  if (assetIsCurrency0) {
    if (target <= sqrtPriceX96) return 0n;
    net = (liquidity * (target - sqrtPriceX96)) / Q96;
  } else {
    if (target >= sqrtPriceX96) return 0n;
    net = (liquidity * Q96 * (sqrtPriceX96 - target)) / (sqrtPriceX96 * target);
  }
  return (net * 1_000_000n) / (1_000_000n - BigInt(fee));
}

function deviationBps(x, ref) {
  const diff = x > ref ? x - ref : ref - x;
  return (diff * 10_000n + ref - 1n) / ref;
}

/** Newton's method from an overestimate, which only ever steps down, to the floor of the root. */
function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

function shortError(error) {
  const text = String(error?.shortMessage ?? error?.message ?? error);
  return text.split('\n')[0].slice(0, 120);
}

function table(inv) {
  const lines = [
    `| Ticker | Token | Feed | Feed price | Feed age | Paused | Pools | Best hookless pool | Fee / spacing | Liquidity | Mid vs feed | 25 USDG buy | Listed |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const a of inv.assets) {
    const best = a.pools?.find((p) => p.id === a.bestPool);
    const q25 = best?.quotes['25'];
    lines.push(
      `| ${a.symbol} | ${a.token ? short(a.token) : 'none'} | ${short(a.feed)} | ${a.feedPrice === null || a.feedPrice === undefined ? '' : a.feedPrice.toFixed(2)} | ${a.feedAgeSeconds == null ? '' : hours(a.feedAgeSeconds)} | ${a.tokenPaused || a.oraclePaused ? 'yes' : 'no'} | ${a.poolsInitialised ?? 0} | ${best ? short(best.id) : 'none usable'} | ${best ? `${best.fee / 10_000}% / ${best.tickSpacing}` : ''} | ${best ? best.liquidity : ''} | ${best ? `${best.midVsFeedBps} bps` : ''} | ${q25 ? `${q25.effectiveVsFeedBps} bps` : ''} | ${a.listed ? 'yes' : 'no'} |`,
    );
  }
  return lines.join('\n');
}

function short(hex) {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function hours(seconds) {
  return `${(seconds / 3600).toFixed(1)} h`;
}

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
