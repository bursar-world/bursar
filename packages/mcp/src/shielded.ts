import { micro, settlementAssetAbi } from '@bursar/core';
import type { Micro, RhcPublicClient, ShieldedDeployment } from '@bursar/core';
import {
  accessRegistryAbi,
  blockedDepositors,
  buildAssociationSet,
  changeSecrets,
  encodeRelayData,
  fetchAssociationSet,
  fetchPoolEvents,
  fetchRelayQuote,
  isStaleSetRefusal,
  leanRoot,
  proofToWire,
  recoverNotes,
  ShieldedServiceError,
  shieldedEntrypointAbi,
  shieldedPoolAbi,
  submitRelay,
  withdrawalContext,
} from '@bursar/sdk';
import type {
  Note,
  NoteSecrets,
  OwnedNote,
  PoolEvents,
  RelayQuote,
  RelayResult,
  ShieldedKeys,
  SolidityProof,
} from '@bursar/sdk';
import { formatEther, getAddress } from 'viem';
import type { Address, Hex } from 'viem';

import { ToolError } from './errors.js';
import { money } from './format.js';
import type { MoneyView } from './types.js';

export type ShieldedStatusView = {
  readonly pool: Address;
  readonly entrypoint: Address;
  readonly relay: Address;
  readonly open: boolean;
  readonly balance: MoneyView;
  readonly caps: { readonly perDeposit: MoneyView; readonly poolTotal: MoneyView; readonly roomLeft: MoneyView };
  readonly associationSet: { readonly root: string; readonly index: number | null; readonly postedAt: string | null } | null;
  readonly relayer: { readonly feeBps: number; readonly gasDropEth: string; readonly feeRecipient: Address } | null;
  readonly note: string;
};

export type ShieldedNoteView = {
  readonly label: string;
  readonly value: MoneyView;
  readonly approved: boolean;
};

export type ShieldedBalanceView = {
  readonly spendable: MoneyView;
  readonly notes: readonly ShieldedNoteView[];
  readonly awaitingApproval: MoneyView;
  readonly note: string;
};

export type ShieldedPayInput = { readonly recipient: Address; readonly amount: Micro; readonly gasDrop: boolean };

export type ShieldedPaymentView = {
  readonly status: 'sent';
  readonly txHash: Hex;
  readonly recipient: Address;
  readonly received: MoneyView;
  readonly relayerFee: MoneyView;
  readonly withdrawn: MoneyView;
  readonly gasDropEth: string;
  readonly leftInNote: MoneyView;
};

export type ShieldedGateway = {
  status(): Promise<ShieldedStatusView>;
  /** Null when no key file is configured, which leaves the status alone. */
  readonly float: {
    balance(): Promise<ShieldedBalanceView>;
    pay(input: ShieldedPayInput): Promise<ShieldedPaymentView>;
  } | null;
  readonly relayerUrl: string | null;
};

export type WithdrawalProver = (args: {
  note: Note;
  amount: bigint;
  change: NoteSecrets;
  stateLeaves: readonly bigint[];
  aspLabels: readonly bigint[];
  context: bigint;
}) => Promise<{ proof: SolidityProof; change: Note }>;

// The prover pulls in snarkjs and a 17 MB proving key, so it loads on the first payment.
const proveWithNodeArtifacts: WithdrawalProver = async (args) => {
  const [{ proveWithdrawal }, { shieldedArtifacts }] = await Promise.all([
    import('@bursar/sdk/shielded-prove'),
    import('@bursar/circuits/privacy-pools'),
  ]);
  return proveWithdrawal({ ...args, artifacts: shieldedArtifacts.withdraw });
};

const STATUS_NOTE =
  'Deposits into the pool are public: the depositor and the amount show on chain. A withdrawal proves it ' +
  'spends some approved deposit without saying which, and the relayer submits it, so the payment carries no ' +
  'trace of the wallet that deposited. How private that is depends on how many deposits the pool holds.';

const BALANCE_NOTE =
  'A deposit can be spent once the association-set provider has approved it; until then it can only be ' +
  'returned to the wallet that made it.';

