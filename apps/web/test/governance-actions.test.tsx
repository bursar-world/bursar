import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { ADDRESSES } from '@/chain';
import { buildCall, actionById } from '@/chain/admin-actions';
import type { AdminAction } from '@/chain/admin-actions';
import { CallPreview } from '@/app/(app)/governance/builder';
import { statusOf } from '@/app/(app)/governance/read';
import { CUSTODY_LINE, answerInList, answerIs, governanceNotice, permits } from '@/app/(app)/governance/roles';
import type { Roles } from '@/app/(app)/governance/roles';

const SIGNER_ONE = '0xb51c63568324848DfC88A09f91F06fA86771aB69' as Address;
const SIGNER_TWO = '0x3C7facc7C72c3aCeB2EF93703813652aC9039266' as Address;
const SIGNER_THREE = '0x1f3eE000728EF363B9F867f88BBF618F2A17c42d' as Address;
const GUARDIAN = '0x7cfF32B8B4DB47E2Cde5907c8F5c93EC6a095E2A' as Address;
const STRANGER = '0x000000000000000000000000000000000000BEEF' as Address;
const SIGNERS = [SIGNER_ONE, SIGNER_TWO, SIGNER_THREE] as const;

function roles(over: Partial<Roles> = {}): Roles {
  return { address: undefined, signer: 'no', guardian: 'no', treasury: 'no', ...over };
}

function action(id: string): AdminAction {
  const found = actionById(id);
  if (!found) throw new Error(`no action ${id}`);
  return found;
}

/**
 * The page refuses, and says what it refused and why.
 *
 * A wallet that is not a signer has to be told so plainly. A signer set that could not be read is
 * a different thing entirely, and the page that renders the second as the first tells an operator
 * holding the right key that they hold the wrong one.
 */
describe('who the connected wallet is', () => {
  it('reads a signer out of the set', () => {
    expect(answerInList(SIGNERS, SIGNER_TWO)).toBe('yes');
    expect(answerInList(SIGNERS, STRANGER)).toBe('no');
  });

  it('answers unread when the set did not come back, never no', () => {
    expect(answerInList(undefined, SIGNER_TWO)).toBe('unread');
    expect(answerIs(undefined, GUARDIAN)).toBe('unread');
  });

  it('answers no for a wallet that is not connected, because nothing was asked of the chain', () => {
    expect(answerInList(undefined, undefined)).toBe('no');
    expect(answerIs(undefined, undefined)).toBe('no');
  });

  it('offers the control on an unread role and withholds it on a read refusal', () => {
    expect(permits('yes')).toBe(true);
    expect(permits('unread')).toBe(true);
    expect(permits('no')).toBe(false);
  });
});

describe('what the page tells a wallet it may do', () => {
  it('asks a disconnected reader for a signer key and says the page reads without one', () => {
    const notice = governanceNotice(roles());

    expect(notice?.headline).toContain('Connect a signer key');
    expect(notice?.detail).toContain('needs no wallet');
    expect(notice?.detail).toContain('guardian key');
  });

  it('says plainly that a stranger can change nothing, and says which keys can', () => {
    const notice = governanceNotice(roles({ address: STRANGER }));

    expect(notice?.headline).toContain('neither a signer nor the guardian');
    expect(notice?.detail).toContain('Connect one of those keys');
  });

  it('never tells a wallet it is not a signer when the signer set was not read', () => {
    const notice = governanceNotice(roles({ address: SIGNER_ONE, signer: 'unread', guardian: 'unread' }));

    expect(notice?.headline).toContain('could not be read');
    expect(notice?.headline).not.toContain('is neither');
    expect(notice?.detail).toContain('still offered');
  });

  it('tells the guardian it holds the brake and nothing else, and why', () => {
    const notice = governanceNotice(roles({ address: GUARDIAN, guardian: 'yes' }));

    expect(notice?.headline).toContain('brake and nothing else');
    expect(notice?.detail).toContain('bars the guardian from the signer set');
  });

  it('says nothing at all to a signer, because the controls are the answer', () => {
    expect(governanceNotice(roles({ address: SIGNER_ONE, signer: 'yes' }))).toBeUndefined();
  });

  it('states how the keys are held once, without hedging', () => {
    expect(CUSTODY_LINE).toContain('plain keys');
    expect(CUSTODY_LINE).toContain('multisig after public launch');
    expect(CUSTODY_LINE).not.toMatch(/Release \d|operator decision/);
    expect(CUSTODY_LINE).not.toContain('audit');
  });
});

/**
 * A failed read decides no badge.
 *
 * The quorum, the approval count and the expiry all come off the chain, and each can fail on its
 * own. A threshold invented for a missing one decides the word on the card and whether Execute is
 * offered at all, so a missing one has to produce its own answer.
 */
