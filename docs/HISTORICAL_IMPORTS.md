# Historical source records and opening balances

Imports provides preview, duplicate/relationship validation, exact-batch apply confirmation, revalidation on apply and audited rollback. Each CSV is limited to 500 rows/50 KB. Use only authorized source exports. Imports create their own new records; they do not overwrite existing company records.

## Historical source archive

Choose `legacy_transactions` and download the empty CSV template. Supported transaction kinds are invoice, payment, refund, credit and expense. Each row requires external_id, source_system, source_reference, transaction_kind, transaction_date, positive integer amount_cents and USD currency. Customer transactions require an existing customer_id; expenses require a vendor. Optional related_reference and memo preserve original invoice links/source context. Suspended customers can retain their authorized history. Dates cannot be in the future.

Duplicate external IDs are detected, and the combination of source system, transaction kind and source reference must also be unique, including within a CSV and against retained rolled-back records. Apply rechecks the source identities, so two separately valid previews cannot import the same transaction twice. All rows in a batch apply atomically. Source rows are immutable.

**The archive is for historical lookup.** It does not create current invoices, re-post revenue or cash, initiate payments, or change live receivables. This prevents source history from duplicating separately reviewed cutover balances. Reports → legacy transactions provides dated CSV/PDF/printable lookup. Rolled-back batches are excluded from active reports while every source record and original batch remains retained for review. Source amounts preserve transaction-kind meaning and are not presented as a signed accounting trial balance.

## Cutover receivables

Reviewed unpaid opening balances use the separate `opening_balances` import. They create receivables against opening equity, using the supplied balance_date as the journal posting date. They do not recognize old revenue again. A future balance date is rejected. A source due date can predate the cutover balance date for already overdue invoices.

Rollback appends a current reversal and voids only its imported invoice. It is blocked by subsequent payments, adjustments, account-credit transfers or provider attempts. Import rollback also protects linked agreements/rentals and physical equipment activity instead of silently cancelling, detaching or retiring changed company records. Exact source migration and accounting reconciliation still require the company's authorized export and reviewed cutover totals. Historical GL conversion/reposting is not supplied by the source archive.