export function createShieldedGateway(options: {
  readonly client: RhcPublicClient;
  readonly chainId: number;
  readonly deployment: ShieldedDeployment;
  readonly keys: ShieldedKeys | null;
  readonly relayerUrl: string | null;
  readonly aspUrl: string | null;
  readonly loadEvents?: () => Promise<PoolEvents>;
  readonly prove?: WithdrawalProver;
}): ShieldedGateway {
  const { client, deployment: d, keys, relayerUrl, aspUrl, chainId } = options;
  const scope = BigInt(d.scope);
  const prove = options.prove ?? proveWithNodeArtifacts;
  const loadEvents =
    options.loadEvents ?? (() => fetchPoolEvents(client, { pool: d.ShieldedPool, fromBlock: BigInt(d.fromBlock) }));

  const latestRoot = async (): Promise<bigint | null> => {
    try {
      return await client.readContract({ address: d.Entrypoint, abi: shieldedEntrypointAbi, functionName: 'latestRoot' });
    } catch {
      // NoRootsAvailable: the provider has not posted yet.
      return null;
    }
  };

  const quote = async (): Promise<RelayQuote> => {
    if (relayerUrl === null) {
      throw new ToolError(
        'relayer_unconfigured',
        'A shielded payment goes through the relayer, so it is never sent from a wallet the owner has used. ' +
          'Set BURSAR_RELAYER_URL and restart the server.',
      );
    }
    const q = await fetchRelayQuote(relayerUrl);
    if (q.chainId !== chainId || getAddress(q.relay) !== getAddress(d.ShieldedRelay)) {
      throw new ToolError(
        'relayer_mismatch',
        `The relayer at ${relayerUrl} submits through ${q.relay} on chain ${q.chainId}, not the shielded relay ` +
          `${d.ShieldedRelay} on chain ${chainId}. Point BURSAR_RELAYER_URL at the right relayer.`,
        { relay: q.relay, chainId: q.chainId },
      );
    }
    if (q.feeBps < 0 || q.feeBps > d.maxRelayFeeBps) {
      throw new ToolError('relayer_fee_too_high', `The relayer asks ${q.feeBps} bps; the relay contract allows ${d.maxRelayFeeBps}.`);
    }
    return q;
  };

  /**
   * The labels behind the posted root. The provider's copy when it matches; otherwise the rule is
   * rebuilt from chain data, trying the deposits in order until the root matches, because the
   * provider posts after deposits land and the newest ones may not be in yet.
   */
  const approvedLabels = async (events: PoolEvents, root: bigint | null): Promise<bigint[] | null> => {
    if (root === null) return null;
    if (aspUrl !== null) {
      try {
        const set = await fetchAssociationSet(aspUrl);
        const labels = set.labels.map(BigInt);
        if (getAddress(set.pool) === getAddress(d.ShieldedPool) && leanRoot(labels) === root) return labels;
      } catch {
        // Fall through to the rebuild; the chain is the authority either way.
      }
    }
    const blocked = await blockedDepositors(client, events.deposits.map((x) => x.depositor), d.AccessRegistry);
    for (let n = events.deposits.length; n > 0; n--) {
      const set = buildAssociationSet({
        chainId,
        pool: d.ShieldedPool,
        scope,
        deposits: events.deposits.slice(0, n),
        blocked,
        throughBlock: events.toBlock,
      });
      if (BigInt(set.root) === root) return set.labels.map(BigInt);
    }
    return null;
  };

  const notesOf = async (k: ShieldedKeys) => {
    const events = await loadEvents();
    const root = await latestRoot();
    const labels = await approvedLabels(events, root);
    const approved = new Set(labels ?? []);
    const spendable = recoverNotes({ keys: k, scope, events }).notes.filter((n) => n.status === 'spendable');
    return { events, root, labels, spendable, approved };
  };

  const float =
    keys === null
      ? null
      : {
          async balance(): Promise<ShieldedBalanceView> {
            const { spendable, approved } = await notesOf(keys);
            const sum = (list: OwnedNote[]) => list.reduce((acc, n) => acc + n.value, 0n);
            return {
              spendable: money(micro(sum(spendable.filter((n) => approved.has(n.label))))),
              awaitingApproval: money(micro(sum(spendable.filter((n) => !approved.has(n.label))))),
              notes: spendable.map((n) => ({ label: n.label.toString(), value: money(micro(n.value)), approved: approved.has(n.label) })),
              note: BALANCE_NOTE,
            };
          },

          async pay(input: ShieldedPayInput): Promise<ShieldedPaymentView> {
            const q = await quote();
            const blocked = await client.readContract({
              address: d.AccessRegistry,
              abi: accessRegistryAbi,
              functionName: 'isBlocked',
              args: [input.recipient],
            });
            if (blocked) {
              throw new ToolError(
                'recipient_blocked',
                `The Robinhood access registry blocks ${input.recipient}, so the pool will not pay it.`,
                { recipient: input.recipient },
              );
            }

            const withdrawn = grossUp(input.amount, BigInt(q.feeBps));
            const withdrawal = {
              processooor: d.ShieldedRelay,
              data: encodeRelayData({ recipient: input.recipient, feeRecipient: q.feeRecipient, relayFeeBPS: BigInt(q.feeBps) }),
            };

            // Reads the pool and the association set afresh each time, so a second attempt proves
            // against the roots as they stand then.
            const attempt = async (): Promise<{ change: Note; sent: RelayResult }> => {
              const { events, root, labels, spendable, approved } = await notesOf(keys);
              if (root === null || labels === null) {
                throw new ToolError(
                  'association_set_unavailable',
                  'The association-set root on chain could not be matched to a set of deposits, so no withdrawal ' +
                    'can be proven right now. Try again after the provider posts its next root.',
                );
              }
              const note = pickNote(spendable, approved, withdrawn);
              const { proof, change } = await prove({
                note,
                amount: withdrawn,
                change: changeSecrets(keys, note.label, BigInt(note.withdrawals)),
                stateLeaves: events.leaves,
                aspLabels: labels,
                context: withdrawalContext(withdrawal, scope),
              });
              const sent = await submitRelay(relayerUrl as string, { withdrawal, proof: proofToWire(proof), gasDrop: input.gasDrop });
              return { change, sent };
            };

            // A root can move between the proof and the submission: the provider posts a new
            // association set, or the pool's state moves on. The pool refuses the stale proof and
            // spends nothing, so the proof is made once more against the new roots.
            let result: { change: Note; sent: RelayResult };
            try {
              result = await attempt();
            } catch (error) {
              if (!provedAgainstMovedRoot(error)) throw error;
              result = await attempt().catch((again: unknown) => {
                if (!provedAgainstMovedRoot(again)) throw again;
                throw new ToolError(
                  'shielded_roots_moved',
                  'The pool refused this payment twice because its roots moved while the proof was being made. ' +
                    'Nothing was spent and the deposit is untouched. Try again in a few minutes.',
                );
              });
            }
            const { change, sent } = result;
            const fee = (withdrawn * BigInt(q.feeBps)) / 10_000n;
            return {
              status: 'sent',
              txHash: sent.transactionHash,
              recipient: input.recipient,
              received: money(micro(withdrawn - fee)),
              relayerFee: money(micro(fee)),
              withdrawn: money(micro(withdrawn)),
              gasDropEth: formatEther(BigInt(sent.gasDropWei)),
              leftInNote: money(micro(change.value)),
            };
          },
        };

  return {
    relayerUrl,
    float,
    async status() {
      const [dead, maxDeposit, maxTotal, balance, root] = await Promise.all([
        client.readContract({ address: d.ShieldedPool, abi: shieldedPoolAbi, functionName: 'dead' }),
        client.readContract({ address: d.ShieldedPool, abi: shieldedPoolAbi, functionName: 'MAX_DEPOSIT' }),
        client.readContract({ address: d.ShieldedPool, abi: shieldedPoolAbi, functionName: 'MAX_TOTAL' }),
        client.readContract({ address: d.asset, abi: settlementAssetAbi, functionName: 'balanceOf', args: [d.ShieldedPool] }),
        latestRoot(),
      ]);
      return {
        pool: d.ShieldedPool,
        entrypoint: d.Entrypoint,
        relay: d.ShieldedRelay,
        open: !dead,
        balance: money(micro(balance)),
        caps: {
          perDeposit: money(micro(maxDeposit)),
          poolTotal: money(micro(maxTotal)),
          roomLeft: money(micro(maxTotal > balance ? maxTotal - balance : 0n)),
        },
        associationSet: root === null ? null : { root: root.toString(), ...(await rootPosting(client, d, root)) },
        relayer: relayerUrl === null ? null : await quote().then(
          (q) => ({ feeBps: q.feeBps, gasDropEth: formatEther(BigInt(q.gasDropWei)), feeRecipient: q.feeRecipient }),
          () => null,
        ),
        note: STATUS_NOTE,
      };
    },
  };
}

