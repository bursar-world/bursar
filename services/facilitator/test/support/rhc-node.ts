import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  RHC_MAINNET,
  agentRegistryAbi,
  escrowAbi,
  escrowAbiV1,
  escrowAbiV2,
  mandateAccountAbi,
  mandateAccountAbiV1,
  mandateAccountAbiV2,
  reputationAbi,
  settlementAssetAbi,
} from '@bursar/core';
import type { Abi } from 'viem';
import { decodeFunctionData, encodeFunctionResult } from 'viem';

/**
 * A MandateAccount, its escrow and its registries, answered over real JSON-RPC.
 *
 * This leaves the composition alone. The facilitator binary builds its own chain client out of
 * `RHC_RPC_PRIMARY` and `RHC_RPC_FALLBACK`, so a test that wants to drive what ships has to put
 * something at those addresses. Every call below goes through viem, the RPC pool and a socket
 * exactly as it does against Robinhood Chain; only the node is local.
 *
 * Nothing here is a policy decision. `previewSpend` answers what the account is set up to answer
 * and the underwriter reaches its own verdict from that.
 *
 * Three accounts over the one fixture, one per contract build, because all three run on 4663. Each
 * points at its build's escrow, which is how a reader tells them apart, and each answers `limits`
 * in its build's shape: v1 in eight words, later builds with the class mask, lifetime total and lane
 * appended. Each escrow answers only what its build has, so a v2 escrow asked for the v3 floor
 * reverts the way the real one does.
 */

/** A v1 account: created against the rhc-mainnet escrow, answering the frozen v1 ABI. */
export const ACCOUNT = '0xe8fd2904175811Db41636c6085eBFE6661E196d5' as const;
/** A v2 account: created against the rhc-mainnet-v2 escrow, answering the frozen v2 ABI. */
export const ACCOUNT_V2 = '0x5b1A4bA0D5E2C6f3A7b8c9D0E1f2a3b4C5d6e7F8' as const;
/** A v3 account, on an escrow no record names, which is read as the current build. */
export const ACCOUNT_V3 = '0x6C2B5cB1E6f3d7a4B8c9DaE1f2a3b4c5d6E7F809' as const;
export const ESCROW = '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4' as const;
export const ESCROW_V2 = '0x4315F8be7C9661345710910577Ec31cb867f3c20' as const;
export const ESCROW_V3 = '0x33c0d7e1f0A5b4C3D2E1F0A9B8c7D6E5f4A3b2c1' as const;
/** The v3 escrow's floor: the smallest lock it opens. */
export const MIN_LOCK = 10_000n;
export const REGISTRY = '0x002750230E742b52F63987704f09f4E44CF4b2C8' as const;
export const REPUTATION = '0x95A14367fA7D9a4F06dd6D41DabbaDB881469a19' as const;
export const USDG = RHC_MAINNET.usdg;
export const AGENT_WALLET = '0x3164F1EaA42C769e40Aec0a43e8C51ec2c0EBe03' as const;
export const PRINCIPAL = '0x46c93a0e4dBFaFc6100a88123885ff9A11025F4e' as const;
export const MERCHANT = '0x780de139902298C8E6687572fC99B32A33144AA7' as const;
export const CAPABILITY = '0x220f0024762d0558a93b06e5546a37f5aba35f5c9f7129155e9f1645a80a4a4c' as const;

