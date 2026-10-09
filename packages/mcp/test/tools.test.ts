import {
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  encodeErrorResult,
  encodeFunctionData,
} from 'viem';
import type { Address, Hex } from 'viem';
import { mandateAccountAbi } from '@bursar/core';
import { describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { refusalForName } from '../src/reasons.js';
import { TOOLS, callTool, redactSecrets, toolsFor } from '../src/tools.js';
import type { ToolContext, ToolResult } from '../src/tools.js';
import { PROVIDER, createFakeGateway } from './fakes.js';
import type { FakeGateway } from './fakes.js';

const RELAY_TOKEN = 'relay-token-0123456789';

/** Every role signs, or none does. Which roles a real server can sign for is server.test.ts. */
function signing(canSign: boolean): ToolContext['canSign'] {
  return { mandate: canSign, resolver: canSign, provider: canSign };
}

function contextFor(fake: FakeGateway, canSign = true): ToolContext {
  return {
    gateway: fake.gateway,
    resolver: null,
    provider: null,
    secrets: [RELAY_TOKEN],
    canSign: signing(canSign),
  };
}

function payArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: PROVIDER,
    capability: 'search.web:1',
    input: { city: 'Paris' },
    amount: '1000000',
    deliverWithinSeconds: 300,
    ...overrides,
  };
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.text) as Record<string, unknown>;
}

const ACCOUNT: Address = '0x00000000000000000000000000000000000acc01';
const CAPABILITY_ID: Hex = `0x${'11'.repeat(32)}`;
const CALLDATA = encodeFunctionData({
  abi: mandateAccountAbi,
  functionName: 'previewSpend',
  args: [ACCOUNT, CAPABILITY_ID, 1_000_000n, 0],
});

/** What a read against an address holding no mandate account throws, in full. */
function viemZeroData(): Error {
  return new ContractFunctionExecutionError(
    new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {
      data: CALLDATA,
      to: ACCOUNT,
    }),
    {
      abi: mandateAccountAbi,
      contractAddress: ACCOUNT,
      functionName: 'previewSpend',
      args: [ACCOUNT, CAPABILITY_ID, 1_000_000n, 0],
      docsPath: '/docs/contract/readContract',
    },
  );
}

/** The same error, carried by a copy of viem whose classes this package cannot match on. */
function foreignViemError(): Error {
  return Object.assign(new Error(viemZeroData().message), {
    name: 'ContractFunctionExecutionError',
    shortMessage: 'Execution reverted for an unknown reason.',
  });
}

/** A refusal wrapped the way a second copy of viem wraps it: right shape, wrong class. */
function foreignRevert(errorName: string): Error {
  const reverted = Object.assign(new Error(`The contract function "spend" reverted.\n\n${viemZeroData().message}`), {
    name: 'ContractFunctionRevertedError',
    shortMessage: 'The contract function "spend" reverted.',
    data: { errorName, args: [] },
  });

  return Object.assign(new Error(viemZeroData().message), {
    name: 'ContractFunctionExecutionError',
    shortMessage: 'The contract function "spend" reverted.',
    cause: reverted,
  });
}

