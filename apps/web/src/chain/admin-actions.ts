/**
 * Every call the timelock can make, as a form and as a sentence.
 *
 * A signer approving a two-day change should not have to read four bytes and a hex blob. This
 * module is the one place that knows which setters exist, what each argument means in the words
 * a reader uses, what the contract itself refuses, and how to say a finished call out loud. The
 * builder on the governance page writes calldata through it, and every pending proposal is read
 * back through the same table, so the sentence under a proposal and the sentence under the form
 * that made it cannot drift apart.
 *
 * Validation here mirrors the contract's own checks. It is a courtesy, not a gate: the contract
 * refuses the same things on chain, two days later, after the delay has already been spent.
 */
import { decodeFunctionData, encodeFunctionData, formatUnits, getAddress, isAddress, slice } from 'viem';
import type { Abi, AbiFunction, Address, Hex } from 'viem';

import { collateralDeployment, deploymentsForChain, micro } from '@bursar/core';
import type { MandateContractName, Micro } from '@bursar/core';

import { brsr } from '../money';
import type { Brsr } from '../money';
import { ADDRESSES, CHAIN_ID } from './rhc';
import {
  adminTimelockAbi,
  agentRegistryAbi,
  escrowAbi,
  mandateAccountFactoryAbi,
  oracleRegistryAbi,
  reputationAbi,
  settlementAssetAbi,
} from './abi';
import { TOKEN_ADDRESSES, brsrAbi, buybackAbi, stakingAbi, vestingAbi } from './generated/token';
import { formatDuration } from '../lib/time';

// The contracts a proposal can target

export type GovernedKey =
  | 'agentRegistry'
  | 'escrow'
  | 'oracleRegistry'
  | 'reputation'
  | 'mandateAccountFactory'
  | 'adminTimelock'
  | 'usdg'
  | 'brsr'
  | 'staking'
  | 'vesting'
  | 'buyback';

export type GovernedContract = {
  readonly key: GovernedKey;
  /** What the product calls it. Used in every sentence a reader sees. */
  readonly name: string;
  readonly abi: Abi;
  /** Lazy: the core address book throws when the deployment record is absent, and a module that
   *  resolves at import would take the whole page down with it. */
  readonly address: () => Address;
};

export const GOVERNED: readonly GovernedContract[] = [
  { key: 'agentRegistry', name: 'the provider registry', abi: agentRegistryAbi as Abi, address: () => ADDRESSES.agentRegistry },
  { key: 'escrow', name: 'the escrow', abi: escrowAbi as Abi, address: () => ADDRESSES.escrow },
  { key: 'oracleRegistry', name: 'the dispute registry', abi: oracleRegistryAbi as Abi, address: () => ADDRESSES.oracleRegistry },
  { key: 'reputation', name: 'reputation', abi: reputationAbi as Abi, address: () => ADDRESSES.reputation },
  {
    key: 'mandateAccountFactory',
    name: 'the mandate account factory',
    abi: mandateAccountFactoryAbi as Abi,
    address: () => ADDRESSES.mandateAccountFactory,
  },
  { key: 'adminTimelock', name: 'the governance delay itself', abi: adminTimelockAbi as Abi, address: () => ADDRESSES.adminTimelock },
  { key: 'usdg', name: 'USDG', abi: settlementAssetAbi as Abi, address: () => ADDRESSES.usdg },
  { key: 'brsr', name: 'the token', abi: brsrAbi as Abi, address: () => TOKEN_ADDRESSES.BRSR },
  { key: 'staking', name: 'the staking pool', abi: stakingAbi as Abi, address: () => TOKEN_ADDRESSES.Staking },
  { key: 'vesting', name: 'the vesting contract', abi: vestingAbi as Abi, address: () => TOKEN_ADDRESSES.Vesting },
  { key: 'buyback', name: 'the buyback', abi: buybackAbi as Abi, address: () => TOKEN_ADDRESSES.Buyback },
];

export function governedByKey(key: GovernedKey): GovernedContract {
  const found = GOVERNED.find((entry) => entry.key === key);
  // The union above is closed and every member is in the table, so this cannot be reached from
  // typed code. It exists so an untyped caller gets a sentence rather than undefined.
  if (!found) throw new Error(`No governed contract named ${key}.`);
  return found;
}

/**
 * The contracts the guardian's brake reaches. Each has a `pause()` that answers one address: the
 * escrow's pauser, and every other one's admin. Which timelock that is differs by contract, so the
 * page reads it rather than assuming the current one. Reputation, the factory and the token carry
 * no pause.
 */
export const PAUSABLE: readonly GovernedKey[] = ['escrow', 'oracleRegistry', 'agentRegistry', 'staking', 'buyback'];

/** The function naming the address a pausable contract lets call `pause()`. */
export function pauseControllerOf(key: GovernedKey): 'admin' | 'pauser' {
  return key === 'escrow' ? 'pauser' : 'admin';
}

// Fields

export type FieldKind = 'usdg' | 'brsr' | 'seconds' | 'bps' | 'count' | 'score' | 'address' | 'bytes32' | 'index';

export type AdminField = {
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  /** What the number means once it is on chain. Shown under the input. */
  readonly help: string;
  readonly placeholder?: string;
};

export type AdminShape =
  | { readonly kind: 'none' }
  | { readonly kind: 'fields'; readonly fields: readonly AdminField[] }
  | { readonly kind: 'rows'; readonly row: readonly AdminField[]; readonly maxRows: number; readonly rowLabel: string };

export type AdminAction = {
  readonly id: string;
  readonly contract: GovernedKey;
  readonly functionName: string;
  /** Imperative, in the reader's words. What the select shows. */
  readonly label: string;
  /** What it does and what follows from it, once, in one or two sentences. */
  readonly consequence: string;
  readonly shape: AdminShape;
  /**
   * Kept so a proposal already on chain still reads back in words, and left out of the builder:
   * the handover it completes has already happened, so proposing it again would be refused.
   */
  readonly retired?: true;
};

const USDG_DECIMALS = 6;
const BRSR_DECIMALS = 18;

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

const DAY = 86_400n;

/** Contract-side ceilings this build mirrors so a form can refuse before a two-day wait does. */
export const LIMITS = {
  bps: 10_000n,
  agentRegistrySlashBps: 5_000n,
  stakingRebateBps: 5_000n,
  stakingTiers: 8,
  stakingMinUnbonding: 7n * DAY,
  stakingMaxUnbonding: 90n * DAY,
  stakingMinUnbondWindow: DAY,
  stakingMaxUnbondWindow: 30n * DAY,
  stakingMinExitHold: DAY,
  stakingMaxExitHold: 30n * DAY,
  stakingMinSlashWindow: DAY,
  stakingMaxSlashWindow: 90n * DAY,
  /** The dispute registry seats at most this many resolvers, and every dispute has to seat them all. */
  oracleRoster: 64n,
  oracleMinWindow: 600n,
  scoreMax: 100n,
  buybackMaxPriceMicroUsd: 1_000_000_000_000n,
  buybackMaxWindow: 30n * DAY,
  buybackMinCeilingAge: DAY,
  buybackMaxCeilingAge: 30n * DAY,
} as const;

// The catalogue

