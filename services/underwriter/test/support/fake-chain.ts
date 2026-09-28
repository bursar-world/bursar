import { type Micro, micro, toMicro } from '@bursar/core';

import type {
  AccountState,
  ControlReading,
  EscrowLock,
  EscrowTerms,
  IssuerControls,
  MandateChain,
  MerchantStanding,
  PreviewResult,
  SimulationResult,
  SpendCall,
} from '../../src/chain.js';
import type { Address, Hex32 } from '../../src/document.js';
import { ChainUnavailableError } from '../../src/errors.js';
import { errorSelector, type Selector, ZERO_SELECTOR } from '../../src/selectors.js';

export const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
export const AGENT: Address = '0x2222222222222222222222222222222222222222';
export const PRINCIPAL: Address = '0x3333333333333333333333333333333333333333';
export const MERCHANT: Address = '0x4444444444444444444444444444444444444444';
export const ESCROW: Address = '0x5555555555555555555555555555555555555555';
export const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const CAPABILITY: Hex32 = `0x${'ab'.repeat(32)}`;

export const DAY = 86_400;
export const MONTH = 30 * DAY;

export const NOW_SECONDS = 1_800_000_000n;
export const NOW_ISO = new Date(Number(NOW_SECONDS) * 1000).toISOString();

export type FakeChainState = {
  account: AccountState;
  terms: EscrowTerms;
  standing: MerchantStanding;
  merchantAllowed: boolean;
  capabilityAllowed: boolean;
  nowSeconds: bigint;
  blockNumber: bigint;
  /** Set to make every read throw, which is how a default-deny path gets exercised. */
  down: boolean;
  simulation: SimulationResult;
  /** Escrow locks by id, as `getLock` would return them. */
  locks: Map<bigint, EscrowLock>;
  decimals: number;
  /**
   * The settlement asset's own controls. The defaults are what USDG answered on 4663 on
   * 2026-09-22: not paused, nobody frozen.
   */
  issuer: {
    paused: boolean;
    frozen: Set<string>;
    /**
     * Makes a control read fail instead of answering.
     *
     * `absent` is the diamond: the selector routes to no facet and the call reverts
     * `FacetNotFound`, which is what `version()` does on USDG today and what `paused()` would do
     * if the issuer removed that facet. `unreadable` is the chain not answering. They are
     * different refusals and this double has to be able to produce both.
     */
    failure: { kind: 'absent' | 'unreadable'; on?: 'paused' | 'frozen' } | null;
  };
  calls: {
    previewSpend: number;
    readAccount: number;
    simulateSpend: SpendCall[];
    /** Every issuer-control batch and who was in it, so a test can see it was one batch. */
    issuerControls: { asset: Address; parties: readonly Address[] }[];
    /** The height every read was answered at, so a decision straddling two is visible. */
    heights: (bigint | undefined)[];
  };
};

/** The rosters the account keeps in mappings, which `AccountState` does not carry. */
type Rosters = { capabilityAllowlist: Set<string>; merchantAllowlist: Set<string> };

function defaultAccount(overrides: Partial<AccountState> = {}): AccountState {
  const base: AccountState = {
    account: ACCOUNT,
    principal: PRINCIPAL,
    agent: AGENT,
    settlementAsset: USDG,
    escrow: ESCROW,
    paused: false,
    revoked: false,
    version: 1n,
    nonce: 0n,
    documentHash: `0x${'0'.repeat(64)}`,
    limits: {
      perCallCapMicros: toMicro(1_000_000),
      dailyCapMicros: toMicro(5_000_000),
      monthlyCapMicros: toMicro(50_000_000),
      dailyWindowSeconds: DAY,
      monthlyWindowSeconds: MONTH,
      approvalThresholdMicros: toMicro(500_000),
      validFrom: 0n,
      validUntil: 0n,
    },
    daily: {
      capMicros: toMicro(5_000_000),
      spentMicros: toMicro(0),
      seconds: DAY,
      startSeconds: 0n,
      epoch: 0n,
    },
    monthly: {
      capMicros: toMicro(50_000_000),
      spentMicros: toMicro(0),
      seconds: MONTH,
      startSeconds: 0n,
      epoch: 0n,
    },
    remaining: { perCall: toMicro(1_000_000), daily: toMicro(5_000_000), monthly: toMicro(50_000_000) },
    merchantGate: { kind: 'allowlist' },
    balanceMicros: toMicro(100_000_000),
  };
  return { ...base, ...overrides };
}

/**
 * Mirrors `MandateAccount._reason` with the no-proof `_merchantReason`, which is what
 * `previewSpend` runs. The order is the contract's order and the selectors are derived from the
 * same ABI the production code reads, so a test that passes here is asserting against the
 * account's own decision function, not a convenient paraphrase of it.
 */
function previewReason(
  state: AccountState,
  rosters: Rosters,
  merchant: Address,
  capabilityId: Hex32,
  amount: Micro,
  now: bigint,
): Selector {
  if (state.paused) return errorSelector('IsPaused');
  if (state.revoked) return errorSelector('IsRevoked');
  if (amount === 0n) return errorSelector('ZeroAmount');
  if (now < state.limits.validFrom) return errorSelector('NotYetValid');
  if (state.limits.validUntil !== 0n && now > state.limits.validUntil) return errorSelector('Expired');
  if (!rosters.capabilityAllowlist.has(capabilityId.toLowerCase())) return errorSelector('CapabilityNotAllowed');
  if (amount > state.limits.perCallCapMicros) return errorSelector('PerCallCapExceeded');
  if (amount > state.remaining.daily) return errorSelector('DailyCapExceeded');
  if (amount > state.remaining.monthly) return errorSelector('MonthlyCapExceeded');

  if (merchant === '0x0000000000000000000000000000000000000000') return errorSelector('ZeroAddress');
  if (state.merchantGate.kind === 'merkleRoot') return errorSelector('MerkleGateActive');
  if (!rosters.merchantAllowlist.has(merchant.toLowerCase())) return errorSelector('MerchantNotAllowed');

  if (amount >= state.limits.approvalThresholdMicros) return errorSelector('ApprovalRequired');
  return ZERO_SELECTOR;
}

