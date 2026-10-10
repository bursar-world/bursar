import { ERC8004_REGISTRATION_TYPE, SPEND_CLASSES, SPEND_CLASS_INFO, agentRegistryId, toCapabilityId } from '@bursar/core';
import type { AgentCard, AgentCardRegistration } from '@bursar/core';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { multicall } from 'viem/actions';

import { discoverIdentities } from '@/app/api/agents/discover/lookup';
import { agentRegistryAbi, mandateAccountAbi, reputationAbi } from '@/chain/abi';
import { PUBLISHED_CAPABILITIES } from '@/chain/capabilities';
import { rhcClient } from '@/chain/client';
import { REGISTRIES, cardUrl, verifyIdentities } from '@/chain/erc8004';
import { mandateCodeVersion } from '@/chain/mandates';
import { ADDRESSES, CHAIN_ID, MULTICALL3, isZeroAddress, shortAddress } from '@/chain/rhc';

/**
 * The agent card for a Bursar address, built from the chain on each read.
 *
 * ERC-8004 points an identity at a registration file and says what it must contain. This is that
 * file, for either of the two things a Bursar address can be: a provider listed in the registry,
 * described by its listing and its settlement record, or a mandate account, described by its
 * budget and the agent seated on it. Nothing in it is typed in by hand; a card that said more than
 * the contracts would be the one place this product's word and its state could part.
 */
const FACILITATOR = 'https://facilitator.bursar.world';

function usd(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2);
}

export async function buildCard(subject: Address, site: string, fetchFn: typeof fetch = fetch): Promise<AgentCard | undefined> {
  const address = getAddress(subject);
  return (await providerCard(address, site, fetchFn)) ?? (await mandateCard(address, site, fetchFn));
}

async function registrationsOf(subject: Address, owner: Address, site: string, fetchFn: typeof fetch): Promise<readonly AgentCardRegistration[]> {
  if (REGISTRIES === undefined) return [];
  const found = await discoverIdentities(owner, fetchFn);
  const verified = await verifyIdentities(rhcClient(), found.ids.map((id) => BigInt(id)), subject, cardUrl(site, subject));
  return verified.map((identity) => ({ agentId: Number(identity.agentId), agentRegistry: agentRegistryId(CHAIN_ID, identity.registry) }));
}

async function providerCard(subject: Address, site: string, fetchFn: typeof fetch): Promise<AgentCard | undefined> {
  const client = rhcClient();
  const registry = ADDRESSES.agentRegistry;
  const reputation = ADDRESSES.reputation;
  const [registered, agent, active, score, cap, stats] = await multicall(client, {
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address: registry, abi: agentRegistryAbi, functionName: 'isRegistered', args: [subject] },
      { address: registry, abi: agentRegistryAbi, functionName: 'getAgent', args: [subject] },
      { address: registry, abi: agentRegistryAbi, functionName: 'isActive', args: [subject] },
      { address: reputation, abi: reputationAbi, functionName: 'score', args: [subject] },
      { address: reputation, abi: reputationAbi, functionName: 'capOf', args: [subject] },
      { address: reputation, abi: reputationAbi, functionName: 'payeeStats', args: [subject] },
    ],
  });
  if (registered.status !== 'success' || registered.result !== true || agent.status !== 'success') return undefined;

  const listing = agent.result;
  const name = listing.name.trim() === '' ? `Provider ${shortAddress(subject)}` : listing.name;
  const taking = active.status === 'success' ? active.result : listing.active;
  const [released, timedOut, disputed] = stats.status === 'success' ? stats.result : [undefined, undefined, undefined];
  const desk = `${site}/providers/${subject}`;
  const record =
    released === undefined
      ? ''
      : ` Record: ${released} delivered, ${disputed} contested, ${timedOut} returned to the payer.`;
  const standing =
    score.status === 'success' && cap.status === 'success'
      ? score.result === 0n
        ? ` A payer can open jobs up to ${usd(cap.result)} USDG.`
        : ` Score ${score.result} of 100, which lets a payer open jobs up to ${usd(cap.result)} USDG.`
      : '';

  return {
    type: ERC8004_REGISTRATION_TYPE,
    name,
    description:
      `${name} is a provider on Bursar, paid by agents through escrow on Robinhood Chain. ` +
      `Listed with a ${usd(listing.stake)} USDG stake and ${taking ? 'taking work' : 'not taking work right now'}.${record}${standing} ` +
      'Feedback tagged ruling from a Bursar resolver address is a published ruling on a contested job.',
    image: `${site}/brand/mark.png`,
    services: [
      { name: 'web', endpoint: desk },
      { name: 'x402', endpoint: `${FACILITATOR}/x402/supported`, version: '2' },
    ],
    x402Support: true,
    active: taking,
    registrations: await registrationsOf(subject, subject, site, fetchFn),
    supportedTrust: ['reputation'],
    bursar: {
      role: 'provider',
      chainId: CHAIN_ID,
      address: subject,
      providerRegistry: registry,
      reputation,
      handle: listing.name,
      stake: usd(listing.stake),
      stakeAsset: 'USDG',
      active: taking,
      ...(listing.registeredAt > 0n ? { listedAt: new Date(Number(listing.registeredAt) * 1000).toISOString() } : {}),
      ...(score.status === 'success' ? { score: score.result } : {}),
      ...(cap.status === 'success' ? { largestJob: usd(cap.result) } : {}),
      ...(released === undefined ? {} : { settled: { delivered: Number(released), contested: Number(disputed), returned: Number(timedOut) } }),
      desk,
      x402: { scheme: '@bursar/x402', facilitator: FACILITATOR },
    },
  };
}