export const ADMIN_ACTIONS: readonly AdminAction[] = [
  {
    id: 'agentRegistry.acceptAdmin',
    contract: 'agentRegistry',
    functionName: 'acceptAdmin',
    label: 'Take administration of the provider registry',
    consequence: 'Completes a handover the provider registry has already started.',
    shape: { kind: 'none' },
    retired: true,
  },
  {
    id: 'reputation.setCurve',
    contract: 'reputation',
    functionName: 'setCurve',
    label: 'Set the payee spending cap curve',
    consequence:
      'Reputation publishes a ceiling per payee from their settlement history. Raising it lets one payee that turns out to be wrong take more before anyone notices.',
    shape: {
      kind: 'fields',
      fields: [
        {
          name: 'baseCap',
          label: 'Cap at a score of zero',
          kind: 'usdg',
          help: 'What a payee with no settled history may be paid in one payment.',
          placeholder: '25.00',
        },
        {
          name: 'capPerScore',
          label: 'Added per score point',
          kind: 'usdg',
          help: 'A score runs 0 to 100 and is the share of a payee’s jobs that released cleanly.',
          placeholder: '2.25',
        },
        {
          name: 'maxCap',
          label: 'Ceiling',
          kind: 'usdg',
          help: 'The curve stops here whatever the score. It cannot be below the cap at zero, or above what a perfect score reaches.',
          placeholder: '250.00',
        },
      ],
    },
  },
  {
    id: 'reputation.acceptAdmin',
    contract: 'reputation',
    functionName: 'acceptAdmin',
    label: 'Take administration of reputation',
    consequence: 'Completes a handover that reputation has already started. It does nothing unless the timelock is the incoming admin.',
    shape: { kind: 'none' },
    retired: true,
  },
  {
    id: 'oracleRegistry.setConfig',
    contract: 'oracleRegistry',
    functionName: 'setConfig',
    label: 'Set the dispute rules',
    consequence:
      'Disputes already open keep the windows they were opened with, so this cannot move a clock resolvers are voting against. Quorum and the deviation band are read when a vote closes. Every seated resolver may vote on every dispute.',
    shape: {
      kind: 'fields',
      fields: [
        {
          name: 'commitWindow',
          label: 'Time to commit',
          kind: 'seconds',
          help: 'How long resolvers have to post a sealed score. At least ten minutes.',
          placeholder: '21600',
        },
        {
          name: 'revealWindow',
          label: 'Time to reveal',
          kind: 'seconds',
          help: 'How long they then have to open it. At least ten minutes.',
          placeholder: '21600',
        },
        {
          name: 'unbondingPeriod',
          label: 'Bond exit wait',
          kind: 'seconds',
          help: 'Has to cover both windows, or a bond matures before the dispute it voted in can settle.',
          placeholder: '604800',
        },
        {
          name: 'quorum',
          label: 'Reveals needed',
          kind: 'count',
          help: 'Fewer than this and the dispute fails rather than rules. Between 1 and 64.',
          placeholder: '2',
        },
        {
          name: 'maxVoters',
          label: 'Resolvers per dispute',
          kind: 'count',
          help: 'At least 64, the size of the roster, so every seated resolver can vote and none is crowded out by whoever commits first.',
          placeholder: '64',
        },
        {
          name: 'maxDeviation',
          label: 'Deviation band',
          kind: 'score',
          help: 'Score points from the median. Outside it a resolver is slashed and earns no share.',
          placeholder: '20',
        },
        { name: 'slashBps', label: 'Slash on a bad vote', kind: 'bps', help: 'Share of the resolver’s bond taken. Zero is refused.', placeholder: '1000' },
      ],
    },
  },
  {
    id: 'oracleRegistry.evict',
    contract: 'oracleRegistry',
    functionName: 'evict',
    label: 'Unseat a resolver',
    consequence:
      'Takes a resolver off the 64-seat roster and returns what is left of its bond, so a seat slashed to nothing or left idle does not hold the roster for good. The registry refuses while a vote that bond backs is still open.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'resolver', label: 'Resolver', kind: 'address', help: 'The resolver key to unseat. Its bond goes back to that address.' }],
    },
  },
  {
    id: 'oracleRegistry.setSlashSink',
    contract: 'oracleRegistry',
    functionName: 'setSlashSink',
    label: 'Change where slashed resolver bonds go',
    consequence: 'Bonds taken from resolvers who voted outside the band are sent here. It cannot be the zero address.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'slashSink_', label: 'Recipient', kind: 'address', help: 'Receives slashed BRSR from this point on. Balances already sent are not moved.' }],
    },
  },
  {
    id: 'oracleRegistry.acceptAdmin',
    contract: 'oracleRegistry',
    functionName: 'acceptAdmin',
    label: 'Take administration of the dispute registry',
    consequence: 'Completes a handover the dispute registry has already started.',
    shape: { kind: 'none' },
    retired: true,
  },
  {
    id: 'agentRegistry.setMinStake',
    contract: 'agentRegistry',
    functionName: 'setMinStake',
    label: 'Set the provider stake floor',
    consequence:
      'Binds on the next registration and on partial withdrawals. Nobody already registered is deregistered, and a provider under a raised floor can still deactivate and exit in full.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'newMinStake', label: 'Floor', kind: 'usdg', help: 'Posted in USDG. Zero is refused.', placeholder: '5.00' }],
    },
  },
  {
    id: 'agentRegistry.setSlashBps',
    contract: 'agentRegistry',
    functionName: 'setSlashBps',
    label: 'Set the provider slash share',
    consequence: 'The share of a provider’s stake a ruling takes. Capped at 50% by the contract, and zero is refused.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'newSlashBps', label: 'Share taken', kind: 'bps', help: '1000 is 10%. The contract refuses anything above 5000.', placeholder: '1000' }],
    },
  },
  {
    id: 'agentRegistry.setSlasher',
    contract: 'agentRegistry',
    functionName: 'setSlasher',
    label: 'Name or clear a second address that may rule against provider stake',
    consequence:
      'No contract in this deployment can size a ruling, so nothing calls this today. Naming an address that can take stake before one exists gives away the power without the check on it. The zero address clears it.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'newSlasher', label: 'Address', kind: 'address', help: 'The zero address clears the slot and leaves nobody able to call it.' }],
    },
  },
  {
    id: 'agentRegistry.setSlashSink',
    contract: 'agentRegistry',
    functionName: 'setSlashSink',
    label: 'Change where slashed provider stake goes',
    consequence: 'Stake taken from a provider is sent here. It cannot be the zero address.',
    shape: { kind: 'fields', fields: [{ name: 'newSlashSink', label: 'Recipient', kind: 'address', help: 'Receives slashed USDG from this point on.' }] },
  },
  {
    id: 'agentRegistry.setBlacklistRoot',
    contract: 'agentRegistry',
    functionName: 'setBlacklistRoot',
    label: 'Set the provider exclusion root',
    consequence: 'A zero root turns the gate off rather than barring everyone. The per-agent flag keeps working either way.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'root', label: 'Root', kind: 'bytes32', help: '32 bytes, written as 0x followed by 64 hex characters.', placeholder: '0x00…' }],
    },
  },
  {
    id: 'agentRegistry.unpause',
    contract: 'agentRegistry',
    functionName: 'unpause',
    label: 'Restart the provider registry',
    consequence:
      'Restarting waits out the full delay. The guardian can stop a contract in the same block and cannot start one, which is what makes a stolen guardian key an outage rather than a loss.',
    shape: { kind: 'none' },
  },
  {
    id: 'escrow.unpause',
    contract: 'escrow',
    functionName: 'unpause',
    label: 'Restart the escrow',
    consequence: 'Restarting waits out the full delay. While the escrow is stopped, new payments cannot lock and new disputes cannot open; releases and refunds of existing locks continue.',
    shape: { kind: 'none' },
  },
  {
    id: 'oracleRegistry.unpause',
    contract: 'oracleRegistry',
    functionName: 'unpause',
    label: 'Restart the dispute registry',
    consequence: 'Restarting waits out the full delay. While the registry is stopped, resolvers cannot join, add bond or commit votes.',
    shape: { kind: 'none' },
  },
  {
    id: 'staking.setBondFloor',
    contract: 'staking',
    functionName: 'setBondFloor',
    label: 'Set one resolver’s bond floor',
    consequence: 'Overrides the resolver bond floor for one address. Zero returns that resolver to the floor everyone else is held to.',
    shape: {
      kind: 'fields',
      fields: [
        { name: 'resolver', label: 'Resolver', kind: 'address', help: 'The resolver key this floor applies to.' },
        { name: 'amount', label: 'Floor', kind: 'brsr', help: 'Zero removes the override.', placeholder: '25000' },
      ],
    },
  },
  {
    id: 'staking.setTiers',
    contract: 'staking',
    functionName: 'setTiers',
    label: 'Set the staking fee rebate tiers',
    consequence:
      'The table decides how much a staked balance takes off the settlement fee on the staker’s own payouts. It ships empty, so every rebate reads zero until this lands. At most eight rungs, ascending in both columns, and no rung above 50%.',
    shape: {
      kind: 'rows',
      rowLabel: 'Rung',
      maxRows: LIMITS.stakingTiers,
      row: [
        { name: 'minStake', label: 'Staked at least', kind: 'brsr', help: 'Has to be higher than the rung above it.', placeholder: '25000' },
        { name: 'rebateBps', label: 'Off the settlement fee', kind: 'bps', help: '500 is 5%. Has to be higher than the rung above it, and at most 5000.', placeholder: '500' },
      ],
    },
  },
  {
    id: 'staking.setCreditManager',
    contract: 'staking',
    functionName: 'setCreditManager',
    label: 'Name the credit manager on the staking pool',
    consequence:
      'The one address the staking pool accepts spread from. It cannot take stake; that is the slasher’s. The zero address clears it.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'account', label: 'Credit manager', kind: 'address', help: 'The zero address is legal here and stops spread arriving.' }],
    },
  },
  {
    id: 'staking.setSlasher',
    contract: 'staking',
    functionName: 'setSlasher',
    label: 'Name the slasher on the staking pool',
    consequence:
      'The one address that can take stake to cover a loss on collateral-backed credit, never more than the slash cap allows. The credit pool slashes when it writes off a line, converting the loss to BRSR at the buyback’s price ceiling. The zero address leaves nobody able to take stake.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'account', label: 'Slasher', kind: 'address', help: 'Usually the credit pool. The zero address clears it.' }],
    },
  },
  {
    id: 'staking.setSlashLimit',
    contract: 'staking',
    functionName: 'setSlashLimit',
    label: 'Set how much of the staking pool a slash can take',
    consequence:
      'The cap is the most one slash takes, as a share of the pool, and the window is how long a used allowance takes to refill. What recent slashes used carries over as it stands, so a change neither hands the slasher a fresh allowance nor takes back what has refilled.',
    shape: {
      kind: 'fields',
      fields: [
        { name: 'capBps', label: 'Most one slash takes', kind: 'bps', help: '1000 is 10% of the pool. Zero is refused.', placeholder: '1000' },
        { name: 'window', label: 'Refill window', kind: 'seconds', help: 'Between 1 and 90 days.', placeholder: '604800' },
      ],
    },
  },
  {
    id: 'staking.setUnbondingPeriod',
    contract: 'staking',
    functionName: 'setUnbondingPeriod',
    label: 'Set the staking exit wait',
    consequence:
      'Applies to requests already pending, in both directions, so a staker cannot freeze the old period by asking to leave ahead of the change. Between 7 and 90 days.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'period', label: 'Wait', kind: 'seconds', help: 'Between a withdrawal request and the withdrawal.', placeholder: '604800' }],
    },
  },
  {
    id: 'staking.setUnbondWindow',
    contract: 'staking',
    functionName: 'setUnbondWindow',
    label: 'Set how long a ready staking exit stays open',
    consequence:
      'Once the exit wait is over, a request can complete for this long and then lapses until it is put back to work. Applies to requests already pending. Between 1 and 30 days.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'window', label: 'Open for', kind: 'seconds', help: 'Counted from the moment a request is ready.', placeholder: '604800' }],
    },
  },
  {
    id: 'staking.setMaxExitHold',
    contract: 'staking',
    functionName: 'setMaxExitHold',
    label: 'Set how long a pause may hold staking exits',
    consequence:
      'A pause keeps ready exits from completing for at most this long, then lets them through while the pool stays paused. The time held is added to every pending request. Takes effect from the next pause. Between 1 and 30 days.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'hold', label: 'Longest hold', kind: 'seconds', help: 'Counted from the moment the pool is paused.', placeholder: '604800' }],
    },
  },
  {
    id: 'staking.setMinBond',
    contract: 'staking',
    functionName: 'setMinBond',
    label: 'Set the resolver bond floor',
    consequence: 'The least BRSR a resolver has to hold in the pool before the dispute registry accepts a bond. Read live on every vote. Zero is refused.',
    shape: { kind: 'fields', fields: [{ name: 'amount', label: 'Floor', kind: 'brsr', help: 'Per resolver.', placeholder: '25000' }] },
  },
  {
    id: 'staking.setTreasury',
    contract: 'staking',
    functionName: 'setTreasury',
    label: 'Change where the staking pool sends unallocated rewards',
    consequence: 'Rewards that arrived with nobody staked to receive them are swept here. It cannot be the zero address.',
    shape: { kind: 'fields', fields: [{ name: 'account', label: 'Recipient', kind: 'address', help: 'Receives swept unallocated USDG.' }] },
  },
  {
    id: 'staking.unpause',
    contract: 'staking',
    functionName: 'unpause',
    label: 'Restart the staking pool',
    consequence:
      'Restarting waits out the full delay. While the pool is paused it takes no new stake and holds ready exits for at most its exit hold; exit requests, cancellations and claims stay open.',
    shape: { kind: 'none' },
  },
  {
    id: 'staking.acceptAdmin',
    contract: 'staking',
    functionName: 'acceptAdmin',
    label: 'Take administration of the staking pool',
    consequence: 'Completes a handover the staking pool has already started.',
    shape: { kind: 'none' },
    retired: true,
  },
  {
    id: 'buyback.setParams',
    contract: 'buyback',
    functionName: 'setParams',
    label: 'Set the buyback limits and price ceiling',
    consequence:
      'All six move together. The ceiling is the most the buyback will pay for one whole BRSR, and a ceiling of zero refuses every trade. Every change restates the ceiling and restarts its age, so even a proposal that only moves the spend has to carry a ceiling somebody is prepared to sign today. Set it against the pool’s price.',
    shape: {
      kind: 'fields',
      fields: [
        { name: 'spendPerCallMicroUsd', label: 'Target spend per call', kind: 'usdg', help: 'The actual spend is this, the balance, or the window headroom, whichever is smallest.', placeholder: '0.50' },
        { name: 'maxSpendPerWindowMicroUsd', label: 'Ceiling per window', kind: 'usdg', help: 'Total spend inside one window. Has to be at least the per-call target.', placeholder: '5.00' },
        { name: 'minSpendMicroUsd', label: 'Refuse below', kind: 'usdg', help: 'A dust buy costs more gas than it moves and hands an observer a cheap price print.', placeholder: '0.10' },
        {
          name: 'maxPriceMicroUsdPerBrsr',
          label: 'Most it will pay for one BRSR',
          kind: 'usdg',
          help: 'Zero refuses every trade. This is the number that decides whether the buyback can be front-run, and no code can tell whether it was set honestly.',
          placeholder: '0.05',
        },
        { name: 'window', label: 'Window', kind: 'seconds', help: 'The period the spend ceiling is counted over. At most 30 days.', placeholder: '86400' },
        { name: 'minInterval', label: 'Wait between buys', kind: 'seconds', help: 'Longer than the window puts the ceiling out of reach.', placeholder: '3600' },
      ],
    },
  },
  {
    id: 'buyback.setKeeper',
    contract: 'buyback',
    functionName: 'setKeeper',
    label: 'Name the buyback keeper',
    consequence:
      'The only address that can trigger a buy. Keeping it to one named key stops anyone from wrapping a buy inside a transaction of their own. The zero address leaves nobody able to trigger one.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'keeper_', label: 'Keeper', kind: 'address', help: 'A key that sends buys on a schedule. The zero address stops buys without a pause.' }],
    },
  },
  {
    id: 'buyback.setMaxCeilingAge',
    contract: 'buyback',
    functionName: 'setMaxCeilingAge',
    label: 'Set how long a buyback price ceiling stays usable',
    consequence:
      'After this long without a new ceiling every buy is refused until governance sets one again. Counted from the last time the limits were set. Between 1 and 30 days.',
    shape: {
      kind: 'fields',
      fields: [{ name: 'age', label: 'Usable for', kind: 'seconds', help: 'A market moves; a week is the default.', placeholder: '604800' }],
    },
  },
  {
    id: 'buyback.unpause',
    contract: 'buyback',
    functionName: 'unpause',
    label: 'Restart the buyback',
    consequence: 'Restarting waits out the full delay.',
    shape: { kind: 'none' },
  },
  {
    id: 'buyback.acceptAdmin',
    contract: 'buyback',
    functionName: 'acceptAdmin',
    label: 'Take administration of the buyback',
    consequence: 'Completes a handover the buyback has already started.',
    shape: { kind: 'none' },
    retired: true,
  },
  {
    id: 'adminTimelock.setGuardian',
    contract: 'adminTimelock',
    functionName: 'setGuardian',
    label: 'Hand the brake to a different key',
    consequence:
      'The old guardian loses the pause the moment this executes. The guardian cannot be one of the three signers: the key that has to be reachable in seconds should not also carry one of the two approvals a change needs.',
    shape: { kind: 'fields', fields: [{ name: 'newGuardian', label: 'New guardian', kind: 'address', help: 'Cannot be a signer and cannot be the zero address.' }] },
  },
  {
    id: 'adminTimelock.updateSigner',
    contract: 'adminTimelock',
    functionName: 'updateSigner',
    label: 'Rotate one of the three signers',
    consequence:
      'Approvals are counted over the current set, never stored, so the replaced key stops carrying every proposal it had approved. Check what is pending before this lands.',
    shape: {
      kind: 'fields',
      fields: [
        { name: 'index', label: 'Seat', kind: 'index', help: '0, 1 or 2, in the order the signers are listed above.', placeholder: '0' },
        { name: 'newSigner', label: 'New signer', kind: 'address', help: 'Cannot already be a signer, cannot be the guardian, cannot be the zero address.' },
      ],
    },
  },
];

