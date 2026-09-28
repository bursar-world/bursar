import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RHC_MAINNET, micro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { AssetMeta } from '../src/domain.js';
import type {
  ControlReading,
  IssuerControls,
  PaymentChain,
  SettlementCall,
  SettlementSigner,
  TokenIdentity,
  TransactionReceipt,
  TypedDataCheck,
} from '../src/ports.js';

/**
 * A chain that answers from a plain object.
 *
 * Verification is decision logic, so this fake stands in for Robinhood Chain. Signature recovery
 * is real: the fake recovers the address the way a node would, which is the one part of the check
 * that would be worthless if it were stubbed.
 */
export const PAYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
export const RELAYER = '0xCC5f9c251Fc3C69c04ae2b860b41150282E6B618' as const;
export const PAY_TO = '0xe67a61f8e2aC4057aa22e64306107E7120078447' as const;

export const USDG = RHC_MAINNET.usdg;

/** Read from USDG on chain 4663 on 2026-09-22 by calling DOMAIN_SEPARATOR(). */
export const USDG_DOMAIN_SEPARATOR =
  '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036' as const;

/** The name USDG answers. It publishes no version, so "1" is supplied and proved by the separator. */
export const USDG_NAME = 'Global Dollar';

export const USDG_ASSET: AssetMeta = {
  address: USDG,
  name: USDG_NAME,
  version: '1',
  decimals: 6,
  domainSeparator: USDG_DOMAIN_SEPARATOR,
  methods: ['eip3009', 'eip2612', 'permit2'],
};

export type FakeChainState = {
  balances?: Record<string, bigint>;
  allowances?: Record<string, bigint>;
  spentNonces?: readonly string[];
  permitNonces?: Record<string, bigint>;
  bitmaps?: Record<string, bigint>;
  code?: readonly string[];
  identity?: TokenIdentity;
  simulateError?: Error | null;
  /** Throws on every simulate from this index on, so a multi-call path can fail on its second. */
  failSimulateFrom?: number;
  receipt?: TransactionReceipt | Error;
  /** The issuer's controls. Absent means the token answers false to both, which is USDG today. */
  paused?: boolean;
  frozen?: readonly string[];
  /**
   * Makes a control read fail instead of answering.
   *
   * `absent` is the diamond: the selector routes to no facet and the call reverts `FacetNotFound`,
   * which is what `version()` does on USDG today and what `paused()` would do if the issuer
   * removed that facet. `unreadable` is the chain not answering. The two are different refusals
   * and the double has to be able to produce both.
   */
  controlFailure?: { readonly kind: 'absent' | 'unreadable'; readonly on?: 'paused' | 'frozen' };
};

export type FakeChain = PaymentChain & {
  readonly reads: string[];
  readonly simulated: SettlementCall[];
  /** The wait budget each settlement handed the receipt read, so a test can see which one it used. */
  readonly receiptWaits: number[];
  /** Every issuer-control batch and who was in it, so a test can see it was one batch. */
  readonly issuerReads: { token: string; parties: readonly string[] }[];
};

