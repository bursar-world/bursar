import { describe, expect, it } from 'vitest';

import { depositSeen, failureLine, isSettled, nextPoll, parseStatus } from '@/relay';

describe('where a Relay request stands', () => {
  it('reads the documented success body', () => {
    const status = parseStatus({
      status: 'success',
      inTxHashes: ['0xe53021eaa63d100b08338197d26953e2219bcbad828267dd936c549ff643aad7'],
      txHashes: ['0x9da7bc54dfe6229d6980fd62250d472f23dfe0f41a1cdc870c81a08b3445f254'],
      updatedAt: 1713290386145,
      originChainId: 8453,
      destinationChainId: 4663,
    });
    expect(status.phase).toBe('success');
    expect(status.txHashes[0]).toBe('0x9da7bc54dfe6229d6980fd62250d472f23dfe0f41a1cdc870c81a08b3445f254');
    expect(isSettled(status)).toBe(true);
    expect(nextPoll(status)).toBe(false);
  });

  it('treats an id Relay does not know yet as still waiting', () => {
    const status = parseStatus({ status: 'unknown' });
    expect(status.phase).toBe('unknown');
    expect(isSettled(status)).toBe(false);
    expect(depositSeen(status)).toBe(false);
    expect(nextPoll(status)).toBe(4_000);
  });

  it('asks more often once the deposit has been seen', () => {
    expect(nextPoll(undefined)).toBe(2_000);
    expect(nextPoll(parseStatus({ status: 'waiting', quoteCreatedAt: 1 }))).toBe(4_000);
    expect(nextPoll(parseStatus({ status: 'pending' }))).toBe(2_000);
    expect(nextPoll(parseStatus({ status: 'delayed' }))).toBe(2_000);
    expect(depositSeen(parseStatus({ status: 'submitted' }))).toBe(true);
  });

  it('reads a word it has never seen as unknown rather than throwing', () => {
    expect(parseStatus({ status: 'teleporting' }).phase).toBe('unknown');
    expect(parseStatus(null).phase).toBe('unknown');
    expect(parseStatus({ status: 'failure', inTxHashes: 'nope' }).inTxHashes).toEqual([]);
  });
});

describe('why it did not arrive', () => {
  it('says the price moved and that the funds came back on the source chain', () => {
    const line = failureLine(parseStatus({ status: 'refund', failReason: 'SLIPPAGE', txHashes: ['0xabc'] }), 'Base');
    expect(line).toBe('The price moved past what the quote allowed before Relay could fill it. The funds were returned on Base.');
  });

  it('does not promise a refund it has not seen', () => {
    expect(failureLine(parseStatus({ status: 'failure', failReason: 'SOLVER_CAPACITY_EXCEEDED' }), 'Arc')).toBe('Relay did not have the USDG on hand to fill this.');
    expect(failureLine(parseStatus({ status: 'failure' }), 'Arc')).toBe('Relay could not complete the transfer.');
  });
});