export function actionById(id: string): AdminAction | undefined {
  return ADMIN_ACTIONS.find((action) => action.id === id);
}

// Building calldata

export type AdminDraft = {
  readonly values: Readonly<Record<string, string>>;
  readonly rows: readonly Readonly<Record<string, string>>[];
};

export function emptyDraft(action: AdminAction): AdminDraft {
  if (action.shape.kind === 'rows') return { values: {}, rows: [blankRow(action.shape.row)] };
  return { values: {}, rows: [] };
}

export function blankRow(fields: readonly AdminField[]): Record<string, string> {
  const row: Record<string, string> = {};
  for (const field of fields) row[field.name] = '';
  return row;
}

export type BuiltCall =
  | { readonly ok: true; readonly target: Address; readonly data: Hex; readonly args: readonly unknown[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Turns a filled-in form into the calldata a proposal carries.
 *
 * Every problem is collected rather than the first one thrown, because a form that reports one
 * error per attempt across seven fields is seven round trips.
 */
export function buildCall(action: AdminAction, draft: AdminDraft): BuiltCall {
  const contract = governedByKey(action.contract);
  const parsed = parseDraft(action, draft);
  if (!parsed.ok) return { ok: false, problems: parsed.problems };

  const problems = validate(action, parsed.args);
  if (problems.length > 0) return { ok: false, problems };

  try {
    const data = encodeFunctionData({ abi: contract.abi, functionName: action.functionName, args: parsed.args }) as Hex;
    return { ok: true, target: contract.address(), data, args: parsed.args };
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : 'The call could not be encoded.'] };
  }
}

