import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
export const feeSelections = z
  .array(
    z.object({ id: z.uuid(), version: z.number().int().positive() }).strict(),
  )
  .max(2);
export async function snapshotFees(
  c: PoolClient,
  customerId: string,
  date: string,
  base: number,
  selections: z.infer<typeof feeSelections>,
) {
  if (new Set(selections.map((s) => s.id)).size !== selections.length)
    throw new BadRequestException("Choose each fee policy only once");
  if (!selections.length) return { snapshot: [], total: 0 };
  const policies = (
    await c.query(
      "SELECT * FROM service_fee_policies WHERE id=ANY($1::uuid[]) ORDER BY kind,id FOR SHARE",
      [selections.map((s) => s.id)],
    )
  ).rows;
  if (
    policies.length !== selections.length ||
    policies.some((p) => p.customer_id !== customerId)
  )
    throw new BadRequestException("Fee policies must belong to this customer");
  if (new Set(policies.map((p) => p.kind)).size !== policies.length)
    throw new BadRequestException(
      "Select at most one fuel and one handling policy",
    );
  const snapshot = policies.map((p) => {
    if (
      p.version !== selections.find((s) => s.id === p.id)!.version ||
      !p.active ||
      date < p.effective_from ||
      (p.effective_to && date > p.effective_to)
    )
      throw new ConflictException(
        "Fee policy changed or is not effective on the service date; refresh the quote",
      );
    const amount =
      p.method === "flat"
        ? p.value
        : Number((BigInt(base) * BigInt(p.value) + 5000n) / 10000n);
    return {
      id: p.id,
      version: p.version,
      kind: p.kind,
      name: p.name,
      method: p.method,
      value: p.value,
      base_cents: base,
      amount_cents: amount,
      effective_from: p.effective_from,
      effective_to: p.effective_to,
    };
  });
  const total = snapshot.reduce((sum, p) => sum + p.amount_cents, 0);
  if (base + total > 100000000)
    throw new BadRequestException(
      "Agreed base price and fees exceed the supported order total",
    );
  return { snapshot, total };
}
// Reverse the remaining recognized revenue proportionally using integer largest-remainder allocation.
// This includes fee revenue from both original charges and later posted late fees.
export async function postAllocatedCredit(
  c: PoolClient,
  invoiceId: string,
  amount: number,
  adjustmentId: string,
  originalNet: number,
) {
  const rows = (
    await c.query(
      "WITH postings AS (SELECT credit_account AS account,amount_cents AS amount FROM journal WHERE invoice_id=$1 UNION ALL SELECT debit_account,-amount_cents FROM journal WHERE invoice_id=$1) SELECT account,sum(amount)::bigint AS available FROM postings WHERE account=ANY($2::text[]) GROUP BY account HAVING sum(amount)<>0 ORDER BY account",
      [
        invoiceId,
        [
          "service_revenue",
          "rental_revenue",
          "facility_revenue",
          "fee_revenue",
          "opening_equity",
          "deferred_revenue",
        ],
      ],
    )
  ).rows;
  const net = originalNet;
  if (
    rows.some((r) => BigInt(r.available) < 0n) ||
    rows.reduce((n, r) => n + Number(r.available), 0) !== net ||
    amount > net
  )
    throw new ConflictException(
      "Invoice revenue does not reconcile; review its ledger before issuing a credit",
    );
  const total = BigInt(net),
    credit = BigInt(amount);
  const parts = rows.map((r) => {
    const product = BigInt(r.available) * credit;
    return {
      account: r.account,
      amount: Number(product / total),
      remainder: product % total,
    };
  });
  let left = amount - parts.reduce((n, r) => n + r.amount, 0);
  parts.sort((a, b) =>
    a.remainder === b.remainder
      ? a.account.localeCompare(b.account)
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const part of parts)
    if (left > 0) {
      part.amount++;
      left--;
    }
  parts.sort((a, b) => a.account.localeCompare(b.account));
  let index = 0;
  for (const part of parts)
    if (part.amount > 0)
      await c.query(
        "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,$2,'accounts_receivable',$3,$4,$5)",
        [
          invoiceId,
          part.account,
          part.amount,
          index++ === 0 ? "credit_memo" : "credit_memo_split_" + index,
          adjustmentId,
        ],
      );
}