describe('the advertised tools', () => {
  it('covers the loop an agent has to close on its own', () => {
    expect(TOOLS.filter((tool) => tool.role === 'mandate').map((tool) => tool.name)).toEqual([
      'mandate_inspect',
      'mandate_quote_spend',
      'mandate_pay_provider',
      'mandate_buy_stock',
      'mandate_list_settlements',
      'mandate_get_settlement',
      'mandate_open_dispute',
      'mandate_hire_agent',
      'mandate_get_dispute',
    ]);
  });

  /**
   * A resolver that cannot rule and a provider that cannot list are the two roles the product had
   * a surface for and no client. Every verb each of them needs is here or neither can run headless.
   */
  it('covers the whole lifecycle for a resolver and for a provider', () => {
    expect(TOOLS.filter((tool) => tool.role === 'resolver').map((tool) => tool.name)).toEqual([
      'resolver_status',
      'resolver_list_disputes',
      'resolver_post_bond',
      'resolver_add_bond',
      'resolver_commit_score',
      'resolver_reveal_score',
      'resolver_finalize_dispute',
      'resolver_fail_dispute',
      'resolver_claim_rewards',
      'resolver_request_unbond',
      'resolver_complete_unbond',
      'resolver_cancel_unbond',
    ]);

    expect(TOOLS.filter((tool) => tool.role === 'provider').map((tool) => tool.name)).toEqual([
      'provider_status',
      'provider_reputation',
      'provider_register',
      'provider_add_stake',
      'provider_request_withdrawal',
      'provider_execute_withdrawal',
      'provider_cancel_withdrawal',
      'provider_deactivate',
      'provider_reactivate',
    ]);
  });

  it('says plainly that an above-threshold spend needs the principal', () => {
    const pay = TOOLS.find((tool) => tool.name === 'mandate_pay_provider');

    expect(pay?.description).toContain('approval the principal signed');
    expect(pay?.description).toContain('There is no credit line here.');
  });

  it('states the consequence of opening a dispute before an agent opens one', () => {
    const dispute = TOOLS.find((tool) => tool.name === 'mandate_open_dispute');

    expect(dispute?.description).toContain('posts a bond');
    expect(dispute?.description).toContain('comes back only if');
  });

  it('describes every argument it accepts', () => {
    for (const tool of TOOLS) {
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(`${tool.name}.${name}: ${property.description ?? ''}`.length).toBeGreaterThan(
          `${tool.name}.${name}: `.length,
        );
      }
    }
  });

  it('hides the tools that spend when there is no signer to send them to', () => {
    const advertised = toolsFor(contextFor(createFakeGateway(), false)).map((tool) => tool.name);

    expect(advertised).not.toContain('mandate_pay_provider');
    expect(advertised).not.toContain('mandate_open_dispute');
    expect(advertised).not.toContain('mandate_hire_agent');
    expect(advertised).toContain('mandate_quote_spend');
    expect(advertised).toContain('mandate_get_dispute');
  });

  /** A server bound to one role must not advertise another role's tools as though it served them. */
  it('offers only the roles this server was configured for', () => {
    const advertised = toolsFor(contextFor(createFakeGateway())).map((tool) => tool.name);

    expect(advertised.every((name) => name.startsWith('mandate_'))).toBe(true);
  });

  it('advertises plain json schema, without the annotations this server keeps for itself', () => {
    const quote = toolsFor(contextFor(createFakeGateway())).find((tool) => tool.name === 'mandate_quote_spend');

    expect(JSON.stringify(quote?.inputSchema)).not.toContain('patternMessage');
    expect(JSON.stringify(quote?.inputSchema)).not.toContain('patternHints');
    expect(quote?.inputSchema.required).toEqual(['provider', 'capability', 'amount']);
  });
});

