import { isBursarError, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { returnedNoData } from '@bursar/sdk';
import { isAddress, isHex } from 'viem';
import type { Address, Hex } from 'viem';

import { ToolError, invalidArguments } from './errors.js';
import type { PrivateMandateGateway } from './private.js';
import type { ShieldedGateway } from './shielded.js';
import { COLLATERAL_HANDLERS, COLLATERAL_TOOLS } from './collateral.js';
import type { CollateralGateway } from './collateral.js';
import type { JobSpec } from '@bursar/sdk';
import { refusalForName } from './reasons.js';
import { isJsonObject, toToolSchema, validate } from './schema.js';
import type { JsonObjectSchema, ObjectSchema, ScalarSchema } from './schema.js';
import type { ApprovalInput, JobSpecInput, MandateGateway, ProviderGateway, ResolverGateway } from './types.js';

/** Which role a tool belongs to. A server serves the roles it was configured for and no others. */
export type ToolRole =
  | 'mandate'
  | 'resolver'
  | 'provider'
  | 'private'
  | 'shielded'
  | 'shielded_float'
  | 'collateral';

/**
 * The roles whose signer is configured apart from their gateway. A private mandate's key comes with
 * it, and a shielded payment is sent by the relayer, never by this server.
 */
export type SignedRole = Exclude<ToolRole, 'private' | 'shielded' | 'shielded_float' | 'collateral'>;

export type ToolContext = {
  /** Null when this server is bound to no mandate, which a resolver-only deployment is. */
  readonly gateway: MandateGateway | null;
  readonly resolver: ResolverGateway | null;
  readonly provider: ProviderGateway | null;
  /**
   * A private mandate this server spends from with the agent key in its key file. When it is set
   * the classic mandate gateway is null: a private mandate has none of the getters those tools read.
   */
  readonly private?: PrivateMandateGateway | null;
  /** The shielded pool on this chain, and the float this agent was handed, if any. */
  readonly shielded?: ShieldedGateway | null;
  /** The collateral lane for the bound mandate, on a chain that records one. */
  readonly collateral?: CollateralGateway | null;
  /** Removed from every payload on the way out, so a leaked message cannot carry one. */
  readonly secrets: readonly string[];
  /**
   * Which roles this server has a signer for. Read per role rather than as one flag: a key held in
   * this process signs for the mandate alone, and the resolver and provider tools it cannot send
   * stay off the list instead of being advertised and then refused.
   */
  readonly canSign: Readonly<Record<SignedRole, boolean>>;
  /**
   * Where a failure the caller only sees as `call_failed` is written in full, for the operator.
   * The server points it at stderr; left out, the detail is dropped.
   */
  readonly report?: (line: string) => void;
};

export type ToolResult = {
  readonly text: string;
  readonly isError: boolean;
};

export type ToolDefinition = {
  readonly name: string;
  readonly role: ToolRole;
  readonly description: string;
  readonly inputSchema: ObjectSchema;
  /** Tools that send a transaction disappear when this server has no signer to send them to. */
  readonly writes: boolean;
};

const UINT128_MAX = 2n ** 128n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

const ADDRESS_PATTERN = '^0x[0-9a-fA-F]{40}$';
const BYTES32_PATTERN = '^0x[0-9a-fA-F]{64}$';
const CAPABILITY_PATTERN = '^(?:(?:service|hire|rwa):)?[^\\s:]+:[^\\s:]+$';
const DIGITS_PATTERN = '^(?:0|[1-9][0-9]*)$';
const ID_PATTERN = '^[1-9][0-9]*$';
const SIGNATURE_PATTERN = '^0x[0-9a-fA-F]+$';

const AMOUNT_UNIT =
  'USDG in six-decimal atomic units, digits only: "1000000" is 1.00 USDG and "2500" is a quarter of a cent.';

const AMOUNT_HELP = `${AMOUNT_UNIT} A decimal point is not accepted.`;

const providerProperty = {
  type: 'string',
  description: 'The provider being paid, as a 0x address.',
  pattern: ADDRESS_PATTERN,
  patternMessage: 'provider must be a 0x-prefixed 20-byte address',
} as const;

const capabilityProperty = {
  type: 'string',
  description:
    'What is being bought, named and versioned: "search.web:1". The mandate allows each one by name, under ' +
    'its spend class: a payment is made under service:search.web:1 and a hire under hire:search.web:1, so ' +
    'pass the bare name and the tool adds the class.',
  pattern: CAPABILITY_PATTERN,
  patternMessage: 'capability must be named and versioned, like "search.web:1"',
} as const;

/**
 * An amount field, with a sentence for each way of getting it wrong.
 *
 * The digits-only rule catches a decimal point and a minus sign alike, and the two mistakes have
 * nothing to do with each other. A caller who sent "-500000" and reads about decimal points goes
 * looking for a decimal point.
 */
function amountProperty(label: string, description: string): ScalarSchema {
  return {
    type: 'string',
    description,
    pattern: DIGITS_PATTERN,
    patternMessage: `${label} must be ${AMOUNT_HELP}`,
    patternHints: [
      {
        when: '^\\s*-',
        message:
          `${label} counts up from 1 and cannot be negative. Send what you want to pay: "1000000" is 1.00 ` +
          'USDG. Funds return to a mandate when a provider misses its deadline or a dispute is ruled that ' +
          'way, never through a payment.',
      },
      {
        when: '[.,]',
        message:
          `${label} must be ${AMOUNT_UNIT} Write 1.50 USDG as "1500000": drop the separator and count in ` +
          'millionths.',
      },
    ],
  };
}

const BOND_UNIT =
  'BRSR in eighteen-decimal atomic units, digits only: "25000000000000000000000" is 25,000 BRSR. ' +
  'BRSR is not USDG and the two have different decimals, so a figure copied from a payment is ' +
  'a million times too small.';

/** A BRSR figure, which is a different token and a different scale from every amount above. */
function bondProperty(label: string, description: string): ScalarSchema {
  return {
    type: 'string',
    description,
    pattern: DIGITS_PATTERN,
    patternMessage: `${label} must be ${BOND_UNIT}`,
    patternHints: [
      {
        when: '[.,]',
        message:
          `${label} must be ${BOND_UNIT} Write 25,000 BRSR as "25000000000000000000000": drop the ` +
          'separator and count in units of 1e-18.',
      },
    ],
  };
}

/** The principal's consent, in the one shape both spending tools take it. */
function approvalProperty(): ObjectSchema {
  return {
    type: 'object',
    description:
      'Consent from the principal for one spend at or above the approval threshold. The principal ' +
      'issues it out of band; pass it through unchanged.',
    required: ['approvalId', 'amount', 'expiry'],
    properties: {
      approvalId: {
        type: 'string',
        description: 'The id the principal gave this approval. It pays for one spend and is then spent.',
        pattern: BYTES32_PATTERN,
        patternMessage: 'approval.approvalId must be 32 bytes of hex',
      },
      amount: amountProperty(
        'approval.amount',
        `The ceiling the principal approved. ${AMOUNT_HELP} The spend may settle under it.`,
      ),
      expiry: {
        type: 'integer',
        description: 'Unix seconds after which the approval is dead.',
        minimum: 1,
      },
      signature: {
        type: 'string',
        description:
          'The signature the principal gave over this approval. Leave it out when the principal has ' +
          'already registered the approval on chain.',
        pattern: SIGNATURE_PATTERN,
        patternMessage: 'approval.signature must be 0x-prefixed hex',
      },
    },
  };
}

function settlementIdSchema(): ObjectSchema {
  return {
    type: 'object',
    required: ['settlementId'],
    properties: {
      settlementId: {
        type: ['string', 'integer'],
        description: 'The settlement id returned by mandate_pay_provider or mandate_list_settlements.',
        pattern: ID_PATTERN,
        minimum: 1,
      },
    },
  };
}

const disputeIdProperty = {
  type: ['string', 'integer'],
  description:
    'The dispute id from resolver_list_disputes. It is issued by the dispute registry and is not a ' +
    'settlement id.',
  pattern: ID_PATTERN,
  minimum: 1,
} as const;

function disputeIdSchema(): ObjectSchema {
  return { type: 'object', required: ['disputeId'], properties: { disputeId: disputeIdProperty } };
}

const scoreProperty = {
  type: 'integer',
  description:
    'How much of the job was delivered, from 0 to 100. 0 is nothing delivered and 100 is delivered ' +
    'as agreed. The refund the payer gets is stepped off this, so two resolvers who agree the work ' +
    'was poor do not have to agree on a percentage. A score more than the deviation band away from ' +
    'the median costs part of the bond.',
  minimum: 0,
  maximum: 100,
} as const;

const NO_ARGUMENTS: ObjectSchema = { type: 'object', properties: {} };

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'mandate_inspect',
    role: 'mandate',
    writes: false,
    description:
      'Read the spending mandate this server is bound to: the per-call cap, the daily and monthly budgets, ' +
      'how much is left in each and when each resets, the amount at and above which the principal has to sign, ' +
      'the balance the principal has funded, and whether the mandate is active, paused, revoked or outside ' +
      'its dates. It also reports the escrow terms, including the smallest payment the escrow will lock. ' +
      'Nothing is spent. Start here when you do not know what you are allowed to buy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mandate_quote_spend',
    role: 'mandate',
    writes: false,
    description:
      'Ask the mandate what it would decide about one spend, before making it. The answer says whether the ' +
      'spend would settle and, when it would not, which limit stopped it: the per-call cap, the daily budget, ' +
      'the monthly budget or the total budget, the capability, the provider, the state of the mandate itself, ' +
      'or the smallest payment the escrow will lock. A spend at or ' +
      'above the approval threshold needs the principal to sign for it, and the quote says so rather than ' +
      'calling it a refusal. Nothing moves and nothing is charged.',
    inputSchema: {
      type: 'object',
      required: ['provider', 'capability', 'amount'],
      properties: {
        provider: providerProperty,
        capability: capabilityProperty,
        amount: amountProperty('amount', AMOUNT_HELP),
        spendClass: {
          type: 'string',
          description:
            'The class to quote a bare capability under: "service" for mandate_pay_provider, "hire" for ' +
            'mandate_hire_agent. Defaults to "service".',
          pattern: '^(?:service|hire)$',
          patternMessage: 'spendClass must be "service" or "hire"',
        },
      },
    },
  },
  {
    name: 'mandate_pay_provider',
    role: 'mandate',
    writes: true,
    description:
      'Pay a provider for one job. The amount is locked in escrow against this mandate and goes to the ' +
      'provider when the work is delivered before the deadline. If nothing is delivered by then, the funds ' +
      'return to the mandate and the daily and monthly budgets are credited back. The contract enforces the ' +
      'limits, so a spend outside them does not settle whatever this server is told. The escrow locks nothing ' +
      'under its floor, which mandate_inspect reports, so a smaller payment is refused before it is sent. A spend ' +
      'at or above the approval threshold needs an approval the principal signed for this provider, this ' +
      'capability and at least this amount; without one the payment is refused before it reaches the chain. The money comes ' +
      'from what the principal has already funded the mandate with. There is no credit line here. The reply ' +
      'carries a settlement id: follow it with mandate_get_settlement to see whether the work arrived.',
    inputSchema: {
      type: 'object',
      required: ['provider', 'capability', 'input', 'amount', 'deliverWithinSeconds'],
      properties: {
        provider: providerProperty,
        capability: capabilityProperty,
        input: {
          type: 'object',
          description:
            'The arguments the provider is being paid to act on. They are hashed and published with the ' +
            'payment, so the provider can prove what it was asked for and you can prove what you sent.',
          additionalProperties: true,
        },
        amount: amountProperty('amount', AMOUNT_HELP),
        deliverWithinSeconds: {
          type: 'integer',
          description:
            'How long the provider has to deliver before the funds return to the mandate. The escrow bounds ' +
            'this and mandate_inspect reports its range. Ask for at least a minute over its minimum, which ' +
            'is the time a payment can take to reach a block.',
          minimum: 1,
          maximum: 2_592_000,
        },
        providerProof: {
          type: 'array',
          description:
            'Only for a mandate that holds its provider roster off chain. The principal issues the proof; ' +
            'leave this out otherwise.',
          maxItems: 64,
          items: {
            type: 'string',
            description: 'One 32-byte proof node.',
            pattern: BYTES32_PATTERN,
            patternMessage: 'each providerProof entry must be 32 bytes of hex',
          },
        },
        approval: approvalProperty(),
      },
    },
  },
  {
    name: 'mandate_buy_stock',
    role: 'mandate',
    writes: true,
    description:
      'Buy an eligible tokenized stock (SPY, NVDA or AAPL on Robinhood Chain) with USDG from this mandate. ' +
      'The stock is delivered to the mandate account. The mandate has to allow stock purchases, and the ' +
      'principal has to have listed the asset for it. The purchase is checked against the Chainlink ' +
      'reference price: it is refused when that price is older than 26 hours, when the trading pool and the ' +
      "reference disagree by more than the asset allows, or when the fill would be worse than the mandate's " +
      'slippage limit. Each purchase is at most 25 USDG and counts against the per-call cap and every ' +
      'budget, like any spend. A purchase is final: nothing is refunded.',
    inputSchema: {
      type: 'object',
      required: ['asset', 'amount'],
      properties: {
        asset: {
          type: 'string',
          description: 'The stock to buy, by symbol ("SPY", "NVDA", "AAPL") or token address.',
          pattern: '^(?:[A-Za-z]{1,10}|0x[0-9a-fA-F]{40})$',
          patternMessage: 'asset must be a ticker symbol or a 0x address',
        },
        amount: amountProperty('amount', AMOUNT_HELP),
      },
    },
  },
  {
    name: 'mandate_list_settlements',
    role: 'mandate',
    writes: false,
    description:
      'List what this mandate has paid for, newest first, with where each payment stands: held in escrow ' +
      'while the provider works, paid to the provider, returned to the mandate, disputed, or split by a ' +
      'resolver. Nothing is spent. The reply carries a cursor when there is history behind it; pass that ' +
      'back as beforeBlock to keep reading. To act on one of them, read it with mandate_get_settlement, ' +
      'which gives the deadline and the decision that is open on it.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many settlements to return. Defaults to 10.',
          minimum: 1,
          maximum: 50,
        },
        beforeBlock: {
          type: 'string',
          description: 'The cursor from a previous reply, to read further back.',
          pattern: DIGITS_PATTERN,
          patternMessage: 'beforeBlock must be a decimal block number',
        },
      },
    },
  },
  {
    name: 'mandate_get_settlement',
    role: 'mandate',
    writes: false,
    description:
      'Read one settlement in full: the amount, the provider, what was committed and what was delivered, ' +
      'where the funds are now, and the next decision with the time it has to be made by. This is how you ' +
      'follow a job you have paid for, and how you follow a dispute through to its ruling.',
    inputSchema: settlementIdSchema(),
  },
  {
    name: 'mandate_open_dispute',
    role: 'mandate',
    writes: true,
    description:
      'Contest a settlement this mandate paid for. While the funds are still held and the delivery deadline ' +
      'has not passed, this hands the split to the resolvers and posts a bond from the mandate balance. The ' +
      'escrow sizes the bond against the amount at stake, and it comes back only if the ruling lands on the ' +
      'side of the mandate or the vote produces no result. Past the deadline the funds go back to the mandate, ' +
      'so there is nothing to contest. Once the provider has been paid there is nothing left to split: the ' +
      'complaint goes on the provider’s record without a ruling, and only while the dispute window that ' +
      'mandate_get_settlement reports is still open. Contesting a payment is a decision for the ' +
      'principal, so it works only where the signer is authorised to act for the principal. Read the ' +
      'settlement again afterwards for the ruling and for when the vote closes.',
    inputSchema: settlementIdSchema(),
  },
  {
    name: 'mandate_hire_agent',
    role: 'mandate',
    writes: true,
    description:
      'Hire another agent to do a piece of work, paid through this mandate. The budget is locked in escrow ' +
      'against a brief: the task in words, the arguments it runs on, and what counts as delivered. That ' +
      'brief is hashed and published with the payment, so the provider can prove what it was asked for, you ' +
      'can prove what you asked, and a resolver reading a contested job has the terms in front of it. The ' +
      'provider is paid by committing to what it delivered, which releases the funds in the same ' +
      'transaction; nothing is paid out before that, and a job nobody answers returns the budget when its ' +
      'deadline passes. Every limit, approval and refusal is the same as mandate_pay_provider, because it is ' +
      'the same spending path. The reply carries a job id, which is the settlement id: follow it with ' +
      'mandate_get_settlement.',
    inputSchema: {
      type: 'object',
      required: ['provider', 'capability', 'task', 'budget', 'deliverWithinSeconds'],
      properties: {
        provider: {
          type: 'string',
          description: 'The agent being hired, as a 0x address. It becomes the payee of the escrow lock.',
          pattern: ADDRESS_PATTERN,
          patternMessage: 'provider must be a 0x-prefixed 20-byte address',
        },
        capability: capabilityProperty,
        task: {
          type: 'string',
          description:
            'What the provider is being paid to do, in words. One or two sentences. It is committed with ' +
            'the payment and cannot be changed afterwards, and it is what a resolver reads if you contest ' +
            'the delivery, so write it as the terms rather than as a hint.',
        },
        input: {
          type: 'object',
          description:
            'The machine arguments the capability runs on. Committed alongside the task. Leave it out for ' +
            'a job that needs none.',
          additionalProperties: true,
        },
        acceptance: {
          type: 'array',
          description:
            'What the delivery will be judged against, one line each. Committed with the task, so a ' +
            'resolver scoring a contested job reads exactly the criteria that were agreed.',
          maxItems: 20,
          items: { type: 'string', description: 'One thing the delivery has to do.' },
        },
        budget: amountProperty(
          'budget',
          `What the job is worth. ${AMOUNT_HELP} It is locked, not sent, until the work is delivered.`,
        ),
        deliverWithinSeconds: {
          type: 'integer',
          description:
            'How long the provider has to deliver before the budget returns to the mandate. The escrow ' +
            'bounds this and mandate_inspect reports its range. Ask for at least a minute over its ' +
            'minimum, which is the time a payment can take to reach a block.',
          minimum: 1,
          maximum: 2_592_000,
        },
        providerProof: {
          type: 'array',
          description:
            'Only for a mandate that holds its provider roster off chain. The principal issues the proof; ' +
            'leave this out otherwise.',
          maxItems: 64,
          items: {
            type: 'string',
            description: 'One 32-byte proof node.',
            pattern: BYTES32_PATTERN,
            patternMessage: 'each providerProof entry must be 32 bytes of hex',
          },
        },
        approval: approvalProperty(),
      },
    },
  },
  {
    name: 'mandate_get_dispute',
    role: 'mandate',
    writes: false,
    description:
      'Read the dispute against one of this mandate’s payments, and the ruling once there is one. While ' +
      'the escrow still holds the funds, bonded resolvers seal scores, publish them and close the vote, and ' +
      'the reply reports which phase it is in, how many have voted, when each window shuts, and when the ' +
      'vote closes. From then anyone can settle it: the escrow moves the money on the ruling, or, when too ' +
      'few resolvers voted, puts the payment back on hold with a new deadline and returns the bond. Once ' +
      'ruled it reports the median score, the refund share, exactly what went back to the mandate and what ' +
      'went to the provider, and whether the bond was returned. A complaint about a payment the provider had ' +
      'already taken is reported as what it is: a record against that provider, with no resolver and no ruling.',
    inputSchema: settlementIdSchema(),
  },
  {
    name: 'private_mandate_inspect',
    role: 'private',
    writes: false,
    description:
      'Read the private mandate this server spends from: its balance, whether it is active, paused, revoked ' +
      'or ended, how many proven payments it has made, and its terms as the owner wrote them: the cap per ' +
      'payment, the cap per period and the period, the total budget, which kinds of payment are allowed, ' +
      'the providers it may pay, and the end date. The terms come from the key file; the chain holds only a ' +
      'commitment to them. It also reports whether the agent address holds enough ETH for the network fee. ' +
      'Nothing is spent. Start here.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'private_mandate_pay',
    role: 'private',
    writes: true,
    description:
      'Pay a provider from the private mandate for one job. The server proves that the payment fits the ' +
      'terms without revealing them, and the mandate locks the amount in escrow for the provider. The ' +
      'brief is sealed to the provider when it has published a viewing key, so only the provider can read ' +
      'it. The amount and the provider are public on chain; the terms and the rest of the provider list ' +
      'are not. A payment the terms do not allow cannot be proven, so it is refused before anything is ' +
      'sent. Proving takes a few seconds. The reply carries the settlement id and the transaction.',
    inputSchema: {
      type: 'object',
      required: ['provider', 'capability', 'amount', 'task'],
      properties: {
        provider: providerProperty,
        capability: capabilityProperty,
        amount: amountProperty('amount', `What the job is worth. ${AMOUNT_HELP}`),
        task: {
          type: 'string',
          description: 'What the provider is being paid to do, in words. Committed with the payment.',
        },
        input: {
          type: 'object',
          description: 'The machine arguments the capability runs on. Leave it out for a job that needs none.',
          additionalProperties: true,
        },
        acceptance: {
          type: 'array',
          description: 'What the delivery will be judged against, one line each.',
          maxItems: 20,
          items: { type: 'string', description: 'One thing the delivery has to do.' },
        },
        spendClass: {
          type: 'string',
          description: '"service" for a payment, "hire" for hiring another agent. Defaults to "service".',
          pattern: '^(?:service|hire)$',
          patternMessage: 'spendClass must be "service" or "hire"',
        },
        deliverWithinSeconds: {
          type: 'integer',
          description: 'How long the provider has to deliver before the amount returns. Defaults to six hours.',
          minimum: 300,
          maximum: 2_592_000,
        },
      },
    },
  },
  {
    name: 'shielded_pool_status',
    role: 'shielded',
    writes: false,
    description:
      'Read the shielded USDG pool: whether it takes deposits, what it holds, the most one deposit and the ' +
      'whole pool may hold and the room left under that, the association-set root in force and when it was ' +
      'posted, and the relayer\u2019s fee when one is configured. Nothing is spent.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'shielded_balance',
    role: 'shielded_float',
    writes: false,
    description:
      'Read the shielded balance this agent was handed: each deposit it can spend from, what is left in it, ' +
      'and whether the association-set service has approved it yet. Only approved deposits can pay. The ' +
      'balance is rebuilt from public chain data with the keys in the key file; nothing is stored. It also ' +
      'reports the caps this server holds shielded payments under, one per payment and one per rolling ' +
      'day, with what the last 24 hours have drawn against them. Nothing is spent.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'shielded_pay',
    role: 'shielded_float',
    writes: true,
    description:
      'Pay an address out of the shielded balance. The server proves the withdrawal from one approved ' +
      'deposit and hands it to the relayer, which submits it from its own wallet, so the payment carries no ' +
      'trace of whoever funded the balance. The recipient receives the full amount; the relayer\u2019s fee is ' +
      'drawn on top, and the rest of the deposit stays in the pool. With gasDrop the relayer also sends the ' +
      'recipient a little ETH, which is how a fresh address gets its first network fee, and the fee rises by ' +
      'what that ETH is worth (shielded_pool_status reports it as gasDropFee); a payment too small to carry ' +
      'it under the relay’s fee cap is refused before anything is proven. One payment draws on ' +
      'one deposit. The pool caps deposits and not withdrawals, so this server holds every payment under two ' +
      'caps of its own, one per payment and one per rolling day; shielded_balance reports them, and a payment ' +
      'over either is refused before anything is proven, with the cap named. Proving takes a few seconds. The ' +
      'amount and the recipient are public on chain.',
    inputSchema: {
      type: 'object',
      required: ['recipient', 'amount'],
      properties: {
        recipient: {
          type: 'string',
          description: 'The address being paid, as a 0x address.',
          pattern: ADDRESS_PATTERN,
          patternMessage: 'recipient must be a 0x-prefixed 20-byte address',
        },
        amount: amountProperty('amount', `What the recipient should receive. ${AMOUNT_HELP}`),
        gasDrop: {
          type: 'boolean',
          description:
            'Ask the relayer to send the recipient ETH for its first network fee, paid for out of this payment’s fee. ' +
            'Only for an address with none.',
        },
      },
    },
  },
  {
    name: 'resolver_status',
    role: 'resolver',
    writes: false,
    description:
      'Read where this resolver stands: the BRSR bonded and the floor it has to clear before its next vote ' +
      'is accepted, whether the staking pool would accept it at all, how many disputes it has ruled on, how ' +
      'many times it has been slashed, how many votes are still holding the bond, and what USDG is waiting ' +
      'to be claimed. The bond is collateral taking first loss, not a deposit: it pays no return, and a ' +
      'vote that goes silent or lands far from the room loses part of it. Also reports the voting ' +
      'parameters in force, which is where the commit and reveal windows come from. Nothing is sent.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'resolver_list_disputes',
    role: 'resolver',
    writes: false,
    description:
      'List the disputes still open to a vote, newest first, each with the job the score is about: who paid, ' +
      'who was hired, for how much, what was committed as the brief and what was committed as the delivery, ' +
      'the delivery deadline and who contested it. It also says whether this resolver has already sealed a ' +
      'score and whether it has published one. Read straight off the chain, so it works with nothing but a ' +
      'node. Nothing is sent.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many of the newest disputes to look at. Defaults to 20.',
          minimum: 1,
          maximum: 64,
        },
      },
    },
  },
  {
    name: 'resolver_post_bond',
    role: 'resolver',
    writes: true,
    description:
      'Put BRSR up and join the roster, which is what makes this address able to vote. The bond is ' +
      'collateral at risk from the moment it lands: a commitment left unrevealed and a score far from the ' +
      'median both take part of it, and nothing in the protocol pays a return on holding one. The staking ' +
      'pool sets the floor and can refuse this address outright; resolver_status reports both figures. The ' +
      'bond has to be approved to the dispute registry first.',
    inputSchema: {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: bondProperty('amount', `The BRSR to put at risk. ${BOND_UNIT}`),
      },
    },
  },
  {
    name: 'resolver_add_bond',
    role: 'resolver',
    writes: true,
    description:
      'Add BRSR to a bond already posted. This is how a resolver comes back after a slash has thinned its ' +
      'bond, or after governance has raised the floor under it: the whole bond is checked against the ' +
      'floor, not the addition, so a top-up that does not reach it is refused. The new BRSR has to be ' +
      'approved to the dispute registry first.',
    inputSchema: {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: bondProperty('amount', `The BRSR to add. ${BOND_UNIT}`),
      },
    },
  },
  {
    name: 'resolver_commit_score',
    role: 'resolver',
    writes: true,
    description:
      'Seal a score on an open dispute, without publishing it. Sealing and publishing are two steps with a ' +
      'window between them, which is what stops a late voter copying an early one. The reply carries a ' +
      'salt generated here: it is the only thing that will ever open this commitment, nothing on chain or ' +
      'in this server can recompute it, and a commitment still sealed when the reveal window shuts is ' +
      'treated as silence and costs part of the bond. Keep the salt and the score together, and pass both ' +
      'back to resolver_reveal_score inside the window the reply names.',
    inputSchema: {
      type: 'object',
      required: ['disputeId', 'score'],
      properties: { disputeId: disputeIdProperty, score: scoreProperty },
    },
  },
  {
    name: 'resolver_reveal_score',
    role: 'resolver',
    writes: true,
    description:
      'Publish a score that was sealed earlier, which is what makes it count. It takes the exact score and ' +
      'the exact salt the commitment was made from, and accepts no other pair: the commitment covers the ' +
      'dispute id, this resolver address, the score and the salt, so one of them being different reads the ' +
      'same as a wrong salt. Reveals open when the commit window shuts and close when the reveal window ' +
      'does; resolver_list_disputes reports both times. A commitment left sealed past that is slashed.',
    inputSchema: {
      type: 'object',
      required: ['disputeId', 'score', 'salt'],
      properties: {
        disputeId: disputeIdProperty,
        score: scoreProperty,
        salt: {
          type: 'string',
          description: 'The salt resolver_commit_score returned for this dispute, unchanged.',
          pattern: BYTES32_PATTERN,
          patternMessage: 'salt must be the 32-byte value resolver_commit_score returned',
        },
      },
    },
  },
  {
    name: 'resolver_finalize_dispute',
    role: 'resolver',
    writes: true,
    description:
      'Close a vote that reached quorum. It takes the median of the published scores, slashes the silent ' +
      'and the outliers, and tells the escrow how to split the settlement, all in one transaction. Anyone ' +
      'can send it, and it is what releases the payer’s funds, so a resolver that voted has reason to. If ' +
      'too few resolvers published a score it is refused and resolver_fail_dispute is the other door.',
    inputSchema: disputeIdSchema(),
  },
  {
    name: 'resolver_fail_dispute',
    role: 'resolver',
    writes: true,
    description:
      'Close a vote that never reached quorum. The escrow puts the payment back on hold with a new deadline ' +
      'for the provider, returns the bond to whoever contested it and pays no resolver fee. On the first ' +
      'contract set it refunds the payer, less the resolver fee. Resolvers that sealed a score and never ' +
      'published one are slashed for it, but only once the window they could have spoken in has shut. ' +
      'Anyone can send it. A vote with no centre is closed by resolver_finalize_dispute and refunds the ' +
      'payer in full, or less the resolver fee on the first contract set.',
    inputSchema: disputeIdSchema(),
  },
  {
    name: 'resolver_claim_rewards',
    role: 'resolver',
    writes: true,
    description:
      'Take the rewards this resolver has earned. They are a share of the fee the escrow took from each ' +
      'settlement it ruled on, split between the resolvers whose scores held, and they are paid in USDG ' +
      'rather than in BRSR: the bond is untouched by this. A resolver that has left the roster still ' +
      'collects what it earned while it was on it.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'resolver_request_unbond',
    role: 'resolver',
    writes: true,
    description:
      'Step one of leaving. It stops this resolver being drawn into new disputes and starts the cooldown, ' +
      'which is set to outlast the longest dispute a live vote could still be slashed over. The bond stays ' +
      'posted and stays slashable across it. resolver_status reports when it matures.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'resolver_complete_unbond',
    role: 'resolver',
    writes: true,
    description:
      'Step two of leaving: take the bond back. It is refused while the cooldown is still running, and ' +
      'refused again while any vote this resolver committed to has yet to settle, because that bond is ' +
      'what stands behind those votes. Closing those disputes is what frees it. Rewards already earned ' +
      'survive the exit.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'resolver_cancel_unbond',
    role: 'resolver',
    writes: true,
    description:
      'Step two, the other way: call the exit off and go back on the roster. The bond was never moved, so ' +
      'nothing is returned and nothing is posted.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'provider_status',
    role: 'provider',
    writes: false,
    description:
      'Read where this provider stands in the registry: whether it is listed, whether it reads as available ' +
      'to principals, the collateral posted against the floor it has to keep, the most a single slash could ' +
      'take from it, and any withdrawal on its way out with the time it matures. Collateral is in USDG and ' +
      'is at risk: governance can take part of it from a provider that failed its counterparties, on a ' +
      'timelocked proposal. A dispute ruling never reaches it. Nothing is sent.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'provider_reputation',
    role: 'provider',
    writes: false,
    description:
      'Read the settlement history this provider has earned and the ceiling it buys: how many jobs were ' +
      'delivered and paid, how many timed out, how many were contested, and the largest single payment the ' +
      'escrow will hold for it right now. The ceiling rises with delivered work and falls with work that ' +
      'times out or is contested. A delivery only counts once it has been finalised, which happens after ' +
      'the window to contest it closes, so a provider that never finalises holds its own ceiling down. ' +
      'Nothing is sent.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'provider_register',
    role: 'provider',
    writes: true,
    description:
      'List this provider in the registry with collateral, which is what lets a principal name it and the ' +
      'escrow hold payments for it. The collateral is at risk from the moment it lands: governance can take ' +
      'part of it from a provider that failed its counterparties, and it cannot be taken back without a ' +
      'delay. The name is a display handle, ' +
      'not an identity: it is not unique and nothing in the protocol resolves it. The collateral has to be ' +
      'approved to the registry first.',
    inputSchema: {
      type: 'object',
      required: ['name', 'stake'],
      properties: {
        name: {
          type: 'string',
          description:
            'A display handle, 3 to 32 characters of letters, digits and underscore. Anything else is ' +
            'refused rather than rendered, because a handle carrying invisible characters can be read as ' +
            'another provider’s.',
          pattern: '^[A-Za-z0-9_]{3,32}$',
          patternMessage: 'name must be 3 to 32 characters of letters, digits and underscore',
        },
        stake: amountProperty(
          'stake',
          `The collateral to put up. ${AMOUNT_HELP} provider_status reports the floor the registry enforces.`,
        ),
      },
    },
  },
  {
    name: 'provider_add_stake',
    role: 'provider',
    writes: true,
    description:
      'Add collateral to a listing that already exists, which raises the most a single slash can take and ' +
      'brings a provider back over the floor after a slash. It also cancels a withdrawal that was waiting: ' +
      'asking to leave and adding collateral in the same breath is contradictory, so the registry clears ' +
      'the request. The collateral has to be approved to the registry first.',
    inputSchema: {
      type: 'object',
      required: ['amount'],
      properties: { amount: amountProperty('amount', `The collateral to add. ${AMOUNT_HELP}`) },
    },
  },
  {
    name: 'provider_request_withdrawal',
    role: 'provider',
    writes: true,
    description:
      'Step one of taking collateral back. It starts a delay during which the collateral stays posted and ' +
      'stays slashable, which is what stops a stake leaving between a bad job and the governance proposal ' +
      'that answers it. An ' +
      'active provider has to leave the registry floor behind; to take the whole stake, deactivate first. ' +
      'There is one withdrawal at a time.',
    inputSchema: {
      type: 'object',
      required: ['amount'],
      properties: { amount: amountProperty('amount', `The collateral to take back. ${AMOUNT_HELP}`) },
    },
  },
  {
    name: 'provider_execute_withdrawal',
    role: 'provider',
    writes: true,
    description:
      'Step two: take the collateral once the delay has matured. It works even while the registry is paused, ' +
      'because matured collateral is the provider’s own. If it leaves the stake under the registry floor ' +
      'the provider stops reading as available, and it comes back by adding collateral and reactivating.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'provider_cancel_withdrawal',
    role: 'provider',
    writes: true,
    description:
      'Step two, the other way: call the withdrawal off and leave the collateral where it is. Nothing moves.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'provider_deactivate',
    role: 'provider',
    writes: true,
    description:
      'Stop reading as available, so the escrow refuses new payments for this provider. Work already paid ' +
      'for is unaffected and still has to be delivered. The collateral stays posted and stays slashable: ' +
      'this is a closed sign, not an exit. Taking the collateral back is a separate three-step withdrawal.',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'provider_reactivate',
    role: 'provider',
    writes: true,
    description:
      'Read as available again, so the escrow will hold new payments for this provider. It needs the ' +
      'collateral to still clear the registry floor and no bar standing against the address.',
    inputSchema: NO_ARGUMENTS,
  },
  ...COLLATERAL_TOOLS.map((tool) => ({ ...tool, role: 'collateral' as const })),
];

