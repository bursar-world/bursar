import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { microToNumeric, numericToMicro, countToNumber } from '../db/numeric.js';
import type { Database, Queryable } from '../db/sql.js';
import { many, one } from '../db/sql.js';
import type { BaseLedger, BasePayment, BasePaymentStatus, OpenPaymentInput, OpenResult } from './ports.js';

const COLUMNS = `id, chain_id, escrow, lock_id, lock_tx_hash, mandate, float, network, asset, pay_to, resource,
  amount_micro, lock_micro, fee_micro, nonce, valid_before, deadline, signed_block, status,
  reported_tx_hash, base_tx_hash, rhc_tx_hash, created_at, closed_at`;

type Row = {
  id: string;
  chain_id: string | number;
  escrow: string;
  lock_id: string;
  lock_tx_hash: string;
  mandate: string;
  float: string;
  network: string;
  asset: string;
  pay_to: string;
  resource: string;
  amount_micro: string;
  lock_micro: string;
  fee_micro: string;
  nonce: string;
  valid_before: string | number;
  deadline: string | number;
  signed_block: string | number;
  status: BasePaymentStatus;
  reported_tx_hash: string | null;
  base_tx_hash: string | null;
  rhc_tx_hash: string | null;
  created_at: Date;
  closed_at: Date | null;
};

function toPayment(row: Row): BasePayment {
  return {
    id: row.id,
    chainId: Number(row.chain_id),
    escrow: row.escrow as Address,
    lockId: BigInt(String(row.lock_id).replace(/\.0+$/, '')),
    lockTransaction: row.lock_tx_hash as Hex,
    mandate: row.mandate as Address,
    float: row.float as Address,
    network: row.network,
    asset: row.asset as Address,
    payTo: row.pay_to as Address,
    resource: row.resource,
    amountMicro: numericToMicro(row.amount_micro, 'amount_micro'),
    lockMicro: numericToMicro(row.lock_micro, 'lock_micro'),
    feeMicro: numericToMicro(row.fee_micro, 'fee_micro'),
    nonce: row.nonce as Hex,
    validBefore: BigInt(row.valid_before),
    deadline: BigInt(row.deadline),
    signedBlock: BigInt(row.signed_block),
    status: row.status,
    reportedTransaction: (row.reported_tx_hash as Hex | null) ?? null,
    baseTransaction: (row.base_tx_hash as Hex | null) ?? null,
    rhcTransaction: (row.rhc_tx_hash as Hex | null) ?? null,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null,
  };
}

async function promisedOn(client: Queryable, float: Address): Promise<Micro> {
  const row = await one<{ promised: string | null }>(
    client,
    `SELECT COALESCE(SUM(amount_micro), 0) AS promised FROM bursar_base_payments
     WHERE float = $1 AND status = 'signed'`,
    [float.toLowerCase()],
  );
  return numericToMicro(row?.promised ?? '0', 'promised');
}

export class PostgresBaseLedger implements BaseLedger {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async open(input: OpenPaymentInput, float: { balance: bigint; minimumMicro: Micro }): Promise<OpenResult> {
    return this.db.transaction(async (client) => {
      // One pay at a time per float. Without it two pays could each read the same promised figure
      // and both be granted the last of the float.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.float.toLowerCase()]);
      const promised = await promisedOn(client, input.float);
      const available = toMicro(float.balance - promised);
      if (available - input.amountMicro < float.minimumMicro) {
        return { opened: false, reason: 'float', availableMicro: available };
      }

      const row = await one<Row>(
        client,
        `INSERT INTO bursar_base_payments (
           chain_id, escrow, lock_id, lock_tx_hash, mandate, float, network, asset, pay_to, resource,
           amount_micro, lock_micro, fee_micro, nonce, valid_before, deadline, signed_block, created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
         ON CONFLICT (chain_id, escrow, lock_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          input.chainId,
          input.escrow.toLowerCase(),
          input.lockId.toString(),
          input.lockTransaction,
          input.mandate,
          input.float.toLowerCase(),
          input.network,
          input.asset,
          input.payTo,
          input.resource,
          microToNumeric(input.amountMicro),
          microToNumeric(input.lockMicro),
          microToNumeric(input.feeMicro),
          input.nonce.toLowerCase(),
          input.validBefore.toString(),
          input.deadline.toString(),
          input.signedBlock.toString(),
          this.now(),
        ],
      );
      if (!row) return { opened: false, reason: 'replay', availableMicro: available };
      return { opened: true, payment: toPayment(row) };
    });
  }

  promised(float: Address): Promise<Micro> {
    return promisedOn(this.db, float);
  }

  async find(id: string): Promise<BasePayment | null> {
    const row = await one<Row>(this.db, `SELECT ${COLUMNS} FROM bursar_base_payments WHERE id = $1::uuid`, [id]);
    return row ? toPayment(row) : null;
  }

  async findLock(chainId: number, escrow: Address, lockId: bigint): Promise<BasePayment | null> {
    const row = await one<Row>(
      this.db,
      `SELECT ${COLUMNS} FROM bursar_base_payments WHERE chain_id = $1 AND escrow = $2 AND lock_id = $3`,
      [chainId, escrow.toLowerCase(), lockId.toString()],
    );
    return row ? toPayment(row) : null;
  }

  async listOpen(limit: number): Promise<BasePayment[]> {
    const rows = await many<Row>(
      this.db,
      `SELECT ${COLUMNS} FROM bursar_base_payments WHERE status IN ('signed', 'paid')
       ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.map(toPayment);
  }

  async listMandate(mandate: Address, limit: number): Promise<BasePayment[]> {
    const rows = await many<Row>(
      this.db,
      `SELECT ${COLUMNS} FROM bursar_base_payments WHERE lower(mandate) = $1
       ORDER BY created_at DESC LIMIT $2`,
      [mandate.toLowerCase(), limit],
    );
    return rows.map(toPayment);
  }

  async report(id: string, transaction: Hex): Promise<void> {
    await this.db.query(
      `UPDATE bursar_base_payments SET reported_tx_hash = $2, updated_at = $3
       WHERE id = $1::uuid AND reported_tx_hash IS NULL`,
      [id, transaction, this.now()],
    );
  }

  async markPaid(id: string, baseTransaction: Hex | null): Promise<void> {
    await this.db.query(
      `UPDATE bursar_base_payments SET status = 'paid', base_tx_hash = COALESCE($2, base_tx_hash), updated_at = $3
       WHERE id = $1::uuid AND status = 'signed'`,
      [id, baseTransaction, this.now()],
    );
  }

  async close(id: string, status: 'settled' | 'returned', rhcTransaction: Hex): Promise<void> {
    const now = this.now();
    await this.db.query(
      `UPDATE bursar_base_payments SET status = $2, rhc_tx_hash = $3, updated_at = $4, closed_at = $4
       WHERE id = $1::uuid AND status IN ('signed', 'paid')`,
      [id, status, rhcTransaction, now],
    );
  }

  async countStuck(nowSeconds: bigint): Promise<number> {
    const row = await one<{ stuck: string }>(
      this.db,
      `SELECT COUNT(*) AS stuck FROM bursar_base_payments WHERE status IN ('signed', 'paid') AND deadline < $1`,
      [nowSeconds.toString()],
    );
    return countToNumber(row?.stuck);
  }
}