describe('mandate_quote_spend', () => {
  it('passes the amount through as atomic units', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web:1',
      amount: '1000000',
    });

    expect(fake.quotes[0]).toEqual({ provider: PROVIDER, capability: 'search.web:1', amount: 1_000_000n });
    expect(parse(result)['allowed']).toBe(true);
  });

  it('teaches the unit rather than repeating the regex', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web:1',
      amount: '1.50',
    });

    expect(parse(result)['message']).toContain('six-decimal atomic units');
    expect(fake.quotes).toHaveLength(0);
  });

  it('tells a caller who sent a negative amount what is wrong with it', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web:1',
      amount: '-500000',
    });

    const message = String(parse(result)['message']);

    expect(message).toContain('amount counts up from 1 and cannot be negative');
    expect(message).not.toMatch(/decimal point/iu);
    expect(fake.quotes).toHaveLength(0);
  });

  it('shows the conversion when the amount carries a separator', async () => {
    const result = await callTool(contextFor(createFakeGateway()), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web:1',
      amount: '1.50',
    });

    expect(String(parse(result)['message'])).toContain('Write 1.50 USDG as "1500000"');
  });

  it('takes a class-namespaced capability and the class to quote a bare one under', async () => {
    const fake = createFakeGateway();

    await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'hire:research.summarize:1',
      amount: '1000000',
    });
    await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'research.summarize:1',
      amount: '1000000',
      spendClass: 'hire',
    });

    expect(fake.quotes).toEqual([
      { provider: PROVIDER, capability: 'hire:research.summarize:1', amount: 1_000_000n },
      { provider: PROVIDER, capability: 'research.summarize:1', amount: 1_000_000n, spendClass: 'hire' },
    ]);
  });

  it('rejects a spend class it does not know', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web:1',
      amount: '1000000',
      spendClass: 'loan',
    });

    expect(result.isError).toBe(true);
    expect(String(parse(result)['message'])).toContain('spendClass must be "service" or "hire"');
    expect(fake.quotes).toHaveLength(0);
  });

  it('rejects a capability without a version', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web',
      amount: '1000000',
    });

    expect(result.isError).toBe(true);
    expect(fake.quotes).toHaveLength(0);
  });

  it.each(['0', '340282366920938463463374607431768211456'])('rejects the amount %s', async (amount) => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web:1',
      amount,
    });

    expect(result.isError).toBe(true);
    expect(fake.quotes).toHaveLength(0);
  });

  it('names the argument a caller left out', async () => {
    const result = await callTool(contextFor(createFakeGateway()), 'mandate_quote_spend', {
      provider: PROVIDER,
      capability: 'search.web:1',
    });

    expect(parse(result)).toEqual({ error: 'invalid_arguments', message: 'amount is required' });
  });
});

describe('mandate_pay_provider', () => {
  it('forwards the order as the gateway expects it', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_pay_provider', payArgs());

    expect(fake.orders[0]).toEqual({
      provider: PROVIDER,
      capability: 'search.web:1',
      input: { city: 'Paris' },
      amount: 1_000_000n,
      ttlSeconds: 300,
      providerProof: [],
      approval: null,
    });
    expect(parse(result)['settlementId']).toBe('42');
  });

  it('carries an approval through unchanged', async () => {
    const fake = createFakeGateway();

    await callTool(
      contextFor(fake),
      'mandate_pay_provider',
      payArgs({
        approval: { approvalId: `0x${'77'.repeat(32)}`, amount: '25000000', expiry: 1_800_001_000 },
      }),
    );

    expect(fake.orders[0]?.approval).toEqual({
      approvalId: `0x${'77'.repeat(32)}`,
      amount: 25_000_000n,
      expiry: 1_800_001_000,
      signature: null,
    });
  });

  it('rejects an approval with no id', async () => {
    const fake = createFakeGateway();

    const result = await callTool(
      contextFor(fake),
      'mandate_pay_provider',
      payArgs({ approval: { amount: '25000000', expiry: 1_800_001_000 } }),
    );

    expect(parse(result)['message']).toBe('approvalId is required');
    expect(fake.orders).toHaveLength(0);
  });

  it('names the approval ceiling when that is the negative amount', async () => {
    const fake = createFakeGateway();

    const result = await callTool(
      contextFor(fake),
      'mandate_pay_provider',
      payArgs({ approval: { approvalId: `0x${'11'.repeat(32)}`, amount: '-1', expiry: 1_900_000_000 } }),
    );

    expect(String(parse(result)['message'])).toContain('approval.amount counts up from 1 and cannot be negative');
    expect(fake.orders).toHaveLength(0);
  });

  it('rejects a proof node that is not 32 bytes', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_pay_provider', payArgs({ providerProof: ['0x1234'] }));

    expect(result.isError).toBe(true);
    expect(fake.orders).toHaveLength(0);
  });

  it('rejects a fractional delivery window', async () => {
    const fake = createFakeGateway();

    const result = await callTool(
      contextFor(fake),
      'mandate_pay_provider',
      payArgs({ deliverWithinSeconds: 300.5 }),
    );

    expect(parse(result)['message']).toBe('deliverWithinSeconds must be a whole number');
    expect(fake.orders).toHaveLength(0);
  });

  it('refuses to spend when this server has no signer, and says which variable is missing', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake, false), 'mandate_pay_provider', payArgs());

    expect(parse(result)).toMatchObject({ error: 'relay_unconfigured' });
    expect(parse(result)['message']).toContain('BURSAR_RELAY_URL');
    expect(fake.orders).toHaveLength(0);
  });
});

