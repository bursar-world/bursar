import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  ERC5564_ANNOUNCER,
  FundsKeySignatureError,
  InvalidArgumentError,
  announceArgs,
  agentHandoff,
  checkStealthAddress,
  computeStealthKey,
  deriveSpendingKey,
  deriveStealthKeys,
  deriveViewingKey,
  erc5564AnnouncerAbi,
  fetchAnnouncements,
  fundsKeyTypedData,
  generateStealthAddress,
  parseMetaAddress,
  planStealthMandate,
  readAgentHandoff,
  recoverStealthMandates,
  registerKeysArgs,
  scanAnnouncements,
  viewingKeyMessage,
  viewingKeyOfMetaAddress,
  writeTerms,
  type Announcement,
  type GeneratedStealthAddress,
  type StealthRole,
} from '../src/index.js';

// The scheme-1 vectors below were produced by the reference implementation,
// @scopelift/stealth-address-sdk 1.0.0-beta.2 (generateStealthAddress and computeStealthKey), from
// the meta-address and private keys in its own test suite.
const REFERENCE = {
  meta: 'st:eth:0x033404e82cd2a92321d51e13064ec13a0fb0192a9fdaaca1cfb47b37bd27ec13970390ad5eca026c05ab5cf4d620a2ac65241b11df004ddca360e954db1b26e3846e',
  spendingPrivateKey: '0x0363721eb9e981558c748b824cb32a840da2b3e8957c2fc3bcb8d9c86cb87456' as Hex,
  viewingPrivateKey: '0xb52a0555f6a8663d89f00365893b1ef9e38eaf2e8bc48a63319c9ea5cb4a27c5' as Hex,
  cases: [
    {
      ephemeralPrivateKey: '0x0000000000000000000000000000000000000000000000000000000000000007' as Hex,
      stealthAddress: '0xB72602b15D0031462E19f9c93C7F0B80ee6f633a',
      ephemeralPublicKey: '0x025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc',
      viewTag: 0x37,
      stealthKey: '0x3a9c6f1627ef0f7efc1670032b1a046bc2f15c6e94da3e817e12029f2e4f3fa9',
    },
    {
      ephemeralPrivateKey: '0x5ab3c1a24e4c1c8a1b9f1e8b0f7a39f2d0e1c2b3a4958677685a4b3c2d1e0f11' as Hex,
      stealthAddress: '0xbDDD1838dF9e00de82044A67D67c0816eDC425D4',
      ephemeralPublicKey: '0x029876d10f0f2e049d981666fe89900368be18180cd75721fed7952c3dd4b29fb0',
      viewTag: 0xec,
      stealthKey: '0xefad56692cb036de192ac886aae6a35d3a4993e7fd08ee19e95ef4279bc988e6',
    },
  ],
} as const;

const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const stranger = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const FACTORY = '0xdbB3bD6172132d9049b2825C5deA18d0Bb2A30D1' as const;
const MANDATE = '0x1A118049d8a039e58BC5DC1e692c16Fa45037aBc' as const;
const POOL = '0x9F9914dd397a9e9462Dd7cB6891Ab835119297C7' as const;

const contextOf = (account: typeof owner) => ({ account: account.address, chainId: 4663, pool: POOL });

async function signaturesOf(account: typeof owner) {
  return {
    viewing: await account.signMessage({ message: viewingKeyMessage(account.address) }),
    funds: await account.signTypedData(fundsKeyTypedData(contextOf(account))),
  };
}

async function keysOf(account: typeof owner) {
  const { viewing, funds } = await signaturesOf(account);
  return deriveStealthKeys(viewing, funds, contextOf(account));
}

function announced(generated: GeneratedStealthAddress, role: StealthRole, caller: Address, blockNumber = 1n): Announcement {
  const [schemeId, stealthAddress, ephemeralPublicKey, metadata] = announceArgs(generated, role);
  return { schemeId, stealthAddress, caller, ephemeralPublicKey, metadata, blockNumber, transactionHash: `0x${'00'.repeat(32)}`, logIndex: 0 };
}