export type AdvertisedTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
};

function servesRole(context: ToolContext, role: ToolRole): boolean {
  if (role === 'private') return (context.private ?? null) !== null;
  if (role === 'shielded') return (context.shielded ?? null) !== null;
  if (role === 'shielded_float') return (context.shielded?.float ?? null) !== null;
  if (role === 'collateral') return (context.collateral ?? null) !== null;
  if (role === 'resolver') return context.resolver !== null;
  if (role === 'provider') return context.provider !== null;

  return context.gateway !== null;
}

/** What this server offers right now. A tool it cannot carry out is not on the list. */
export function toolsFor(context: ToolContext): AdvertisedTool[] {
  return TOOLS.filter((tool) => servesRole(context, tool.role) && (canSign(context, tool.role) || !tool.writes)).map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toToolSchema(tool.inputSchema),
    }),
  );
}

/**
 * A private mandate signs with the key in its file, so it can always send what it serves. A shielded
 * payment is sent by the relayer, so it is offered only with one configured.
 */
function canSign(context: ToolContext, role: ToolRole): boolean {
  if (role === 'private' || role === 'shielded') return servesRole(context, role);
  if (role === 'shielded_float') return servesRole(context, role) && (context.shielded?.relayerUrl ?? null) !== null;
  if (role === 'collateral') return context.collateral?.canWrite === true;
  return context.canSign[role];
}