describe('settlements', () => {
  it('defaults the page size and reads the cursor', async () => {
    const fake = createFakeGateway();

    await callTool(contextFor(fake), 'mandate_list_settlements', {});
    await callTool(contextFor(fake), 'mandate_list_settlements', { limit: 3, beforeBlock: '61539000' });

    expect(fake.queries).toEqual([
      { limit: 10, beforeBlock: null },
      { limit: 3, beforeBlock: 61_539_000n },
    ]);
  });

  it('reads a settlement by id, sent either as text or as a number', async () => {
    const fake = createFakeGateway();

    await callTool(contextFor(fake), 'mandate_get_settlement', { settlementId: '42' });
    await callTool(contextFor(fake), 'mandate_get_settlement', { settlementId: 42 });

    expect(fake.reads).toEqual([42n, 42n]);
  });

  it.each([0, '0', 'abc', '1.5', null])('rejects the settlement id %p', async (settlementId) => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_get_settlement', { settlementId });

    expect(result.isError).toBe(true);
    expect(fake.reads).toHaveLength(0);
  });

  it('rejects a settlement id no uint256 can hold, as an argument error', async () => {
    const fake = createFakeGateway();

    const result = await callTool(contextFor(fake), 'mandate_get_settlement', { settlementId: (2n ** 256n).toString() });

    expect(parse(result)).toMatchObject({ error: 'invalid_arguments' });
    expect(fake.reads).toHaveLength(0);
  });

  it('routes a dispute to the dispute path and nowhere else', async () => {
    const fake = createFakeGateway();

    await callTool(contextFor(fake), 'mandate_open_dispute', { settlementId: '7' });

    expect(fake.disputes).toEqual([7n]);
    expect(fake.reads).toHaveLength(0);
  });
});