describe('the status of a proposal', () => {
  const base = {
    raw: { target: ADDRESSES.escrow, data: '0x' as const, createdAt: 1n, executeAfter: 2n, executed: false, cancelled: false },
    approvals: 2,
    required: 2,
    executeAfter: new Date('2026-09-24T10:07:16Z'),
    expiresAt: new Date('2026-10-08T10:07:16Z'),
    now: new Date('2026-09-23T00:00:00Z'),
  };

  it('counts down inside the delay', () => {
    expect(statusOf(base)).toBe('waiting-out-the-delay');
  });

  it('is executable once the delay has passed', () => {
    expect(statusOf({ ...base, now: new Date('2026-09-25T00:00:00Z') })).toBe('executable');
  });

  it('says not read when the approval count did not come back', () => {
    expect(statusOf({ ...base, approvals: undefined })).toBe('not-read');
  });

  it('says not read when the quorum did not come back, rather than assuming two', () => {
    expect(statusOf({ ...base, required: undefined })).toBe('not-read');
  });

  it('says not read when the expiry did not come back, rather than calling it expired', () => {
    expect(statusOf({ ...base, expiresAt: undefined })).toBe('not-read');
  });

  it('still reports what is on the record that was read', () => {
    expect(statusOf({ ...base, approvals: undefined, raw: { ...base.raw, executed: true } })).toBe('executed');
    expect(statusOf({ ...base, required: undefined, raw: { ...base.raw, cancelled: true } })).toBe('cancelled');
  });
});

describe('the preview under the builder', () => {
  it('shows the decoded sentence and the bytes it was decoded from', () => {
    const built = buildCall(action('agentRegistry.setMinStake'), { values: { newMinStake: '5.00' }, rows: [] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const markup = renderToStaticMarkup(<CallPreview built={built} />);

    expect(markup).toContain('Sets the provider stake floor to 5 USDG');
    expect(markup).toContain(built.data);
    expect(markup).toContain('setMinStake(uint128)');
  });

  it('names every problem instead of offering a proposal that would revert', () => {
    const built = buildCall(action('agentRegistry.setSlashBps'), { values: { newSlashBps: '9000' }, rows: [] });
    expect(built.ok).toBe(false);

    const markup = renderToStaticMarkup(<CallPreview built={built} />);

    expect(markup).toContain('Nothing to propose yet');
    expect(markup).toContain('above 5000');
  });

  it('renders the arguments in the units the form asked for them in', () => {
    const built = buildCall(action('staking.setTiers'), {
      values: {},
      rows: [{ minStake: '25000', rebateBps: '500' }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const markup = renderToStaticMarkup(<CallPreview built={built} />);

    expect(markup).toContain('25,000 BRSR');
    expect(markup).toContain('5%');
    expect(markup).not.toContain('25000000000000000000000');
  });
});

/**
 * The skin lands in one place, so nothing here may hold a colour or a type size of its own.
 *
 * `globals.css` names every colour and the three steps below `text-sm`. A hex written into a
 * component sits outside that file, and moving the palette then means editing every surface that
 * spelled one out.
 */
describe('the surfaces this release added', () => {
  const files = [
    'src/chain/admin-actions.ts',
    'src/components/fields.tsx',
    'src/app/(app)/governance/builder.tsx',
    'src/app/(app)/governance/actions-panel.tsx',
    'src/app/(app)/governance/governance-view.tsx',
    'src/app/(app)/governance/roles.ts',
    'src/app/(app)/ops/ops-view.tsx',
    'src/app/(app)/ops/gate.ts',
    'src/app/(app)/ops/read.ts',
  ];

  const source = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

  it.each(files)('%s holds no colour of its own', (path) => {
    expect(source(path).match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  it.each(files)('%s holds no type size of its own', (path) => {
    expect(source(path).match(/text-\[[0-9.]+(px|rem|em)\]/g)).toBeNull();
  });
});

/**
 * The list runs newest first, so the topmost Execute is the highest id and never proposal 0. A
 * signer reaching for one proposal read the card title, moved down to a button reading "Execute"
 * and executed another. The id travels with every control now.
 *
 * The same three controls take the action row off the screen the instant the new state is read,
 * which is why the receipt is held behind `onContinue` rather than handed to `onConfirmed`. There
 * is no executable proposal on the deployment most days, so this is asserted here rather than
 * driven.
 */
describe('the controls on a proposal card', () => {
  const view = readFileSync(fileURLToPath(new URL('../src/app/(app)/governance/governance-view.tsx', import.meta.url)), 'utf8');

  it.each(['Approve', 'Execute', 'Cancel'])('%s names the proposal it acts on', (word) => {
    expect(view).toContain(`label={\`${word} proposal \${proposal.id}\`}`);
  });

  it('holds the receipt until the reader moves the page on', () => {
    expect(view.match(/onContinue=\{onChanged\}/g)).toHaveLength(3);
    expect(view).not.toContain('onConfirmed={onChanged}');
  });

  it('says which end of the list is which', () => {
    expect(view).toContain('Newest first');
  });
});
