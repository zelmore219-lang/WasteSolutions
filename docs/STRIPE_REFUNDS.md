# Stripe payment returns and account-credit refunds

Finance can review provider refunds from the office navigation or expand **Review Stripe refunds** on a Stripe payment/account credit. Provider credentials must be configured before a request or a read of a live receipt. Creating a request only reserves the selected funds; a separate **Submit refund to Stripe** action sends money. The application never sends a refund simply because an invoice is viewed, a request is saved, or a page is refreshed.

## Funding and accounting

A return against an ordinary recorded Stripe payment debits receivables and credits cash after Stripe confirms success. It reopens the affected invoice; it does not reverse the original service revenue. A service-price/cancellation adjustment is a separate reviewed credit memo.

If the payment already funded customer account credit, refund that remaining credit liability instead. Invoice-funded credits require the recorded Stripe payment ID from the same invoice. Captured Stripe account credit retains its own original payment-intent reference and does not require an invented invoice payment. Confirmed credit refunds debit customer_credit, credit cash and reduce the credit's remaining amount without reopening the credited source invoice. They retain their original Stripe payment reference and contribute to the original payment's displayed refunded total.

Requests serialize against the source invoice/credit and reserve unrefunded Stripe funds and unspent account credit. A concurrent request cannot reserve the same money twice. Credit applications and manual cash/check credit refunds cannot spend funds reserved for a provider refund. Invoice credit memos are blocked while relevant provider refunds are unresolved. A never-submitted request may be cancelled locally; an attempted request cannot be silently discarded to free funds.

## Delivery and receipt recovery

A durable request identity and exact amount/reason/funding snapshot are retained. Submission claims that identity transactionally, makes provider I/O outside the transaction, uses a stable Stripe idempotency key and disables SDK retry for that refund POST. Concurrent/repeated submissions do not send a second request. A lost process or uncertain provider reply leaves the request sending/review with its funds reserved. There is no timed retry or resubmission after Stripe's idempotency retention expires.

A pending refund posts no success or financial refund row. A successful response or signed refund.created/refund.updated/refund.failed event must exactly match the request's metadata ID, payment intent, USD amount, provider refund ID and configured live/test mode. Only confirmed success records the immutable local refund, journal and once-only customer notice. Repeated receipts/events cannot post twice. A stale failure/pending event cannot downgrade an already recorded success. A provider-confirmed failed/cancelled refund releases its reservation without a success posting.

Finance can retrieve an exact `re_…` receipt to recover a lost response. Reconciliation uses GET and never sends another refund. Wrong amount, intent, metadata or provider ID fails before accounting changes. Provider errors are sanitized; raw provider errors/keys are not returned to the office. An uncertain request without an exact provider receipt remains reserved for operator/provider investigation; absence of a receipt is not treated as proof that no refund occurred.

## Externally issued refunds

Signed receipts without a matched local request are retained as immutable observations and shown for finance review. Further refunds against the affected funds are blocked until reconciliation; no accounting treatment is guessed from the provider event. Even an external failed/cancelled observation needs explicit verification before its review hold is released.

From Provider refunds, finance can choose the original recorded payment or account-credit liability, supply the existing Stripe refund ID, exact amount, reason and `RECONCILE re_…` confirmation. The server retrieves the provider receipt, validates its funding/amount/mode and rejects a receipt belonging to another CoreWaste request. The operation records the verified external receipt and its chosen legitimate accounting treatment without sending another refund. Original provider observations remain intact. Later matching signed events can settle an adopted pending external receipt. A receipt can be reconciled only once.

## Validation and activation

Automated tests use an injected deterministic provider with PostgreSQL and cryptographically signed local webhook fixtures. They exercise concurrent reservations/submission, cancellation, lost responses, mismatched receipts, mode/signature rejection, pending/failed/success events, both kinds of account credit and external receipt reconciliation. A browser/HTTP workflow verifies provider-disabled review and signed once-only settlement. These are not evidence of live Stripe bank/card/ACH behavior. Configure Stripe credentials and the three refund event types on the deployed webhook, then run authorized sandbox and live acceptance before production.
