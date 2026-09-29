import { renderToStaticMarkup } from 'react-dom/server';
import { commit, deriveViewingKey, openTerms, sealTerms, viewingKeyMessage, writeTerms } from '@bursar/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { TermsView, periodLabel } from '@/app/(app)/console/[mandate]/committed-view';
import { readableInput } from '@/app/(app)/console/lib/share-with-resolver';
import { PRIVATE_LIMIT_LINE } from '@/app/(app)/console/new/private-create';
import { EMPTY_PRIVATE_FORM, readAddressList, readPrivateForm } from '@/chain/private';

const PROVIDER = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as const;
const NOW = Date.parse('2026-09-29T00:00:00Z');

const filled = {
  ...EMPTY_PRIVATE_FORM,
  perCall: '0.10',
  periodCap: '0.25',
  total: '1',
  counterparties: [PROVIDER],
  expiry: '2026-12-31',
};

describe('the private terms form', () => {
  it('reads a complete form into micro-unit terms', () => {
    const { terms, problems } = readPrivateForm(filled, NOW);
    expect(problems).toEqual([]);
    expect(terms).toMatchObject({ perCallCap: 100_000n, periodCap: 250_000n, totalCap: 1_000_000n, periodLen: 86_400, classes: ['service'] });
    expect(terms?.expiry).toBe(Date.parse('2026-12-31') / 1000);
  });

  it('refuses a total budget above the $25.00 private ceiling, and takes one at it', () => {
    expect(readPrivateForm({ ...filled, total: '25.01' }, NOW).problems).toEqual(['A private mandate can have a total budget of at most $25.00 for now.']);
    expect(readPrivateForm({ ...filled, total: '25' }, NOW).problems).toEqual([]);
  });

  it('names each thing that is missing or cannot hold', () => {
    expect(readPrivateForm(EMPTY_PRIVATE_FORM, NOW).problems).toEqual(
      expect.arrayContaining([
        'Enter the per-payment cap.',
        'Name at least one provider this mandate may pay.',
        'Choose the date the mandate ends.',
      ]),
    );
    expect(readPrivateForm({ ...filled, periodCap: '0.05' }, NOW).problems).toContain(
      'The period cap cannot be smaller than the per-payment cap.',
    );
    expect(readPrivateForm({ ...filled, expiry: '2026-01-01' }, NOW).problems).toContain('The end date has to be in the future.');
    expect(readPrivateForm({ ...filled, classes: { service: false, hire: false } }, NOW).terms).toBeUndefined();
  });

  it('reads a pasted provider list and refuses what is not an address', () => {
    const { addresses, rejected } = readAddressList(`${PROVIDER}, ${PROVIDER.toLowerCase()}\nnope`);
    expect(addresses).toEqual([PROVIDER]);
    expect(rejected).toEqual(['nope']);
  });

  it('states the limit plainly and without em dashes', () => {
    expect(PRIVATE_LIMIT_LINE).toContain('amount and the provider of each payment are visible on chain');
    expect(PRIVATE_LIMIT_LINE).not.toContain('—');
  });
});

describe('the terms the viewing key opens', () => {
  it('round-trips from the form through the seal and renders readable', async () => {
    const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const key = deriveViewingKey(await owner.signMessage({ message: viewingKeyMessage(owner.address) }));
    const doc = writeTerms({ ...readPrivateForm(filled, NOW).terms!, label: 'Render budget' });
    const sealed = await sealTerms(key.termsKey, owner.address, doc);
    expect(sealed).not.toContain('5210');
    expect(commit(doc).termsCommitment).toBeGreaterThan(0n);

    const opened = await openTerms(key.termsKey, owner.address, sealed);
    const html = renderToStaticMarkup(<TermsView terms={opened} />);
    expect(html).toContain('Render budget');
    expect(html).toContain('$0.10');
    expect(html).toContain('Per day');
    expect(html).toContain('$1.00');
    expect(html).toContain('Services');
  });

  it('labels the periods it offers', () => {
    expect(periodLabel(604_800)).toBe('week');
    expect(periodLabel(123)).toBe('123 seconds');
  });
});

describe('the input shared with a resolver', () => {
  it('shares a readable job and nothing for a sealed one', () => {
    const doc = { task: 'render', input: {} };
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(doc)).toString('base64')}`;
    expect(readableInput(uri)).toEqual(doc);
    expect(readableInput('data:application/vnd.bursar.sealed;base64,AAAA')).toBeNull();
    expect(readableInput('')).toBeNull();
  });
});