/** Where and when the current root was posted, from the Entrypoint's RootUpdated events. */
async function rootPosting(
  client: RhcPublicClient,
  d: ShieldedDeployment,
  root: bigint,
): Promise<{ index: number | null; postedAt: string | null }> {
  try {
    const event = shieldedEntrypointAbi.find((x) => x.type === 'event' && x.name === 'RootUpdated');
    const logs = await client.getLogs({ address: d.Entrypoint, event: event as never, fromBlock: BigInt(d.fromBlock) });
    const index = logs.length - 1;
    const last = logs[index] as { args?: { _root?: bigint; _timestamp?: bigint } } | undefined;
    if (last?.args?._root !== root) return { index: null, postedAt: null };
    const at = last.args._timestamp;
    return { index, postedAt: at === undefined ? null : new Date(Number(at) * 1000).toISOString().replace('.000Z', 'Z') };
  } catch {
    return { index: null, postedAt: null };
  }
}

/**
 * Whether the relayer turned a withdrawal away because a root it was proved against has moved: the
 * association set is no longer the latest, or the pool's state root has aged out of the history it
 * keeps. Either way nothing was spent, and a proof made against the current roots can go through.
 */
function provedAgainstMovedRoot(error: unknown): boolean {
  if (isStaleSetRefusal(error)) return true;
  return error instanceof ShieldedServiceError && error.code === 'would_revert' && error.message.includes('UnknownStateRoot');
}