const ZERO32 = `0x${'0'.repeat(64)}` as const;
// Tracks real time. The underwriter holds a caller's clock to the chain's within the deadline
// drift, so a fake chain frozen in the past turns every decision into a refusal for a reason that
// has nothing to do with what the test is checking.
const blockTimestamp = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/** The mandate the walkthrough uses: 2 per call, 3 a day, 10 a month, 2.5 needs consent. */
export type AccountFixture = {
  perCallCap: bigint;
  dailyCap: bigint;
  monthlyCap: bigint;
  approvalThreshold: bigint;
  remaining: readonly [bigint, bigint, bigint];
  balance: bigint;
  paused: boolean;
  revoked: boolean;
  version: bigint;
  /** What `previewSpend` answers, and the selector it answers with when it refuses. */
  preview: (amount: bigint) => readonly [boolean, `0x${string}`];
  /**
   * The settlement asset's own controls, which are the token issuer's and not this deployment's.
   * The defaults are what USDG answered on 4663 on 2026-09-22.
   */
  usdg: {
    paused: boolean;
    /** Lowercased addresses the issuer has frozen. */
    frozen: Set<string>;
    /** Set to make the control revert the way a diamond does for a facet it no longer routes. */
    facetRemoved: boolean;
  };
};

export function defaultFixture(): AccountFixture {
  return {
    perCallCap: 2_000_000n,
    dailyCap: 3_000_000n,
    monthlyCap: 10_000_000n,
    approvalThreshold: 2_500_000n,
    remaining: [2_000_000n, 3_000_000n, 10_000_000n],
    balance: 5_000_000n,
    paused: false,
    revoked: false,
    version: 1n,
    // `DailyCapExceeded()`, the selector a live account returns when the daily cap is spent.
    preview: (amount) => (amount <= 2_000_000n ? [true, '0x00000000'] : [false, '0xcc70389d']),
    usdg: { paused: false, frozen: new Set<string>(), facetRemoved: false },
  };
}

export type RhcNode = {
  readonly urls: readonly [string, string];
  readonly fixture: AccountFixture;
  readonly calls: string[];
  close(): Promise<void>;
};

const ABIS: Readonly<Record<string, Abi>> = {
  [ACCOUNT.toLowerCase()]: mandateAccountAbiV1 as Abi,
  [ACCOUNT_V2.toLowerCase()]: mandateAccountAbiV2 as Abi,
  [ACCOUNT_V3.toLowerCase()]: mandateAccountAbi as Abi,
  [ESCROW.toLowerCase()]: escrowAbiV1 as Abi,
  [ESCROW_V2.toLowerCase()]: escrowAbiV2 as Abi,
  [ESCROW_V3.toLowerCase()]: escrowAbi as Abi,
  [REGISTRY.toLowerCase()]: agentRegistryAbi as Abi,
  [REPUTATION.toLowerCase()]: reputationAbi as Abi,
  [USDG.toLowerCase()]: settlementAssetAbi as Abi,
};

/**
 * Two listeners, because the chain client will not start on one provider and the check is by
 * hostname. They are independent servers over the same fixture, which is what a second provider
 * looks like from the client's side.
 */
export async function startRhcNode(fixture: AccountFixture = defaultFixture()): Promise<RhcNode> {
  const calls: string[] = [];

  const node = (): Server =>
    createServer((incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: number;
          method: string;
          params: readonly unknown[];
        };

        let body: string;
        try {
          body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: answer(request, fixture, calls) });
        } catch (error) {
          body = JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error:
              error instanceof Reverted
                ? { code: 3, message: 'execution reverted', data: '0x' }
                : { code: -32000, message: error instanceof Error ? error.message : String(error) },
          });
        }
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(body);
      })();
    });

  const [primary, fallback] = await Promise.all([listen(node(), '127.0.0.1'), listen(node(), 'localhost')]);

  return {
    urls: [primary.url, fallback.url],
    fixture,
    calls,
    async close() {
      await Promise.all([primary.close(), fallback.close()]);
    },
  };
}

class Reverted extends Error {}

