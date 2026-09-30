import {
  CURRENT_CONTRACT_SET,
  classLabel,
  classOfLabel,
  committedMandateAccountAbi,
  contractSetOfEscrow,
  escrowAbi,
  micro,
  settlementAssetAbi,
} from '@bursar/core';
import type { Micro, RhcPublicClient } from '@bursar/core';
import { classesOf } from '@bursar/sdk';
import type { AgentHandoff, CommittedClass, JobSpec } from '@bursar/sdk';
import type { PrivatePayment, PrivatePaymentReceipt } from '@bursar/sdk/agent';
import { formatEther } from 'viem';
import type { Address, Hex } from 'viem';

import { ToolError } from './errors.js';
import { duration, instant, money } from './format.js';
import type { MoneyView } from './types.js';

/** What the agent can do inside a private mandate, signing with the key from its file. */
export type PrivateMandateGateway = {
  inspect(): Promise<PrivateMandateView>;
  pay(input: PrivatePayInput): Promise<PrivatePaymentView>;
};

export type PrivatePayInput = {
  readonly payee: Address;
  readonly amount: Micro;
  readonly capability: string;
  readonly spendClass: CommittedClass;
  readonly spec: JobSpec;
  readonly deliverWithinSeconds: number;
};

export type PrivateMandateView = {
  readonly mandate: Address;
  readonly agent: Address;
  readonly agentMatchesFile: boolean;
  readonly state: 'active' | 'paused' | 'revoked' | 'ended';
  readonly balance: MoneyView;
  readonly provenPayments: number;
  readonly termsVersion: number;
  readonly agentGas: { readonly eth: string; readonly enough: boolean };
  readonly terms: {
    readonly label: string | null;
    readonly perPayment: MoneyView;
    readonly perPeriod: MoneyView;
    readonly period: string;
    readonly total: MoneyView;
    readonly allowed: readonly CommittedClass[];
    /** The only capabilities a payment can carry. The proof binds the one the escrow lock names. */
    readonly capabilities: readonly string[];
    readonly providers: readonly Address[];
    readonly endsAt: string;
  };
  readonly note: string;
};

export type PrivatePaymentView = {
  readonly status: 'locked';
  readonly settlementId: string;
  readonly txHash: Hex;
  readonly payee: Address;
  readonly amount: MoneyView;
  readonly capability: string;
  readonly briefSealed: boolean;
};

type Agent = { readonly address: Address; pay(payment: PrivatePayment): Promise<PrivatePaymentReceipt> };
export type AgentFactory = (handoff: AgentHandoff, client: RhcPublicClient) => Agent | Promise<Agent>;

/** One proven spend with a sealed brief used about 0.9M gas, 150k of it L1 data, at 0.02 gwei on 4663. */
const MIN_GAS_WEI = 30_000_000_000_000n;

const NOTE =
  'The terms come from the key file and are known only to the owner and this agent. On chain the ' +
  'mandate shows a commitment to them. The amount and the provider of each payment are public.';

// The prover pulls in snarkjs and the proving artifacts, so it loads on the first payment.
const loadAgent: AgentFactory = async (handoff, client) => {
  const { privateAgent } = await import('@bursar/sdk/agent');
  return privateAgent(handoff, client);
};

