type RentalWork = {
  id: string;
  status: string;
  rental_id?: string;
  rental_action?: string;
  container_number?: string;
  replacement_container_number?: string | null;
};
// Apply only the equipment handoff implied by an accepted/queued exchange. No assignment or version is invented.
export function advanceRentalPickup<T extends RentalWork>(
  jobs: T[],
  exchange: T,
): T[] {
  if (
    exchange.rental_action !== "exchange" ||
    !exchange.rental_id ||
    !exchange.container_number ||
    !exchange.replacement_container_number
  )
    return jobs;
  return jobs.map((job) =>
    job.id !== exchange.id &&
    job.rental_id === exchange.rental_id &&
    job.rental_action === "pickup" &&
    job.container_number === exchange.container_number &&
    !["completed", "invoiced", "cancelled"].includes(job.status)
      ? { ...job, container_number: exchange.replacement_container_number! }
      : job,
  );
}
