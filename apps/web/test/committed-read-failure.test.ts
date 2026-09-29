import { HttpRequestError } from 'viem';
import { describe, expect, it, vi } from 'vitest';

const readContract = vi.fn();
vi.mock('@/chain/client', () => ({ rhcClient: () => ({ readContract }) }));

const { readCommittedMandate } = await import('@/chain/private');
const ACCOUNT = '0x3bFc90701288767f005eeC8B97326733592A79Fd';

describe('readCommittedMandate', () => {
  it('throws when the request itself failed, so a private mandate is never shown as a standard one', async () => {
    readContract.mockRejectedValueOnce(Object.assign(new Error('read failed'), { cause: new HttpRequestError({ url: 'https://rpc.example', status: 429 }) }));
    await expect(readCommittedMandate(ACCOUNT)).rejects.toThrow();
  });

  it('answers undefined when the contract itself says it is not a private mandate', async () => {
    readContract.mockRejectedValueOnce(Object.assign(new Error('reverted'), { cause: { name: 'ContractFunctionRevertedError' } }));
    await expect(readCommittedMandate(ACCOUNT)).resolves.toBeUndefined();
  });
});
