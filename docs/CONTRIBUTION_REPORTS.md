# Service and route operating contribution

Finance can optionally attribute a full recorded expense to one service order or one route. Leave both fields empty for unallocated overhead. The target must exist, a service cannot be cancelled, a route cannot be archived, and a supplied truck must match the target's known assignment. Original expenses stay immutable; vendor credits follow their original cost attribution automatically. No extra expense/journal row is created merely for attribution.

Service profitability and route profitability use dated journal postings: recognized service/rental/facility/fee revenue less recorded net expense. Deferred advance contract charges and opening-equity balances do not count as earned revenue. Service categories follow the invoice's service/contract/facility context. A directly attributed service expense follows its order's service type; route-wide costs have no guessed service split.

Route revenue is assigned only when all linked service orders for its invoice belong to one saved route. Ordinary single-order invoices are unambiguous. Multi-route contracts/rentals, facility invoices and unrouted work remain in **Unallocated / mixed routes**. Service-order costs follow their saved route; explicit route expenses follow the chosen route. Route ownership is the current saved stop ownership, not a reconstructed historical assignment snapshot.

Each report keeps unallocated revenue/costs visible. Summing either split reconciles to the ledger profitability report for the same posting-date range. Invoice credits reduce revenue; vendor credits reduce their attributed expenses. Bill payments/reversals settle liabilities and do not recognize expense again.

These are operating contribution reports, not a fully allocated net margin or estimates of unrecorded labor/fuel. Disposal-ticket costs count only when also recorded as an actual business expense/bill. Enter each actual cost once. No automatic labor rates, depreciation, overhead split or ticket-to-cash posting is invented. Review accounting policies and real-data attribution before production use.