function shieldedOf(context: ToolContext): ShieldedGateway {
  const gateway = context.shielded ?? null;
  if (gateway === null) {
    throw new ToolError('shielded_unavailable', 'This chain has no shielded pool recorded, so there is nothing to read.');
  }
  return gateway;
}

function floatOf(context: ToolContext): NonNullable<ShieldedGateway['float']> {
  const float = context.shielded?.float ?? null;
  if (float === null) {
    throw new ToolError(
      'shielded_unconfigured',
      'This server holds no shielded balance. Set BURSAR_SHIELDED_KEY_FILE to the shielded key file the ' +
        'owner handed over, then restart it.',
    );
  }
  return float;
}

function privateOf(context: ToolContext): PrivateMandateGateway {
  const gateway = context.private ?? null;

  if (gateway === null) {
    throw new ToolError(
      'private_mandate_unconfigured',
      'This server is not bound to a private mandate. Set BURSAR_AGENT_KEY_FILE to the agent key file the ' +
        'owner exported, with BURSAR_SIGNER=local, then restart it.',
    );
  }

  return gateway;
}

/**
 * The gateway a tool runs against, or the reason there is none.
 *
 * A tool filtered out of the list can still be called by a client working from a stale list, and a
 * null dereference is the wrong way for that to land.
 */
