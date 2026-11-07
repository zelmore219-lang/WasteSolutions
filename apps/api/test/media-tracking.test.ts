import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Actor, Operations } from "../src/domain";
import { Media } from "../src/media";
import { DriverTracking } from "../src/driver-tracking";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  media = new Media(ops),
  tracking = new DriverTracking(ops);
const key = () => randomUUID();
let owner: Actor,
  driver: Actor,
  stranger: Actor,
  customer: Actor,
  orderId: string,
  directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "corewaste-media-test-"));
  process.env.LOCAL_STORAGE_DIR = directory;
  process.env.STORAGE_DRIVER = "local";
  process.env.NODE_ENV = "test";
  for (const role of ["owner", "driver", "driver"]) {
    const r = (
      await pool.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$3) RETURNING *",
        [key(), "media_" + key().slice(0, 8), role],
      )
    ).rows[0];
    if (role === "owner") owner = r;
    else if (!driver) driver = r;
    else stranger = r;
  }
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Media fixture",
    kind: "commercial",
    email: "media@example.test",
    billing_address: "Media Street",
  });
  customer = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,'Media customer','customer',$3) RETURNING *",
      [key(), "media_" + key().slice(0, 8), c.id],
    )
  ).rows[0];
  const l: any = await ops.createLocation(owner, key(), c.id, {
    address: "Media service street",
  });
  const t = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "MEDIA-" + key(),
    ])
  ).rows[0];
  const o: any = await ops.createOrder(owner, key(), {
    customer_id: c.id,
    location_id: l.id,
    kind: "pickup",
    scheduled_date: "2026-11-12",
    price_cents: 0,
  });
  orderId = o.id;
  await ops.assign(owner, key(), orderId, {
    driver_id: driver.id,
    truck_id: t.id,
    version: 1,
  });
});
after(async () => {
  await pool.end();
  await rm(directory, { recursive: true, force: true });
});
async function png() {
  return {
    buffer: await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#186b50" },
    })
      .png()
      .toBuffer(),
    originalname: "service.png",
  };
}
test("service photographs are normalized, private by default, retry-safe and integrity-checked", async () => {
  const file = await png(),
    command = key();
  const a: any = await media.upload(
      driver,
      command,
      { entity_kind: "order", entity_id: orderId, kind: "photo" },
      file,
    ),
    b: any = await media.upload(
      driver,
      command,
      { entity_kind: "order", entity_id: orderId, kind: "photo" },
      file,
    );
  assert.equal(a.id, b.id);
  assert.equal(a.content_type, "image/jpeg");
  assert.equal((await media.list(customer, "order", orderId)).length, 0);
  await assert.rejects(media.download(customer, a.id), /Forbidden/);
  await assert.rejects(media.download(stranger, a.id), /Forbidden/);
  const downloaded = await media.download(owner, a.id);
  assert.equal(downloaded.data[0], 255);
  await writeFile(join(directory, a.id), "tampered");
  await assert.rejects(media.download(owner, a.id), /integrity check/);
});
test("customer-visible signatures require signer details; invalid files are rejected", async () => {
  await assert.rejects(
    media.upload(
      driver,
      key(),
      { entity_kind: "order", entity_id: orderId, kind: "signature" },
      await png(),
    ),
    /signer name/,
  );
  const signature: any = await media.upload(
    driver,
    key(),
    {
      entity_kind: "order",
      entity_id: orderId,
      kind: "signature",
      visibility: "customer",
      signer_name: "Customer signature fixture",
      signed_at: new Date().toISOString(),
    },
    await png(),
  );
  assert.equal(signature.content_type, "image/png");
  assert.ok(
    (await media.list(customer, "order", orderId)).some(
      (x) => x.id === signature.id,
    ),
  );
  await assert.rejects(
    media.upload(
      driver,
      key(),
      { entity_kind: "order", entity_id: orderId, kind: "document" },
      {
        buffer: Buffer.from("<script>malicious</script>"),
        originalname: "file.pdf",
      },
    ),
    /JPEG or PNG/,
  );
});
test("location recording requires driver consent and sensible times; dispatch sees coordinates but other drivers cannot", async () => {
  await assert.rejects(
    tracking.record(driver, key(), {
      latitude: 41,
      longitude: -87,
      accuracy_m: 12,
      recorded_at: new Date().toISOString(),
      consent: false,
    }),
  );
  await tracking.record(driver, key(), {
    latitude: 41.88,
    longitude: -87.62,
    accuracy_m: 12,
    recorded_at: new Date().toISOString(),
    consent: true,
  });
  assert.ok(
    (await tracking.latest(owner)).some((l) => l.driver_id === driver.id),
  );
  await assert.rejects(tracking.latest(stranger), /Forbidden/);
  await assert.rejects(
    tracking.record(driver, key(), {
      latitude: 41,
      longitude: -87,
      accuracy_m: 12,
      recorded_at: "2020-01-01T00:00:00Z",
      consent: true,
    }),
    /timestamp/,
  );
});
test("offline conflict proof is retained for dispatch review without overwriting the service order", async () => {
  const proof: any = await tracking.exception(driver, key(), {
    order_id: orderId,
    command_key: key(),
    original_version: 1,
    reported_status: "completed",
    note: "Offline completion conflicted with reassignment",
    performed_at: new Date().toISOString(),
  });
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [orderId]))
      .rows[0].status,
    "assigned",
  );
  await assert.rejects(
    tracking.exception(stranger, key(), {
      order_id: orderId,
      command_key: key(),
      original_version: 1,
      reported_status: "completed",
      note: "Unauthorized",
      performed_at: new Date().toISOString(),
    }),
    /assignment history/,
  );
  await tracking.resolve(owner, key(), proof.id, {
    status: "acknowledged",
    resolution: "Service evidence retained; reconcile dispatch before billing",
  });
  assert.equal(
    (await tracking.exceptions(driver)).find((x) => x.id === proof.id).status,
    "acknowledged",
  );
});

