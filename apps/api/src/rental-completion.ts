import { recordStorageEvent } from "./equipment-events";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PoolClient } from "pg";
import { Actor } from "./domain";
// Invoked inside the existing order transaction. A physical movement is never committed
// separately from its job completion or accepted twice after an offline retry.
export async function completeRentalJob(
  c: PoolClient,
  a: Actor,
  order: Record<string, any>,
  verification?: {
    container_number: string;
    replacement_container_number?: string;
  },
  performedAt?: string,
) {
  const job = (
    await c.query("SELECT * FROM rental_jobs WHERE order_id=$1", [order.id])
  ).rows[0];
  if (!job) {
    if (verification)
      throw new BadRequestException(
        "This ordinary service has no rental container to verify",
      );
    return;
  }
  const rental = (
    await c.query("SELECT * FROM rentals WHERE id=$1 FOR UPDATE", [
      job.rental_id,
    ])
  ).rows[0];
  if (["cancelled", "invoiced", "collected"].includes(rental.status))
    throw new ConflictException("Rental is no longer executable");
  const containerIds = [
    job.container_id,
    ...(job.replacement_container_id ? [job.replacement_container_id] : []),
  ].sort();
  const containers = (
    await c.query(
      "SELECT * FROM containers WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [containerIds],
    )
  ).rows;
  const current = containers.find((x) => x.id === job.container_id)!;
  const replacement = job.replacement_container_id
    ? containers.find((x) => x.id === job.replacement_container_id)
    : null;
  if (
    !verification ||
    verification.container_number !== current.number ||
    (replacement
      ? verification.replacement_container_number !== replacement.number
      : verification.replacement_container_number !== undefined)
  )
    throw new ConflictException(
      "Physically verify the assigned container number and any exchange replacement before completing this rental job",
    );
  await c.query(
    "INSERT INTO container_verifications(order_id,actor_id,container_id,container_number,replacement_container_id,replacement_container_number,verified_at) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()))",
    [
      order.id,
      a.id,
      current.id,
      verification.container_number,
      replacement?.id || null,
      verification.replacement_container_number || null,
      performedAt || null,
    ],
  );

  const move = async (id: string, action: string) => {
    await c.query(
      "INSERT INTO container_movements(container_id,rental_id,order_id,action,location_id,actor_id,service_date) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        rental.id,
        order.id,
        action,
        rental.location_id,
        a.id,
        order.scheduled_date,
      ],
    );
    const before = containers.find((co) => co.id === id)!;
    const after = (await c.query("SELECT * FROM containers WHERE id=$1", [id]))
      .rows[0];
    await recordStorageEvent(
      c,
      a.id,
      before,
      after,
      "rental_" + action,
      "Rental " + job.action + " completed with manual equipment confirmation",
      {
        observed_number:
          id === job.container_id
            ? verification.container_number
            : verification.replacement_container_number,
        order_id: order.id,
        performed_at: performedAt,
      },
    );
  };
  if (job.action === "delivery") {
    if (
      rental.status !== "reserved" ||
      !(
        current.status === "yard" ||
        (current.status === "on_truck" &&
          current.carried_by_truck_id === order.truck_id)
      )
    )
      throw new ConflictException(
        "Delivery requires a reserved rental and container physically in yard",
      );
    await c.query(
      "UPDATE containers SET status='deployed',location_id=$2,yard_id=NULL,carried_by_truck_id=NULL,version=version+1 WHERE id=$1",
      [current.id, rental.location_id],
    );
    await c.query(
      "UPDATE rentals SET status='delivered',version=version+1 WHERE id=$1",
      [rental.id],
    );
    await move(current.id, "delivered");
    return;
  }
  if (
    rental.status !== "delivered" ||
    rental.current_container_id !== current.id ||
    current.status !== "deployed" ||
    current.location_id !== rental.location_id
  )
    throw new ConflictException("Rental and deployed container do not match");
  if (order.scheduled_date < rental.start_date)
    throw new ConflictException("Pickup cannot precede delivery");
  const load = (
    await c.query(
      "INSERT INTO disposal_loads(id,order_id,rental_id,container_id,assigned_driver_id,assigned_truck_id) VALUES($1,$1,$2,$3,$4,$5) RETURNING id",
      [order.id, rental.id, current.id, order.driver_id, order.truck_id],
    )
  ).rows[0];
  await c.query(
    "INSERT INTO disposal_load_events(load_id,actor_id,action,note) VALUES($1,$2,'collected','Loaded container is unavailable until disposal is verified')",
    [load.id, a.id],
  );
  if (job.action === "exchange") {
    const replacement = containers.find(
      (x) => x.id === job.replacement_container_id,
    )!;
    if (!(
      replacement.status === "yard" ||
      (replacement.status === "on_truck" &&
        replacement.carried_by_truck_id === order.truck_id)
    ))
      throw new ConflictException("Replacement container is not in yard");
    await c.query(
      "UPDATE containers SET status='awaiting_disposal',location_id=NULL,version=version+1 WHERE id=$1",
      [current.id],
    );
    await c.query(
      "UPDATE containers SET status='deployed',location_id=$2,yard_id=NULL,carried_by_truck_id=NULL,version=version+1 WHERE id=$1",
      [replacement.id, rental.location_id],
    );
    await c.query(
      "UPDATE container_bookings SET end_date_exclusive=$3::date+1 WHERE rental_id=$1 AND container_id=$2 AND NOT released",
      [rental.id, current.id, order.scheduled_date],
    );
    await c.query(
      "UPDATE rentals SET current_container_id=$2,version=version+1 WHERE id=$1",
      [rental.id, replacement.id],
    );
    await c.query(
      "UPDATE rental_jobs SET container_id=$2 WHERE rental_id=$1 AND action='pickup'",
      [rental.id, replacement.id],
    );
    await move(current.id, "collected");
    await move(replacement.id, "delivered");
  } else {
    const incomplete = (
      await c.query(
        "SELECT 1 FROM rental_jobs j JOIN orders o ON o.id=j.order_id WHERE j.rental_id=$1 AND j.action='exchange' AND o.status NOT IN ('completed','invoiced')",
        [rental.id],
      )
    ).rowCount;
    if (incomplete)
      throw new ConflictException(
        "Complete outstanding exchanges before final pickup",
      );
    await c.query(
      "UPDATE containers SET status='awaiting_disposal',location_id=NULL,version=version+1 WHERE id=$1",
      [current.id],
    );
    await c.query(
      "UPDATE container_bookings SET end_date_exclusive=$3::date+1 WHERE rental_id=$1 AND container_id=$2 AND NOT released",
      [rental.id, current.id, order.scheduled_date],
    );
    await c.query(
      "UPDATE rentals SET status='collected',actual_pickup_date=$2,version=version+1 WHERE id=$1",
      [rental.id, order.scheduled_date],
    );
    await move(current.id, "collected");
  }
}

