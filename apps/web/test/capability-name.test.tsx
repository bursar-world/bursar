import { toCapabilityId } from '@bursar/core';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { CapabilityName } from '@/app/(app)/console/lib/capability-name';
import { PUBLISHED_CAPABILITIES, publishedCapability } from '@/chain/capabilities';

/**
 * What a treasurer reads in the one table that answers "what may this agent buy".
 *
 * The chain holds the hash of a capability label. A name shown against one is the preimage, found
 * the same way the preview panel finds it: hash the candidate and compare the id. A hash with no
 * candidate behind it is shown as a hash and says so.
 */
const SUMMARIZE = toCapabilityId(PUBLISHED_CAPABILITIES.summarize);
const UNKNOWN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;

describe('publishedCapability', () => {
  it('answers a hash it can produce from a name', () => {
    expect(publishedCapability(SUMMARIZE)).toBe('doc.summarize:1');
    expect(publishedCapability(toCapabilityId(PUBLISHED_CAPABILITIES.render))).toBe('gpu.render:1');
  });

  it('answers the same hash written in either case', () => {
    expect(publishedCapability(SUMMARIZE.toUpperCase().replace('0X', '0x') as Hex)).toBe('doc.summarize:1');
  });

  it('answers nothing for a hash it cannot produce', () => {
    expect(publishedCapability(UNKNOWN)).toBeUndefined();
  });
});

describe('CapabilityName', () => {
  it('names the capability the landing page and the console both point at', () => {
    const markup = renderToStaticMarkup(<CapabilityName id={SUMMARIZE} />);
    expect(markup).toContain('doc.summarize:1');
  });

  it('keeps the hash alongside the name, because the hash is what the contract holds', () => {
    const markup = renderToStaticMarkup(<CapabilityName id={SUMMARIZE} />);
    expect(markup).toContain('0x8fb1176b');
  });

  it('shows a hash it cannot name as a hash, and says why', () => {
    const markup = renderToStaticMarkup(<CapabilityName id={UNKNOWN} />);
    expect(markup).toContain('0xbbbbbbbbbb');
    expect(markup).toContain('Allowed under a name');
    expect(markup).toContain('cannot recover it');
  });

  it('never invents a name for a hash', () => {
    const markup = renderToStaticMarkup(<CapabilityName id={UNKNOWN} />);
    for (const name of Object.values(PUBLISHED_CAPABILITIES)) {
      expect(markup).not.toContain(name);
    }
  });
});
