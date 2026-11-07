import type { PendingAction } from "./action-queue";
// Build once from the cached server snapshot and durable requests; never replay an overlay onto itself.
export function disposalWork(
  jobs: any[],
  remote: any[],
  pending: PendingAction[],
) {
  let loads = remote.map((l) => ({ ...l }));
  for (const job of jobs) {
    if (
      !job.rental_id ||
      !["pickup", "exchange"].includes(job.rental_action) ||
      !["completed", "invoiced"].includes(job.status) ||
      job.disposal_ticket_id ||
      (job.disposal_load_id && job.disposal_driver_id !== job.driver_id) ||
      loads.some((l) => l.order_id === job.id)
    )
      continue;
    loads.push({
      id: job.disposal_load_id || job.id,
      order_id: job.id,
      rental_id: job.rental_id,
      customer_name: job.customer_name,
      container_number: job.container_number,
      status: "awaiting_disposal",
      version: 1,
    });
  }
  for (const action of pending) {
    if (action.kind === "disposal")
      loads = loads.filter((l) => l.order_id !== action.body.order_id);
    if (action.kind === "unable_dump")
      loads = loads.flatMap((l) =>
        l.id !== action.loadId
          ? [l]
          : !action.body.returning_later
            ? []
            : l.version === action.body.version
              ? [
                  {
                    ...l,
                    status: "disposal_failed",
                    version: l.version + 1,
                    last_failure_reason: action.body.reason,
                  },
                ]
              : [l],
      );
  }
  return loads;
}