export async function assertRentalStart(c: PoolClient, id: string) {
  const job = (
    await c.query(
      "SELECT j.*,o.truck_id,current.carried_by_truck_id AS container_carrier,replacement.carried_by_truck_id AS replacement_carrier,r.status AS rental_status,current.status AS container_status,replacement.status AS replacement_status FROM rental_jobs j JOIN orders o ON o.id=j.order_id JOIN rentals r ON r.id=j.rental_id JOIN containers current ON current.id=j.container_id LEFT JOIN containers replacement ON replacement.id=j.replacement_container_id WHERE j.order_id=$1",
      [id],
    )
  ).rows[0];
  if (!job) return;
  if (
    job.action === "delivery" &&
    (job.rental_status !== "reserved" ||
      !(
        job.container_status === "yard" ||
        (job.container_status === "on_truck" &&
          job.container_carrier === job.truck_id)
      ))
  )
    throw new ConflictException(
      "Delivery container is not ready in the yard; resolve inventory or disposal holds before starting",
    );
  if (
    job.action !== "delivery" &&
    (job.rental_status !== "delivered" || job.container_status !== "deployed")
  )
    throw new ConflictException(
      "Rental container is not deployed for this service",
    );
  const outgoing =
    job.action === "delivery"
      ? job.container_id
      : job.action === "exchange"
        ? job.replacement_container_id
        : null;
  if (
    outgoing &&
    ((job.action === "exchange" &&
      !(
        job.replacement_status === "yard" ||
        (job.replacement_status === "on_truck" &&
          job.replacement_carrier === job.truck_id)
      )) ||
      (
        await c.query(
          "SELECT 1 FROM disposal_loads WHERE container_id=$1 AND status<>'disposed'",
          [outgoing],
        )
      ).rowCount)
  )
    throw new ConflictException(
      "Container has an unresolved disposal or inventory hold",
    );
}