export type FakeChain = MandateChain & { state: FakeChainState; rosters: Rosters };

export function fakeChain(overrides: Partial<AccountState> = {}, rosterOverrides: Partial<Rosters> = {}): FakeChain {
  const rosters: Rosters = {
    capabilityAllowlist: rosterOverrides.capabilityAllowlist ?? new Set([CAPABILITY.toLowerCase()]),
    merchantAllowlist: rosterOverrides.merchantAllowlist ?? new Set([MERCHANT.toLowerCase()]),
  };

  const state: FakeChainState = {
    account: defaultAccount(overrides),
    terms: {
      escrow: ESCROW,
      settlementAsset: USDG,
      reputation: '0x6666666666666666666666666666666666666666',
      registry: '0x7777777777777777777777777777777777777777',
      minTtlSeconds: 60n,
      maxTtlSeconds: 7n * 86_400n,
      feeBps: 50,
      disputeBondBps: 500,
    },
    standing: { merchant: MERCHANT, active: true, blacklisted: false, capMicros: micro(10_000_000n) },
    merchantAllowed: rosters.merchantAllowlist.has(MERCHANT.toLowerCase()),
    capabilityAllowed: rosters.capabilityAllowlist.has(CAPABILITY.toLowerCase()),
    nowSeconds: NOW_SECONDS,
    blockNumber: 61_563_463n,
    down: false,
    simulation: { ok: true },
    locks: new Map(),
    decimals: 6,
    issuer: { paused: false, frozen: new Set<string>(), failure: null },
    calls: { previewSpend: 0, readAccount: 0, simulateSpend: [], issuerControls: [], heights: [] },
  };

  /** What the account held at each height handed out, the way an archive node answers. */
  const history = new Map<bigint, AccountState>();

  const guard = <T>(value: T): Promise<T> =>
    state.down ? Promise.reject(new ChainUnavailableError('fake chain is down')) : Promise.resolve(value);

  const accountAt = (blockNumber: bigint | undefined): AccountState => {
    state.calls.heights.push(blockNumber);
    if (blockNumber === undefined) return state.account;
    return history.get(blockNumber) ?? state.account;
  };

  return {
    state,
    rosters,

    readAccount: async (_account, blockNumber) => {
      state.calls.readAccount += 1;
      return guard(accountAt(blockNumber));
    },

    previewSpend: async (_account, merchant, capabilityId, amountMicros, blockNumber): Promise<PreviewResult> => {
      state.calls.previewSpend += 1;
      const account = accountAt(blockNumber);
      const selector = previewReason(account, rosters, merchant, capabilityId, amountMicros, state.nowSeconds);
      return guard({ allowed: selector === ZERO_SELECTOR, selector });
    },

    readEscrowTerms: async (_escrow, blockNumber) => {
      state.calls.heights.push(blockNumber);
      return guard(state.terms);
    },
    readIssuerControls: async (asset, parties, blockNumber): Promise<IssuerControls> => {
      state.calls.issuerControls.push({ asset, parties });
      state.calls.heights.push(blockNumber);

      const reading = (control: 'paused' | 'frozen', value: boolean): ControlReading => {
        const failure = state.issuer.failure;
        if (failure !== null && (failure.on ?? control) === control) {
          // The same two shapes the real client sees: a diamond's revert for a selector it does
          // not route, and a call that never came back.
          return failure.kind === 'absent'
            ? { state: 'absent', detail: 'execution reverted: FacetNotFound' }
            : { state: 'unreadable', detail: 'the request timed out after 10000 ms' };
        }
        return { state: 'read', value };
      };

      // Not guarded by `down`. A chain that cannot answer produces unreadable controls here, which
      // is a refusal of its own; the reads that do throw are the ones above.
      return {
        asset,
        paused: reading('paused', state.issuer.paused),
        parties: parties.map((address) => ({
          address,
          frozen: reading('frozen', state.issuer.frozen.has(address.toLowerCase())),
        })),
      };
    },

    readMerchantStanding: async (_terms, _merchant, blockNumber) => {
      state.calls.heights.push(blockNumber);
      return guard(state.standing);
    },
    readMerchantAllowed: async (_account, _merchant, blockNumber) => {
      state.calls.heights.push(blockNumber);
      return guard(state.merchantAllowed);
    },
    readCapabilityAllowed: async (_account, _capabilityId, blockNumber) => {
      state.calls.heights.push(blockNumber);
      return guard(state.capabilityAllowed);
    },
    blockTimestamp: async () => guard(state.nowSeconds),

    latestBlock: async () => {
      history.set(state.blockNumber, state.account);
      return guard({ number: state.blockNumber, timestamp: state.nowSeconds });
    },

    readEscrowLock: async (_escrow, id) =>
      guard(state.locks.get(id) ?? { id, payer: '0x0000000000000000000000000000000000000000', amountMicros: micro(0n), status: 0 }),

    readAssetDecimals: async () => guard(state.decimals),

    simulateSpend: async (call) => {
      state.calls.simulateSpend.push(call);
      state.calls.heights.push(call.blockNumber);
      return guard(state.simulation);
    },
  };
}
