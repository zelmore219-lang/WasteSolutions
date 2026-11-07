# Physical container-number confirmation

A rental delivery, exchange or pickup now requires the operator to enter the number read from the actual assigned container before completion. Exchanges also require the actual replacement number. Numbers must exactly match the current assigned equipment, including case; a mismatch must be reviewed by dispatch. Entering the wrong number leaves the order, container, rental, movements and disposal load unchanged.

Web completion includes typed numbers and an operator attestation. The native driver app checks the cached expected equipment before queuing, stores the entered numbers inside the encrypted durable service command, and replays that same payload and idempotency key. The server locks the relevant rental/equipment and checks the authoritative current assignment again. This is manual operator confirmation, not barcode scanning or a hardware-certified observation.

An accepted completion stores an append-only confirmation with the actor, equipment IDs, entered number snapshots, method and captured time in the same transaction as its physical movement. Exchanges store both equipment numbers. Retries do not create another confirmation or movement. Existing historical completions are not retroactively given fabricated confirmations.

If offline work conflicts with dispatch, submitting service evidence retains the original command body and its captured numbers. The office monitor displays those numbers for review. The original evidence cannot be changed or deleted; office resolution acknowledges/rejects it without automatically forcing the old physical movement or billing. An altered resubmission under the original queued command key is rejected.

Deploy the updated API, web client and driver client together. Older queued rental completions without the new physical confirmation will be rejected and must be preserved for office review; do not manufacture numbers or discard old proof to force replay. Actual iPhone/Android permissions, persistence/restart and field confirmation still require installed-device acceptance.

Queued exchanges also advance their own later open pickup from the old number to the replacement number in the local display/cache. The same handoff is persisted before removing an acknowledged exchange command, so a restart between acknowledgement and refresh retains the correct equipment reference. Closed, unrelated or already changed pickup references are not overwritten. The server remains authoritative when commands replay.