describe('ERC-5564 scheme 1 against the reference implementation', () => {
  it('reads the meta-address into the keys of its private halves', () => {
    const keys = parseMetaAddress(REFERENCE.meta);
    expect(keys.spendingPublicKey).toBe(bytesToHex(secp256k1.getPublicKey(REFERENCE.spendingPrivateKey.slice(2), true)));
    expect(keys.viewingPublicKey).toBe(bytesToHex(secp256k1.getPublicKey(REFERENCE.viewingPrivateKey.slice(2), true)));
  });

  for (const vector of REFERENCE.cases) {
    it(`generates ${vector.stealthAddress} and its key`, () => {
      const generated = generateStealthAddress(REFERENCE.meta, { ephemeralPrivateKey: vector.ephemeralPrivateKey });
      expect(generated).toEqual({ stealthAddress: vector.stealthAddress, ephemeralPublicKey: vector.ephemeralPublicKey, viewTag: vector.viewTag });

      const key = computeStealthKey({
        ephemeralPublicKey: vector.ephemeralPublicKey,
        viewingPrivateKey: REFERENCE.viewingPrivateKey,
        spendingPrivateKey: REFERENCE.spendingPrivateKey,
      });
      expect(key).toBe(vector.stealthKey);
      expect(privateKeyToAccount(key).address).toBe(vector.stealthAddress);

      const { spendingPublicKey } = parseMetaAddress(REFERENCE.meta);
      const check = { ephemeralPublicKey: vector.ephemeralPublicKey, stealthAddress: vector.stealthAddress, viewingPrivateKey: REFERENCE.viewingPrivateKey, spendingPublicKey };
      expect(checkStealthAddress({ ...check, viewTag: vector.viewTag })).toBe(true);
      expect(checkStealthAddress({ ...check, viewTag: (vector.viewTag + 1) & 0xff })).toBe(false);
    });
  }

  it('accepts the bare hex and a single-key meta-address, and refuses anything else', () => {
    const hex = REFERENCE.meta.slice('st:eth:'.length);
    expect(parseMetaAddress(hex)).toEqual(parseMetaAddress(REFERENCE.meta));
    const single = parseMetaAddress(`st:eth:${hex.slice(0, 68)}`);
    expect(single.viewingPublicKey).toBe(single.spendingPublicKey);
    expect(() => parseMetaAddress('st:eth:0x1234')).toThrow(InvalidArgumentError);
    expect(() => parseMetaAddress(`0x04${hex.slice(4)}`)).toThrow(InvalidArgumentError);
  });

  it('draws a different address every time without a fixed ephemeral key', () => {
    const a = generateStealthAddress(REFERENCE.meta);
    const b = generateStealthAddress(REFERENCE.meta);
    expect(a.stealthAddress).not.toBe(b.stealthAddress);
  });
});

describe('the owner’s stealth keys', () => {
  it('take the viewing half from the viewing-key signature and the spending half from the funds key', async () => {
    const { viewing, funds } = await signaturesOf(owner);
    const keys = deriveStealthKeys(viewing, funds, contextOf(owner));
    expect(keys).toEqual(deriveStealthKeys(viewing, funds, contextOf(owner)));
    expect(keys.viewingPrivateKey).toBe(deriveViewingKey(viewing).privateKey);
    expect(keys.spendingPrivateKey).toBe(deriveSpendingKey(funds, contextOf(owner)).privateKey);
    expect(keys.spendingPrivateKey).not.toBe(keys.viewingPrivateKey);
    expect(viewingKeyOfMetaAddress(keys.metaAddress)).toBe(keys.viewingPublicKey);
    expect(registerKeysArgs(keys.metaAddress)).toEqual([1n, keys.metaAddress]);
    expect((await keysOf(stranger)).metaAddress).not.toBe(keys.metaAddress);
  });

  it('refuse a spending key from any signature that is not this wallet’s funds key for this chain and pool', async () => {
    const context = contextOf(owner);
    const { viewing } = await signaturesOf(owner);
    const refusals = [
      // The viewing-key signature: it reads, it must never spend.
      viewing,
      // Another wallet signing the owner's request.
      await stranger.signTypedData(fundsKeyTypedData(context)),
      // The owner's funds key for another pool, and for another chain.
      await owner.signTypedData(fundsKeyTypedData({ ...context, pool: MANDATE })),
      await owner.signTypedData(fundsKeyTypedData({ ...context, chainId: 1 })),
      // Bytes that are not a signature.
      `0x${'ab'.repeat(65)}` as Hex,
      '0x1234' as Hex,
    ];
    for (const signature of refusals) {
      expect(() => deriveSpendingKey(signature, context)).toThrow(FundsKeySignatureError);
      expect(() => deriveStealthKeys(viewing, signature, context)).toThrow(FundsKeySignatureError);
    }
  });

  it('say in the typed data itself that the signature controls funds', () => {
    const request = fundsKeyTypedData(contextOf(owner));
    expect(request.primaryType).toBe('KeyThatControlsFunds');
    expect(request.message.warning).toMatch(/^This signature controls funds\./);
    expect(request.domain).toEqual({ name: 'Bursar', version: '1', chainId: 4663, verifyingContract: POOL });
    expect(request.message.wallet).toBe(owner.address);
  });
});