function mandateOf(context: ToolContext): MandateGateway {
  if (context.gateway === null) {
    throw new ToolError(
      'mandate_unconfigured',
      'This server is not bound to a spending mandate, so it cannot pay, hire or read one. Set ' +
        'MANDATE_ACCOUNT to the mandate account it should work inside, then restart it.',
    );
  }

  return context.gateway;
}

function resolverOf(context: ToolContext): ResolverGateway {
  if (context.resolver === null) {
    throw new ToolError(
      'resolver_unconfigured',
      'This server does not act for a resolver. Set BURSAR_RESOLVER_ACCOUNT to the address its signer ' +
        'holds, then restart it. That address sits inside every commitment a resolver seals, so it has ' +
        'to be the signer\u2019s own.',
    );
  }

  return context.resolver;
}

function providerOf(context: ToolContext): ProviderGateway {
  if (context.provider === null) {
    throw new ToolError(
      'provider_unconfigured',
      'This server does not act for a provider. Set BURSAR_PROVIDER_ACCOUNT to the address its signer ' +
        'holds, then restart it.',
    );
  }

  return context.provider;
}

type Handler = (context: ToolContext, args: Record<string, unknown>) => Promise<unknown>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  mandate_inspect: (context) => mandateOf(context).inspect(),

  mandate_quote_spend: (context, args) =>
    mandateOf(context).quote({
      provider: readAddress(args, 'provider'),
      capability: readString(args, 'capability'),
      amount: readAmount(args, 'amount'),
      ...(args['spendClass'] === undefined
        ? {}
        : { spendClass: readString(args, 'spendClass') === 'hire' ? ('hire' as const) : ('service' as const) }),
    }),

  mandate_pay_provider: (context, args) =>
    mandateOf(context).pay({
      provider: readAddress(args, 'provider'),
      capability: readString(args, 'capability'),
      input: readObject(args, 'input'),
      amount: readAmount(args, 'amount'),
      ttlSeconds: readInteger(args, 'deliverWithinSeconds'),
      providerProof: readProof(args),
      approval: readApproval(args),
    }),

  mandate_hire_agent: (context, args) =>
    mandateOf(context).hire({
      provider: readAddress(args, 'provider'),
      capability: readString(args, 'capability'),
      spec: readJobSpec(args),
      budget: readAmount(args, 'budget'),
      ttlSeconds: readInteger(args, 'deliverWithinSeconds'),
      providerProof: readProof(args),
      approval: readApproval(args),
    }),

  mandate_buy_stock: (context, args) =>
    mandateOf(context).buyStock({ asset: readString(args, 'asset'), amount: readAmount(args, 'amount') }),

  mandate_list_settlements: (context, args) =>
    mandateOf(context).settlements({
      limit: args['limit'] === undefined ? 10 : readInteger(args, 'limit'),
      beforeBlock: args['beforeBlock'] === undefined ? null : BigInt(readString(args, 'beforeBlock')),
    }),

  mandate_get_settlement: (context, args) => mandateOf(context).settlement(readSettlementId(args)),

  mandate_open_dispute: (context, args) => mandateOf(context).openDispute(readSettlementId(args)),

  mandate_get_dispute: (context, args) => mandateOf(context).dispute(readSettlementId(args)),

  private_mandate_inspect: (context) => privateOf(context).inspect(),

  private_mandate_pay: (context, args) =>
    privateOf(context).pay({
      payee: readAddress(args, 'provider'),
      capability: readString(args, 'capability'),
      amount: readAmount(args, 'amount'),
      spendClass: args['spendClass'] === 'hire' ? 'hire' : 'service',
      spec: jobSpecOf(readJobSpec(args)),
      deliverWithinSeconds: args['deliverWithinSeconds'] === undefined ? 6 * 3600 : readInteger(args, 'deliverWithinSeconds'),
    }),

  shielded_pool_status: (context) => shieldedOf(context).status(),

  shielded_balance: (context) => floatOf(context).balance(),

  shielded_pay: (context, args) =>
    floatOf(context).pay({
      recipient: readAddress(args, 'recipient'),
      amount: readAmount(args, 'amount'),
      gasDrop: args['gasDrop'] === true,
    }),

  resolver_status: (context) => resolverOf(context).status(),

  resolver_list_disputes: (context, args) =>
    resolverOf(context).openDisputes(args['limit'] === undefined ? 20 : readInteger(args, 'limit')),

  resolver_post_bond: (context, args) => resolverOf(context).bond(readBond(args, 'amount')),

  resolver_add_bond: (context, args) => resolverOf(context).addBond(readBond(args, 'amount')),

  resolver_commit_score: (context, args) =>
    resolverOf(context).commit({ disputeId: readDisputeId(args), score: readScore(args) }),

  resolver_reveal_score: (context, args) =>
    resolverOf(context).reveal({
      disputeId: readDisputeId(args),
      score: readScore(args),
      salt: readBytes32(args, 'salt'),
    }),

  resolver_finalize_dispute: (context, args) => resolverOf(context).finalize(readDisputeId(args)),

  resolver_fail_dispute: (context, args) => resolverOf(context).fail(readDisputeId(args)),

  resolver_claim_rewards: (context) => resolverOf(context).claimRewards(),

  resolver_request_unbond: (context) => resolverOf(context).requestUnbond(),

  resolver_complete_unbond: (context) => resolverOf(context).completeUnbond(),

  resolver_cancel_unbond: (context) => resolverOf(context).cancelUnbond(),

  provider_status: (context) => providerOf(context).status(),

  provider_reputation: (context) => providerOf(context).reputation(),

  provider_register: (context, args) =>
    providerOf(context).register({ name: readString(args, 'name'), stake: readAmount(args, 'stake') }),

  provider_add_stake: (context, args) => providerOf(context).addStake(readAmount(args, 'amount')),

  provider_request_withdrawal: (context, args) =>
    providerOf(context).requestWithdrawal(readAmount(args, 'amount')),

  provider_execute_withdrawal: (context) => providerOf(context).executeWithdrawal(),

  provider_cancel_withdrawal: (context) => providerOf(context).cancelWithdrawal(),

  provider_deactivate: (context) => providerOf(context).deactivate(),

  provider_reactivate: (context) => providerOf(context).reactivate(),

  ...Object.fromEntries(
    Object.entries(COLLATERAL_HANDLERS).map(([name, run]) => [
      name,
      (context: ToolContext, args: Record<string, unknown>) => run(collateralOf(context), args),
    ]),
  ),
};