test("offline physical container evidence is preserved for review and cannot be silently replaced", async () => {
  const timestamp = new Date().toISOString(),
    command = key(),
    body = {
      order_id: orderId,
      command_key: command,
      original_version: 1,
      reported_status: "completed",
      note: "Original offline physical confirmation",
      performed_at: timestamp,
      original_body: {
        status: "completed",
        version: 1,
        note: "",
        performed_at: timestamp,
        service_date: "2026-11-07",
        container_verification: {
          container_number: "ACTUAL-42",
          replacement_container_number: "ACTUAL-43",
        },
      },
    };
  const proof: any = await tracking.exception(driver, key(), body);
  assert.deepEqual(
    proof.original_body.container_verification,
    body.original_body.container_verification,
  );
  assert.equal(
    ((await tracking.exception(driver, key(), body)) as any).id,
    proof.id,
  );
  await assert.rejects(
    tracking.exception(driver, key(), {
      ...body,
      original_body: {
        ...body.original_body,
        container_verification: { container_number: "DIFFERENT" },
      },
    }),
    /cannot be replaced/,
  );
  await assert.rejects(
    tracking.exception(driver, key(), {
      ...body,
      command_key: key(),
      original_version: 2,
    }),
    /must match/,
  );
  await assert.rejects(
    pool.query(
      "UPDATE sync_exceptions SET original_body='{}'::jsonb WHERE id=$1",
      [proof.id],
    ),
    /Immutable/,
  );
  await tracking.resolve(owner, key(), proof.id, {
    status: "acknowledged",
    resolution:
      "Original physical evidence reviewed; no automatic movement applied",
  });
  assert.deepEqual(
    (
      await pool.query(
        "SELECT original_body FROM sync_exceptions WHERE id=$1",
        [proof.id],
      )
    ).rows[0].original_body,
    proof.original_body,
  );
});