type ParsedDraft = { readonly ok: true; readonly args: readonly unknown[] } | { readonly ok: false; readonly problems: readonly string[] };

function parseDraft(action: AdminAction, draft: AdminDraft): ParsedDraft {
  const problems: string[] = [];
  const shape = action.shape;

  if (shape.kind === 'none') return { ok: true, args: [] };

  if (shape.kind === 'rows') {
    const rows: Record<string, bigint>[] = [];
    if (draft.rows.length === 0) problems.push(`Add at least one ${shape.rowLabel.toLowerCase()}, or the table is cleared.`);

    draft.rows.forEach((row, index) => {
      const built: Record<string, bigint> = {};
      for (const field of shape.row) {
        const result = parseField(field, row[field.name] ?? '');
        if (!result.ok) problems.push(`${shape.rowLabel} ${index + 1}, ${field.label.toLowerCase()}: ${result.problem}`);
        else if (typeof result.value === 'bigint') built[field.name] = result.value;
      }
      rows.push(built);
    });

    return problems.length > 0 ? { ok: false, problems } : { ok: true, args: [rows] };
  }

  const fields = shape.fields;
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const result = parseField(field, draft.values[field.name] ?? '');
    if (!result.ok) problems.push(`${field.label}: ${result.problem}`);
    else values[field.name] = result.value;
  }
  if (problems.length > 0) return { ok: false, problems };

  // A single struct argument arrives as one object; separate arguments arrive in order. The ABI
  // says which, so the form never has to.
  const contract = governedByKey(action.contract);
  const entry = functionEntry(contract.abi, action.functionName, fields.length);
  if (entry && entry.inputs.length === 1 && entry.inputs[0]?.type === 'tuple') return { ok: true, args: [values] };

  return { ok: true, args: fields.map((field) => values[field.name]) };
}