function collateralOf(context: ToolContext): CollateralGateway {
  const gateway = context.collateral ?? null;
  if (gateway === null) {
    throw new ToolError(
      'collateral_unavailable',
      'This server is not bound to a mandate on a chain that offers collateral-backed credit.',
    );
  }
  return gateway;
}

/** What a tool that needs a signer says when this server has none to send it to. */
const SIGNER_NEEDED: Readonly<Record<SignedRole, string>> = {
  mandate: 'the signer that submits transactions for this mandate',
  resolver: 'the signer that holds the resolver address this server votes as',
  provider: 'the signer that holds the provider address this server is listed under',
};

/** Runs one tool call and returns the JSON text an MCP client receives. */
export async function callTool(context: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  try {
    const definition = TOOLS.find((tool) => tool.name === name);
    const handler = HANDLERS[name];

    if (definition === undefined || handler === undefined) {
      throw new ToolError('unknown_tool', `This server does not serve a tool called ${name}.`);
    }

    if (definition.role === 'shielded_float' && definition.writes && (context.shielded?.relayerUrl ?? null) === null && context.shielded?.float) {
      throw new ToolError(
        'relayer_unconfigured',
        `${name} is sent by the relayer, so it never comes from a wallet the owner has used. Set ` +
          'BURSAR_RELAYER_URL, then restart it.',
      );
    }

    if (
      definition.writes &&
      definition.role !== 'private' &&
      definition.role !== 'shielded' &&
      definition.role !== 'shielded_float' &&
      definition.role !== 'collateral' &&
      !context.canSign[definition.role]
    ) {
      throw new ToolError(
        'relay_unconfigured',
        `${name} sends a transaction, and this server has no signer for it. Set BURSAR_RELAY_URL to ` +
          `${SIGNER_NEEDED[definition.role]}, then restart it.`,
      );
    }

    return { text: serialize(context, await handler(context, validate(definition.inputSchema, args))), isError: false };
  } catch (error) {
    const view = describe(error);

    // The reply to the model is kept to sentences this server wrote, so the library's own text
    // goes to the operator instead of nowhere. Without this the reply points at a log with
    // nothing in it.
    if (!(error instanceof ToolError)) {
      context.report?.(JSON.stringify({ tool: name, error: view.error, cause: causeOf(error) }));
    }

    return { text: serialize(context, view), isError: true };
  }
}

