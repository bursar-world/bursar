import { getAddress } from 'viem';
import { caip2 } from '@bursar/core';
import type { RhcChain, Caip2 } from '@bursar/core';
import type { PaymentBinding } from './binding.js';
import { assertAssetConsistent, type AssetMeta } from './domain.js';
import { eip2612Path } from './eip2612.js';
import { eip3009Path } from './eip3009.js';
import { isNotSent, X402ConfigError } from './errors.js';
import { isRevert, simulationRefusal } from './issuer.js';
import { describe, type AuthorizationPath, type MethodContext, type MethodVerdict } from './method.js';
import { canonicalNetwork, networkChainId, sameNetwork } from './network.js';
import { readAddress, requiredAmount } from './payload.js';
import { permit2Path } from './permit2.js';
import type { PaymentChain, SettlementCall, SettlementSigner } from './ports.js';
import { REASON, type InvalidReason } from './reasons.js';
import {
  isSupportedVersion,
  isTransferMethod,
  SUPPORTED_VERSIONS,
  TRANSFER_METHODS,
  type PaymentPayload,
  type PaymentRequirements,
  type SchemePayload,
  type SettleResult,
  type SupportedAsset,
  type SupportedKind,
  type SupportedResponse,
  type TransferMethod,
  type VerifyResult,
} from './types.js';

/**
 * The `exact` scheme on EVM.
 *
 * Verify never writes. Settle broadcasts, and only after simulating, so a malformed authorisation
 * costs the relayer nothing. Both work against the ports in ports.ts, which keeps the redundancy
 * and breaker policy in `@bursar/core` where every service shares it.
 *
 * Robinhood Chain is `eip155:4663` and nothing else. It appears in no public facilitator's
 * network list, which is why this package exists.
 */
const EXPIRY_MARGIN_SECONDS = 6;
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * The longest work budget a resource server may quote, one hour.
 *
 * The figure bounds the payer's exposure rather than the facilitator's. It sets how far into the
 * future the authorisation has to stay valid, and an authorisation signed for a century is one
 * this facilitator could redeem at any point in it. Anything above the ceiling is refused outright:
 * clamping it would leave the payer signing for a window other than the one quoted.
 */
const MAX_TIMEOUT_SECONDS = 3_600;

/**
 * How long settle waits for a receipt.
 *
 * A fixed ceiling, independent of the server's work budget. That number arrives in the
 * requirements, so letting it size the wait hands a stranger the relayer's clock: past 2^31-1 ms
 * Node clamps the timer to one millisecond and every settlement comes back unconfirmed with the
 * money already gone.
 */
export const RECEIPT_WAIT_MS = 60_000;

/**
 * The most transactions one settlement submits, each with its own receipt wait. EIP-2612 is a
 * permit and then a pull; EIP-3009 and Permit2 are one call. A caller that has to outlast a settle,
 * such as a shutdown deadline, needs at least this times RECEIPT_WAIT_MS.
 */
export const MAX_SETTLEMENT_CALLS = 2;

/**
 * What a deployment settles unless it says otherwise.
 *
 * EIP-3009 signs the recipient into the authorisation. The two permit paths do not: they authorise
 * the relayer for an amount and trust it to forward the funds to the payee. Serving them is a
 * decision an operator makes explicitly.
 */
const DEFAULT_METHODS: readonly TransferMethod[] = Object.freeze(['eip3009']);

/** The work budget the requirements quoted, or null when they quoted something that is not one. */
function readTimeoutSeconds(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_MAX_TIMEOUT_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value > 0 && value <= MAX_TIMEOUT_SECONDS ? value : null;
}

const PATHS: Readonly<Record<TransferMethod, AuthorizationPath>> = Object.freeze({
  eip3009: eip3009Path,
  eip2612: eip2612Path,
  permit2: permit2Path,
});