type FieldResult = { readonly ok: true; readonly value: bigint | Address | Hex } | { readonly ok: false; readonly problem: string };

export function parseField(field: AdminField, text: string): FieldResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, problem: 'Enter a value.' };

  if (field.kind === 'address') {
    if (!isAddress(trimmed)) return { ok: false, problem: 'That is not a 20-byte address.' };
    return { ok: true, value: getAddress(trimmed) };
  }

  if (field.kind === 'bytes32') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return { ok: false, problem: 'Write 0x followed by 64 hex characters.' };
    return { ok: true, value: trimmed.toLowerCase() as Hex };
  }

  if (field.kind === 'usdg' || field.kind === 'brsr') {
    const decimals = field.kind === 'usdg' ? USDG_DECIMALS : BRSR_DECIMALS;
    const amount = parseDecimal(trimmed, decimals);
    if (!amount.ok) return amount;
    return { ok: true, value: amount.value };
  }

  const integer = parseInteger(trimmed);
  if (!integer.ok) return integer;

  const ceiling = ceilingFor(field.kind);
  if (integer.value > ceiling) return { ok: false, problem: `At most ${ceiling.toString()}.` };
  return { ok: true, value: integer.value };
}

function ceilingFor(kind: FieldKind): bigint {
  switch (kind) {
    case 'bps':
      return LIMITS.bps;
    case 'score':
      return LIMITS.scoreMax;
    case 'count':
      return 255n;
    case 'index':
      return 2n;
    case 'seconds':
      return MAX_UINT64;
    default:
      return MAX_UINT256;
  }
}

type NumberResult = { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly problem: string };

/**
 * Takes the decimal separator a person uses. Most of the world writes 25.000,50, and
 * reading that as twenty-five thousand and a half rather than as twenty-five is the kind of
 * mistake that only shows up once the change has landed.
 */