/** The name and message of a failure, one line, for the operator's log. */
function causeOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const short = (error as { shortMessage?: unknown }).shortMessage;

  return `${error.name}: ${typeof short === 'string' ? short : error.message}`.replace(/\s+/gu, ' ');
}

export type ErrorView = {
  readonly error: string;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
};

const CALL_FAILED =
  'This server could not complete the call, and the reason stayed inside the process where the operator ' +
  'reads it. If it was a payment, do not send it again until mandate_list_settlements shows whether it ' +
  'landed: a call that fails on the way out can still have reached the chain. Any other call can be tried again.';

/**
 * A read that came back empty. The address holds no contract of the kind this server was told it
 * is, which is configuration: asking again gets the same empty answer.
 */
const NO_CONTRACT =
  'A contract this server reads answered with nothing, so the address it is configured with holds no ' +
  'contract of that kind on this chain. Retrying will not change that. The operator has to correct ' +
  'MANDATE_ACCOUNT, or the contract address overrides, and restart the server.';

/** A revert this server has no sentence for. The name goes in the detail beside it. */
const CALL_REVERTED = 'The contract refused this call, and this server has no reading for the name it gave.';

/** The same, with nothing to name it by. */
const CALL_REVERTED_UNNAMED =
  'The contract refused this call and gave no reason with it. Some nodes drop the reason: try once more, ' +
  'and tell the operator if it comes back empty again.';

