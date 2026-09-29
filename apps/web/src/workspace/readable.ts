import { SPEND_CLASS_INFO, SPEND_CLASSES } from '@bursar/core';

import { isTotalDraft } from '@/app/(app)/console/limits-form';
import { LANE_NAME } from '@/chain/mandates';
import { formatDuration } from '@/lib/time';
import { draftTitle } from './model';
import type { MandateDraft, Workspace, WorkspaceAgent } from './model';

/**
 * The readable export: the workspace in plain JSON, carrying only the fields the reader ticked.
 *
 * It is the one thing this page writes in the clear, so it is built from an explicit list of fields
 * and nothing else. A field that is not ticked is not in the file, not even as an empty key.
 */

export const DRAFT_FIELDS = [
  { id: 'name', label: 'Draft name' },
  { id: 'notes', label: 'Notes' },
  { id: 'agent', label: 'Agent address' },
  { id: 'limits', label: 'Limits and expiry' },
  { id: 'lane', label: 'Funding lane' },
  { id: 'classes', label: 'Spend classes and capabilities' },
  { id: 'payees', label: 'Counterparties' },
  { id: 'status', label: 'Activation status' },
] as const;

export const AGENT_FIELDS = [
  { id: 'name', label: 'Agent name' },
  { id: 'address', label: 'Agent address' },
  { id: 'notes', label: 'Notes' },
] as const;

export type DraftField = (typeof DRAFT_FIELDS)[number]['id'];
export type AgentField = (typeof AGENT_FIELDS)[number]['id'];

export type ReadableSelection = {
  readonly drafts: readonly DraftField[];
  readonly agents: readonly AgentField[];
};

export const NOTHING_SELECTED: ReadableSelection = { drafts: [], agents: [] };

export function readableExport(workspace: Workspace, selection: ReadableSelection, now = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format: 'bursar-workspace-readable',
    exportedAt: now.toISOString(),
    note: 'Readable export. It holds only the fields selected when it was made. Keep it private.',
  };
  if (selection.drafts.length > 0) {
    out['drafts'] = workspace.drafts.map((draft) => pickDraft(draft, selection.drafts));
  }
  if (selection.agents.length > 0) {
    out['agents'] = workspace.agents.map((agent) => pickAgent(agent, selection.agents));
  }
  return out;
}

function pickDraft(draft: MandateDraft, fields: readonly DraftField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    switch (field) {
      case 'name':
        out['name'] = draftTitle(draft);
        break;
      case 'notes':
        out['notes'] = draft.notes;
        break;
      case 'agent':
        out['agent'] = draft.agent;
        break;
      case 'limits': {
        const l = draft.limits;
        const total = isTotalDraft(l);
        out['limits'] = {
          perPaymentUsdg: l.perCall,
          periodCapUsdg: l.daily,
          period: formatDuration(l.shortWindow),
          ...(total ? { totalBudgetUsdg: l.monthly } : { secondCapUsdg: l.monthly, secondCapRefills: formatDuration(l.longWindow) }),
          approval:
            l.approvalMode === 'above' ? `from ${l.approvalAmount} USDG` : l.approvalMode === 'every' ? 'every payment' : 'none',
          validUntil: l.validUntil === '' ? 'no expiry' : l.validUntil,
        };
        break;
      }
      case 'lane':
        out['fundingLane'] = LANE_NAME[draft.lane ?? 'prefund'];
        break;
      case 'classes':
        out['spendClasses'] = SPEND_CLASSES.filter((id) => draft.classes[id]).map((id) => ({
          class: SPEND_CLASS_INFO[id].name,
          capabilities: draft.capabilities
            .filter((entry) => entry.spendClass === id)
            .map((entry) => `${SPEND_CLASS_INFO[id].prefix}${entry.label}`),
        }));
        break;
      case 'payees':
        out['counterparties'] = [...draft.payees];
        break;
      case 'status':
        out['status'] = draft.activated === null ? 'draft' : { activatedAt: draft.activated.at, mandate: draft.activated.address };
        break;
    }
  }
  return out;
}

function pickAgent(agent: WorkspaceAgent, fields: readonly AgentField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = agent[field];
  return out;
}