export type NetworkSettlement = {
  readonly chain: RhcChain;
  readonly client: PaymentChain;
  /** Assets this facilitator settles. Build them with `resolveAsset`, not by hand. */
  readonly assets: readonly AssetMeta[];
  /** Absent on a verify-only deployment, which can then answer /verify but not /settle. */
  readonly signer?: SettlementSigner;
  /**
   * The address a permit must name as its spender. Defaults to the signer. Set it explicitly when
   * verification runs in a different process from settlement, which is the only way that process
   * can tell a permit meant for this facilitator from one meant for somebody else's.
   */
  readonly relayer?: `0x${string}`;
  readonly permit2?: `0x${string}`;
  /**
   * What this deployment will serve. Defaults to EIP-3009 alone. Naming `eip2612` or `permit2`
   * here opts into a path where the payer signs an allowance and the recipient is chosen by
   * whoever holds the relayer key at settlement time.
   */
  readonly methods?: readonly TransferMethod[];
};

export type ExactEvmOptions = {
  readonly networks: readonly NetworkSettlement[];
  /**
   * Refuse any payment that is not bound to a specific request. Leave it on. A payment that is
   * good for any request is a bearer token backed by the payer's money, and anyone who sees the
   * header in flight can spend it on a call of their own choosing.
   */
  readonly requireBinding?: boolean;
};

export type VerifyOptions = {
  /** Unix seconds. Injected so every time-dependent verdict is testable without waiting. */
  readonly now?: number;
  /** The request this payment must be bound to. */
  readonly binding?: PaymentBinding | null;
};

export type ExactEvm = {
  verify(
    payload: PaymentPayload | null | undefined,
    requirements: PaymentRequirements | null | undefined,
    options?: VerifyOptions,
  ): Promise<VerifyResult>;
  settle(
    payload: PaymentPayload | null | undefined,
    requirements: PaymentRequirements | null | undefined,
    options?: VerifyOptions,
  ): Promise<SettleResult>;
  supported(): SupportedResponse;
};

type Entry = {
  readonly network: Caip2;
  readonly chain: RhcChain;
  readonly client: PaymentChain;
  readonly assets: ReadonlyMap<`0x${string}`, AssetMeta>;
  readonly signer: SettlementSigner | null;
  readonly relayer: `0x${string}` | null;
  readonly permit2: `0x${string}` | null;
  readonly methods: readonly TransferMethod[];
};

function normalise(address: string, role: string, network: Caip2): `0x${string}` {
  try {
    return getAddress(address);
  } catch {
    throw new X402ConfigError('x402_address_invalid', `${role} address ${address} on ${network} is not an address`, {
      network,
      role,
      address,
    });
  }
}