describe('failures', () => {
  it('translates a contract refusal into the sentence a quote would have given', async () => {
    const fake = createFakeGateway({
      failure: new ContractFunctionRevertedError({
        abi: mandateAccountAbi,
        data: encodeErrorResult({ abi: mandateAccountAbi, errorName: 'DailyCapExceeded' }),
        functionName: 'spend',
      }),
    });

    const result = await callTool(contextFor(fake), 'mandate_pay_provider', payArgs());

    expect(parse(result)).toEqual({
      error: 'mandate_refused',
      message: 'The daily budget does not have room for this spend. It refills at the next daily reset.',
      detail: { revert: 'DailyCapExceeded' },
    });
  });

  it('carries no stack trace out of the process', async () => {
    const fake = createFakeGateway({ failure: new Error('connect ECONNREFUSED 127.0.0.1:8545') });

    const result = await callTool(contextFor(fake), 'mandate_inspect', {});

    expect(Object.keys(parse(result))).toEqual(['error', 'message']);
    expect(result.text).not.toMatch(/\bat \S+:\d+/u);
  });

  it('writes the library failure it withheld to the operator log', async () => {
    const lines: string[] = [];
    const fake = createFakeGateway({ failure: new Error('connect ECONNREFUSED 127.0.0.1:8545') });

    await callTool({ ...contextFor(fake), report: (line) => lines.push(line) }, 'mandate_inspect', {});

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ECONNREFUSED');
    expect(lines[0]).toContain('"tool":"mandate_inspect"');
  });

  it('does not ask for a retry when the configured address holds no contract', async () => {
    const empty = Object.assign(new Error('The contract function "limits" returned no data ("0x").'), {
      name: 'ContractFunctionZeroDataError',
      shortMessage: 'The contract function "limits" returned no data ("0x").',
    });

    const result = await callTool(contextFor(createFakeGateway({ failure: empty })), 'mandate_inspect', {});

    expect(parse(result)['error']).toBe('no_contract');
    expect(parse(result)['message']).not.toContain('Try the call again');
  });

  it('answers a library failure in its own words, and says what to do before paying again', async () => {
    const fake = createFakeGateway({ failure: viemZeroData() });

    const result = await callTool(contextFor(fake), 'mandate_inspect', {});

    expect(parse(result)['error']).toBe('call_failed');
    expect(parse(result)['message']).toContain('do not send it again until mandate_list_settlements shows whether it');
  });

  /**
   * The workspace resolves several copies of viem, so the class identity a wrapper matches on is a
   * coin flip. The address, the calldata and the docs URL viem folds into `message` are the same
   * either way.
   */
  it.each([
    ['the copy of viem this package resolved', viemZeroData()],
    ['a copy of viem this package never loaded', foreignViemError()],
  ])('keeps the contract address, the calldata and the docs url out of a failure from %s', async (_case, failure) => {
    const result = await callTool(contextFor(createFakeGateway({ failure })), 'mandate_inspect', {});

    expect(result.text).not.toContain(ACCOUNT);
    expect(result.text).not.toContain(CALLDATA);
    expect(result.text).not.toContain('viem.sh');
    expect(result.text).not.toContain('Contract Call');
    expect(parse(result)['message']).toContain('could not complete the call');
  });

  it('still reads a refusal out of a viem error it cannot recognise by class', async () => {
    const result = await callTool(
      contextFor(createFakeGateway({ failure: foreignRevert('IsRevoked') })),
      'mandate_pay_provider',
      payArgs(),
    );

    expect(parse(result)).toEqual({
      error: 'mandate_refused',
      message:
        'The principal revoked the agent on this mandate, so nothing settles against it. Seating an agent ' +
        'again is what puts it back to work, and only the principal can do that.',
      detail: { revert: 'IsRevoked' },
    });
  });

  it('names a revert it has no sentence for without quoting the library', async () => {
    const result = await callTool(
      contextFor(createFakeGateway({ failure: foreignRevert('SomethingElse') })),
      'mandate_pay_provider',
      payArgs(),
    );

    expect(parse(result)).toEqual({
      error: 'call_reverted',
      message: 'The contract refused this call, and this server has no reading for the name it gave.',
      detail: { revert: 'SomethingElse' },
    });
  });

  it('refuses a tool it does not serve', async () => {
    const result = await callTool(contextFor(createFakeGateway()), 'mandate_withdraw', { amount: '1' });

    expect(parse(result)).toEqual({
      error: 'unknown_tool',
      message: 'This server does not serve a tool called mandate_withdraw.',
    });
  });
});

describe('secrets', () => {
  const calls: [string, unknown][] = [
    ['mandate_inspect', {}],
    ['mandate_quote_spend', { provider: PROVIDER, capability: 'search.web:1', amount: '1000000' }],
    ['mandate_pay_provider', payArgs()],
    ['mandate_list_settlements', {}],
    ['mandate_get_settlement', { settlementId: '1' }],
    ['mandate_open_dispute', { settlementId: '1' }],
  ];

  it.each(calls)('keeps the relay token out of a failed %s result', async (name, args) => {
    const fake = createFakeGateway({
      failure: new ToolError('relay_rejected', `the relay rejected ${RELAY_TOKEN}`, { cause: RELAY_TOKEN }),
    });

    const result = await callTool(contextFor(fake), name, args);

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(RELAY_TOKEN);
    expect(result.text).toContain('[redacted]');
  });

  it('leaves a value too short to be a secret alone', () => {
    expect(redactSecrets('the answer is 42', ['42'])).toBe('the answer is 42');
  });

  it('redacts a 0x-prefixed secret however it is cased', () => {
    const secret = `0x${'ab'.repeat(16)}`;

    expect(redactSecrets(`saw ${secret.toUpperCase()}`, [secret])).toBe('saw 0X[redacted]');
  });
});