export function parseDecimal(input: string, decimals: number): NumberResult {
  const cleaned = input.replace(/[\s  ']/g, '');
  if (cleaned === '') return { ok: false, problem: 'Enter a value.' };
  if (cleaned.startsWith('-')) return { ok: false, problem: 'Enter a positive value.' };
  const body = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^[\d.,]+$/.test(body)) return { ok: false, problem: 'Use digits, and a comma or a dot for the decimal point.' };

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  const at = Math.max(lastComma, lastDot);
  const grouped = at === -1 ? body : body.slice(0, at);
  const fraction = at === -1 ? '' : body.slice(at + 1);

  if (fraction.includes(',') || fraction.includes('.')) return { ok: false, problem: 'Only one decimal point.' };
  if (fraction.length > decimals) return { ok: false, problem: `At most ${decimals} decimal places.` };

  const whole = grouped.replace(/[.,]/g, '');
  if (whole === '' && fraction === '') return { ok: false, problem: 'Enter a value.' };
  if (!/^\d*$/.test(whole)) return { ok: false, problem: 'Use digits, and a comma or a dot for the decimal point.' };

  const value = BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return { ok: true, value };
}

function parseInteger(input: string): NumberResult {
  const cleaned = input.replace(/[\s  ',.]/g, '');
  if (!/^\d+$/.test(cleaned)) return { ok: false, problem: 'Enter a whole number.' };
  return { ok: true, value: BigInt(cleaned) };
}

// Validation, mirroring the contracts

/** A struct argument, read field by field. A missing key cannot happen once `parseDraft` has run. */
type Tuple = Readonly<Record<string, bigint>>;

function at(tuple: Tuple, key: string): bigint {
  return tuple[key] ?? 0n;
}

function validate(action: AdminAction, args: readonly unknown[]): readonly string[] {
  const problems: string[] = [];
  const record = (condition: boolean, message: string) => {
    if (condition) problems.push(message);
  };

  switch (action.id) {
    case 'reputation.setCurve': {
      const curve = args[0] as Tuple;
      record(at(curve, 'maxCap') === 0n, 'A ceiling of zero caps every payee at nothing, so every payment would be refused.');
      record(at(curve, 'maxCap') < at(curve, 'baseCap'), 'The ceiling cannot be below the cap at a score of zero. Reputation refuses the curve.');
      record(
        at(curve, 'maxCap') > at(curve, 'baseCap') + at(curve, 'capPerScore') * LIMITS.scoreMax,
        'No score reaches that ceiling: a perfect score of 100 stops at the cap at zero plus 100 steps. Reputation refuses a ceiling it would publish and never pay.',
      );
      record(
        at(curve, 'baseCap') > MAX_UINT128 || at(curve, 'capPerScore') > MAX_UINT128 || at(curve, 'maxCap') > MAX_UINT128,
        'That is larger than the contract can hold.',
      );
      break;
    }
    case 'oracleRegistry.setConfig': {
      const config = args[0] as Tuple;
      record(
        at(config, 'commitWindow') < LIMITS.oracleMinWindow || at(config, 'revealWindow') < LIMITS.oracleMinWindow,
        'Each window has to be at least ten minutes. A shorter one is a vote only a party already watching can take part in.',
      );
      record(at(config, 'quorum') === 0n, 'Quorum has to be at least one.');
      record(
        at(config, 'quorum') > LIMITS.oracleRoster,
        `Quorum cannot be above the ${LIMITS.oracleRoster}-seat roster. No vote could reach it and every dispute would fail.`,
      );
      record(
        at(config, 'maxVoters') < LIMITS.oracleRoster,
        `The voter cap has to seat the whole ${LIMITS.oracleRoster}-resolver roster, or whoever commits first shuts the rest out.`,
      );
      record(at(config, 'maxDeviation') > LIMITS.scoreMax, 'A deviation band wider than 100 points is wider than the whole score.');
      record(
        at(config, 'slashBps') === 0n,
        'A slash of zero fires the slash event and takes nothing, which reads as enforcement to anyone watching. The contract refuses it.',
      );
      record(at(config, 'slashBps') > LIMITS.bps, 'A slash cannot exceed the whole bond.');
      record(
        at(config, 'unbondingPeriod') < at(config, 'commitWindow') + at(config, 'revealWindow'),
        'The bond exit wait has to cover both windows, or a bond matures before the dispute it voted in can settle.',
      );
      break;
    }
    case 'agentRegistry.setMinStake':
      record(args[0] === 0n, 'A floor of zero is refused. Use the pause if the intent is to stop registrations.');
      record((args[0] as bigint) > MAX_UINT128, 'That is larger than the contract can hold.');
      break;
    case 'agentRegistry.setSlashBps':
      record(args[0] === 0n, 'A slash of zero is refused.');
      record((args[0] as bigint) > LIMITS.agentRegistrySlashBps, 'The registry refuses anything above 5000, which is half the stake.');
      break;
    case 'agentRegistry.setSlashSink':
    case 'oracleRegistry.setSlashSink':
    case 'staking.setTreasury':
      record(isZero(args[0]), 'The zero address is refused here.');
      break;
    case 'adminTimelock.setGuardian':
      record(isZero(args[0]), 'The zero address is refused here.');
      break;
    case 'adminTimelock.updateSigner':
      record((args[0] as bigint) > 2n, 'There are three seats, numbered 0, 1 and 2.');
      record(isZero(args[1]), 'The zero address is refused here.');
      break;
    case 'staking.setTiers': {
      const tiers = args[0] as readonly Tuple[];
      record(tiers.length > LIMITS.stakingTiers, `At most ${LIMITS.stakingTiers} rungs.`);
      tiers.forEach((tier, index) => {
        record(at(tier, 'minStake') === 0n, `Rung ${index + 1}: a threshold of zero is refused.`);
        record(at(tier, 'rebateBps') === 0n, `Rung ${index + 1}: a rebate of zero is refused. Remove the rung instead.`);
        record(at(tier, 'rebateBps') > LIMITS.stakingRebateBps, `Rung ${index + 1}: the pool refuses a rebate above 5000, which is half the fee.`);
        const previous = index === 0 ? undefined : tiers[index - 1];
        if (previous) {
          record(at(tier, 'minStake') <= at(previous, 'minStake'), `Rung ${index + 1}: the threshold has to be above rung ${index}.`);
          record(at(tier, 'rebateBps') <= at(previous, 'rebateBps'), `Rung ${index + 1}: the rebate has to be above rung ${index}.`);
        }
      });
      break;
    }
    case 'staking.setUnbondingPeriod':
      record((args[0] as bigint) < LIMITS.stakingMinUnbonding, 'The pool refuses anything under seven days.');
      record((args[0] as bigint) > LIMITS.stakingMaxUnbonding, 'The pool refuses anything over ninety days.');
      break;
    case 'staking.setMinBond':
      record(args[0] === 0n, 'A floor of zero is refused.');
      break;
    case 'staking.setUnbondWindow':
      record(
        (args[0] as bigint) < LIMITS.stakingMinUnbondWindow || (args[0] as bigint) > LIMITS.stakingMaxUnbondWindow,
        'The pool takes between one and thirty days.',
      );
      break;
    case 'staking.setMaxExitHold':
      record(
        (args[0] as bigint) < LIMITS.stakingMinExitHold || (args[0] as bigint) > LIMITS.stakingMaxExitHold,
        'The pool takes between one and thirty days.',
      );
      break;
    case 'staking.setSlashLimit':
      record(args[0] === 0n, 'A cap of zero is refused. Clear the slasher instead to stop slashing.');
      record((args[0] as bigint) > LIMITS.bps, 'A slash cannot take more than the whole pool.');
      record(
        (args[1] as bigint) < LIMITS.stakingMinSlashWindow || (args[1] as bigint) > LIMITS.stakingMaxSlashWindow,
        'The refill window has to be between one and ninety days.',
      );
      break;
    case 'buyback.setMaxCeilingAge':
      record(
        (args[0] as bigint) < LIMITS.buybackMinCeilingAge || (args[0] as bigint) > LIMITS.buybackMaxCeilingAge,
        'The buyback takes between one and thirty days.',
      );
      break;
    case 'buyback.setParams': {
      const params = args[0] as Tuple;
      record(at(params, 'spendPerCallMicroUsd') === 0n, 'A target spend of zero is refused.');
      record(at(params, 'minSpendMicroUsd') === 0n, 'A floor of zero is refused.');
      record(at(params, 'minSpendMicroUsd') > at(params, 'spendPerCallMicroUsd'), 'The floor cannot be above the per-call target.');
      record(at(params, 'spendPerCallMicroUsd') > at(params, 'maxSpendPerWindowMicroUsd'), 'The per-call target cannot be above the window ceiling.');
      record(at(params, 'maxPriceMicroUsdPerBrsr') > LIMITS.buybackMaxPriceMicroUsd, 'That price is outside the range the contract accepts.');
      record(at(params, 'window') === 0n, 'A window of zero is refused.');
      record(at(params, 'window') > LIMITS.buybackMaxWindow, 'The window cannot be longer than thirty days.');
      record(
        at(params, 'minInterval') > at(params, 'window'),
        'A wait longer than the window puts the ceiling out of reach and turns a rate limit into one buy per period.',
      );
      break;
    }
    default:
      break;
  }

  return problems;
}

function isZero(value: unknown): boolean {
  return typeof value === 'string' && /^0x0{40}$/i.test(value);
}

// Reading calldata back

export type CallRow = {
  readonly label: string;
  readonly value: string;
  /** Set where the value is an address, so a surface can render it as one. */
  readonly address?: Address;
};

export type CallReading = {
  readonly targetName: string | undefined;
  readonly functionName: string | undefined;
  readonly signature: string | undefined;
  readonly selector: Hex | undefined;
  /** What this call does, in one sentence, with the values in it. */
  readonly sentence: string;
  readonly rows: readonly CallRow[];
  /** False when nothing in this build decodes the call. The hex is then the whole story. */
  readonly recognised: boolean;
};

/**
 * What a proposal would do, in a sentence.
 *
 * Where the call is one this build has an interface for, it is decoded and named with its own
 * numbers in it. Where it is not, the card says exactly that. A wrong description of a governance
 * action is worse than none.
 */
/** The core contracts each governed key stands for in a deployment record. */
const RECORD_NAMES: Partial<Record<GovernedKey, MandateContractName>> = {
  agentRegistry: 'AgentRegistry',
  escrow: 'Escrow',
  oracleRegistry: 'OracleRegistry',
  reputation: 'Reputation',
  mandateAccountFactory: 'MandateAccountFactory',
  adminTimelock: 'AdminTimelock',
};

/**
 * The governed contract at an address, in the current set or in an older one still live on this
 * chain. A proposal queued against the v1 registry names the registry, not an unknown contract.
 */
function governedAt(target: Address): GovernedContract | undefined {
  const current = GOVERNED.find((entry) => sameAddress(addressOrUndefined(entry), target));
  if (current) return current;
  let records: readonly { readonly contracts: Readonly<Record<MandateContractName, Address>> }[] = [];
  try {
    records = deploymentsForChain(CHAIN_ID);
  } catch {
    return undefined;
  }
  return GOVERNED.find((entry) => {
    const name = RECORD_NAMES[entry.key];
    return name !== undefined && records.some((record) => sameAddress(record.contracts[name], target));
  });
}

export function readCall(target: Address, data: Hex): CallReading {
  const known = governedAt(target);
  const selector = data.length >= 10 ? (slice(data, 0, 4) as Hex) : undefined;

  const decoded = decodeWith(data, known?.abi) ?? decodeAcrossAll(data);
  if (!decoded) {
    return {
      targetName: known?.name,
      functionName: undefined,
      signature: undefined,
      selector,
      sentence: known
        ? `Calls ${selector ?? 'no function'} on ${known.name}. This build carries no interface that matches it, so the calldata below is the whole story.`
        : `Calls ${selector ?? 'no function'} on a contract this build does not recognise. The calldata below is the whole story.`,
      rows: [],
      recognised: false,
    };
  }

  const signature = signatureOf(decoded.entry);
  // Where the call is one the builder knows, its own field labels and units are used, so a
  // resolver bond reads as 25,000 BRSR and not as twenty-two digits of wei.
  const action = known === undefined ? undefined : ADMIN_ACTIONS.find((entry) => entry.contract === known.key && entry.functionName === decoded.entry.name);

  return {
    targetName: known?.name,
    functionName: decoded.entry.name,
    signature,
    selector,
    sentence: sentenceFor(decoded.entry.name, known, decoded.args, signature),
    rows: rowsFor(decoded.entry, decoded.args, action),
    recognised: true,
  };
}

function isCreditPool(value: unknown): boolean {
  const pool = collateralDeployment(CHAIN_ID)?.CreditPool;
  return typeof value === 'string' && sameAddress(value, pool);
}

function addressOrUndefined(entry: GovernedContract): Address | undefined {
  try {
    return entry.address();
  } catch {
    // The address book is absent. Naming the target is a courtesy; decoding still works.
    return undefined;
  }
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

function decodeWith(data: Hex, abi: Abi | undefined): { readonly entry: AbiFunction; readonly args: readonly unknown[] } | undefined {
  if (!abi) return undefined;
  try {
    const result = decodeFunctionData({ abi, data });
    const entry = abi.find((item): item is AbiFunction => item.type === 'function' && item.name === result.functionName);
    return entry ? { entry, args: (result.args ?? []) as readonly unknown[] } : undefined;
  } catch {
    return undefined;
  }
}

/** A proposal may target a contract deployed after this build. The selector is still worth naming. */
function decodeAcrossAll(data: Hex): { readonly entry: AbiFunction; readonly args: readonly unknown[] } | undefined {
  for (const entry of GOVERNED) {
    const result = decodeWith(data, entry.abi);
    if (result) return result;
  }
  return undefined;
}

function functionEntry(abi: Abi, name: string, arity: number): AbiFunction | undefined {
  const matches = abi.filter((item): item is AbiFunction => item.type === 'function' && item.name === name);
  return matches.find((item) => item.inputs.length === arity) ?? matches[0];
}

/** viem's `AbiParameter` only carries `components` on the tuple members of its union. */
type AbiParamLike = { readonly type: string; readonly name?: string | undefined; readonly components?: readonly AbiParamLike[] | undefined };

function parametersOf(entry: AbiFunction): readonly AbiParamLike[] {
  return entry.inputs as readonly AbiParamLike[];
}

function signatureOf(entry: AbiFunction): string {
  return `${entry.name}(${parametersOf(entry).map(typeSignature).join(',')})`;
}

function typeSignature(input: AbiParamLike): string {
  if (!input.type.startsWith('tuple') || !input.components) return input.type;
  const inner = input.components.map(typeSignature).join(',');
  return `(${inner})${input.type.slice('tuple'.length)}`;
}

function rowsFor(entry: AbiFunction, args: readonly unknown[], action: AdminAction | undefined): readonly CallRow[] {
  const rows: CallRow[] = [];
  const shape = action?.shape;
  const named = (name: string): AdminField | undefined => {
    if (shape === undefined) return undefined;
    if (shape.kind === 'fields') return shape.fields.find((field) => field.name === name);
    if (shape.kind === 'rows') return shape.row.find((field) => field.name === name);
    return undefined;
  };

  parametersOf(entry).forEach((input, index) => {
    const value = args[index];
    const label = input.name && input.name.length > 0 ? humanise(input.name) : `Argument ${index + 1}`;

    if (input.type === 'tuple' && input.components && isRecord(value)) {
      for (const component of input.components) {
        const key = component.name ?? '';
        rows.push(row(named(key)?.label ?? humanise(key), value[key], named(key)));
      }
      return;
    }

    if (input.type === 'tuple[]' && Array.isArray(value)) {
      const rowLabel = shape?.kind === 'rows' ? shape.rowLabel : label;
      value.forEach((item, position) => {
        if (!isRecord(item)) return;
        const parts = Object.entries(item).map(([key, entryValue]) => {
          const field = named(key);
          return `${(field?.label ?? humanise(key)).toLowerCase()} ${display(entryValue, field)}`;
        });
        rows.push({ label: `${rowLabel} ${position + 1}`, value: parts.join(', ') });
      });
      return;
    }

    const field = named(input.name ?? '');
    rows.push(row(field?.label ?? label, value, field));
  });

  return rows;
}

function row(label: string, value: unknown, field?: AdminField | undefined): CallRow {
  if (typeof value === 'string' && isAddress(value)) return { label, value, address: getAddress(value) };
  return { label, value: display(value, field) };
}

/**
 * A value in the unit the form asked for it in. Without a field it is the raw number.
 *
 * Anything narrower than a uint64 comes back from viem as a `number`, so a basis-point share and a
 * micro-USD amount arrive as different JavaScript types out of the same struct.
 */
function display(value: unknown, field: AdminField | undefined): string {
  if (field === undefined) return plain(value);
  if (typeof value !== 'bigint' && typeof value !== 'number') return plain(value);
  const amount = BigInt(value);

  switch (field.kind) {
    case 'usdg':
      return formatUsdg(micro(amount));
    case 'brsr':
      return formatBrsrAmount(brsr(amount));
    case 'bps':
      return formatBps(amount);
    case 'seconds':
      return formatDuration(Number(amount));
    case 'score':
      return `${amount.toString()} points`;
    default:
      return plain(amount);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function plain(value: unknown): string {
  if (typeof value === 'bigint') return group(value.toString());
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `${value.length} entries`;
  if (value === null || value === undefined) return 'empty';
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, entry]) => `${humanise(key).toLowerCase()} ${plain(entry)}`)
      .join(', ');
  }
  return String(value);
}

/** `setMinStake` and `minStake` both read as "Min stake" on screen, which is what a form needs. */
function humanise(name: string): string {
  const spaced = name.replace(/_+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Sentences

/**
 * The two assets, and the two scales they are counted in.
 *
 * Both take a branded amount rather than a bare word. USDG is micro-dollars at six decimals and
 * BRSR is wei at eighteen, and the figures sit next to each other on the operator screen: a stake
 * floor in one column, a bond floor in the next. Unbranded, swapping the two arguments formats a
 * 50,000 BRSR floor as 50 billion USDG and compiles. Branded, it does not compile at all. A raw
 * word decoded out of calldata is branded where it is read, which is the point at which somebody
 * decided what asset it counts.
 */
export function formatUsdg(amount: Micro): string {
  return `${group(formatUnits(amount, USDG_DECIMALS))} USDG`;
}

export function formatBrsrAmount(amount: Brsr): string {
  return `${group(formatUnits(amount, BRSR_DECIMALS))} BRSR`;
}

export function formatBps(value: bigint): string {
  const percent = Number(value) / 100;
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 2)}%`;
}

/** Thousands separators on the whole part only, so a decimal fraction is left where it is. */
function group(text: string): string {
  const [whole, fraction] = text.split('.');
  const grouped = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function bigintAt(value: unknown, key: string): bigint {
  if (isRecord(value)) {
    const found = value[key];
    if (typeof found === 'bigint') return found;
    if (typeof found === 'number') return BigInt(found);
  }
  return 0n;
}

function seconds(value: unknown): string {
  return typeof value === 'bigint' || typeof value === 'number' ? formatDuration(Number(value)) : 'an unread period';
}

function sentenceFor(name: string, contract: GovernedContract | undefined, args: readonly unknown[], signature: string): string {
  const on = contract?.name ?? 'the target contract';
  const first = args[0];

  switch (name) {
    case 'acceptAdmin':
      return `Takes administration of ${on}. Every later change to it then waits out this delay as well.`;
    case 'transferAdmin':
      return `Hands administration of ${on} to ${plain(first)}, which has to accept it before it takes effect.`;
    case 'pause':
      return `Stops ${on}.`;
    case 'unpause':
      return `Restarts ${on}. Unlike the pause, this waits out the full delay.`;
    case 'setGuardian':
      return `Hands the brake to ${plain(first)}. The old guardian loses it the moment this executes.`;
    case 'updateSigner':
      return `Replaces signer ${plain(first)} with ${plain(args[1])}. Approvals are counted over the current set, so the replaced key stops carrying every proposal it had approved.`;
    case 'setCurve':
      return `Sets the payee spending cap to ${formatUsdg(micro(bigintAt(first, 'baseCap')))} at a score of zero, rising ${formatUsdg(
        micro(bigintAt(first, 'capPerScore')),
      )} for each of the hundred score points, and stopping at ${formatUsdg(micro(bigintAt(first, 'maxCap')))}.`;
    case 'setConfig':
      return `Sets the dispute rules to ${seconds(bigintAt(first, 'commitWindow'))} to commit and ${seconds(
        bigintAt(first, 'revealWindow'),
      )} to reveal, ${bigintAt(first, 'quorum').toString()} reveals needed with up to ${bigintAt(
        first,
        'maxVoters',
      ).toString()} resolvers voting, a deviation band of ${bigintAt(first, 'maxDeviation').toString()} score points, ${formatBps(
        bigintAt(first, 'slashBps'),
      )} of the bond slashed outside it, and a bond exit wait of ${seconds(bigintAt(first, 'unbondingPeriod'))}.`;
    case 'setMinStake':
      return `Sets the provider stake floor to ${formatUsdg(micro(asBigint(first)))}. It binds on the next registration and on partial withdrawals, and deregisters nobody.`;
    case 'setSlashBps':
      return `Sets the share of a provider's stake a ruling takes to ${formatBps(asBigint(first))}.`;
    case 'setSlasher':
      return slasherSentence(contract, first);
    case 'setSlashLimit':
      return `Lets one slash take at most ${formatBps(asBigint(first))} of the staking pool, with the allowance refilling over ${seconds(args[1])}.`;
    case 'setUnbondWindow':
      return `Keeps a ready staking exit open for ${seconds(first)} before it lapses. It applies to requests already pending.`;
    case 'setMaxExitHold':
      return `Lets a pause hold ready staking exits for at most ${seconds(first)}, from the next pause on.`;
    case 'setKeeper':
      return isZero(first)
        ? 'Clears the buyback keeper. No buy can run until one is named again.'
        : `Names ${plain(first)} as the buyback keeper, the only address that can trigger a buy.`;
    case 'setMaxCeilingAge':
      return `Keeps a buyback price ceiling usable for ${seconds(first)} after it is set. Past that every buy is refused until the ceiling is set again.`;
    case 'evict':
      return `Unseats resolver ${plain(first)} from ${on} and returns what is left of its bond. Refused while a vote that bond backs is open.`;
    case 'sweepSurplus':
      return `Sends the settlement asset ${on} holds beyond the rewards it owes to its slash sink.`;
    case 'setSlashSink':
      return `Sends everything slashed by ${on} to ${plain(first)} from this point on. Balances already sent are not moved.`;
    case 'setBlacklistRoot':
      return isZeroWord(first)
        ? 'Clears the provider exclusion root, which turns that gate off. The per-agent flag keeps working.'
        : `Sets the provider exclusion root to ${plain(first)}.`;
    case 'setTiers':
      return tiersSentence(args[0]);
    case 'setCreditManager':
      if (isZero(first)) return 'Clears the credit manager. No spread can be paid in to stakers until one is named again.';
      return isCreditPool(first)
        ? `Names the credit pool, ${plain(first)}, as the staking pool’s credit manager, so its spread is paid to stakers.`
        : `Names ${plain(first)} as the staking pool’s credit manager, the one address that can pay spread in.`;
    case 'setBondFloor':
      return asBigint(args[1]) === 0n
        ? `Returns resolver ${plain(first)} to the bond floor everyone else is held to.`
        : `Sets the bond floor for resolver ${plain(first)} to ${formatBrsrAmount(brsr(asBigint(args[1])))}.`;
    case 'setUnbondingPeriod':
      return `Changes the staking exit wait to ${seconds(first)}. It applies to requests already pending, in both directions.`;
    case 'setMinBond':
      return `Sets the resolver bond floor to ${formatBrsrAmount(brsr(asBigint(first)))}. The dispute registry reads it live on every vote.`;
    case 'setTreasury':
      return `Changes the address ${on} pays to ${plain(first)}.`;
    case 'setParams':
      return paramsSentence(first);
    case 'sweep':
      return `Moves ${on === 'the buyback' ? plain(args[1]) : plain(args[2])} of token ${plain(first)} out of ${on}.`;
    case 'revoke':
      return 'Freezes a vesting grant at the amount vested that instant. What has already vested stays claimable.';
    default:
      return `Calls ${signature} on ${on}.`;
  }
}

/** One function name on two contracts: the provider registry's second ruling authority, and the staking pool's slasher. */
function slasherSentence(contract: GovernedContract | undefined, value: unknown): string {
  if (contract?.key === 'staking') {
    if (isZero(value)) return 'Clears the staking pool’s slasher. Nothing can take stake until one is named again.';
    return isCreditPool(value)
      ? `Names the credit pool, ${plain(value)}, as the staking pool’s slasher. A write-off then takes stake, converted to BRSR at the buyback’s price ceiling and held to the slash cap.`
      : `Names ${plain(value)} as the staking pool’s slasher, the one address that can take stake, held to the slash cap.`;
  }
  return isZero(value)
    ? 'Clears the second address allowed to rule against provider stake.'
    : `Names ${plain(value)} as a second address allowed to rule against provider stake.`;
}

function asBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return 0n;
}