/** The withdrawal that leaves `amount` with the recipient after the relayer's cut. */
export function grossUp(amount: bigint, feeBps: bigint): bigint {
  const net = (gross: bigint) => gross - (gross * feeBps) / 10_000n;
  let gross = (amount * 10_000n) / (10_000n - feeBps);
  while (net(gross) < amount) gross++;
  while (gross > amount && net(gross - 1n) >= amount) gross--;
  return gross;
}

/** The smallest approved note that covers the amount; one note pays one withdrawal. */
export function pickNote(spendable: readonly OwnedNote[], approved: ReadonlySet<bigint>, amount: bigint): OwnedNote {
  const usable = spendable.filter((n) => approved.has(n.label)).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const fits = usable.find((n) => n.value >= amount);
  if (fits) return fits;
  const pending = spendable.find((n) => !approved.has(n.label) && n.value >= amount);
  if (pending) {
    throw new ToolError(
      'note_not_approved',
      `The deposit that covers ${formatUsdg(amount)} USDG is not in the association set yet. It becomes spendable ` +
        'once the provider approves it.',
      { label: pending.label.toString() },
    );
  }
  const largest = usable.at(-1)?.value ?? 0n;
  const total = usable.reduce((acc, n) => acc + n.value, 0n);
  throw new ToolError(
    'amount_above_note',
    `One payment is drawn from one deposit, and the largest spendable deposit holds ${formatUsdg(largest)} USDG ` +
      `(${formatUsdg(total)} USDG across all of them). Pay ${formatUsdg(largest)} USDG or less, including the relayer fee.`,
    { largest: largest.toString(), total: total.toString() },
  );
}

function formatUsdg(value: bigint): string {
  return money(micro(value)).usdg;
}
