import { readFile } from 'node:fs/promises';

import { DocumentError } from '../errors.js';
import { parseDocument } from '../document.js';
import type { MandateDocument } from '../document.js';
import type { DocumentStore, MandateBinding } from './types.js';

/**
 * Mandate documents from a JSON file: one document, or an array of them.
 *
 * The file is re-read on every load, so a principal who rewrites a mandate does not have to
 * restart the process to have it taken into account. A document that does not name an
 * account is rejected, because a mandate that does not say which account it governs cannot be
 * compared against one, and comparing it against the account someone happened to ask about is how
 * a document ends up authorising a balance it was never written for.
 */
export function createFileDocumentStore(path: string): DocumentStore {
  return {
    source: 'file',
    describe: path,

    async load() {
      const raw = await readFile(path, 'utf8').catch((cause: unknown) => {
        throw new DocumentError(`could not read the mandate document file ${path}`, {
          path,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new DocumentError(`${path} is not valid JSON`, { path });
      }

      const entries = Array.isArray(parsed) ? parsed : [parsed];
      return entries.map((entry, index) => bind(parseDocument(entry, `${path}[${index}]`), path, index));
    },

    async close() {
      // Nothing is held open: the file is read on demand.
    },
  };
}

function bind(document: MandateDocument, path: string, index: number): MandateBinding {
  if (document.account === null) {
    throw new DocumentError(`${path}[${index}] has no "account", so it names no MandateAccount to enforce it against`, {
      path,
      subject: document.subject,
    });
  }
  return { subject: document.subject, account: document.account, document };
}
