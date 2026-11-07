# Public workflow research

Reviewed November 7, 2026. Earlier CONNECT 403 results were resolved after the user published the environment. The required website, help center and legacy knowledge base returned HTTP 200 in this resumed session. No additional network configuration was changed or published.

Only public workflow descriptions were reviewed. Source code, graphics, branding and UI assets were not copied. Downloaded research pages are kept in ignored local scratch storage, not shipped with the product.

## Reviewed sources

- https://www.curbwaste.com/ — public capability overview.
- https://www.curbwaste.com/help-center — help center entry point.
- https://knowledgebase.curbwaste.com/ — legacy article directory; points to a newer knowledge base on another host.
- https://knowledgebase.curbwaste.com/recurring-billing-template — billing cadence, anchoring, proration and invoice timing.
- https://knowledgebase.curbwaste.com/route-plan-optimization — previewing and explicitly accepting an optimized stop sequence.
- https://knowledgebase.curbwaste.com/tasks — independent driver assignments separate from billable orders.
- https://knowledgebase.curbwaste.com/what-is-the-difference-between-unable-to-complete-and-unable-to-dump — collection failure versus outstanding disposal; inventory availability after a loaded return.
- https://knowledgebase.curbwaste.com/serialized-inventory-driver-app-enhancements — yard/truck availability and serialized asset reservation.
- https://knowledgebase.curbwaste.com/adding-fuel-and-handling-fees — configured flat/percentage fees and calculation bases.

## Independent implementation and remaining parity work

| Public workflow | CoreWaste implementation | Further acceptance or development |
|---|---|---|
| Customer/order/dispatch/portal | Shared accounts, scoped portal, order history, routes, realtime refresh, reports | Broader calendar/map dispatch and real operational acceptance |
| Recurring billing | Per-service billing; calendar monthly arrears, calendar-day first/final proration, verified visits, duplicate prevention, contract end dates | Anniversary anchoring, advance billing and the other documented billing cadences/templates |
| Route optimization | Ordered routes with explicit editing and in-progress assignment protection | Real road/truck-aware provider, optimized preview, ETA and map acceptance; no straight-line optimizer is presented as road routing |
| Driver tasks | Required service checklists, independent prioritized driver tasks with start/completion/failure, and separate disposal tasks | Full installed-device acceptance and broader task tooling |
| Collection versus disposal | Completed collection creates an outstanding load and blocks container reuse until a verified disposal ticket; driver unable-to-dump report, return-to-dispatch and separate reassignment | Full yard/truck movement lifecycle and installed-device workflow |
| Serialized inventory | Physical container reservations, overlapping-booking exclusion, movements and disposal holds | Multiple yards, truck stock, native asset reservation/selection and non-serialized stock workflows |
| Extra charges | Agreed service/rental prices, extension/weight fees, credits and configured late fees | Reviewed flat/percentage fuel and handling charge policies and their applicable bases |
| Accounting | Balanced append-only journal, receipts/refunds/credits and reviewed QuickBooks general-ledger exports | Live provider acceptance, provider refunds, native QuickBooks invoice/payment reconciliation |

The inventory disposal hold was added after reviewing the public inability-to-dump workflow: a collected loaded container cannot be treated as empty available inventory. Tests cover return to dispatch, a relief driver's reassignment, retained inventory hold and exactly one verified release.

The newer knowledge base referenced by the directory has not been reviewed. Public descriptions alone do not establish complete product parity. The detailed original request remains in BUILD_REQUIREMENTS.md; FEATURES.md records incomplete implementation and acceptance.
