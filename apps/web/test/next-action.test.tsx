import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { NextActionLine } from '@/components/status';
import { evaluateAsset, evaluateConnectivity, evaluatePermission } from '@/state/evaluate';
import type { AnyState, NextAction } from '@/state';
import type { ProviderHealth } from '@/chain/client';

/**
 * Every next action on screen either does something or does not look like it does.
 *
 * "Read again" and "Correct the endpoint" rendered as bold text with no href and no handler. A
 * reader presses them, nothing happens, and they spend their next move on the product rather than
 * on the endpoint that is serving the wrong chain. An action is a control when this app
 * can carry it out: a link has somewhere to go and a re-read can be taken. Everything else is an
 * instruction to a person and is set as one.
 */
const NOW = new Date('2026-09-20T12:00:00.000Z');

function render(action: NextAction, onRetry?: () => void): string {
  return renderToStaticMarkup(<NextActionLine action={action} onRetry={onRetry} />);
}

function provider(over: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    name: 'primary',
    url: 'https://rpc.mainnet.chain.robinhood.com',
    reachable: true,
    blockNumber: 100n,
    chainId: 4663,
    latencyMs: 12,
    problem: null,
    breaker: 'closed',
    throttled: 0,
    failures: 0,
    ...over,
  };
}

/** The states that carry an operator action, which is where every hrefless one lived. */
function statesWithActions(): readonly AnyState[] {
  return [
    evaluateAsset({ asset: { token: '0x5fc5' as Address, tokenPaused: false, blocked: {}, incomplete: true } } as never, NOW, false),
    evaluatePermission({ permission: { merchant: '0x4444444444444444444444444444444444444444' } } as never, NOW, false),
    evaluateConnectivity([provider({ reachable: false }), provider({ name: 'fallback', reachable: false })], 4663, undefined, NOW, false),
    evaluateConnectivity([provider({ chainId: 999 })], 4663, 100n, NOW, false),
    evaluateConnectivity([provider(), provider({ name: 'fallback', reachable: false })], 4663, 100n, NOW, false),
  ];
}

describe('an action that cannot be carried out is not rendered as a control', () => {
  it('renders no anchor and no button for an instruction to a person', () => {
    const markup = render({ label: 'Correct the endpoint', owner: 'operator', kind: 'contact' });

    expect(markup).toContain('Correct the endpoint');
    expect(markup).not.toContain('<a');
    expect(markup).not.toContain('<button');
  });

  it('does not set it in the weight a control uses', () => {
    const markup = render({ label: 'Restore the endpoint', owner: 'operator', kind: 'contact' });

    expect(markup).not.toContain('font-medium');
    expect(markup).not.toContain('underline');
  });

  it('renders an anchor where there is somewhere to go', () => {
    const markup = render({ label: 'Check the status page', owner: 'token-issuer', kind: 'link', href: '/status' });

    expect(markup).toContain('<a href="/status"');
  });

  it('renders a button for a re-read the screen can take', () => {
    let taken = 0;
    const markup = render({ label: 'Read again', owner: 'operator', kind: 'retry' }, () => (taken += 1));

    expect(markup).toContain('<button');
    expect(markup).toContain('Read again');
    expect(taken).toBe(0);
  });

  it('falls back to plain text where the caller cannot re-read', () => {
    const markup = render({ label: 'Read again', owner: 'operator', kind: 'retry' });

    expect(markup).not.toContain('<button');
    expect(markup).toContain('Read again');
  });
});

describe('the states that produce them', () => {
  it('never emits a link without the href that makes it one', () => {
    for (const state of statesWithActions()) {
      const action = state.nextAction;
      if (action?.kind === 'link') expect(action.href).toBeDefined();
    }
  });

  it('asks for a re-read where the reading is what failed, and nowhere else', () => {
    const [assetIncomplete, permissionUnread, unreachable, wrongChain, oneDown] = statesWithActions();

    expect(assetIncomplete?.nextAction).toMatchObject({ label: 'Read again', kind: 'retry' });
    expect(permissionUnread?.nextAction).toMatchObject({ kind: 'retry' });
    expect(unreachable?.nextAction).toMatchObject({ label: 'Try again', kind: 'retry' });

    // These two are somebody going to fix an endpoint. Pressing anything here would not do it.
    expect(wrongChain?.nextAction).toMatchObject({ label: 'Correct the endpoint', kind: 'contact' });
    expect(oneDown?.nextAction).toMatchObject({ label: 'Restore the endpoint', kind: 'contact' });
  });

  it('renders every one of them as either a control or a sentence, never a control that is neither', () => {
    for (const state of statesWithActions()) {
      const action = state.nextAction;
      if (!action) continue;

      const markup = render(action, undefined);
      const looksPressable = markup.includes('<a ') || markup.includes('<button');
      expect(looksPressable).toBe(action.href !== undefined);
    }
  });
});