export function fakeChain(state: FakeChainState = {}): FakeChain {
  const reads: string[] = [];
  const simulated: SettlementCall[] = [];
  const receiptWaits: number[] = [];
  const issuerReads: { token: string; parties: readonly string[] }[] = [];
  const key = (...parts: string[]): string => parts.map((part) => part.toLowerCase()).join(':');

  return {
    reads,
    simulated,
    receiptWaits,
    issuerReads,
    chainId: RHC_MAINNET.chainId,

    async verifyTypedData(check: TypedDataCheck): Promise<boolean> {
      const recovered = await recoverTypedDataAddress({
        domain: check.domain,
        types: check.types,
        primaryType: check.primaryType,
        message: check.message,
        signature: check.signature,
      });
      return recovered.toLowerCase() === check.address.toLowerCase();
    },

    async tokenIdentity(): Promise<TokenIdentity> {
      reads.push('tokenIdentity');
      // No `version` by default, because that is what the settlement asset does: USDG's
      // `version()` reverts and the domain is assembled without an answer from it.
      return (
        state.identity ?? {
          name: USDG_NAME,
          decimals: 6,
          domainSeparator: USDG_DOMAIN_SEPARATOR,
        }
      );
    },

    async balanceOf(token, owner): Promise<bigint> {
      reads.push('balanceOf');
      return state.balances?.[key(token, owner)] ?? 0n;
    },

    async allowance(token, owner, spender): Promise<bigint> {
      reads.push('allowance');
      return state.allowances?.[key(token, owner, spender)] ?? 0n;
    },

    async authorizationState(_token, _authorizer, nonce): Promise<boolean> {
      reads.push('authorizationState');
      return (state.spentNonces ?? []).some((spent) => spent.toLowerCase() === nonce.toLowerCase());
    },

    async permitNonce(token, owner): Promise<bigint> {
      reads.push('permitNonce');
      return state.permitNonces?.[key(token, owner)] ?? 0n;
    },

    async issuerControls(token, parties): Promise<IssuerControls> {
      reads.push('issuerControls');
      issuerReads.push({ token, parties });
      const frozen = new Set((state.frozen ?? []).map((entry) => entry.toLowerCase()));
      const fail = state.controlFailure;

      const reading = (control: 'paused' | 'frozen', value: boolean): ControlReading => {
        if (fail !== undefined && (fail.on ?? control) === control) {
          // The same two shapes the adapter sees: a diamond's revert for a selector it does not
          // route, and a call that never came back.
          return fail.kind === 'absent'
            ? { state: 'absent', detail: 'execution reverted: 0x800ab12c' }
            : { state: 'unreadable', detail: 'the request timed out after 10000 ms' };
        }
        return { state: 'read', value };
      };

      return {
        asset: token,
        paused: reading('paused', state.paused ?? false),
        parties: parties.map((address) => ({
          address,
          frozen: reading('frozen', frozen.has(address.toLowerCase())),
        })),
      };
    },

    async nonceBitmap(permit2, owner, word): Promise<bigint> {
      reads.push('nonceBitmap');
      return state.bitmaps?.[key(permit2, owner) + `:${word.toString()}`] ?? 0n;
    },

    async hasCode(address): Promise<boolean> {
      reads.push('hasCode');
      return (state.code ?? []).some((entry) => entry.toLowerCase() === address.toLowerCase());
    },

    async simulate(call): Promise<void> {
      simulated.push(call);
      const index = simulated.length - 1;
      // With an index the failure starts there, which is how a permit that lands and a pull that
      // then reverts is reproduced. Without one it fails from the first call.
      if (state.failSimulateFrom !== undefined) {
        if (index < state.failSimulateFrom) return;
        throw state.simulateError ?? new Error('execution reverted: ERC20: transfer amount exceeds allowance');
      }
      if (state.simulateError) throw state.simulateError;
    },

    async waitForReceipt(_hash, timeoutMs): Promise<TransactionReceipt> {
      receiptWaits.push(timeoutMs);
      const receipt = state.receipt ?? { status: 'success', gasUsed: 87_363n };
      if (receipt instanceof Error) throw receipt;
      return receipt;
    },
  };
}

export function fakeSigner(
  behaviour: { hashes?: readonly `0x${string}`[]; error?: Error } = {},
): SettlementSigner & { readonly sent: SettlementCall[] } {
  const sent: SettlementCall[] = [];
  const hashes = behaviour.hashes ?? [`0x${'ab'.repeat(32)}` as const];
  return {
    sent,
    address: RELAYER,
    async send(call: SettlementCall): Promise<`0x${string}`> {
      if (behaviour.error) throw behaviour.error;
      sent.push(call);
      return hashes[Math.min(sent.length - 1, hashes.length - 1)] ?? `0x${'ab'.repeat(32)}`;
    },
  };
}

export function balanceKey(owner: string, amount: bigint): Record<string, bigint> {
  return { [`${USDG.toLowerCase()}:${owner.toLowerCase()}`]: amount };
}

export function allowanceKey(
  owner: string,
  spender: string,
  amount: bigint,
): Record<string, bigint> {
  return { [`${USDG.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`]: amount };
}

export const PRICE: Micro = micro(300_000n);
export const NOW = 1_800_000_000;
