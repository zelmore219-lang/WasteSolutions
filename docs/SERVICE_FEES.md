# Agreed fuel and handling charges

Finance roles maintain customer-specific fuel and handling policies under Customer pricing. Each policy is a flat USD amount or a percentage of the service base in basis points, with inclusive effective dates, active state and optimistic version. Policy changes require a reason and retain an audit record. Percentages are limited to 100 percent per policy.

Office staff explicitly select at most one fuel policy and one handling policy on a new ordinary order or quoted rate order. No fee is enabled by default. Both percentages use the agreed service base independently, without compounding. Calculations use integer arithmetic and round half up to the nearest cent. The server validates account ownership, dates, policy versions, active state and the supported total before creating work. The order saves the selected names, versions, formulas, base and calculated amounts; later policy edits or rescheduling do not reprice already agreed work.

The order total is its saved base plus the saved fees. Invoicing itemizes service, fuel and handling, credits service_revenue only for the base and fee_revenue only for fees, and recognizes the combined receivable once. Zero amounts do not create zero-value journal postings. Monthly contracts, roll-off packages and scale tickets retain their separate charge workflows; they do not inherit these policies silently.

Invoice credit memos now reverse the remaining service/facility/rental/fee/equity charges proportionally, including posted late fees. Integer largest-remainder allocation preserves every cent and allows a final full credit to clear all original revenue components. A paid excess still becomes customer-credit liability rather than a negative receivable. A ledger that does not reconcile is rejected for review rather than credited against an invented account. Original journal and invoice lines remain append-only.

Global automatic policies, contract fees, taxes, compounded charges and payment-provider refunds remain separate work. This module does not initiate a charge or contact a payment provider.
