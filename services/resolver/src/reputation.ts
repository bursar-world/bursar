import { agentRegistryId, cardRegistrations, erc8004Registries } from '@bursar/core';
import { isAddressEqual } from 'viem';
import type { Address, Hex } from 'viem';

import { PRICE_NORMAL } from './chain.js';
import type { ChainPort, Pricing, ReputationPort, TxOutcome } from './chain.js';
import type { Served } from './config.js';
import type { DisputeRecord, Journal } from './journal.js';
import type { ResolverKey } from './keys.js';
import { describeError } from './log.js';
import type { Logger } from './log.js';

/**
 * A published ruling, posted as ERC-8004 feedback against the provider's agent.
 *
 * The standard's reputation registry takes a signed value per agent from any client that is not
 * the agent's owner. A resolver key is such a client, and a finalised dispute is a value it can
 * stand behind: the median score, 0 to 100, under the tag `ruling`, with the dispute named in the
 * second tag and the published reasons at the feedback URI. The provider's agent id comes from the
 * card the console serves for the payee, and is believed only once the identity registry says the
 * token is the payee's or names the payee as its subject.
 *
 * Idempotent twice over: the journal records what was posted, and before a post the registry is
 * asked whether this client already left this dispute's feedback, so a journal lost to a redeploy
 * does not become a second entry.
 */
export type Reputation = {
  /** Called once a dispute is done. Posts when there is a ruling, an identity and no earlier post. */
  after(served: Served, disputeId: bigint): Promise<void>;
};

export type ReputationOptions = {
  readonly enabled: boolean;
  readonly chainId: number;
  /** The console that serves agent cards and published rulings, e.g. https://app.bursar.world. */
  readonly cardBase: string;
  readonly chain: ReputationPort;
  readonly locks: Pick<ChainPort, 'lock'>;
  readonly journal: Pick<Journal, 'get' | 'update'>;
  readonly keys: readonly ResolverKey[];
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly pricing?: Pricing;
};

const CARD_TIMEOUT_MS = 10_000;

export function feedbackTag2(served: Pick<Served, 'name'>, disputeId: bigint): string {
  return `${served.name}:${disputeId.toString()}`;
}

export function createReputation(options: ReputationOptions): Reputation {
  const { chain, locks, journal, keys, logger } = options;
  const registries = erc8004Registries(options.chainId);
  const identity = registries?.identity;
  const reputation = registries?.reputation;
  const base = options.cardBase.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const pricing = options.pricing ?? PRICE_NORMAL;

  async function agentOf(payee: Address): Promise<bigint | null> {
    if (identity === undefined) return null;
    const response = await fetchFn(`${base}/agents/${payee}/card.json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const ids = cardRegistrations(await response.json(), agentRegistryId(options.chainId, identity));
    for (const id of ids) {
      const facts = await chain.identity(identity, id);
      if (facts === null) continue;
      if (isAddressEqual(facts.owner, payee) || (facts.subject !== null && isAddressEqual(facts.subject, payee))) return id;
    }
    return null;
  }

  async function mark(served: Served, disputeId: bigint, agentId: bigint, hash: Hex | null): Promise<void> {
    await journal.update(served.registry, disputeId, (record) =>
      record === undefined ? undefined : { ...record, reputation: { agentId: agentId.toString(), hash } },
    );
  }

  return {
    after: async (served, disputeId) => {
      if (!options.enabled || identity === undefined || reputation === undefined) return;
      const record = await journal.get(served.registry, disputeId);
      if (record === undefined || record.outcome === null || record.outcome.status !== 'finalized' || record.reputation !== undefined) return;

      const key = keys[0];
      if (key === undefined) return;

      const payee = await payeeOf(served, record, locks);
      const agentId = await agentOf(payee);
      if (agentId === null) {
        logger.info('reputation_no_identity', { registry: served.registry, disputeId, payee });
        return;
      }

      const tag2 = feedbackTag2(served, disputeId);
      if (await chain.posted(reputation, agentId, key.address, tag2)) {
        await mark(served, disputeId, agentId, null);
        logger.info('reputation_already_posted', { disputeId, agentId, key: key.name });
        return;
      }

      let tx: TxOutcome;
      try {
        tx = await chain.giveFeedback(
          key,
          reputation,
          agentId,
          record.outcome.medianScore,
          tag2,
          `${base}/providers/${payee}`,
          `${base}/api/rulings?dispute=${disputeId.toString()}&registry=${served.registry}`,
          pricing,
        );
      } catch (error) {
        logger.warn('reputation_write_failed', { disputeId, agentId, reason: describeError(error) });
        return;
      }
      if (tx.status !== 'success') {
        logger.warn('reputation_reverted', { disputeId, agentId, hash: tx.hash });
        return;
      }

      await mark(served, disputeId, agentId, tx.hash);
      logger.info('reputation_posted', { disputeId, agentId, score: record.outcome.medianScore, key: key.name, hash: tx.hash });
    },
  };
}

async function payeeOf(served: Served, record: DisputeRecord, locks: Pick<ChainPort, 'lock'>): Promise<Address> {
  if (record.snapshot !== null) return record.snapshot.lock.payee;
  return (await locks.lock(served.escrow, record.escrowId)).payee;
}