/** Every capability name this console publishes, bare and under each class it can be spent in. */
function capabilityCandidates(): readonly string[] {
  return Object.values(PUBLISHED_CAPABILITIES).flatMap((name) => [name, ...SPEND_CLASSES.map((spendClass) => `${SPEND_CLASS_INFO[spendClass].prefix}${name}`)]);
}

async function mandateCard(subject: Address, site: string, fetchFn: typeof fetch): Promise<AgentCard | undefined> {
  if ((await mandateCodeVersion(subject)) === undefined) return undefined;

  const client = rhcClient();
  const names = capabilityCandidates();
  const [principal, agent, paused, revoked, limits] = await multicall(client, {
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address: subject, abi: mandateAccountAbi, functionName: 'principal' },
      { address: subject, abi: mandateAccountAbi, functionName: 'agent' },
      { address: subject, abi: mandateAccountAbi, functionName: 'paused' },
      { address: subject, abi: mandateAccountAbi, functionName: 'revoked' },
      { address: subject, abi: mandateAccountAbi, functionName: 'limits' },
    ],
  });
  const allowed = await multicall(client, {
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: names.map((name) => ({ address: subject, abi: mandateAccountAbi, functionName: 'capabilities', args: [toCapabilityId(name)] }) as const),
  });
  if (principal.status !== 'success' || agent.status !== 'success') return undefined;

  const owner = getAddress(principal.result);
  const seated = isZeroAddress(agent.result) ? undefined : getAddress(agent.result);
  const capabilities = names.filter((_, index) => allowed[index]?.status === 'success' && allowed[index]?.result === true);
  const caps = limits.status === 'success' ? limits.result : undefined;
  const console = `${site}/console/${subject}`;
  const budget =
    caps === undefined
      ? ''
      : ` The owner set the budget: up to ${usd(caps.perCallCap)} USDG per payment, ${usd(caps.dailyCap)} per day and ${usd(caps.monthlyCap)} per month` +
        (caps.totalCap > 0n ? `, ${usd(caps.totalCap)} in all.` : '.');
  const name = `Bursar mandate ${shortAddress(subject)}`;

  return {
    type: ERC8004_REGISTRATION_TYPE,
    name,
    description:
      `An agent spending from a Bursar mandate on Robinhood Chain.${budget}` +
      ` ${seated === undefined ? 'No agent is seated, so nothing can spend from it.' : `The seated agent is ${seated}.`}` +
      ` Payments settle through Bursar's escrow in USDG${capabilities.length > 0 ? `, for ${capabilities.join(', ')}` : ''}.`,
    image: `${site}/brand/mark.png`,
    services: [{ name: 'web', endpoint: console }],
    x402Support: false,
    active: !(paused.status === 'success' && paused.result) && !(revoked.status === 'success' && revoked.result) && seated !== undefined,
    registrations: await registrationsOf(subject, owner, site, fetchFn),
    supportedTrust: ['reputation'],
    bursar: {
      role: 'mandate',
      chainId: CHAIN_ID,
      address: subject,
      owner,
      ...(seated === undefined ? {} : { agent: seated }),
      paused: paused.status === 'success' ? paused.result : undefined,
      revoked: revoked.status === 'success' ? revoked.result : undefined,
      ...(caps === undefined
        ? {}
        : {
            limits: {
              perPayment: usd(caps.perCallCap),
              daily: usd(caps.dailyCap),
              monthly: usd(caps.monthlyCap),
              ...(caps.totalCap > 0n ? { total: usd(caps.totalCap) } : {}),
              asset: 'USDG',
            },
          }),
      capabilities,
      console,
    },
  };
}
