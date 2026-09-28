import type { Postgres } from '../db.js';
import { parseDocument } from '../document.js';
import { DocumentError } from '../errors.js';
import type { DocumentStore, MandateBinding } from './types.js';

/*
 * Mandate documents from Postgres, one row per subject.
 *
 * The row repeats the subject and the account the document already carries, so an operator can
 * index and join on them. That makes them capable of disagreeing with the document, and a row
 * whose columns say one thing while its JSON says another is refused: either value could be the
 * one somebody meant, and picking one silently is how a mandate ends up enforced against an
 * account nobody chose.
 */

/**
 * A database filled before the brand rename holds these rows under the old table name. Adopt it:
 * creating an empty table beside it would read as a deployment with no mandates bound to it, and
 * every spend would be refused for a subject that is in fact documented.
 */
const ADOPT = `
DO $$
BEGIN
  IF to_regclass('mandate_documents') IS NOT NULL AND to_regclass('bursar_documents') IS NULL THEN
    ALTER TABLE mandate_documents RENAME TO bursar_documents;
  END IF;
END
$$`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bursar_documents (
  subject     TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  document    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

type Row = { subject: string; account: string; document: unknown };

export function createPostgresDocumentStore(db: Postgres, describe: string): DocumentStore {
  return {
    source: 'postgres',
    describe,

    async load() {
      await db.query(ADOPT);
      await db.query(SCHEMA);
      const rows = await db.query<Row>('SELECT subject, account, document FROM bursar_documents ORDER BY subject');
      return rows.map(bind);
    },

    async close() {
      // The pool belongs to the service, which opened it and closes it once.
    },
  };
}

function bind(row: Row): MandateBinding {
  const document = parseDocument(row.document, `bursar_documents[${row.subject}]`);

  if (document.subject !== row.subject) {
    throw new DocumentError(
      `bursar_documents row "${row.subject}" holds a document for subject "${document.subject}"`,
      { row: row.subject, document: document.subject },
    );
  }
  if (document.account === null) {
    throw new DocumentError(`bursar_documents row "${row.subject}" holds a document with no "account"`, {
      row: row.subject,
    });
  }
  if (document.account.toLowerCase() !== row.account.toLowerCase()) {
    throw new DocumentError(
      `bursar_documents row "${row.subject}" names account ${row.account} and its document names ${document.account}`,
      { row: row.subject, column: row.account, document: document.account },
    );
  }

  return { subject: row.subject, account: document.account, document };
}
