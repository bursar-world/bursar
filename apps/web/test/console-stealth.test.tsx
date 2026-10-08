import { renderToStaticMarkup } from 'react-dom/server';
import {
  ERC5564_ANNOUNCER,
  announceArgs,
  erc5564AnnouncerAbi,
  fundsKeyTypedData,
  planStealthMandate,
  readAgentHandoff,
  viewingKeyMessage,
  writeTerms,
} from '@bursar/sdk';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import type { Address, Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { StealthToggle } from '@/app/(app)/console/new/stealth-create';
import {
  STEALTH_LIMIT_LINE,
  agentGasWei,
  agentKeyFile,
  createGasWei,
  formatEth,
  ownerKeysFrom,
  remainingSteps,
  scanOwnedMandates,
  spareForAgent,
} from '@/chain/stealth';
import { fundsKeyContext } from '@/chain/shielded';
import { addressSegment, ADDRESS_ROUTES } from '@/lib/path';

const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const FACTORY = '0xdbB3bD6172132d9049b2825C5deA18d0Bb2A30D1' as Address;
const MANDATE = '0x1A118049d8a039e58BC5DC1e692c16Fa45037aBc' as Address;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const GWEI = 1_000_000_000n;

async function keysOf(account: typeof owner) {
  const context = fundsKeyContext(account.address);
  const viewing = await account.signMessage({ message: viewingKeyMessage(account.address) });
  return ownerKeysFrom(viewing, await account.signTypedData(fundsKeyTypedData(context)), context);
}

const ownerKeys = () => keysOf(owner);

function announcementLog(plan: ReturnType<typeof planStealthMandate>, role: 'principal' | 'agent', block: bigint): Log {
  const identity = plan[role];
  const [schemeId, stealthAddress, ephemeralPubKey, metadata] = announceArgs(identity.announcement, role);
  return {
    address: ERC5564_ANNOUNCER,
    topics: encodeEventTopics({ abi: erc5564AnnouncerAbi, eventName: 'Announcement', args: { schemeId, stealthAddress, caller: plan.principal.address } }) as never,
    data: encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [ephemeralPubKey, metadata]),
    blockNumber: block,
    transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
    logIndex: 0,
    blockHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

describe('stealth gas', () => {
  it('asks for twice the create and announce gas at the current price', () => {
    expect(createGasWei(GWEI / 20n)).toBe(2_000_000n * (GWEI / 20n) * 2n);
    expect(agentGasWei(GWEI)).toBe(900_000n * 5n * GWEI * 2n);
  });

  it('passes the agent what the owner address can spare after the transfer fee and its pause reserve', () => {
    expect(spareForAgent(10n ** 15n, GWEI, 10n ** 14n)).toBe(10n ** 14n);
    expect(spareForAgent(450_000n * GWEI, GWEI, 10n ** 14n)).toBe(8_000n * GWEI);
    expect(spareForAgent(400_000n * GWEI, GWEI, 10n ** 14n)).toBe(0n);
  });

  it('prints small ETH amounts readably', () => {
    expect(formatEth(0n)).toBe('0 ETH');
    expect(formatEth(200_000_000_000_000n)).toBe('0.0002 ETH');
    expect(formatEth(123_456_789_012_345n)).toBe('0.000123 ETH');
  });
});

describe('the stealth create steps', () => {
  it('resumes from the first step not yet confirmed', () => {
    expect(remainingSteps(new Set())).toEqual(['announce-owner', 'announce-agent', 'create']);
    expect(remainingSteps(new Set(['announce-owner'] as const))).toEqual(['announce-agent', 'create']);
    expect(remainingSteps(new Set(['announce-owner', 'announce-agent', 'create'] as const))).toEqual([]);
  });

  it('states the funding limit where the option is offered, without an em dash', () => {
    const html = renderToStaticMarkup(<StealthToggle on={false} onChange={() => undefined} />);
    expect(html).toContain('Hide the owner and the agent.');
    expect(html).toContain(STEALTH_LIMIT_LINE.replace(/'/g, '&#x27;'));
    expect(html).not.toContain('—');
  });

  it('keeps /console/private off the mandate-address route', () => {
    const consoleRoute = ADDRESS_ROUTES.find((route) => route.prefix === 'console');
    expect(consoleRoute && addressSegment('/console/private', consoleRoute)).toBeUndefined();
  });
});

describe('recovering private mandates', () => {
  it('finds the owner’s mandate and agent from announcements and reads its state', async () => {
    const keys = await ownerKeys();
    const plan = planStealthMandate(keys.stealth);
    const stranger = planStealthMandate((await keysOf(privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'))).stealth);
    const logs = [announcementLog(stranger, 'principal', 10n), announcementLog(plan, 'principal', 20n), announcementLog(plan, 'agent', 21n)];

    const client = {
      getBlockNumber: async () => 100n,
      getLogs: async () => logs,
      getBalance: async ({ address }: { address: Address }) => (address === plan.principal.address ? 7n : 3n),
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        switch (functionName) {
          case 'accountsOf':
            return args?.[0] === plan.principal.address ? [MANDATE] : [];
          case 'agent':
            return plan.agent.address;
          case 'settlementAsset':
            return USDG;
          case 'paused':
            return true;
          case 'revoked':
            return false;
          case 'version':
            return 2n;
          case 'termsCommitment':
            return 99n;
          case 'balanceOf':
            return 20_000n;
          default:
            throw new Error(functionName);
        }
      },
    };

    const found = await scanOwnedMandates({ keys: keys.stealth, factories: [FACTORY], fromBlock: 0n, client: client as never });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ mandate: MANDATE, balance: 20_000n, paused: true, revoked: false, version: 2n, termsCommitment: 99n, ownerGas: 7n, agentGas: 3n });
    expect(found[0]?.principal.privateKey).toBe(plan.principal.privateKey);
    expect(found[0]?.agentMatch?.privateKey).toBe(plan.agent.privateKey);
  });

  it('exports an agent key file the agent runtime accepts', async () => {
    const plan = planStealthMandate((await ownerKeys()).stealth);
    const terms = writeTerms({
      perCallCap: 10_000n,
      periodCap: 20_000n,
      periodLen: 86_400,
      totalCap: 20_000n,
      capabilities: ['service:gpu.render:1'],
      counterparties: ['0x5210D8df060A9D5ce4c1305045ED5c9548fca374'],
      expiry: 1_893_456_000,
    });
    const file = await agentKeyFile({ mandate: MANDATE, privateKey: plan.agent.privateKey, terms, fromBlock: 75_627_494n });
    expect(file.name).toBe('bursar-agent-key-1a118049.json');
    const read = readAgentHandoff(file.body);
    expect(read).toMatchObject({ chainId: 4663, mandate: MANDATE, agent: plan.agent.address, fromBlock: 75_627_494 });
  });
});

describe('the funds key', () => {
  it('is bound to the wallet and this chain, names no contract, and refuses the viewing-key signature', async () => {
    const context = fundsKeyContext(owner.address);
    expect(context).toEqual({ account: owner.address, chainId: 4663 });
    expect(fundsKeyTypedData(context).domain).not.toHaveProperty('verifyingContract');
    const viewing = await owner.signMessage({ message: viewingKeyMessage(owner.address) });
    await expect(ownerKeysFrom(viewing, viewing, context)).rejects.toThrow(/funds-key signature/);
  });
});
