import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkerQuickstart } from '@/components/worker-quickstart';

/**
 * The quickstart is copy a provider pastes into a terminal, so what it prints has to be the
 * commands that work, and it has to read as product copy rather than as a build log.
 */
describe('the Cloudflare Worker quickstart', () => {
  const html = renderToStaticMarkup(<WorkerQuickstart />);
  const compact = renderToStaticMarkup(<WorkerQuickstart compact />);

  it('prints the create, secret and deploy commands in order', () => {
    const create = html.indexOf('npm create @bursar/provider my-api');
    const secret = html.indexOf('wrangler secret put BURSAR_FACILITATOR_TOKEN');
    const deploy = html.indexOf('wrangler deploy');
    expect(create).toBeGreaterThan(-1);
    expect(secret).toBeGreaterThan(create);
    expect(deploy).toBeGreaterThan(secret);
  });

  it('shows the handler on the long form only and the price on both', () => {
    expect(html).toContain('withBursar');
    expect(compact).not.toContain('withBursar');
    for (const markup of [html, compact]) {
      expect(markup).toContain('POST /render');
      expect(markup).toContain('0.01 USDG');
      expect(markup).toContain('href="/providers"');
    }
  });

  it('keeps internal vocabulary out', () => {
    for (const word of ['canary', 'rollout', 'feature flag', 'PR ', 'branch', 'worktree', 'TODO']) {
      expect(html).not.toContain(word);
    }
  });
});