/** Doubles for the two roles, so the dispatch and the role gating can be driven without a chain. */
function roleContext(options: { resolver?: boolean; provider?: boolean; canSign?: boolean } = {}): {
  context: ToolContext;
  resolverCalls: string[];
  providerCalls: string[];
} {
  const resolverCalls: string[] = [];
  const providerCalls: string[] = [];

  const record =
    (calls: string[], name: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      calls.push(`${name}:${JSON.stringify(args, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))}`);

      return { txHash: `0x${'ab'.repeat(32)}`, action: name, next: 'done' };
    };

  const resolver = {
    status: record(resolverCalls, 'status'),
    openDisputes: record(resolverCalls, 'openDisputes'),
    bond: record(resolverCalls, 'bond'),
    addBond: record(resolverCalls, 'addBond'),
    commit: record(resolverCalls, 'commit'),
    reveal: record(resolverCalls, 'reveal'),
    finalize: record(resolverCalls, 'finalize'),
    fail: record(resolverCalls, 'fail'),
    claimRewards: record(resolverCalls, 'claimRewards'),
    requestUnbond: record(resolverCalls, 'requestUnbond'),
    completeUnbond: record(resolverCalls, 'completeUnbond'),
    cancelUnbond: record(resolverCalls, 'cancelUnbond'),
  } as unknown as ToolContext['resolver'];

  const provider = {
    status: record(providerCalls, 'status'),
    reputation: record(providerCalls, 'reputation'),
    register: record(providerCalls, 'register'),
    addStake: record(providerCalls, 'addStake'),
    requestWithdrawal: record(providerCalls, 'requestWithdrawal'),
    executeWithdrawal: record(providerCalls, 'executeWithdrawal'),
    cancelWithdrawal: record(providerCalls, 'cancelWithdrawal'),
    deactivate: record(providerCalls, 'deactivate'),
    reactivate: record(providerCalls, 'reactivate'),
  } as unknown as ToolContext['provider'];

  return {
    context: {
      gateway: null,
      resolver: options.resolver === false ? null : resolver,
      provider: options.provider === false ? null : provider,
      secrets: [RELAY_TOKEN],
      canSign: signing(options.canSign ?? true),
    },
    resolverCalls,
    providerCalls,
  };
}

describe('the roles a server advertises', () => {
  it('offers the resolver and provider tools and no mandate tools when it holds no mandate', () => {
    const advertised = toolsFor(roleContext().context).map((tool) => tool.name);

    expect(advertised).toContain('resolver_commit_score');
    expect(advertised).toContain('provider_register');
    expect(advertised.some((name) => name.startsWith('mandate_'))).toBe(false);
  });

  it('keeps the reads and drops the writes when there is no signer', () => {
    const advertised = toolsFor(roleContext({ canSign: false }).context).map((tool) => tool.name);

    expect(advertised).toEqual(['resolver_status', 'resolver_list_disputes', 'provider_status', 'provider_reputation']);
  });

  it('says which signer is missing, in the vocabulary of the role that needed it', async () => {
    const { context } = roleContext({ canSign: false });

    const commit = parse(await callTool(context, 'resolver_commit_score', { disputeId: 4, score: 70 }));
    const register = parse(await callTool(context, 'provider_register', { name: 'render_farm', stake: '25000000' }));

    expect(commit['message']).toContain('the resolver address this server votes as');
    expect(register['message']).toContain('the provider address this server is listed under');
  });

  it('answers a role it was never configured for with what to set, not a crash', async () => {
    const { context } = roleContext({ resolver: false });

    const view = parse(await callTool(context, 'resolver_status', {}));

    expect(view['error']).toBe('resolver_unconfigured');
    expect(view['message']).toContain('BURSAR_RESOLVER_ACCOUNT');
    expect(view['message']).toContain("signer’s own");
  });
});