/** What a contract refusal looks like once it is out of whichever error wrapped it. */
type Reverted = {
  /** The Solidity error name, or the reason string of a `require`. Null when the revert carried neither. */
  readonly name: string | null;
};

/**
 * The contract refusal inside a failure, read by shape.
 *
 * `instanceof` holds only for the copy of viem that threw, and a workspace resolving two copies is
 * ordinary. A miss used to fall through to the branch that handed the model viem's whole message:
 * the contract address, the encoded calldata and a docs URL, on an error class this server never
 * wrote a word of.
 */
function revertedIn(error: unknown): Reverted | undefined {
  let node: unknown = error;

  for (let depth = 0; depth < 8 && isJsonObject(node); depth += 1) {
    if (node['name'] === 'ContractFunctionRevertedError') {
      const data = node['data'];
      const decoded = isJsonObject(data) ? data['errorName'] : undefined;
      const reason = node['reason'];

      if (typeof decoded === 'string') return { name: oneLine(decoded) };

      return { name: typeof reason === 'string' ? oneLine(reason) : null };
    }

    node = node['cause'];
  }

  return undefined;
}

/** A revert reason is on-chain text of any length, and one line of it is enough to report. */
function oneLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? value;

  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * Reduces a failure to the one line a caller can act on.
 *
 * Every sentence that leaves here was written for this server. Library text is not forwarded at
 * all, which is the only version of the promise above this file can keep: viem folds the contract
 * address, the calldata, the sender and a docs URL into `message`, and several of its classes put
 * the node's raw response there too.
 */