export function createPrivateGateway(options: {
  readonly client: RhcPublicClient;
  readonly handoff: AgentHandoff;
  readonly agentOf?: AgentFactory;
  readonly now?: () => number;
}): PrivateMandateGateway {
  const { client, handoff } = options;
  const address = handoff.mandate;
  const abi = committedMandateAccountAbi;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let agent: Promise<Agent> | undefined;

  // The mandate's escrow and that escrow's floor are both fixed at deployment, so one read serves
  // every payment. An escrow before v3 refuses only an empty lock, and asking it for a floor reverts.
  let floor: Promise<bigint> | undefined;
  const lockFloor = (): Promise<bigint> =>
    (floor ??= client
      .readContract({ address, abi, functionName: 'escrow' })
      .then((escrow) =>
        (contractSetOfEscrow(escrow) ?? CURRENT_CONTRACT_SET) === 'v3'
          ? client.readContract({ address: escrow, abi: escrowAbi, functionName: 'minLock' })
          : 1n,
      )
      .catch((error: unknown) => {
        floor = undefined;
        throw error;
      }));

  const read = async () => {
    const [onChainAgent, paused, revoked, nonce, version, asset] = await Promise.all([
      client.readContract({ address, abi, functionName: 'agent' }),
      client.readContract({ address, abi, functionName: 'paused' }),
      client.readContract({ address, abi, functionName: 'revoked' }),
      client.readContract({ address, abi, functionName: 'nonce' }),
      client.readContract({ address, abi, functionName: 'version' }),
      client.readContract({ address, abi, functionName: 'settlementAsset' }),
    ]);
    const [balance, gas] = await Promise.all([
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'balanceOf', args: [address] }),
      client.getBalance({ address: handoff.agent }),
    ]);
    return { onChainAgent, paused, revoked, nonce, version, balance, gas };
  };

  return {
    async inspect() {
      const state = await read();
      const terms = handoff.terms;
      return {
        mandate: address,
        agent: handoff.agent,
        agentMatchesFile: state.onChainAgent.toLowerCase() === handoff.agent.toLowerCase(),
        state: state.revoked ? 'revoked' : state.paused ? 'paused' : terms.expiry <= now() ? 'ended' : 'active',
        balance: money(micro(state.balance)),
        provenPayments: Number(state.nonce),
        termsVersion: Number(state.version),
        agentGas: { eth: formatEther(state.gas), enough: state.gas >= MIN_GAS_WEI },
        terms: {
          label: terms.label ?? null,
          perPayment: money(micro(BigInt(terms.perCallCap))),
          perPeriod: money(micro(BigInt(terms.periodCap))),
          period: duration(terms.periodLen),
          total: money(micro(BigInt(terms.totalCap))),
          allowed: classesOf(terms),
          capabilities: terms.capabilities,
          providers: terms.counterparties,
          endsAt: instant(terms.expiry),
        },
        note: NOTE,
      };
    },

    async pay(input) {
      const state = await read();
      if (state.onChainAgent.toLowerCase() !== handoff.agent.toLowerCase()) {
        throw new ToolError(
          'agent_replaced',
          'The owner has moved this mandate to a different agent, so the key in this server can no longer ' +
            'spend from it. Ask the owner for the new key file.',
          { agent: handoff.agent, mandateAgent: state.onChainAgent },
        );
      }
      if (state.revoked) throw new ToolError('mandate_revoked', 'The owner has revoked this mandate. Nothing more can be paid from it.');
      if (state.paused) throw new ToolError('mandate_paused', 'The owner has paused this mandate. Payments resume when the owner resumes it.');
      if (state.gas < MIN_GAS_WEI) {
        throw new ToolError(
          'agent_needs_gas',
          `The agent address ${handoff.agent} holds ${formatEther(state.gas)} ETH, which does not cover the ` +
            'network fee for a proven payment. The owner has to send it a little ETH first.',
          { agent: handoff.agent },
        );
      }
      const label = classOfLabel(input.capability) === undefined ? classLabel(input.spendClass, input.capability) : input.capability;
      const fits = checkTerms(handoff, input, label, now());
      if (fits !== null) throw fits;

      // The terms can allow a payment the escrow will not lock, and proving one takes seconds.
      const minLock = await lockFloor();
      if (input.amount < minLock) {
        throw new ToolError(
          'below_lock_floor',
          `The escrow locks no payment under ${money(micro(minLock)).usdg} USDG, and this one is ` +
            `${money(input.amount).usdg}. The floor keeps every payment large enough that contesting it costs a bond.`,
          { minLock: minLock.toString() },
        );
      }

      agent ??= Promise.resolve((options.agentOf ?? loadAgent)(handoff, client));
      const receipt = await (await agent).pay({
        payee: input.payee,
        amount: input.amount,
        capability: label,
        spec: input.spec,
        spendClass: input.spendClass,
        deliverWithin: input.deliverWithinSeconds,
      });
      return {
        status: 'locked',
        settlementId: receipt.escrowId.toString(),
        txHash: receipt.hash,
        payee: input.payee,
        amount: money(input.amount),
        capability: label,
        briefSealed: receipt.sealed,
      };
    },
  };
}

/**
 * The checks the proof would fail on, made first so the agent reads which term stopped it. The
 * period and total caps depend on the counters, which the prover rebuilds; those refusals come
 * back from the prover.
 */
function checkTerms(handoff: AgentHandoff, input: PrivatePayInput, label: string, now: number): ToolError | null {
  const terms = handoff.terms;
  if (terms.expiry <= now) return new ToolError('mandate_ended', `This mandate ended at ${instant(terms.expiry)}.`);
  const spendClass = classOfLabel(label);
  if (spendClass === undefined || !classesOf(terms).includes(spendClass as CommittedClass)) {
    return new ToolError('class_not_allowed', `This mandate does not allow ${spendClass === 'hire' ? 'agent hires' : 'service payments'}.`);
  }
  if (!terms.capabilities.includes(label)) {
    return new ToolError('capability_not_allowed', `${label} is not one of the capabilities this mandate may pay for.`, {
      capabilities: terms.capabilities,
    });
  }
  if (!terms.counterparties.some((entry) => entry.toLowerCase() === input.payee.toLowerCase())) {
    return new ToolError('provider_not_allowed', `${input.payee} is not one of the providers this mandate may pay.`, {
      providers: terms.counterparties,
    });
  }
  if (input.amount > BigInt(terms.perCallCap)) {
    return new ToolError(
      'over_per_payment_cap',
      `This mandate pays at most ${money(micro(BigInt(terms.perCallCap))).usdg} USDG per payment.`,
    );
  }
  return null;
}
