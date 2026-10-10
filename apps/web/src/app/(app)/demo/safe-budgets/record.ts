import type { Address, Hex } from 'viem';

/** The Safe-owned mandate the script walked on Robinhood Chain on 2026-10-10. */
export const LIVE = {
  safe: '0x053C8E803fBB862d6465399f69001A9b58Cdf4fe' as Address,
  mandate: '0x98B59693751d14f9067A7C321276b0F27Fb03bAc' as Address,
  agent: '0xd140FA73F66b3F51250906b259E6FaaF8f7469b3' as Address,
  steps: [
    { action: 'Deploy the Safe', signed: 'The first owner, from its own wallet', hash: '0xe6ebf1c2a0b9e29d283ea07228aa86d06a18768bf14307e2e833ac04ee9c9da0' as Hex },
    { action: 'ETH for gas to the Safe', signed: 'The first owner', hash: '0x2baf272ee573c6155be6f97f329a2242bb590f06bb986e128260e11268d77c1b' as Hex },
    { action: '$0.50 USDG to the Safe', signed: 'The first owner', hash: '0x1d83d8ac181c82d326b1a892dfa56d6290820911525b8dd74fd21c9a095ac7a6' as Hex },
    { action: 'Create the mandate', signed: 'Two of the three owners', hash: '0xc89eba3f5c98b7df44c6a7eb67344293f5fd0a4d8aaa868fba28d96be16bc0f5' as Hex },
    { action: 'Fund it with $0.50', signed: 'Two of the three owners', hash: '0x55ecb7b81a6d20d7b054616ba360e622b0dadc027bcb71415dc2c909f29e5fb1' as Hex },
    { action: 'Raise the per-payment cap to $0.25', signed: 'Two of the three owners', hash: '0xd435c4b19aadca4f541a67bc8da038f678566bed27f37af6c812586f2dfd98b6' as Hex },
    { action: 'Seat the agent and allow the payee', signed: 'Two of the three owners', hash: '0x749fa6e9486bb9cbabc061a867237488ecb9f02e929b112af1a7063c1627cff1' as Hex },
    { action: 'Allow the kind of work', signed: 'Two of the three owners', hash: '0x739ccb27f53cac06a85bfa38ba50e8a80c24f9945ac8fe4a4d4a239316ed3967' as Hex },
    { action: 'Register an approval for $0.10', signed: 'Two of the three owners', hash: '0xaab3a9eedea09d8a811aa6bdc553a3a42ea50f53e83ae1608dbf587a8f3c6ef7' as Hex },
    { action: 'The agent pays $0.10 with the signed approval', signed: 'Two owners signed the message; the agent sent the payment', hash: '0xba03af06bffd9c7d75616653d73686a350ef8921f89933e516dbad490dd7d1d8' as Hex },
  ],
} as const;
