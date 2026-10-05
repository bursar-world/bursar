/**
 * A deployment record as the contracts' local rehearsal writes it, cut to the sections this server
 * reads. It answers as chain 4663 and settles in USDG at the mainnet address, and every contract of
 * its own sits somewhere else, so an address taken from mainnet in its place is one the fake node
 * does not hold. It lists no AAPL, which mainnet does.
 *
 * Assets are keyed by symbol, as a record on disk keys them.
 */
export const LOCAL_RECORD = {
  network: 'local-4663',
  chainId: 4663,
  status: 'planned',
  local: true,
  dev: true,
  rpc: 'http://127.0.0.1:8545',
  explorer: '',
  settlementAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  settlementDecimals: 6,
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  contracts: {
    AdminTimelock: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    Reputation: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    Escrow: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    OracleRegistry: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    AgentRegistry: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    MandateAccountFactory: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788',
  },
  verifiedOnChain: {},
  examples: {},
  roles: {
    timelockSigners: [
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    ],
    guardian: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    treasury: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    slashSink: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  },
  rwa: {
    AssetRegistry: '0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE',
    PriceGuard: '0x68B1D87F95878fE05B998F19b66F4baba5De1aed',
    StockSpendRouter: '0x3Aa5ebB10DC797CAC828524e59A333d0A371443c',
    TreasuryPark: '0xc6e7DF5E7b4f2A278906862b61205850344D4e7d',
    assets: {
      SGOV: {
        address: '0xb19b36b1456E65E3A6D514D3F715f204BD59f431',
        feed: '0x8ce361602B935680E8DeC218b820ff5056BeB7af',
        kind: 'treasury',
      },
      SPY: {
        address: '0xe1Aa25618fA0c7A1CFDab5d6B456af611873b629',
        feed: '0xe1DA8919f262Ee86f9BE05059C9280142CF23f48',
        kind: 'stock',
      },
      NVDA: {
        address: '0x0C8E79F3534B00D9a3D4a856B665Bf4eBC22f2ba',
        feed: '0xeD1DB453C3156Ff3155a97AD217b3087D5Dc5f6E',
        kind: 'stock',
      },
    },
    adapters: {
      SGOV: '0x59b670e9fA9D0A427751Af201D676719a970857b',
      USDG: '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1',
    },
    fromBlock: 43,
    collateral: {
      CreditPool: '0xa85233C63b9Ee964Add6F2cffe00Fd84eb32338f',
      CollateralVault: '0x4A679253410272dd5232B3Ff7cF5dbB88f295319',
      Staking: '0x9A676e781A523b5d0C0e43731313A708CB607508',
      lender: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      fromBlock: 50,
    },
  },
} as const;