describe('announce and scan', () => {
  it('finds exactly the owner’s principal and agent, with their keys, among foreign announcements', async () => {
    const keys = await keysOf(owner);
    const plan = planStealthMandate(keys);
    expect(plan.principal.address).not.toBe(plan.agent.address);
    expect(privateKeyToAccount(plan.principal.privateKey).address).toBe(plan.principal.address);
    expect(privateKeyToAccount(plan.agent.privateKey).address).toBe(plan.agent.address);

    const foreign = planStealthMandate(await keysOf(stranger));
    const log = [
      announced(foreign.principal.announcement, 'principal', foreign.principal.address),
      announced(plan.principal.announcement, 'principal', plan.principal.address),
      announced(plan.agent.announcement, 'agent', plan.principal.address),
      announced(foreign.agent.announcement, 'agent', foreign.principal.address),
      ...Array.from({ length: 40 }, () => announced(generateStealthAddress(REFERENCE.meta), 'agent', stranger.address)),
    ];

    const found = scanAnnouncements(log, keys);
    expect(found.map((m) => [m.role, m.stealthAddress, m.privateKey])).toEqual([
      ['principal', plan.principal.address, plan.principal.privateKey],
      ['agent', plan.agent.address, plan.agent.privateKey],
    ]);

    const viewOnly = scanAnnouncements(log, { viewingPrivateKey: keys.viewingPrivateKey, spendingPublicKey: keys.spendingPublicKey });
    expect(viewOnly.map((m) => m.stealthAddress)).toEqual([plan.principal.address, plan.agent.address]);
    expect(viewOnly.every((m) => m.privateKey === undefined)).toBe(true);
  });

  it('skips announcements whose ephemeral key or metadata is malformed', async () => {
    const keys = await keysOf(owner);
    const good = announced(planStealthMandate(keys).principal.announcement, 'principal', owner.address);
    const found = scanAnnouncements(
      [
        { ...good, metadata: '0x' },
        { ...good, ephemeralPublicKey: '0x02' },
        { ...good, ephemeralPublicKey: `0x02${'ff'.repeat(32)}` },
        good,
      ],
      keys,
    );
    expect(found).toHaveLength(1);
  });

  it('pages the log query and halves a range the endpoint refuses', async () => {
    const keys = await keysOf(owner);
    const plan = planStealthMandate(keys);
    const [schemeId, stealthAddress, ephemeralPubKey, metadata] = announceArgs(plan.agent.announcement, 'agent');
    const raw: Log = {
      address: ERC5564_ANNOUNCER,
      topics: encodeEventTopics({ abi: erc5564AnnouncerAbi, eventName: 'Announcement', args: { schemeId, stealthAddress, caller: plan.principal.address } }) as never,
      data: encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [ephemeralPubKey, metadata]),
      blockNumber: 1_500n,
      transactionHash: `0x${'11'.repeat(32)}`,
      logIndex: 3,
      blockHash: `0x${'22'.repeat(32)}`,
      transactionIndex: 0,
      removed: false,
    };
    const ranges: Array<[bigint, bigint]> = [];
    const client = {
      getBlockNumber: async () => 9_999n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (toBlock - fromBlock >= 2_500n) throw new Error('range too wide');
        ranges.push([fromBlock, toBlock]);
        return fromBlock <= 1_500n && 1_500n <= toBlock ? [raw] : [];
      },
    };
    const found = await fetchAnnouncements(client as never, { fromBlock: 0n, chunk: 10_000n });
    expect(ranges[0]).toEqual([0n, 2_499n]);
    expect(ranges.at(-1)?.[1]).toBe(9_999n);
    expect(found).toHaveLength(1);
    expect(scanAnnouncements(found, keys)[0]?.privateKey).toBe(plan.agent.privateKey);
  });
});

