import { BURSAR_SUBJECT_KEY, agentRegistryId, cardRegistrations, identityRegistryAbi, openseaAgentUrl, scanAgentUrl } from '@bursar/core';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import type { Address, TransactionReceipt } from 'viem';
import { describe, expect, it } from 'vitest';

import { REGISTER_WITH_METADATA_ABI, REGISTRIES, SET_AGENT_URI_ABI, cardUrl, registeredIds, registrationArgs } from '@/chain/erc8004';
import { CHAIN_ID } from '@/chain/rhc';

/**
 * What a registration writes and how its receipt is read. The registry is the standard's own, so
 * the shape of the call and the event are not this product's to choose; these pin what is sent to
 * what the contract takes, and the reading of the receipt to the registry's address only.
 */
const SUBJECT = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as Address;
const SITE = 'https://app.bursar.world';

describe('the registries on this chain', () => {
  it('are the standard deployments and name the two explorers', () => {
    expect(REGISTRIES?.identity).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(REGISTRIES?.reputation).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    expect(REGISTRIES?.validation).toBeUndefined();
    expect(scanAgentUrl(CHAIN_ID, 8623n)).toBe('https://www.8004scan.io/agents/robinhood-chain/8623');
    expect(openseaAgentUrl(CHAIN_ID, 8623n)).toBe('https://opensea.io/item/robinhood/0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/8623');
    expect(agentRegistryId(CHAIN_ID, REGISTRIES?.identity as Address)).toBe('eip155:4663:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432');
  });
});

describe('a registration', () => {
  it('points at the card and names the subject in metadata', () => {
    const card = cardUrl(`${SITE}/`, SUBJECT.toLowerCase() as Address);
    expect(card).toBe(`${SITE}/agents/${SUBJECT}/card.json`);

    const [uri, metadata] = registrationArgs(SUBJECT, card);
    expect(uri).toBe(card);
    expect(metadata).toEqual([{ metadataKey: BURSAR_SUBJECT_KEY, metadataValue: SUBJECT }]);
  });

  it('is sent to the register overload that takes metadata, and the re-point to setAgentURI', () => {
    expect(REGISTER_WITH_METADATA_ABI[0].name).toBe('register');
    expect(REGISTER_WITH_METADATA_ABI[0].inputs.map((input) => input.type)).toEqual(['string', 'tuple[]']);
    expect(SET_AGENT_URI_ABI[0].name).toBe('setAgentURI');
  });

  it('reads the minted id from the registry event in the receipt and from no other contract', () => {
    const registry = REGISTRIES?.identity as Address;
    const log = (address: Address, agentId: bigint) => ({
      address,
      topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: 'Registered', args: { agentId, owner: SUBJECT } }),
      data: encodeAbiParameters([{ type: 'string' }], ['https://example.invalid/card.json']),
      blockNumber: 1n,
      transactionHash: `0x${'1'.repeat(64)}`,
      logIndex: 0,
      transactionIndex: 0,
      blockHash: `0x${'2'.repeat(64)}`,
      removed: false,
    });
    const receipt = { logs: [log('0x1111111111111111111111111111111111111111', 5n), log(registry, 9n)] } as unknown as TransactionReceipt;

    expect(registeredIds(receipt)).toEqual([9n]);
  });
});

describe('a card from somebody else', () => {
  it('yields only the ids registered on the named registry', () => {
    const registry = agentRegistryId(CHAIN_ID, REGISTRIES?.identity as Address);
    const body = {
      registrations: [
        { agentId: 12, agentRegistry: registry.toUpperCase() },
        { agentId: '13', agentRegistry: registry },
        { agentId: 14, agentRegistry: 'eip155:8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432' },
        { agentId: -1, agentRegistry: registry },
        'junk',
      ],
    };
    expect(cardRegistrations(body, registry)).toEqual([12n, 13n]);
    expect(cardRegistrations(null, registry)).toEqual([]);
    expect(cardRegistrations({ registrations: 'no' }, registry)).toEqual([]);
  });
});