function listen(server: Server, host: string): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, host === 'localhost' ? '127.0.0.1' : host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function answer(
  request: { method: string; params: readonly unknown[] },
  fixture: AccountFixture,
  calls: string[],
): unknown {
  switch (request.method) {
    case 'eth_chainId':
      return `0x${RHC_MAINNET.chainId.toString(16)}`;
    case 'eth_blockNumber':
      return '0x3ab1b09';
    case 'eth_getBlockByNumber':
      return block();
    case 'eth_call':
      return call(request.params[0] as { to: `0x${string}`; data: `0x${string}` }, fixture, calls);
    case 'eth_getCode':
      // Code at every contract this node answers for, and none anywhere else, which is how Permit2
      // reads on a chain it was never deployed to.
      return ABIS[String(request.params[0]).toLowerCase()] ? '0x6080604052' : '0x';
    default:
      throw new Error(`this node does not answer ${request.method}`);
  }
}

function call(
  { to, data }: { to: `0x${string}`; data: `0x${string}` },
  fixture: AccountFixture,
  calls: string[],
): `0x${string}` {
  // An address with no code at it returns empty data, which is what a mistyped address looks like
  // from the client. A node that threw here would exercise a failure the chain cannot produce, and
  // would never exercise the one it does.
  const abi = ABIS[to.toLowerCase()];
  if (!abi) return '0x';

  // A contract with no function for the selector reverts, which is what a node reports. The client
  // tells "not implemented" from "could not ask" by exactly that, so a transport error here would
  // exercise a failure the chain does not produce.
  let decoded: { readonly functionName: string; readonly args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi, data });
  } catch {
    throw new Reverted();
  }
  const { functionName, args = [] } = decoded;
  calls.push(`${to.toLowerCase()}.${functionName}`);
  const result = read(to.toLowerCase(), functionName, args as readonly unknown[], fixture);
  return encodeFunctionResult({ abi, functionName, result } as never);
}

function read(to: string, fn: string, args: readonly unknown[], fixture: AccountFixture): unknown {
  if (to === ACCOUNT.toLowerCase()) return account('v1', fn, args, fixture);
  if (to === ACCOUNT_V2.toLowerCase()) return account('v2', fn, args, fixture);
  if (to === ACCOUNT_V3.toLowerCase()) return account('v3', fn, args, fixture);
  if (to === ESCROW.toLowerCase() || to === ESCROW_V2.toLowerCase() || to === ESCROW_V3.toLowerCase()) return escrow(fn);
  if (to === REGISTRY.toLowerCase()) return fn === 'isActive';
  if (to === REPUTATION.toLowerCase()) return 25_000_000n;
  if (to === USDG.toLowerCase()) return settlementAsset(fn, args, fixture);
  throw new Error(`this node holds no contract at ${to}`);
}

function account(build: 'v1' | 'v2' | 'v3', fn: string, args: readonly unknown[], fixture: AccountFixture): unknown {
  switch (fn) {
    case 'principal':
      return PRINCIPAL;
    case 'agent':
      return AGENT_WALLET;
    case 'settlementAsset':
      return USDG;
    case 'escrow':
      return build === 'v1' ? ESCROW : build === 'v2' ? ESCROW_V2 : ESCROW_V3;
    case 'paused':
      return fixture.paused;
    case 'revoked':
      return fixture.revoked;
    case 'version':
      return fixture.version;
    case 'nonce':
      return 0n;
    case 'documentHash':
      return ZERO32;
    case 'limits':
      return {
        perCallCap: fixture.perCallCap,
        dailyCap: fixture.dailyCap,
        monthlyCap: fixture.monthlyCap,
        dailyWindow: 86_400n,
        monthlyWindow: 2_592_000n,
        approvalThreshold: fixture.approvalThreshold,
        validFrom: 0n,
        validUntil: 0n,
        // Every class allowed, no lifetime total, the escrow lane.
        ...(build === 'v1' ? {} : { classMask: 7, totalCap: 0n, lane: 0 }),
      };
    case 'window': {
      const daily = args[0] === 0;
      return {
        cap: daily ? fixture.dailyCap : fixture.monthlyCap,
        spent: daily ? fixture.dailyCap - fixture.remaining[1] : fixture.monthlyCap - fixture.remaining[2],
        duration: daily ? 86_400n : 2_592_000n,
        start: blockTimestamp() - 100n,
        epoch: 1n,
      };
    }
    case 'remaining':
      return fixture.remaining;
    case 'merchantGate':
      return 0;
    case 'merchantRoot':
      return ZERO32;
    case 'merchants':
      return (args[0] as string).toLowerCase() === MERCHANT.toLowerCase();
    case 'capabilities':
      return (args[0] as string).toLowerCase() === CAPABILITY.toLowerCase();
    case 'previewSpend':
      return fixture.preview(args[2] as bigint);
    default:
      throw new Error(`the account fixture does not implement ${fn}`);
  }
}