describe('carrying a role call through', () => {
  it('reads the arguments each resolver verb takes', async () => {
    const { context, resolverCalls } = roleContext();

    await callTool(context, 'resolver_commit_score', { disputeId: '4', score: 70 });
    await callTool(context, 'resolver_reveal_score', { disputeId: 4, score: 70, salt: `0x${'11'.repeat(32)}` });
    await callTool(context, 'resolver_post_bond', { amount: '25000000000000000000000' });
    await callTool(context, 'resolver_list_disputes', {});

    expect(resolverCalls[0]).toContain('"disputeId":"4","score":70');
    expect(resolverCalls[1]).toContain(`"salt":"0x${'11'.repeat(32)}"`);
    expect(resolverCalls[2]).toContain('25000000000000000000000');
    expect(resolverCalls[3]).toBe('openDisputes:[20]');
  });

  it('reads the arguments each provider verb takes', async () => {
    const { context, providerCalls } = roleContext();

    await callTool(context, 'provider_register', { name: 'render_farm', stake: '25000000' });
    await callTool(context, 'provider_request_withdrawal', { amount: '10000000' });

    expect(providerCalls[0]).toContain('"name":"render_farm"');
    expect(providerCalls[0]).toContain('"stake":"25000000"');
    expect(providerCalls[1]).toBe('requestWithdrawal:["10000000"]');
  });

  /** BRSR has eighteen decimals and USDG has six. A figure copied across is off by a million. */
  it('tells a resolver which token and which scale a bond is in', async () => {
    const { context } = roleContext();

    const view = parse(await callTool(context, 'resolver_post_bond', { amount: '25000.5' }));

    expect(view['message']).toContain('eighteen-decimal atomic units');
    expect(view['message']).toContain('BRSR is not USDG');
  });

  it('refuses a score outside the scale the registry accepts', async () => {
    const { context, resolverCalls } = roleContext();

    const view = parse(await callTool(context, 'resolver_commit_score', { disputeId: 4, score: 101 }));

    expect(view['message']).toContain('at most 100');
    expect(resolverCalls).toHaveLength(0);
  });
});

describe('what a hire and a ruling read like before they are made', () => {
  it('tells a hiring agent the brief is what a resolver will read', () => {
    const hire = TOOLS.find((tool) => tool.name === 'mandate_hire_agent');

    expect(hire?.description).toContain('same spending path');
    expect(hire?.inputSchema.properties?.['task']?.description).toContain('cannot be changed afterwards');
    expect(hire?.inputSchema.properties?.['acceptance']?.description).toContain('resolver scoring a contested job');
  });

  it('tells a resolver what losing the salt costs, before it seals anything', () => {
    const commit = TOOLS.find((tool) => tool.name === 'resolver_commit_score');

    expect(commit?.description).toContain('the only thing that will ever open this commitment');
    expect(commit?.description).toContain('costs part of the bond');
  });

  it('tells a payer that a ruling reports where the money actually went', () => {
    const dispute = TOOLS.find((tool) => tool.name === 'mandate_get_dispute');

    expect(dispute?.description).toContain('went back to the mandate and what went to the provider');
    expect(dispute?.description).toContain('no resolver and no ruling');
  });
});

describe('mandate_buy_stock', () => {
  it('passes the asset and amount through to the gateway', async () => {
    const fake = createFakeGateway();
    const context: ToolContext = {
      gateway: fake.gateway,
      resolver: null,
      provider: null,
      secrets: [],
      canSign: { mandate: true, resolver: false, provider: false },
    };
    const result = await callTool(context, 'mandate_buy_stock', { asset: 'SPY', amount: '50000' });
    expect(result.isError).toBe(false);
    expect(fake.buys).toEqual([{ asset: 'SPY', amount: 50_000n }]);
    expect(result.text).toContain('valueAtReference');
  });

  it('names the reference-price refusals', () => {
    expect(refusalForName('StalePrice')?.message).toContain('26 hours');
    expect(refusalForName('AssetNotAllowed')?.subject).toBe('asset');
  });
});
