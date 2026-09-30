import type * as Core from '@bursar/core';
import type { Deployment, MandateContractName } from '@bursar/core';
import type { Address } from 'viem';

type CoreModule = typeof Core;

const fill = (digit: string) => `0x${digit.repeat(40)}` as Address;

/**
 * A v3 record for chain 4663 on top of v2, with every address made up. The committed records say
 * whatever the last deploy wrote, so a test about three sets brings its own third one.
 */
export function v3Record(core: CoreModule, overrides: { escrow?: Address; oracleRegistry?: Address } = {}): Deployment {
  return core.parseDeployment({
    network: 'rhc-mainnet-v3',
    chainId: 4663,
    rpc: 'https://rpc.example.invalid',
    explorer: 'https://explorer.example.invalid',
    settlementAsset: core.RHC_MAINNET.usdg,
    settlementDecimals: 6,
    deployer: fill('b'),
    contracts: {
      AdminTimelock: fill('1'),
      Reputation: fill('2'),
      Escrow: overrides.escrow ?? fill('3'),
      OracleRegistry: overrides.oracleRegistry ?? fill('4'),
      AgentRegistry: fill('5'),
      MandateAccountFactory: fill('6'),
    },
    roles: { timelockSigners: [fill('7')], guardian: fill('c'), treasury: fill('d'), slashSink: fill('e') },
    verifiedOnChain: {},
    supersedes: 'rhc-mainnet-v2',
  });
}

/**
 * `@bursar/core` with its address book narrowed to `records`, for a test that has to hold whatever
 * the committed records say. Every lookup a screen resolves a chain, an escrow or a lane through
 * answers from these records, by the same rules the real one follows; the rest is the real module.
 */
export function withRecords(core: CoreModule, records: readonly Deployment[]): CoreModule {
  const line = (chainId: number): readonly Deployment[] => {
    const onChain = records.filter((d) => d.chainId === chainId);
    const superseded = (d: Deployment) => onChain.some((other) => other.supersedes === d.network);
    const ordered: Deployment[] = [];
    let next = onChain.find((d) => d.retired === undefined && !superseded(d));
    while (next !== undefined && !ordered.includes(next)) {
      ordered.push(next);
      const older = next.supersedes;
      next = older === undefined ? undefined : onChain.find((d) => d.network === older);
    }
    return [...ordered, ...onChain.filter((d) => d.retired === undefined && !ordered.includes(d))];
  };

  const head = (chainId: number): Deployment => {
    const found = line(chainId)[0];
    if (found === undefined) throw new Error(`No record for chain ${chainId} in this test's address book.`);
    return found;
  };

  const byContract = (contract: MandateContractName, address: Address) =>
    records.find((d) => d.contracts[contract].toLowerCase() === address.toLowerCase());

  const sameSet = (chainId: number): readonly Deployment[] => {
    const all = line(chainId);
    const set = all[0] === undefined ? undefined : core.contractSetOf(all[0]);
    return all.filter((d) => core.contractSetOf(d) === set);
  };

  const rwaDeployment = (chainId: number) => sameSet(chainId).find((d) => d.rwa !== undefined)?.rwa;

  return {
    ...core,
    DEPLOYMENTS: Object.fromEntries(records.map((d) => [d.network, d])) as CoreModule['DEPLOYMENTS'],
    deployment: (name: string) => {
      const found = records.find((d) => d.network === name);
      if (found === undefined) throw new Error(`No record named ${name} in this test's address book.`);
      return found;
    },
    deploymentForChain: head,
    deploymentsForChain: line,
    liveDeployments: () => records.filter((d) => d.retired === undefined),
    deploymentByContract: byContract,
    contractSetOfEscrow: (escrow: Address) => {
      const found = byContract('Escrow', escrow);
      return found === undefined ? undefined : core.contractSetOf(found);
    },
    contractSetOfRegistry: (registry: Address) => {
      const found = byContract('OracleRegistry', registry);
      return found === undefined ? undefined : core.contractSetOf(found);
    },
    currentSetDeployments: sameSet,
    rwaDeployment,
    collateralDeployment: (chainId: number) => rwaDeployment(chainId)?.collateral,
    privacyDeployment: (chainId: number) => sameSet(chainId).find((d) => d.privacy !== undefined)?.privacy,
  } as CoreModule;
}