function escrow(fn: string): unknown {
  switch (fn) {
    case 'settlementAsset':
      return USDG;
    case 'reputation':
      return REPUTATION;
    case 'registry':
      return REGISTRY;
    case 'minTtl':
      return 300n;
    case 'maxTtl':
      return 604_800n;
    case 'minLock':
      return MIN_LOCK;
    case 'feeBps':
      return 100;
    case 'disputeBondBps':
      return 500;
    default:
      throw new Error(`the escrow fixture does not implement ${fn}`);
  }
}

/**
 * USDG's own separator, recomputed here for name "Global Dollar", version "1", chain 4663 and the
 * token address above. A signature built against a guessed domain fails verification with nothing
 * to point at, so the fixture carries the real value rather than a placeholder.
 */
const DOMAIN_SEPARATOR = '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036' as const;

function settlementAsset(fn: string, args: readonly unknown[], fixture: AccountFixture): unknown {
  switch (fn) {
    case 'balanceOf':
      return fixture.balance;
    // The two issuer controls, both of which the live token routes. They are read on the decision
    // path, so a fixture that did not answer them would take every decision without the token's
    // own view of the parties.
    case 'paused':
      if (fixture.usdg.facetRemoved) throw new Error('execution reverted: FacetNotFound');
      return fixture.usdg.paused;
    case 'isFrozen':
      if (fixture.usdg.facetRemoved) throw new Error('execution reverted: FacetNotFound');
      return fixture.usdg.frozen.has(String(args[0]).toLowerCase());
    case 'decimals':
      return 6;
    case 'name':
      return 'Global Dollar';
    case 'version':
      // USDG is a diamond proxy and routes only the selectors its facets declare, so `version()`
      // reverts with FacetNotFound on 4663. The fixture reverts too: a node that answered would
      // let a caller depend on a read the real token does not serve, and the composition would
      // pass here and fail on chain.
      throw new Error('execution reverted: FacetNotFound');
    case 'DOMAIN_SEPARATOR':
      return DOMAIN_SEPARATOR;
    // The scheme probes for an authorisation path by calling these and seeing whether they answer.
    // USDG carries EIP-3009, verified against the live token.
    case 'authorizationState':
      return false;
    case 'nonces':
      return 0n;
    default:
      throw new Error(`the settlement asset fixture does not implement ${fn}`);
  }
}

function block(): Readonly<Record<string, unknown>> {
  return {
    number: '0x3ab1b09',
    hash: `0x${'11'.repeat(32)}`,
    parentHash: `0x${'22'.repeat(32)}`,
    nonce: '0x0000000000000000',
    sha3Uncles: `0x${'33'.repeat(32)}`,
    logsBloom: `0x${'0'.repeat(512)}`,
    transactionsRoot: `0x${'44'.repeat(32)}`,
    stateRoot: `0x${'55'.repeat(32)}`,
    receiptsRoot: `0x${'66'.repeat(32)}`,
    miner: '0x0000000000000000000000000000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x400',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    timestamp: `0x${blockTimestamp().toString(16)}`,
    baseFeePerGas: '0x4a817c800',
    transactions: [],
    uncles: [],
  };
}