export function createExactEvm(options: ExactEvmOptions): ExactEvm {
  const requireBinding = options.requireBinding ?? true;
  const entries = new Map<string, Entry>();

  for (const settlement of options.networks) {
    const network = caip2(settlement.chain.chainId);
    if (entries.has(network)) {
      throw new X402ConfigError('x402_duplicate_network', `network ${network} configured twice`, {
        network,
      });
    }
    if (settlement.assets.length === 0) {
      throw new X402ConfigError('x402_no_assets', `network ${network} settles no asset`, { network });
    }

    // Every address is checksummed once, here. Lookups and comparisons downstream are against
    // payer-supplied values that readAddress has already checksummed, so an operator who wrote
    // an address in lowercase would otherwise have every payment refused as an unknown asset or
    // a foreign spender.
    const signer = settlement.signer ?? null;
    const configuredRelayer = settlement.relayer ?? signer?.address ?? null;
    const relayer = configuredRelayer === null ? null : normalise(configuredRelayer, 'relayer', network);
    const permit2 = normalise(settlement.permit2 ?? settlement.chain.permit2, 'permit2', network);
    const assets = new Map<`0x${string}`, AssetMeta>();
    for (const configured of settlement.assets) {
      const address = normalise(configured.address, 'asset', network);
      const asset: AssetMeta = address === configured.address ? configured : { ...configured, address };
      assertAssetConsistent(asset, settlement.chain.chainId);
      assets.set(address, asset);
    }

    entries.set(network, {
      network,
      chain: settlement.chain,
      client: settlement.client,
      assets,
      signer,
      relayer,
      permit2,
      methods: settlement.methods ?? DEFAULT_METHODS,
    });
  }

  if (entries.size === 0) {
    throw new X402ConfigError('x402_no_networks', 'exact-evm was configured with no network');
  }

  function resolve(
    requirements: PaymentRequirements,
  ): { readonly entry: Entry; readonly asset: AssetMeta } | InvalidReason {
    const chainId = networkChainId(requirements.network);
    if (chainId === null) return REASON.network;
    const entry = entries.get(caip2(chainId));
    if (entry === undefined) return REASON.network;

    const address = readAddress(requirements.asset);
    if (address === null) return REASON.requirements;
    const asset = entry.assets.get(address);
    if (asset === undefined) return REASON.network;

    return { entry, asset };
  }

  /**
   * Which authorisation path this payment takes.
   *
   * The client may name one, and the requirements may name one, but neither may name a path the
   * asset does not implement or this deployment does not serve. With nothing named, the order in
   * TRANSFER_METHODS decides, and EIP-3009 is first for a reason: one transaction, no prior
   * approval, and the recipient is inside the signature.
   */
  function chooseMethod(
    entry: Entry,
    asset: AssetMeta,
    requirements: PaymentRequirements,
    payload: SchemePayload,
  ): TransferMethod | null {
    const available = TRANSFER_METHODS.filter(
      (method) => asset.methods.includes(method) && entry.methods.includes(method),
    );
    const declared = payload['method'] ?? requirements.extra?.['assetTransferMethod'];
    if (declared === undefined || declared === null) return available[0] ?? null;
    if (!isTransferMethod(declared)) return null;
    return available.includes(declared) ? declared : null;
  }

  async function check(
    payload: PaymentPayload | null | undefined,
    requirements: PaymentRequirements | null | undefined,
    options: VerifyOptions,
  ): Promise<
    | {
        readonly ok: true;
        readonly entry: Entry;
        readonly verdict: MethodVerdict & { ok: true };
        readonly method: TransferMethod;
        readonly asset: AssetMeta;
        readonly payTo: `0x${string}`;
      }
    | { readonly ok: false; readonly reason: InvalidReason; readonly payer?: `0x${string}`; readonly detail?: string }
  > {
    if (requirements === null || requirements === undefined) {
      return { ok: false, reason: REASON.requirements };
    }

    const version = payload?.x402Version;
    if (version !== undefined && !isSupportedVersion(version)) {
      return { ok: false, reason: REASON.version };
    }

    const accepted = payload?.accepted;
    if ((accepted?.scheme ?? requirements.scheme ?? 'exact') !== 'exact') {
      return { ok: false, reason: REASON.scheme };
    }
    // A client echoes back the terms it agreed to. Terms that name a different chain from the ones
    // being charged against are not a payment for this call.
    if (accepted?.network !== undefined && !sameNetwork(accepted.network, requirements.network)) {
      return { ok: false, reason: REASON.network };
    }

    const resolved = resolve(requirements);
    if (typeof resolved === 'string') return { ok: false, reason: resolved };
    const { entry, asset } = resolved;

    const payTo = readAddress(requirements.payTo);
    if (payTo === null) return { ok: false, reason: REASON.requirements };
    const required = requiredAmount(requirements);
    if (required === null) return { ok: false, reason: REASON.requirements };

    const scheme = payload?.payload;
    if (scheme === undefined || scheme === null) return { ok: false, reason: REASON.payload };

    const method = chooseMethod(entry, asset, requirements, scheme);
    if (method === null) return { ok: false, reason: REASON.method };

    const binding = options.binding ?? null;
    if (requireBinding && binding === null) {
      return { ok: false, reason: REASON.unbound, detail: 'this facilitator settles bound payments only' };
    }

    const maxTimeout = readTimeoutSeconds(requirements.maxTimeoutSeconds);
    if (maxTimeout === null) {
      return {
        ok: false,
        reason: REASON.requirements,
        detail: `maxTimeoutSeconds must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}`,
      };
    }

    const context: MethodContext = {
      chain: entry.client,
      asset,
      payTo,
      required,
      now: options.now ?? Math.floor(Date.now() / 1000),
      // A settlement that lands after the authorisation expires reverts and burns gas, so anything
      // inside this margin fails verification up front instead.
      mustOutlive: Math.max(EXPIRY_MARGIN_SECONDS, maxTimeout),
      relayer: entry.relayer,
      permit2: entry.permit2,
      payload: scheme,
      binding,
    };

    const verdict = await PATHS[method].check(context);
    if (!verdict.ok) {
      return {
        ok: false,
        reason: verdict.reason,
        ...(verdict.payer === undefined ? {} : { payer: verdict.payer }),
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
      };
    }
    return { ok: true, entry, verdict, method, asset, payTo };
  }

  async function verify(
    payload: PaymentPayload | null | undefined,
    requirements: PaymentRequirements | null | undefined,
    options: VerifyOptions = {},
  ): Promise<VerifyResult> {
    const outcome = await check(payload, requirements, options);
    if (!outcome.ok) {
      return {
        isValid: false,
        invalidReason: outcome.reason,
        ...(outcome.payer === undefined ? {} : { payer: outcome.payer }),
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      };
    }
    return {
      isValid: true,
      payer: outcome.verdict.payer,
      method: outcome.method,
      amount: outcome.verdict.amount,
    };
  }

  async function settle(
    payload: PaymentPayload | null | undefined,
    requirements: PaymentRequirements | null | undefined,
    options: VerifyOptions = {},
  ): Promise<SettleResult> {
    const network = canonicalNetwork(requirements?.network);
    let outcome: Awaited<ReturnType<typeof check>>;
    try {
      outcome = await check(payload, requirements, options);
    } catch (error) {
      // Settle re-reads the chain before it sends, and a read that fails there has sent nothing.
      // Throwing would leave the caller unable to tell this from a send that may have landed, and
      // the careful caller treats that as a broadcast and keeps the payer's nonce claimed forever.
      return {
        success: false,
        settled: false,
        broadcast: false,
        errorReason: REASON.facilitator,
        payer: '',
        transaction: '',
        network,
        detail: describe(error),
      };
    }
    if (!outcome.ok) {
      return {
        success: false,
        settled: false,
        broadcast: false,
        errorReason: outcome.reason,
        payer: outcome.payer ?? '',
        transaction: '',
        network,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      };
    }

    const { entry, verdict, method } = outcome;
    const signer = entry.signer;
    if (signer === null) {
      return {
        success: false,
        settled: false,
        broadcast: false,
        errorReason: REASON.state,
        payer: verdict.payer,
        transaction: '',
        network,
        method,
        detail: 'this deployment verifies but does not settle',
      };
    }

    return broadcast(entry, signer, verdict.calls, {
      payer: verdict.payer,
      network,
      method,
      asset: outcome.asset,
      payTo: outcome.payTo,
    });
  }

  async function broadcast(
    entry: Entry,
    signer: SettlementSigner,
    calls: readonly SettlementCall[],
    context: {
      readonly payer: `0x${string}`;
      readonly network: string;
      readonly method: TransferMethod;
      readonly asset: AssetMeta;
      readonly payTo: `0x${string}`;
    },
  ): Promise<SettleResult> {
    const base = { payer: context.payer, network: context.network, method: context.method };
    let sent = false;
    let hash = '';

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (call === undefined) continue;

      // The first call was simulated during verification. A later one could not be: a pull has no
      // allowance to pull against until the permit before it lands, so it is simulated here, once
      // that has happened.
      if (index > 0) {
        try {
          await entry.client.simulate(call, signer.address);
        } catch (error) {
          if (!isRevert(error)) {
            // The chain did not answer, which says nothing about the pull. The earlier call has
            // landed, so this is reported with that broadcast rather than thrown, and not as a
            // transaction-state refusal the payer would read as their fault.
            return {
              ...base,
              success: false,
              settled: false,
              broadcast: sent,
              errorReason: REASON.facilitator,
              transaction: hash,
              detail: describe(error),
            };
          }
          // The permit has landed by now, so this is the one place a settlement can meet an issuer
          // condition with the relayer's gas already spent, so it is named in the same vocabulary
          // the reads use.
          const refusal = simulationRefusal(error, context.asset, {
            payer: context.payer,
            payee: context.payTo,
          });
          return {
            ...base,
            success: false,
            settled: false,
            broadcast: sent,
            errorReason: refusal.reason,
            transaction: hash,
            ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
          };
        }
      }

      let submitted: `0x${string}`;
      try {
        submitted = await signer.send(call);
      } catch (error) {
        if (isNotSent(error)) {
          // The signer knows this one never reached a node, so the only transaction that can have
          // landed is an earlier call in the same settlement.
          return {
            ...base,
            success: false,
            settled: false,
            broadcast: sent,
            errorReason: REASON.facilitator,
            transaction: hash,
            detail: describe(error),
          };
        }
        // A send that throws has not necessarily failed. A node that accepted the transaction and
        // then lost the response looks exactly like one that rejected it, and the caller cannot
        // tell them apart either. Reporting `broadcast: false` here is a claim that nothing
        // reached the chain, and a resource server acts on it: it releases the replay claim and
        // refunds the budget, and the transfer lands a moment later with nothing recording it.
        // Unknown is the honest answer, and the type already carries it.
        return {
          ...base,
          success: false,
          settled: null,
          broadcast: true,
          errorReason: REASON.state,
          transaction: hash,
          detail: describe(error),
        };
      }
      sent = true;
      hash = submitted;

      // The broadcast already happened, so failing to read the receipt is not failing to pay.
      // Reporting it as one loses money that moved: a server that saw an error here would refund,
      // or serve for free, against a transfer that settled. Say unconfirmed and hand back the hash.
      let receipt;
      try {
        receipt = await entry.client.waitForReceipt(submitted, RECEIPT_WAIT_MS);
      } catch (error) {
        return {
          ...base,
          success: false,
          settled: null,
          broadcast: true,
          errorReason: REASON.unconfirmed,
          transaction: submitted,
          detail: describe(error),
        };
      }

      if (receipt.status !== 'success') {
        return {
          ...base,
          success: false,
          settled: false,
          broadcast: true,
          errorReason: REASON.state,
          transaction: submitted,
          detail: `transaction ${index + 1} of ${calls.length} reverted`,
        };
      }
    }

    return { ...base, success: true, settled: true, broadcast: sent, transaction: hash };
  }

  function supported(): SupportedResponse {
    const kinds: SupportedKind[] = [];
    for (const entry of entries.values()) {
      const assets: SupportedAsset[] = [];
      const served = new Set<TransferMethod>();
      for (const asset of entry.assets.values()) {
        const methods = asset.methods.filter((method) => entry.methods.includes(method));
        for (const method of methods) served.add(method);
        assets.push({
          address: asset.address,
          name: asset.name,
          version: asset.version,
          decimals: asset.decimals,
          methods,
        });
      }
      const ordered = TRANSFER_METHODS.filter((method) => served.has(method));
      const preferred = ordered[0];
      if (preferred === undefined) continue;

      for (const version of SUPPORTED_VERSIONS) {
        kinds.push({
          x402Version: version,
          scheme: 'exact',
          network: entry.network,
          // The name and version of each asset are published because a payer has to sign under the
          // token's own EIP-712 domain and cannot be expected to guess it.
          extra: { assetTransferMethod: preferred, assetTransferMethods: ordered, assets },
        });
      }
    }
    return { kinds };
  }

  return { verify, settle, supported };
}