function describe(error: unknown): ErrorView {
  if (error instanceof ToolError) {
    return Object.keys(error.detail).length === 0
      ? { error: error.code, message: error.message }
      : { error: error.code, message: error.message, detail: { ...error.detail } };
  }

  // The SDK's word for a write that was sent and not read back. It has to reach the caller as such:
  // reduced to call_failed it would read as a payment that never happened.
  if (isBursarError(error) && error.code === 'receipt_timeout') {
    return { error: 'signer_unconfirmed', message: error.message, detail: { ...error.details } };
  }

  if (returnedNoData(error)) return { error: 'no_contract', message: NO_CONTRACT };

  const reverted = revertedIn(error);

  if (reverted) {
    const refusal = reverted.name === null ? null : refusalForName(reverted.name);

    if (refusal) {
      return { error: 'mandate_refused', message: refusal.message, detail: { revert: refusal.code } };
    }

    return reverted.name === null
      ? { error: 'call_reverted', message: CALL_REVERTED_UNNAMED }
      : { error: 'call_reverted', message: CALL_REVERTED, detail: { revert: reverted.name } };
  }

  return { error: 'call_failed', message: CALL_FAILED };
}

function serialize(context: ToolContext, payload: unknown): string {
  return redactSecrets(JSON.stringify(payload, null, 2), context.secrets);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Removes configured secrets from text on its way out. Short values are skipped: a two-character
 * secret would redact half the payload.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => {
    const body = secret.startsWith('0x') ? secret.slice(2) : secret;

    if (body.length < 8) return redacted;

    return redacted.replace(new RegExp(escapeRegExp(body), 'giu'), '[redacted]');
  }, text);
}

function readString(args: Record<string, unknown>, name: string): string {
  const value = args[name];

  if (typeof value !== 'string') throw invalidArguments(`${name} must be a string`);

  return value;
}

function readInteger(args: Record<string, unknown>, name: string): number {
  const value = args[name];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidArguments(`${name} must be a whole number`);
  }

  return value;
}

function readObject(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];

  if (!isJsonObject(value)) throw invalidArguments(`${name} must be a JSON object`);

  return value;
}

function readAddress(args: Record<string, unknown>, name: string): Address {
  const value = readString(args, name);

  // Casing is not checked: the contracts compare raw addresses, and rejecting an all-lowercase
  // address would reject the form most tools print.
  if (!isAddress(value, { strict: false })) {
    throw invalidArguments(`${name} must be a 0x-prefixed 20-byte address`);
  }

  return value;
}

function readAmount(args: Record<string, unknown>, name: string, label = name): Micro {
  const amount = toMicro(readString(args, name));

  if (amount === 0n) throw invalidArguments(`${label} must be greater than zero`);
  if (amount > UINT128_MAX) throw invalidArguments(`${label} is larger than the escrow can hold`);

  return amount;
}

/** A BRSR figure. Branded nowhere, but kept out of the money path and checked on its own scale. */
function readBond(args: Record<string, unknown>, name: string): bigint {
  const raw = readString(args, name);

  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw invalidArguments(`${name} must be ${BOND_UNIT}`);
  }

  const amount = BigInt(raw);

  if (amount === 0n) throw invalidArguments(`${name} must be greater than zero`);
  if (amount > UINT128_MAX) throw invalidArguments(`${name} is larger than a bond can be held in`);

  return amount;
}

function readDisputeId(args: Record<string, unknown>): bigint {
  return readId(args, 'disputeId');
}

/**
 * An id the registry or the escrow issued, which is a uint256. A larger one names nothing, and
 * viem would refuse to encode it with library text this server does not forward.
 */
function readId(args: Record<string, unknown>, name: string): bigint {
  const value = args[name];
  const id =
    typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
      ? BigInt(value)
      : typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? BigInt(value)
        : null;

  if (id === null) throw invalidArguments(`${name} must be a decimal string or a whole number of at least 1`);
  if (id > UINT256_MAX) throw invalidArguments(`${name} is larger than any id the chain can issue`);

  return id;
}

function readScore(args: Record<string, unknown>): number {
  const score = readInteger(args, 'score');

  if (score < 0 || score > 100) {
    throw invalidArguments(
      'score must be a whole number from 0 to 100, where 0 is nothing delivered and 100 is delivered ' +
        'as agreed',
    );
  }

  return score;
}

function readBytes32(args: Record<string, unknown>, name: string): Hex {
  const value = readString(args, name);

  if (!isHex(value) || value.length !== 66) throw invalidArguments(`${name} must be 32 bytes of hex`);

  return value;
}

/**
 * The brief, read into the one shape both halves hash.
 *
 * Every field is checked here rather than trusted from the schema, because what comes out of this
 * is committed on chain and cannot be corrected afterwards.
 */
function readJobSpec(args: Record<string, unknown>): JobSpecInput {
  const task = readString(args, 'task');
  const rawAcceptance = args['acceptance'];

  if (rawAcceptance !== undefined && !Array.isArray(rawAcceptance)) {
    throw invalidArguments('acceptance must be an array of lines');
  }

  const acceptance = (rawAcceptance ?? []).map((line, index) => {
    if (typeof line !== 'string') throw invalidArguments(`acceptance[${index}] must be a string`);

    return line;
  });

  return {
    task,
    input: args['input'] === undefined ? null : readObject(args, 'input'),
    acceptance,
  };
}

function jobSpecOf(job: JobSpecInput): JobSpec {
  return { task: job.task, acceptance: job.acceptance, ...(job.input === null ? {} : { input: job.input }) };
}

function readSettlementId(args: Record<string, unknown>): bigint {
  return readId(args, 'settlementId');
}

function readProof(args: Record<string, unknown>): readonly Hex[] {
  const value = args['providerProof'];

  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidArguments('providerProof must be an array');

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !isHex(entry) || entry.length !== 66) {
      throw invalidArguments(`providerProof[${index}] must be 32 bytes of hex`);
    }

    return entry;
  });
}

function readApproval(args: Record<string, unknown>): ApprovalInput | null {
  const value = args['approval'];

  if (value === undefined) return null;
  if (!isJsonObject(value)) throw invalidArguments('approval must be a JSON object');

  const approvalId = readString(value, 'approvalId');

  if (!isHex(approvalId) || approvalId.length !== 66) {
    throw invalidArguments('approval.approvalId must be 32 bytes of hex');
  }

  const signature = value['signature'];

  if (signature !== undefined && (typeof signature !== 'string' || !isHex(signature))) {
    throw invalidArguments('approval.signature must be 0x-prefixed hex');
  }

  return {
    approvalId,
    amount: readAmount(value, 'amount', 'approval.amount'),
    expiry: readInteger(value, 'expiry'),
    signature: signature === undefined ? null : signature,
  };
}
