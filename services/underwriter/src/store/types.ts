import type { DocumentSource } from '../config.js';
import type { Address, MandateDocument } from '../document.js';

/**
 * One mandate this process speaks for: the agent the facilitator will ask about, the
 * MandateAccount that holds the money and the limits, and the terms, if a principal wrote any.
 *
 * `document` is null only in `chain` mode, where the terms are derived from the account. That is
 * a named mode, not an empty store. A store that returns nothing has nothing to say about an
 * agent, and the registry refuses it, which is a different answer from "the account's own limits
 * are the whole mandate".
 */
export type MandateBinding = {
  readonly subject: string;
  readonly account: Address;
  readonly document: MandateDocument | null;
};

export type DocumentStore = {
  readonly source: DocumentSource;
  /** Where the documents came from, for the health route. Never a credential. */
  readonly describe: string;
  load(): Promise<readonly MandateBinding[]>;
  close(): Promise<void>;
};
