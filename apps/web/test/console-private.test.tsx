import { renderToStaticMarkup } from 'react-dom/server';
import {
  TermsLockedError,
  TermsMismatchError,
  commit,
  deriveViewingKey,
  openTerms,
  sealTerms,
  viewingKeyMessage,
  writeTerms,
} from '@bursar/sdk';
import { stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { AmendTerms, TermsView, periodLabel } from '@/app/(app)/console/[mandate]/committed-view';
import { readableInput } from '@/app/(app)/console/lib/share-with-resolver';
import { PRIVATE_LIMIT_LINE, PrivateCapabilities } from '@/app/(app)/console/new/private-create';
import { EMPTY_PRIVATE_FORM, formFromTerms, readAddressList, readPrivateForm, termsProblem } from '@/chain/private';
import type { PrivateForm } from '@/chain/private';

const PROVIDER = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374' as const;
const MANDATE = '0x96f085Adc31984F1eE0F769798FA52465d39f56c' as const;
const NOW = Date.parse('2026-09-29T00:00:00Z');

const filled: PrivateForm = {
  ...EMPTY_PRIVATE_FORM,
  perCall: '0.10',
  periodCap: '0.25',
  total: '1',
  capabilities: [
    { spendClass: 'service', label: 'gpu.render:1' },
    { spendClass: 'hire', label: 'research.summarize:1' },
  ],
  counterparties: [PROVIDER],
  expiry: '2026-12-31',
};

describe('the private terms form', () => {
  it('reads a complete form into micro-unit terms, committing only the capabilities of the classes that are on', () => {
    const { terms, problems } = readPrivateForm(filled, NOW);
    expect(problems).toEqual([]);
    expect(terms).toMatchObject({
      perCallCap: 100_000n,
      periodCap: 250_000n,
      totalCap: 1_000_000n,
      periodLen: 86_400,
      capabilities: ['service:gpu.render:1'],
    });
    expect(terms?.expiry).toBe(Date.parse('2026-12-31') / 1000);
    expect(readPrivateForm({ ...filled, classes: { service: true, hire: true } }, NOW).terms?.capabilities).toEqual([
      'service:gpu.render:1',
      'hire:research.summarize:1',
    ]);
  });

  it('asks for a capability, not just a class', () => {
    expect(readPrivateForm({ ...filled, capabilities: [] }, NOW).problems).toEqual(['Name at least one capability this mandate may pay for.']);
    expect(readPrivateForm({ ...filled, classes: { service: false, hire: true }, capabilities: [filled.capabilities[0]!] }, NOW).problems).toEqual([
      'Name at least one capability this mandate may pay for.',
    ]);
  });

  it('edits capabilities for services and hires only', () => {
    const html = renderToStaticMarkup(<PrivateCapabilities form={filled} onChange={() => undefined} />);
    expect(html).toContain('data-spend-class="service"');
    expect(html).toContain('data-spend-class="hire"');
    expect(html).not.toContain('data-spend-class="rwa"');
    expect(html).toContain('service:gpu.render:1');
    expect(html).not.toContain('—');
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
    expect(PRIVATE_LIMIT_LINE).toContain('amount and the provider of each payment are still visible on chain');
    expect(PRIVATE_LIMIT_LINE).not.toContain('—');
  });
});

describe('the terms the viewing key opens', () => {
  it('round-trips from the form through the seal and renders readable', async () => {
    const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const key = deriveViewingKey(await owner.signMessage({ message: viewingKeyMessage(owner.address) }));
    const doc = writeTerms({ ...readPrivateForm(filled, NOW).terms!, label: 'Research agent: data and inference' });
    const sealed = await sealTerms(key.termsKey, { account: MANDATE, version: 1 }, doc);
    // Whole strings, as raw bytes and as text: a four-digit fragment turns up in random bytes a few
    // runs in a hundred.
    expect(sealed.toLowerCase()).not.toContain(PROVIDER.slice(2).toLowerCase());
    for (const clear of ['Research agent: data and inference', PROVIDER, PROVIDER.toLowerCase()]) {
      expect(sealed.toLowerCase()).not.toContain(stringToHex(clear).slice(2));
    }

    const record = { account: MANDATE, version: 1n, termsCommitment: commit(doc).termsCommitment, ciphertext: sealed };
    const opened = await openTerms(key.termsKey, record);
    const html = renderToStaticMarkup(<TermsView terms={opened} />);
    expect(html).toContain('Research agent: data and inference');
    expect(html).toContain('$0.10');
    expect(html).toContain('Per day');
    expect(html).toContain('$1.00');
    expect(html).toContain('Services');
    expect(html).toContain('service:gpu.render:1');

    // A copy that is not the committed document is refused, and the owner is told why.
    const other = writeTerms(readPrivateForm(filled, NOW).terms!);
    const refusal = await openTerms(key.termsKey, { ...record, termsCommitment: commit(other).termsCommitment }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TermsMismatchError);
    expect(termsProblem(refusal)).toContain('not the terms this mandate committed to');
    expect(termsProblem(new TermsLockedError())).toContain('does not open these terms');
  });

  it('prefills an amendment with the terms in force', async () => {
    const doc = writeTerms({ ...readPrivateForm(filled, NOW).terms!, label: 'Research agent: data and inference' });
    const form = formFromTerms(doc);
    expect(form).toMatchObject({ perCall: '0.1', periodCap: '0.25', total: '1', expiry: '2026-12-31', classes: { service: true, hire: false } });
    expect(readPrivateForm(form, NOW).terms).toEqual(readPrivateForm(filled, NOW).terms);

    const html = renderToStaticMarkup(
      <AmendTerms
        mandate={MANDATE}
        opened={{ terms: doc, termsKey: new Uint8Array(32) }}
        version={1n}
        fromBlock={0n}
        send={async () => undefined}
        onAmended={() => undefined}
      />,
    );
    expect(html).toContain('Amend the terms');
    expect(html).toContain('what the agent has already spent counts against them');
    expect(html).not.toContain('—');
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

describe('returnable', () => {
  it('offers a private payment back only once it is still locked and past its deadline', async () => {
    const { returnable } = await import('@/chain/private');
    const { LockStatus } = await import('@bursar/sdk');
    expect(returnable({ status: LockStatus.Locked, deadline: 100n }, 101n)).toBe(true);
    expect(returnable({ status: LockStatus.Locked, deadline: 100n }, 100n)).toBe(false);
    expect(returnable({ status: LockStatus.Released, deadline: 100n }, 200n)).toBe(false);
  });
});
