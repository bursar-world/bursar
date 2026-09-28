import { describe, expect, it } from 'vitest';
import { commitCanonical } from '@bursar/core';

import { InvalidArgumentError } from '../src/errors.js';
import {
  MAX_JOB_BYTES,
  jobCommit,
  jobDocument,
  jobURI,
  parseJobDocument,
  readJobURI,
  verifyDelivery,
} from '../src/job.js';

describe('the document a hire commits to', () => {
  it('holds the work and nothing the lock already carries', () => {
    const document = jobDocument({ task: 'Summarize the filing', input: { url: 'https://x/1' } });

    expect(Object.keys(document).sort()).toEqual(['input', 'task']);
  });

  it('reads an absent input and an empty one as the same job', () => {
    expect(jobCommit({ task: 'Do the thing' })).toBe(jobCommit({ task: 'Do the thing', input: {} }));
  });

  it('reads an empty acceptance list as no list rather than as a claim', () => {
    expect(jobCommit({ task: 'Do the thing', acceptance: [] })).toBe(jobCommit({ task: 'Do the thing' }));
  });

  it('trims the task, so two callers who meant the same job commit to the same bytes', () => {
    expect(jobCommit({ task: '  Do the thing  ' })).toBe(jobCommit({ task: 'Do the thing' }));
  });

  it('commits to exactly the bytes a provider recomputes from', () => {
    const spec = { task: 'Render the frame', input: { seed: 7 }, acceptance: ['1024x1024 png'] };

    expect(jobCommit(spec)).toBe(commitCanonical(jobDocument(spec)));
  });

  it('refuses a hire with no brief, because a payment with no terms is a tip', () => {
    expect(() => jobDocument({ task: '   ' })).toThrow(InvalidArgumentError);
    expect(() => jobDocument({ task: '' })).toThrow(/needs a task/u);
  });

  it('refuses an acceptance line that says nothing but changes the commitment', () => {
    expect(() => jobDocument({ task: 'Do it', acceptance: ['fine', ' '] })).toThrow(InvalidArgumentError);

    try {
      jobDocument({ task: 'Do it', acceptance: ['fine', ' '] });
      expect.unreachable('an empty acceptance line has to be refused');
    } catch (error) {
      expect((error as InvalidArgumentError).field).toBe('acceptance[1]');
    }
  });

  /**
   * The provider's worker reads at most a mebibyte. Over it the job is refused while the escrow
   * still holds the money, so the budget sits against a brief nobody will open.
   */
  it('refuses a brief no provider would read, before it costs a lock', () => {
    const spec = { task: 'x', input: { blob: 'a'.repeat(MAX_JOB_BYTES) } };

    expect(() => jobCommit(spec)).toThrow(/serialises to \d+ bytes/u);
  });
});

describe('publishing and reading a job back', () => {
  it('travels inline, so a provider needs nothing of the payer’s to be up', () => {
    const spec = { task: 'Summarize the filing', input: { url: 'https://x/1' } };

    expect(readJobURI(jobURI(spec))).toEqual(jobDocument(spec));
  });

  it('refuses to follow a URI that points somewhere else', () => {
    expect(() => readJobURI('https://provider.example/job/1.json')).toThrow(/not published inline/u);
  });

  it('refuses a document that is not the shape both sides agreed on', () => {
    expect(() => parseJobDocument('[]')).toThrow(/a JSON object/u);
    expect(() => parseJobDocument('{"input":{}}')).toThrow(/names the task/u);
    expect(() => parseJobDocument('{"task":"x","input":[]}')).toThrow(/input is a JSON object/u);
  });
});

describe('checking a delivery against what was committed', () => {
  const output = { summary: 'four pages', pages: 4 };
  const commit = commitCanonical(output);

  it('accepts the bytes the provider was paid for, whatever order they arrive in', () => {
    expect(verifyDelivery({ outputCommit: commit, output: { pages: 4, summary: 'four pages' } })).toBe(true);
  });

  it('rejects a later edit, whoever served it', () => {
    expect(verifyDelivery({ outputCommit: commit, output: { ...output, pages: 5 } })).toBe(false);
  });
});

/**
 * One brief, one hash, across two implementations.
 *
 * `@bursar/mcp` builds this document for an agent hiring through the MCP server and this builds it
 * for one hiring directly, and the provider's worker hashes whatever it reads off the lock. If the
 * two ever disagree by a key order, a default or a trimmed space, the lock is one the provider
 * cannot answer and the budget sits there until the deadline. The same vector is pinned in the
 * MCP suite, so either side drifting turns both red.
 */
describe('the brief both halves have to agree on', () => {
  const SPEC = {
    task: 'Summarize the 10-K risk factors into ten bullets.',
    input: { filing: 'https://sec.example/10-K' },
    acceptance: ['Ten bullets or fewer'],
  };

  it('hashes to the value @bursar/mcp pins for the same brief', () => {
    expect(jobCommit(SPEC)).toBe('0xf377b77c359e9a3b2e67b36bc92fe1ef676a27b79165ec0c8df8a4c84e73835b');
  });
});
