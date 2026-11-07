# Material stock by facility or bin

Material stock tracks physical kilograms, not dollar inventory valuation. Owners, managers and dispatchers open an account for an active material and named facility/bin, recording its actual reviewed opening count and source. Even a zero opening count creates an immutable observation. Staff and finance roles can review balances and the latest 100 movements.

A manual scale ticket can explicitly select a stock account for the same material. Finishing both readings adds verified net kilograms for an inbound load or subtracts them for an outbound shipment, in the same transaction as the second reading. Replaying the accepted command cannot post another stock movement. Invoicing does not move stock again. Historical tickets and new tickets left untracked do not invent opening inventory or retroactive stock. Ticket cards identify their stock site or untracked state.

An outbound reading that exceeds available stock is rejected before committing the second reading. Review receipts or reconcile a physical count before retrying; the ticket remains open. This software does not authorize a truck to leave or operate scale hardware. Concurrent outbound tickets serialize on the account and cannot jointly consume more stock than recorded.

A physical count requires the account version that was reviewed and a reason. Any intervening movement makes the count stale. Reconcile the actual measurement before submitting another count; a refresh is not permission to overwrite a changed balance blindly. Differences append a count adjustment, including a zero adjustment when the recorded measurement agrees.

Transfers require the same material at two distinct active sites and current versions of both accounts. Both accounts lock in a stable order. Equal and opposite immutable entries share a transfer reference and commit together; an invalid destination, stale version or insufficient source rolls back both legs. Account/movement quantities are bounded and never become negative.

The material_stock report reconstructs site/material quantities as of its Through date from dated movements, including earlier counts and transfers. From date does not omit earlier stock. CSV/PDF output is available. Stock operations create no cash, revenue, expense or valuation journal entries.

Calibrated scale communications, material processing/yield transformations, costing/valuation, external supplier reconciliation and physical facility acceptance remain open. Manual verified readings are supported; no hardware connection or synthetic production measurement is represented as complete.