describe('recovery', () => {
  it('rebuilds the owner’s mandates and agents from announcements and the factory list', async () => {
    const keys = await keysOf(owner);
    const plan = planStealthMandate(keys);
    const unused = planStealthMandate(keys);
    const matches = scanAnnouncements(
      [
        announced(plan.principal.announcement, 'principal', plan.principal.address),
        announced(plan.agent.announcement, 'agent', plan.principal.address),
        announced(unused.principal.announcement, 'principal', unused.principal.address),
      ],
      keys,
    );
    const client = {
      readContract: async ({ functionName, args, address }: { functionName: string; args?: readonly unknown[]; address: Address }) => {
        if (functionName === 'accountsOf') return args?.[0] === plan.principal.address && address === FACTORY ? [MANDATE] : [];
        if (functionName === 'agent') return plan.agent.address;
        throw new Error(functionName);
      },
    };
    const recovered = await recoverStealthMandates(client as never, matches, [FACTORY]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.mandate).toBe(MANDATE);
    expect(recovered[0]?.principal.privateKey).toBe(plan.principal.privateKey);
    expect(recovered[0]?.agentMatch?.privateKey).toBe(plan.agent.privateKey);
  });
});

describe('agent key hand-off', () => {
  const terms = writeTerms({
    perCallCap: 10_000n,
    periodCap: 20_000n,
    periodLen: 86_400,
    totalCap: 20_000n,
    capabilities: ['service:gpu.render:1'],
    counterparties: ['0x5210D8df060A9D5ce4c1305045ED5c9548fca374'],
    expiry: 1_893_456_000,
  });

  it('round-trips through JSON and names the agent the key belongs to', async () => {
    const plan = planStealthMandate(await keysOf(owner));
    const file = JSON.stringify(agentHandoff({ chainId: 4663, mandate: MANDATE, privateKey: plan.agent.privateKey, terms, fromBlock: 75_627_494n }));
    const read = readAgentHandoff(file);
    expect(read.agent).toBe(plan.agent.address);
    expect(read.terms).toEqual(terms);
    expect(read.fromBlock).toBe(75_627_494);
  });

  it('refuses a file whose key is not the agent it names, or that is not a hand-off at all', async () => {
    const plan = planStealthMandate(await keysOf(owner));
    const handoff = agentHandoff({ chainId: 4663, mandate: MANDATE, privateKey: plan.agent.privateKey, terms, fromBlock: 1 });
    expect(() => readAgentHandoff({ ...handoff, agent: plan.principal.address })).toThrow(/not the agent/);
    expect(() => readAgentHandoff({ ...handoff, kind: 'other' })).toThrow(InvalidArgumentError);
    expect(() => readAgentHandoff('{')).toThrow(InvalidArgumentError);
    expect(() => readAgentHandoff({ ...handoff, terms: {} })).toThrow(/no usable terms/);
    expect(() => readAgentHandoff({ ...handoff, terms: { ...terms, v: 1 } })).toThrow(/no usable terms/);
    expect(() => readAgentHandoff({ ...handoff, terms: { ...terms, capabilities: ['rwa:SPY'] } })).toThrow(/no usable terms/);
  });
});