function isZeroWord(value: unknown): boolean {
  return typeof value === 'string' && /^0x0+$/i.test(value);
}

function tiersSentence(value: unknown): string {
  if (!Array.isArray(value)) return 'Replaces the fee rebate table that decides how much a staked balance takes off the settlement fee.';
  if (value.length === 0) {
    return 'Clears the fee rebate table. Every rebate then reads zero, whatever anyone has staked.';
  }

  const rungs = value
    .filter(isRecord)
    .map((tier) => `${formatBrsrAmount(brsr(asBigint(tier.minStake)))} for ${formatBps(asBigint(tier.rebateBps))}`)
    .join(', ');

  return `Replaces the fee rebate table with ${value.length} ${value.length === 1 ? 'rung' : 'rungs'}: ${rungs} off the settlement fee on the staker's own payouts.`;
}

function paramsSentence(value: unknown): string {
  const ceiling = bigintAt(value, 'maxPriceMicroUsdPerBrsr');
  const head = `Sets the buyback to spend up to ${formatUsdg(micro(bigintAt(value, 'spendPerCallMicroUsd')))} per call and ${formatUsdg(
    micro(bigintAt(value, 'maxSpendPerWindowMicroUsd')),
  )} per ${seconds(bigintAt(value, 'window'))}, refusing anything under ${formatUsdg(micro(bigintAt(value, 'minSpendMicroUsd')))} and waiting ${seconds(
    bigintAt(value, 'minInterval'),
  )} between buys.`;

  return ceiling === 0n
    ? `${head} The price ceiling is zero, which refuses every trade.`
    : `${head} It will pay at most ${formatUsdg(micro(ceiling))} for one whole BRSR.`;
}
