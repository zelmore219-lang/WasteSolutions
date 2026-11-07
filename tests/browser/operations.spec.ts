import { test, expect, Page } from "@playwright/test";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
test.afterAll(async () => {
  await pool.end();
});
async function account(role: string) {
  const email = `browser-${randomUUID()}@example.test`,
    password = randomBytes(24).toString("base64url");
  const r = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-test-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!r.ok) throw Error("Auth emulator signup failed");
  const user = await r.json();
  const employee = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$4) RETURNING id",
      [
        user.localId,
        "browser_" + randomUUID().slice(0, 8),
        "Browser " + role,
        role,
      ],
    )
  ).rows[0];
  return { email, password, id: employee.id, uid: user.localId };
}
async function login(page: Page, user: { email: string; password: string }) {
  await page.goto("/office");
  await page.getByLabel("Work email or employee username").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
}
test("authenticated dispatcher creates a customer and service location through working forms", async ({
  page,
}) => {
  const user = await account("dispatcher");
  await login(page, user);
  await page.getByRole("button", { name: "◉ Customers" }).click();
  const name = "Browser customer " + randomUUID().slice(0, 8);
  await page.getByLabel("Company or customer name").fill(name);
  await page.getByLabel("Email", { exact: true }).fill("customer@example.test");
  await page.getByLabel("Billing address").fill("10 Billing Street");
  await page
    .getByRole("button", { name: "Create customer", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "View locations" }).click();
  await page.getByLabel("Service address").fill("20 Collection Street");
  await page.getByRole("button", { name: "Add service location" }).click();
  await expect(
    page.getByText("20 Collection Street", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "▤ Orders" }).click();
  await page
    .getByLabel("Customer", { exact: true })
    .selectOption({ label: name });
  await page
    .getByLabel("Service location", { exact: true })
    .selectOption({ label: "20 Collection Street" });
  await page.getByLabel("Scheduled date").fill("2026-11-10");
  await page.getByLabel("Agreed price ($)").fill("185.00");
  await page
    .getByRole("button", { name: "Create service order", exact: true })
    .click();
  await expect(page.locator(".order").filter({ hasText: name })).toContainText(
    "$185.00",
  );
});
test("inventory form writes real equipment records and displays them after refresh", async ({
  page,
}) => {
  const user = await account("dispatcher");
  await login(page, user);
  await page.getByRole("button", { name: "▧ Containers" }).click();
  const number = "BROWSER-" + randomUUID().slice(0, 8);
  await page.getByLabel("Container number").fill(number);
  await page.getByLabel("Capacity (cubic yards)").fill("30");
  await page
    .getByRole("button", { name: "Add equipment", exact: true })
    .click();
  await expect(page.getByRole("row").filter({ hasText: number })).toContainText(
    "yard",
  );
  await page.reload();
  await page.getByRole("button", { name: "▧ Containers" }).click();
  await expect(page.getByRole("row").filter({ hasText: number })).toBeVisible();
});
test("accountant records a payment through the invoice screen and sees the paid balance", async ({
  page,
}) => {
  const user = await account("accountant");
  const customer = (
    await pool.query(
      "INSERT INTO customers(name,kind,email,billing_address) VALUES($1,'commercial','billing-browser@example.test','Browser Billing Street') RETURNING id",
      ["Payment browser " + randomUUID().slice(0, 8)],
    )
  ).rows[0];
  const material = (
    await pool.query(
      "INSERT INTO materials(name,category,rate_cents_per_tonne,minimum_charge_cents) VALUES($1,'landfill',9000,0) RETURNING id",
      ["Browser material " + randomUUID()],
    )
  ).rows[0];
  const ticket = (
    await pool.query(
      "INSERT INTO scale_tickets(customer_id,material_id,direction,vehicle_number,first_weight_kg,second_weight_kg,rate_cents_per_tonne,minimum_charge_cents,source,source_reference,status,actor_id) VALUES($1,$2,'inbound','BROWSER',8000,7000,9000,0,'manual','Browser fixture','weighed',$3) RETURNING id",
      [customer.id, material.id, user.id],
    )
  ).rows[0];
  const { Station } = await import("../../apps/api/src/station");
  const { Operations } = await import("../../apps/api/src/domain");
  const invoice: any = await new Station(new Operations(pool)).invoice(
    { id: user.id, role: "accountant", customer_id: null },
    randomUUID(),
    ticket.id,
  );
  await login(page, user);
  await page.getByRole("button", { name: "▧ Invoices", exact: true }).click();
  const row = page
    .getByRole("row")
    .filter({ hasText: "CW-" + String(invoice.number).padStart(6, "0") });
  await row.getByRole("button", { name: "View invoice" }).click();
  await page.getByLabel("Amount received ($)").fill("90.00");
  await page
    .getByLabel("Receipt or check reference")
    .fill("BROWSER-" + randomUUID());
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(row).toContainText("paid");
  await expect(row).toContainText("$0.00");
});
test("reports execute in the browser and download a nonempty PDF", async ({
  page,
}) => {
  const user = await account("accountant");
  await login(page, user);
  await page.getByRole("button", { name: "▧ Reports", exact: true }).click();
  await page
    .getByLabel("Report", { exact: true })
    .selectOption("trial_balance");
  await page.getByLabel("From date").fill("2026-01-01");
  await page.getByLabel("Through date").fill("2026-12-31");
  await page.getByRole("button", { name: "Run report", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export PDF" })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF" }).click();
  const file = await downloadEvent;
  expect(file.suggestedFilename()).toBe("CoreWaste-trial_balance.pdf");
  expect(await file.failure()).toBe(null);
  const payload = await readFile((await file.path())!);
  expect(payload.subarray(0, 5).toString()).toBe("%PDF-");
  expect(payload.length).toBeGreaterThan(500);
});
test("owner signs in with an enrolled SMS factor before entering company administration", async ({
  page,
}) => {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
  const { initializeApp, getApps } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  if (!getApps().length) initializeApp({ projectId: "demo-corewaste" });
  const user = await account("owner"),
    phone = "+1650" + String(Math.floor(Math.random() * 9000000) + 1000000);
  await getAuth().updateUser(user.uid, {
    emailVerified: true,
    multiFactor: {
      enrolledFactors: [
        {
          uid: "mfa-" + randomUUID(),
          factorId: "phone",
          phoneNumber: phone,
          displayName: "Local test MFA",
        },
      ],
    },
  });
  await page.goto("/office");
  await page.getByLabel("Work email or employee username").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Send verification code", exact: true })
    .click();
  let code = "";
  await expect
    .poll(async () => {
      const r = await fetch(
        "http://127.0.0.1:9099/emulator/v1/projects/demo-corewaste/verificationCodes",
      );
      const value = await r.json();
      code =
        value.verificationCodes?.find((c: any) => c.phoneNumber === phone)
          ?.code || "";
      return Boolean(code);
    })
    .toBe(true);
  await page.getByLabel("Verification code", { exact: true }).fill(code);
  await page
    .getByRole("button", { name: "Verify and sign in", exact: true })
    .click();
  await page.getByRole("button", { name: "▧ Company", exact: true }).click();
  await expect(page.getByLabel("Company name")).toHaveValue("CoreWaste");
});
test("public CoreWaste website submits a real inquiry that appears in the office queue", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Waste handled. Room for what’s next." }),
  ).toBeVisible();
  const name = "Public browser " + randomUUID().slice(0, 8);
  await page.getByLabel("Your name or business").fill(name);
  await page
    .getByLabel("Email address", { exact: true })
    .fill("public-browser@example.test");
  await page
    .getByLabel("Service address", { exact: true })
    .fill("Public browser service road");
  await page
    .getByLabel("How can we help?")
    .fill("Please review a weekly collection request.");
  await page.getByRole("button", { name: "Send service request ↗" }).click();
  await expect(page.getByRole("status")).toContainText(
    "sent to the CoreWaste office",
  );
  const user = await account("dispatcher");
  await login(page, user);
  await page
    .getByRole("button", { name: "▧ Service inquiries", exact: true })
    .click();
  await expect(page.locator(".order").filter({ hasText: name })).toContainText(
    "weekly collection",
  );
});
test("customer verifies email, requests access, is approved by office and enters only their account", async ({
  page,
  browser,
}) => {
  const email = "portal-browser-" + randomUUID() + "@example.test",
    password = randomBytes(24).toString("base64url");
  await page.goto("/portal");
  await page
    .getByRole("button", { name: "Create a customer sign-in", exact: true })
    .click();
  await page.getByLabel("Work email or employee username").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create customer sign-in", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Send customer verification email",
      exact: true,
    })
    .click();
  const codes = await (
    await fetch(
      "http://127.0.0.1:9099/emulator/v1/projects/demo-corewaste/oobCodes",
    )
  ).json();
  const code = codes.oobCodes.find(
    (c: any) => c.email === email && c.requestType === "VERIFY_EMAIL",
  );
  expect(Boolean(code)).toBe(true);
  const verified = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:update?key=local-test-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oobCode: code.oobCode }),
    },
  );
  expect(verified.status).toBe(200);
  await page
    .getByRole("button", { name: "Check verification", exact: true })
    .click();
  const name = "Approved portal " + randomUUID().slice(0, 8);
  await page.getByLabel("Customer or business name").fill(name);
  await page
    .getByLabel("Billing address", { exact: true })
    .fill("Portal billing road");
  await page
    .getByLabel("Service address", { exact: true })
    .fill("Portal service road");
  await page
    .getByRole("button", {
      name: "Request customer account access",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Your verified request is waiting for office approval.", {
      exact: false,
    }),
  ).toBeVisible();
  const staff = await account("dispatcher"),
    staffContext = await browser.newContext(),
    staffPage = await staffContext.newPage();
  try {
    await login(staffPage, staff);
    await staffPage
      .getByRole("button", { name: "▧ Portal access", exact: true })
      .click();
    const request = staffPage.locator(".order").filter({ hasText: email });
    await request
      .getByLabel("Review note")
      .fill("Verified request approved in browser acceptance test");
    await request
      .getByRole("button", { name: "Record access decision", exact: true })
      .click();
    await expect(request).toContainText("approved");
  } finally {
    await staffContext.close();
  }
  await page
    .getByRole("button", { name: "Check approval status", exact: true })
    .click();
  await page.getByRole("button", { name: "◉ Customers", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "▧ Company", exact: true }),
  ).toHaveCount(0);
});
test("driver completes required service tasks, records arrival, and completes assigned work", async ({
  page,
}) => {
  const dispatcher = await account("dispatcher"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const { OrderTasks } = await import("../../apps/api/src/order-tasks");
  const ops = new Operations(pool),
    officeActor = { id: dispatcher.id, role: "dispatcher", customer_id: null };
  const name = "Driver task browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(officeActor, randomUUID(), {
    name,
    kind: "commercial",
    email: "driver-task@example.test",
    billing_address: "Task billing street",
  });
  const location: any = await ops.createLocation(
    officeActor,
    randomUUID(),
    customer.id,
    { address: "Task service street" },
  );
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "TASK-" + randomUUID(),
    ])
  ).rows[0];
  const order: any = await ops.createOrder(officeActor, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "pickup",
    scheduled_date: "2026-11-07",
    price_cents: 18500,
  });
  await new OrderTasks(ops).add(officeActor, randomUUID(), order.id, {
    label: "Secure the container latch",
    required: true,
    version: 1,
  });
  await ops.assign(officeActor, randomUUID(), order.id, {
    driver_id: driver.id,
    truck_id: truck.id,
    version: 2,
  });
  await login(page, driver);
  const row = page.locator("article.order").filter({ hasText: name });
  await row.getByRole("button", { name: "Start service", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Record arrival", exact: true }),
  ).toBeVisible();
  await row
    .getByRole("button", { name: "Record arrival", exact: true })
    .click();
  await expect(row.getByText(/^Arrival:/)).toBeVisible();
  await row.locator("summary").filter({ hasText: "Service tasks" }).click();
  await row.getByRole("button", { name: "Complete task", exact: true }).click();
  await expect(row.getByText("✓ Secure the container latch")).toBeVisible();
  await row
    .getByRole("button", { name: "Complete service", exact: true })
    .click();
  await expect(row.locator(".badge")).toHaveText("completed");
  const notices = (
    await pool.query(
      "SELECT kind FROM notifications WHERE customer_id=$1 ORDER BY created_at,id",
      [customer.id],
    )
  ).rows;
  expect(notices.map((n) => n.kind)).toEqual([
    "en_route",
    "arrival",
    "service_completed",
  ]);
});

test("dispatcher creates a monthly recurring contract through the agreement form", async ({
  page,
}) => {
  const user = await account("dispatcher");
  const { Operations } = await import("../../apps/api/src/domain");
  const ops = new Operations(pool),
    actor = { id: user.id, role: "dispatcher", customer_id: null };
  const name = "Monthly form browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "monthly-form@example.test",
    billing_address: "Monthly billing street",
  });
  await ops.createLocation(actor, randomUUID(), customer.id, {
    address: "Monthly collection street",
  });
  await login(page, user);
  await page.getByRole("button", { name: "▧ Agreements", exact: true }).click();
  const form = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "New recurring service agreement",
      exact: true,
    }),
  });
  await form.getByLabel("Customer", { exact: true }).selectOption(customer.id);
  await form
    .getByLabel("Service location", { exact: true })
    .selectOption({ label: "Monthly collection street" });
  await form.getByLabel("Billing schedule").selectOption("monthly");
  await form.getByLabel("Monthly contract rate ($)").fill("200.00");
  const future = (
    await pool.query(
      "SELECT date_trunc('month',now()+interval '2 months')::date AS start,(date_trunc('month',now()+interval '2 months')+interval '14 days')::date AS finish",
    )
  ).rows[0];
  await form.getByLabel("First service date").fill(future.start);
  await form.getByLabel("Last service date (optional)").fill(future.finish);
  await form
    .getByRole("button", { name: "Create agreement", exact: true })
    .click();
  await expect(
    page.locator("article.order").filter({ hasText: name }),
  ).toContainText("$200.00 per month");
  const saved = (
    await pool.query("SELECT * FROM service_agreements WHERE customer_id=$1", [
      customer.id,
    ])
  ).rows[0];
  expect(saved.billing_mode).toBe("monthly");
  expect(saved.monthly_rate_cents).toBe(20000);
  expect(saved.price_cents).toBe(0);
});
test("service calendar previews a holiday shift and applies it to the reviewed unstarted job", async ({
  page,
}) => {
  const user = await account("dispatcher");
  const { Operations } = await import("../../apps/api/src/domain"),
    { Workflows } = await import("../../apps/api/src/workflows");
  const ops = new Operations(pool),
    workflows = new Workflows(ops),
    actor = { id: user.id, role: "dispatcher", customer_id: null };
  const name = "Calendar browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "residential",
    email: "calendar-browser@example.test",
    billing_address: "Calendar billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Calendar collection street" },
  );
  const agreement: any = await workflows.agreement(actor, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "residential",
    price_cents: 2500,
    interval_days: 7,
    next_service_date: "2027-01-15",
    contract_end_date: "2027-01-15",
  });
  await workflows.generate(actor, randomUUID(), { through_date: "2027-01-15" });
  await login(page, user);
  await page
    .getByRole("button", { name: "▧ Service calendar", exact: true })
    .click();
  const zonePanel = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Service zones and collection days",
      exact: true,
    }),
  });
  const zoneName = "Browser zone " + randomUUID().slice(0, 8);
  await zonePanel.getByLabel("Zone name", { exact: true }).fill(zoneName);
  await zonePanel
    .getByRole("button", { name: "Create service zone", exact: true })
    .click();
  await expect(
    zonePanel.getByRole("heading", {
      name: zoneName + " · Active",
      exact: true,
    }),
  ).toBeVisible();
  const assign = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Assign a location to a zone",
      exact: true,
    }),
  });
  await assign
    .getByLabel("Customer", { exact: true })
    .selectOption(customer.id);
  await assign
    .getByLabel("Location", { exact: true })
    .selectOption(location.id);
  await assign
    .getByLabel("Service zone", { exact: true })
    .selectOption({ label: zoneName });
  await assign
    .getByRole("button", { name: "Save location zone", exact: true })
    .click();
  const changes = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Holiday and collection date changes",
      exact: true,
    }),
  });
  await changes.getByLabel("Rule applies to").selectOption({ label: zoneName });
  await changes.getByLabel("Original collection date").fill("2027-01-15");
  await changes.getByLabel("Replacement date").fill("2027-01-16");
  await changes
    .getByLabel("Reason", { exact: true })
    .fill("Browser holiday acceptance");
  await changes
    .getByRole("button", { name: "Create date change", exact: true })
    .click();
  await expect(
    page.getByText(
      "Date rule saved. Preview existing orders before applying it.",
      { exact: true },
    ),
  ).toBeVisible();
  const review = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Review existing service changes",
      exact: true,
    }),
  });
  await review.getByLabel("Original service from").fill("2027-01-15");
  await review.getByLabel("Original service through").fill("2027-01-15");
  await review.getByLabel("Filter zone").selectOption({ label: zoneName });
  await review
    .getByRole("button", { name: "Preview service changes", exact: true })
    .click();
  await expect(review).toContainText("1 affected orders");
  await review
    .getByRole("button", {
      name: "Apply reviewed service changes",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("1 service dates updated. Customer notices queued.", {
      exact: true,
    }),
  ).toBeVisible();
  const order = (
    await pool.query(
      "SELECT scheduled_date,service_occurrence_date FROM orders WHERE agreement_id=$1",
      [agreement.id],
    )
  ).rows[0];
  expect(order.scheduled_date).toBe("2027-01-16");
  expect(order.service_occurrence_date).toBe("2027-01-15");
});

test("unable-to-dump remains an inventory hold until office assigns and verifies disposal", async ({
  page,
}) => {
  const dispatcher = await account("dispatcher"),
    driver = await account("driver"),
    relief = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain"),
    { Rentals } = await import("../../apps/api/src/rentals");
  const ops = new Operations(pool),
    rentals = new Rentals(ops),
    office = { id: dispatcher.id, role: "dispatcher", customer_id: null },
    driverActor = { id: driver.id, role: "driver", customer_id: null };
  const customer: any = await ops.createCustomer(office, randomUUID(), {
    name: "Disposal browser " + randomUUID().slice(0, 8),
    kind: "commercial",
    email: "disposal-browser@example.test",
    billing_address: "Disposal billing",
  });
  const location: any = await ops.createLocation(
    office,
    randomUUID(),
    customer.id,
    { address: "Disposal collection street" },
  );
  const container: any = await rentals.createContainer(office, randomUUID(), {
    number: "DISPOSAL-" + randomUUID().slice(0, 8),
    kind: "roll_off",
    capacity_yards: 20,
  });
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "DISPOSAL-" + randomUUID(),
    ])
  ).rows[0];
  const rental: any = await rentals.reserve(office, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    container_id: container.id,
    start_date: "2026-11-01",
    pickup_date: "2026-11-07",
    base_price_cents: 40000,
    extension_daily_cents: 2500,
    included_weight_kg: 2000,
    overweight_cents_per_tonne: 8000,
  });
  for (const id of [rental.delivery_order_id, rental.pickup_order_id]) {
    let o: any = await ops.assign(office, randomUUID(), id, {
      driver_id: driver.id,
      truck_id: truck.id,
      version: 1,
    });
    o = await ops.transition(driverActor, randomUUID(), id, {
      status: "in_progress",
      version: o.version,
    });
    await ops.transition(driverActor, randomUUID(), id, {
      status: "completed",
      container_verification: { container_number: container.number },
      version: o.version,
      service_date:
        id === rental.delivery_order_id ? "2026-11-01" : "2026-11-07",
    });
  }
  await login(page, driver);
  await page
    .getByRole("button", { name: "▧ Disposal loads", exact: true })
    .click();
  let card = page.locator("article.panel").filter({
    has: page.getByRole("heading", {
      name: container.number + " · " + customer.name,
      exact: true,
    }),
  });
  await card
    .getByLabel("Unable to dump reason")
    .fill("Facility closed; return to dispatch");
  await card.getByLabel("Returning later — keep on my schedule").uncheck();
  await card
    .getByRole("button", { name: "Report unable to dump", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  expect(
    (
      await pool.query("SELECT status FROM containers WHERE id=$1", [
        container.id,
      ])
    ).rows[0].status,
  ).toBe("awaiting_disposal");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, dispatcher);
  await page
    .getByRole("button", { name: "▧ Disposal loads", exact: true })
    .click();
  card = page.locator("article.panel").filter({
    has: page.getByRole("heading", {
      name: container.number + " · " + customer.name,
      exact: true,
    }),
  });
  await card
    .getByLabel("Disposal driver", { exact: true })
    .selectOption(relief.id);
  await card
    .getByLabel("Disposal truck", { exact: true })
    .selectOption(truck.id);
  await card
    .getByRole("button", { name: "Assign disposal task", exact: true })
    .click();
  await expect(card).toContainText("Browser driver");
  await card
    .getByText("Record verified disposal ticket", { exact: true })
    .click();
  await card
    .getByLabel("Facility", { exact: true })
    .fill("Verified browser disposal facility");
  await card.getByLabel("Facility ticket number").fill(randomUUID());
  await card.getByLabel("Gross weight (kg)").fill("9000");
  await card.getByLabel("Tare weight (kg)").fill("7000");
  await card.getByLabel("Disposal cost ($)").fill("120.00");
  await card
    .getByRole("button", {
      name: "Verify disposal and release inventory hold",
      exact: true,
    })
    .click();
  await expect(card).toHaveCount(0);
  expect(
    (
      await pool.query("SELECT status FROM containers WHERE id=$1", [
        container.id,
      ])
    ).rows[0].status,
  ).toBe("yard");
});

test("dispatch creates a non-billable independent task and its assigned driver completes it", async ({
  page,
}) => {
  const dispatcher = await account("dispatcher"),
    driver = await account("driver"),
    title = "Independent browser " + randomUUID().slice(0, 8);
  await login(page, dispatcher);
  await page
    .getByRole("button", { name: "▧ Driver tasks", exact: true })
    .click();
  await page.getByText("Create a driver task", { exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill(title);
  await page
    .getByLabel("Task date", { exact: true })
    .fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Task priority", { exact: true }).selectOption("high");
  await page
    .getByLabel("Task description", { exact: true })
    .fill("Collect the completed vehicle inspection paperwork");
  await page.getByLabel("Task driver", { exact: true }).selectOption(driver.id);
  await page
    .getByRole("button", { name: "Create independent task", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const task = (
    await pool.query("SELECT * FROM driver_tasks WHERE title=$1", [title])
  ).rows[0];
  expect(task.driver_id).toBe(driver.id);
  expect(task.priority).toBe("high");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, driver);
  await page
    .getByRole("button", { name: "▧ Driver tasks", exact: true })
    .click();
  const card = page
    .locator("article.panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await card
    .getByRole("button", { name: "Start independent task", exact: true })
    .click();
  await expect(
    card.getByRole("button", {
      name: "Complete independent task",
      exact: true,
    }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Complete independent task", exact: true })
    .click();
  await expect(card.locator(".badge")).toContainText("completed");
  expect(
    (await pool.query("SELECT status FROM driver_tasks WHERE id=$1", [task.id]))
      .rows[0].status,
  ).toBe("completed");
});

test("calendar drag-and-drop saves the service date, driver and truck together", async ({
  page,
}) => {
  const user = await account("dispatcher"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const ops = new Operations(pool),
    actor = { id: user.id, role: "dispatcher", customer_id: null },
    name = "Calendar drag " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "drag-calendar@example.test",
    billing_address: "Calendar drag billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Calendar drag service street" },
  );
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "DRAG-" + randomUUID(),
    ])
  ).rows[0];
  const date = new Date().toISOString().slice(0, 10),
    weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const monday = new Date(
    Date.parse(date + "T12:00:00Z") - ((weekday + 6) % 7) * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const target = new Date(Date.parse(monday + "T12:00:00Z") + 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const original: any = await ops.createOrder(actor, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "pickup",
    scheduled_date: date,
    price_cents: 18500,
  });
  await login(page, user);
  await page
    .getByRole("button", { name: "Calendar dispatch view", exact: true })
    .click();
  const panel = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Dispatch calendar",
      exact: true,
    }),
  });
  await panel.getByLabel("Week containing").fill(date);
  await panel
    .getByLabel("Calendar assignment", { exact: true })
    .selectOption("assign");
  await panel
    .getByLabel("Calendar driver", { exact: true })
    .selectOption(driver.id);
  await panel
    .getByLabel("Calendar truck", { exact: true })
    .selectOption(truck.id);
  const card = panel
    .locator("article.calendar-order")
    .filter({ hasText: name });
  await expect(card).toBeVisible();
  // Initiate the pointer drag before scrolling the horizontal board to the target.
  const handle = card.locator(".calendar-drag-handle");
  await handle.scrollIntoViewIfNeeded();
  const sourceBox = await handle.boundingBox();
  expect(sourceBox).not.toBeNull();
  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2,
    sourceBox!.y + sourceBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2 - 20,
    sourceBox!.y + sourceBox!.height / 2 + 2,
    { steps: 5 },
  );
  const destination = panel.locator(
    ".calendar-day[data-date='" + target + "'] .calendar-drop-zone",
  );
  await destination.scrollIntoViewIfNeeded();
  const targetBox = await destination.boundingBox();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height / 2,
    { steps: 20 },
  );
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2 + 1,
    targetBox!.y + targetBox!.height / 2 + 1,
  );
  await page.mouse.up();
  await expect(
    panel
      .locator(".calendar-day[data-date='" + target + "']")
      .locator("article.calendar-order")
      .filter({ hasText: name }),
  ).toContainText("assigned");
  const saved = (
    await pool.query("SELECT * FROM orders WHERE id=$1", [original.id])
  ).rows[0];
  expect(saved.scheduled_date).toBe(target);
  expect(saved.driver_id).toBe(driver.id);
  expect(saved.truck_id).toBe(truck.id);
  expect(saved.version).toBe(2);
});

test("an open driver assignment cannot silently overwrite a live dispatch change", async ({
  page,
}) => {
  const dispatcher = await account("dispatcher"),
    first = await account("driver"),
    second = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const ops = new Operations(pool),
    actor = { id: dispatcher.id, role: "dispatcher", customer_id: null },
    name = "Assignment conflict " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "assignment-conflict@example.test",
    billing_address: "Assignment billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Assignment service street" },
  );
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "ASSIGN-" + randomUUID(),
    ])
  ).rows[0];
  const order: any = await ops.createOrder(actor, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "pickup",
    scheduled_date: "2026-11-10",
    price_cents: 18500,
  });
  await login(page, dispatcher);
  const card = page.locator("article.order").filter({ hasText: name });
  await card
    .getByRole("button", { name: "Assign driver and truck", exact: true })
    .click();
  await card.getByLabel("Driver", { exact: true }).selectOption(first.id);
  await card.getByLabel("Truck", { exact: true }).selectOption(truck.id);
  await ops.assign(actor, randomUUID(), order.id, {
    version: 1,
    driver_id: second.id,
    truck_id: truck.id,
  });
  await expect(
    card.getByText(
      "This order changed while you were editing. Reload its current assignment before saving.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Save driver assignment", exact: true }),
  ).toBeDisabled();
  expect(
    (await pool.query("SELECT driver_id FROM orders WHERE id=$1", [order.id]))
      .rows[0].driver_id,
  ).toBe(second.id);
  await card
    .getByRole("button", { name: "Reload current assignment", exact: true })
    .click();
  await expect(card.getByLabel("Driver", { exact: true })).toHaveValue(
    second.id,
  );
  await card.getByLabel("Driver", { exact: true }).selectOption(first.id);
  await card
    .getByRole("button", { name: "Save driver assignment", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: "Change driver and truck", exact: true }),
  ).toBeVisible();
  const saved = (
    await pool.query("SELECT driver_id,version FROM orders WHERE id=$1", [
      order.id,
    ])
  ).rows[0];
  expect(saved.driver_id).toBe(first.id);
  expect(saved.version).toBe(3);
});

test("dispatcher verifies a service entrance on the route map and sees unconfigured road routing explicitly", async ({
  page,
}) => {
  const user = await account("dispatcher"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Workflows } = await import("../../apps/api/src/workflows");
  const ops = new Operations(pool),
    actor = { id: user.id, role: "dispatcher", customer_id: null };
  const name = "Map browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "map@example.test",
    billing_address: "Map billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Verified map entrance" },
  );
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "MAP-" + randomUUID(),
    ])
  ).rows[0];
  const order: any = await ops.createOrder(actor, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "bulk",
    scheduled_date: "2026-11-07",
    price_cents: 10000,
  });
  const route: any = await new Workflows(ops).route(actor, randomUUID(), {
    name,
    service_date: "2026-11-07",
    driver_id: driver.id,
    truck_id: truck.id,
    order_ids: [order.id],
  });
  await login(page, user);
  await page.getByRole("button", { name: "▧ Routes", exact: true }).click();
  const row = page.locator("article.order").filter({ hasText: name });
  await row
    .getByRole("button", { name: "Map and road planning", exact: true })
    .click();
  const panel = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Map and road planning",
      exact: true,
    }),
  });
  await expect(
    panel.getByRole("region", { name: "Service pins and road route map" }),
  ).toBeVisible();
  await expect(
    panel.getByText("Road routing is not configured.", { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Calculate road preview", exact: true }),
  ).toBeDisabled();
  await panel
    .locator("summary")
    .filter({ hasText: "Verify service pins" })
    .click();
  await panel.getByLabel("Entrance longitude", { exact: true }).fill("-87.65");
  await panel.getByLabel("Entrance latitude", { exact: true }).fill("41.85");
  await panel
    .getByLabel("Verification source / note")
    .fill("Customer confirmed truck entrance");
  await panel
    .getByRole("button", { name: "Save verified pin", exact: true })
    .click();
  await expect(
    panel.locator("summary").filter({ hasText: "Verify service pins" }),
  ).toContainText("(1/1)");
  await expect(panel.locator(".road-stop-pin")).toHaveCount(1);
  const pin = (
    await pool.query(
      "SELECT routing_longitude,routing_latitude,routing_note,routing_verified_by FROM locations WHERE id=$1",
      [location.id],
    )
  ).rows[0];
  expect(pin).toEqual({
    routing_longitude: -87.65,
    routing_latitude: 41.85,
    routing_note: "Customer confirmed truck entrance",
    routing_verified_by: user.id,
  });
  // Deterministic road geometry is seeded only in the isolated test database.
  // This exercises preview/application UI; it is not a live routing-provider test.
  await pool.query(
    "INSERT INTO truck_routing_profiles(truck_id,height_cm,width_cm,length_cm,gross_weight_kg,weight_per_axle_kg,verification_note,verified_by) VALUES($1,400,250,900,26000,10000,'Browser fixture only',$2)",
    [truck.id, user.id],
  );
  const { RoadPlanning } = await import("../../apps/api/src/road-planning");
  const departure = (
    await pool.query(
      "SELECT ('2026-11-07'::date+time '08:00') AT TIME ZONE timezone AS departure FROM company_settings",
    )
  ).rows[0].departure.toISOString();
  const preview = await new RoadPlanning(ops, {
    configured: () => true,
    plan: async () => ({
      order_ids: [order.id],
      distance_m: 12000,
      duration_s: 1800,
      geometry: [
        [
          [-87.7, 41.8],
          [-87.65, 41.85],
        ],
        [
          [-87.65, 41.85],
          [-87.7, 41.8],
        ],
      ],
      provider: "amazon-location-v2",
    }),
  }).create(actor, randomUUID(), route.id, {
    version: 1,
    origin: [-87.7, 41.8],
    destination: [-87.7, 41.8],
    departure_time: departure,
    optimize: false,
    verified_depots: true,
  });
  expect(preview.status).toBe("ready");
  await panel.getByRole("button", { name: "Close map", exact: true }).click();
  await row
    .getByRole("button", { name: "Map and road planning", exact: true })
    .click();
  await expect(
    panel.getByText("7.5 road miles", { exact: false }),
  ).toBeVisible();
  await expect(
    panel.locator('.leaflet-overlay-pane path[stroke="#1765b3"]'),
  ).toHaveCount(2);
  await panel
    .getByRole("button", { name: "Apply preview stop order", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "Road preview · applied", exact: true }),
  ).toBeVisible();
  await expect(
    panel.locator('.leaflet-overlay-pane path[stroke="#1765b3"]'),
  ).toHaveCount(2);
  expect(
    (
      await pool.query("SELECT status FROM road_plans WHERE id=$1", [
        preview.id,
      ])
    ).rows[0].status,
  ).toBe("applied");
  await panel.screenshot({ path: ".local/screenshots/dispatch-map.png" });
});

test("accountant records an unpaid vendor bill and a partial settlement with an auditable remaining balance", async ({
  page,
}) => {
  const user = await account("accountant"),
    vendor = "Bill browser " + randomUUID().slice(0, 8),
    reference = "BILL-" + randomUUID(),
    paymentReference = "CHECK-" + randomUUID();
  await login(page, user);
  await page.getByRole("button", { name: "▧ Expenses", exact: true }).click();
  await page
    .getByLabel("Payment status", { exact: true })
    .selectOption("payable");
  await page.getByLabel("Bill due date", { exact: true }).fill("2026-11-05");
  await page.getByLabel("Vendor", { exact: true }).fill(vendor);
  await page.getByLabel("Category", { exact: true }).selectOption("repair");
  await page.getByLabel("Expense date", { exact: true }).fill("2026-11-01");
  await page.getByLabel("Amount ($)", { exact: true }).fill("100.00");
  await page
    .getByLabel("Receipt or reference", { exact: true })
    .fill(reference);
  await page
    .getByRole("button", { name: "Record expense", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: vendor });
  await expect(row).toContainText("$100.00");
  await row.getByRole("button", { name: "Review bill", exact: true }).click();
  const panel = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Vendor bill · " + vendor,
      exact: true,
    }),
  });
  await panel
    .getByLabel("Bill payment amount ($)", { exact: true })
    .fill("35.00");
  await panel
    .getByLabel("Bill payment date", { exact: true })
    .fill("2026-11-06");
  await panel
    .getByLabel("Bill payment reference", { exact: true })
    .fill(paymentReference);
  await panel
    .getByRole("button", { name: "Record bill payment", exact: true })
    .click();
  await expect(panel).toContainText("Unpaid $65.00");
  await expect(
    panel.getByRole("row").filter({ hasText: paymentReference }),
  ).toContainText("$35.00");
  const expense = (
    await pool.query(
      "SELECT id,balance_cents FROM expense_balances WHERE reference=$1",
      [reference],
    )
  ).rows[0];
  expect(Number(expense.balance_cents)).toBe(6500);
  const entries = (
    await pool.query(
      "SELECT debit_account,credit_account,amount_cents FROM journal WHERE source_id=$1 OR source_id IN (SELECT id FROM expense_payments WHERE expense_id=$1) ORDER BY posting_date",
      [expense.id],
    )
  ).rows;
  expect(entries).toEqual([
    {
      debit_account: "expense:repair",
      credit_account: "accounts_payable",
      amount_cents: 10000,
    },
    {
      debit_account: "accounts_payable",
      credit_account: "cash",
      amount_cents: 3500,
    },
  ]);
});

test("accountant saves a customer rate and dispatch creates a connected order with the frozen quoted price", async ({
  page,
}) => {
  const accountant = await account("accountant"),
    dispatcher = await account("dispatcher");
  const { Operations } = await import("../../apps/api/src/domain");
  const ops = new Operations(pool),
    actor = { id: dispatcher.id, role: "dispatcher", customer_id: null };
  const name = "Pricing browser " + randomUUID().slice(0, 8),
    rateName = "Agreed bulk " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "pricebook@example.test",
    billing_address: "Rate billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Rate service entrance" },
  );
  await login(page, accountant);
  await page
    .getByRole("button", { name: "▧ Customer pricing", exact: true })
    .click();
  await page
    .getByLabel("Pricing customer", { exact: true })
    .selectOption(customer.id);
  await page.getByLabel("Rate name", { exact: true }).fill(rateName);
  await page.getByLabel("Rate service", { exact: true }).selectOption("bulk");
  await page
    .getByLabel("Rate location", { exact: true })
    .selectOption(location.id);
  await page.getByLabel("Rate amount ($)", { exact: true }).fill("187.50");
  await page
    .getByLabel("Rate effective from", { exact: true })
    .fill("2026-11-01");
  await page
    .getByLabel("Rate effective through", { exact: true })
    .fill("2026-11-30");
  await page
    .getByLabel("Customer-facing rate terms", { exact: true })
    .fill("One agreed bulk collection");
  await page
    .getByRole("button", { name: "Save customer rate", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Customer rate saved");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, dispatcher);
  await page
    .getByRole("button", { name: "▧ Customer pricing", exact: true })
    .click();
  await page
    .getByLabel("Pricing customer", { exact: true })
    .selectOption(customer.id);
  const card = page.locator("article.order").filter({ hasText: rateName });
  await expect(card).toContainText("$187.50");
  await card
    .getByRole("button", { name: "Create order at this rate", exact: true })
    .click();
  await page
    .getByLabel("Quoted service location", { exact: true })
    .selectOption(location.id);
  await page
    .getByLabel("Quoted service date", { exact: true })
    .fill("2026-11-07");
  await page
    .getByLabel("Quoted service instructions", { exact: true })
    .fill("Use the verified entrance");
  await page
    .getByRole("button", { name: "Create quoted service order", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Created order CW-O");
  const orders = (
    await pool.query(
      "SELECT price_cents,pricebook_id,pricing_snapshot FROM orders WHERE customer_id=$1",
      [customer.id],
    )
  ).rows;
  expect(orders).toHaveLength(1);
  expect(orders[0].price_cents).toBe(18750);
  expect(orders[0].pricing_snapshot).toMatchObject({
    name: rateName,
    version: 1,
    price_cents: 18750,
    description: "One agreed bulk collection",
  });
  expect(orders[0].pricebook_id).not.toBeNull();
});

test("accounting configures agreed fuel and handling fees and dispatch explicitly includes them in a quoted order", async ({
  page,
}) => {
  const accountant = await account("accountant"),
    dispatcher = await account("dispatcher"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Pricebooks } = await import("../../apps/api/src/pricebooks");
  const ops = new Operations(pool),
    office = { id: dispatcher.id, role: "dispatcher", customer_id: null },
    finance = { id: accountant.id, role: "accountant", customer_id: null },
    name = "Fee browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(office, randomUUID(), {
    name,
    kind: "commercial",
    email: "fees@example.test",
    billing_address: "Fee billing",
  });
  const location: any = await ops.createLocation(
    office,
    randomUUID(),
    customer.id,
    { address: "Fee collection entrance" },
  );
  await new Pricebooks(ops).create(finance, randomUUID(), {
    customer_id: customer.id,
    location_id: null,
    name: "Base agreed pickup",
    description: "Base service",
    kind: "bulk",
    price_cents: 10000,
    effective_from: "2026-11-01",
    effective_to: "2026-11-30",
    active: true,
  });
  await login(page, accountant);
  await page
    .getByRole("button", { name: "▧ Customer pricing", exact: true })
    .click();
  await page
    .getByLabel("Pricing customer", { exact: true })
    .selectOption(customer.id);
  const section = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Customer fuel and handling policies",
      exact: true,
    }),
  });
  await section
    .getByLabel("Fee policy name", { exact: true })
    .fill("Agreed fuel ten percent");
  await section
    .getByLabel("Fee calculation", { exact: true })
    .selectOption("percent");
  await section.getByLabel("Fee percentage (%)", { exact: true }).fill("10.00");
  await section
    .getByLabel("Fee effective from", { exact: true })
    .fill("2026-11-01");
  await section
    .getByLabel("Fee effective through", { exact: true })
    .fill("2026-11-30");
  await section
    .getByRole("button", { name: "Save fee policy", exact: true })
    .click();
  await expect(section.locator("article.order")).toHaveCount(1);
  await section
    .getByLabel("Fee policy name", { exact: true })
    .fill("Agreed handling");
  await section
    .getByLabel("Fee kind", { exact: true })
    .selectOption("handling");
  await section.getByLabel("Fee amount ($)", { exact: true }).fill("2.50");
  await section
    .getByLabel("Fee effective from", { exact: true })
    .fill("2026-11-01");
  await section
    .getByLabel("Fee effective through", { exact: true })
    .fill("2026-11-30");
  await section
    .getByRole("button", { name: "Save fee policy", exact: true })
    .click();
  await expect(section.locator("article.order")).toHaveCount(2);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, dispatcher);
  await page
    .getByRole("button", { name: "▧ Customer pricing", exact: true })
    .click();
  await page
    .getByLabel("Pricing customer", { exact: true })
    .selectOption(customer.id);
  await page
    .getByRole("button", { name: "Create order at this rate", exact: true })
    .click();
  const policies = (
    await pool.query(
      "SELECT * FROM service_fee_policies WHERE customer_id=$1",
      [customer.id],
    )
  ).rows;
  await page
    .getByLabel("Fuel fee policy", { exact: true })
    .selectOption(policies.find((p) => p.kind === "fuel").id);
  await page
    .getByLabel("Handling fee policy", { exact: true })
    .selectOption(policies.find((p) => p.kind === "handling").id);
  await expect(
    page.getByText("Selected fees $12.50 · Agreed order total $112.50", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Quoted service location", { exact: true })
    .selectOption(location.id);
  await page
    .getByLabel("Quoted service date", { exact: true })
    .fill("2026-11-07");
  await page
    .getByRole("button", { name: "Create quoted service order", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Created order CW-O");
  const order = (
    await pool.query("SELECT * FROM orders WHERE customer_id=$1", [customer.id])
  ).rows[0];
  expect(order.fee_total_cents).toBe(1250);
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "FEES-" + randomUUID(),
    ])
  ).rows[0];
  await ops.assign(office, randomUUID(), order.id, {
    driver_id: driver.id,
    truck_id: truck.id,
    version: 1,
  });
  const actor = { id: driver.id, role: "driver", customer_id: null };
  await ops.transition(actor, randomUUID(), order.id, {
    status: "in_progress",
    version: 2,
  });
  await ops.transition(actor, randomUUID(), order.id, {
    status: "completed",
    version: 3,
    service_date: "2026-11-07",
  });
  const invoice: any = await ops.invoice(finance, randomUUID(), order.id);
  expect(invoice.amount_cents).toBe(11250);
  expect(
    (
      await pool.query(
        "SELECT amount_cents FROM invoice_lines WHERE invoice_id=$1",
        [invoice.id],
      )
    ).rows
      .map((r) => r.amount_cents)
      .sort((a, b) => a - b),
  ).toEqual([250, 1000, 10000]);
});

test("dispatch records physical stock, transfers between sites and posts a tracked inbound weighing", async ({
  page,
}) => {
  const user = await account("dispatcher"),
    accountant = await account("accountant");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Station } = await import("../../apps/api/src/station");
  const ops = new Operations(pool),
    actor = { id: user.id, role: "dispatcher", customer_id: null };
  const name = "Stock browser " + randomUUID().slice(0, 8),
    site = "Receiving " + randomUUID().slice(0, 8),
    target = "Processing " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "stock@example.test",
    billing_address: "Stock billing",
  });
  const material: any = await new Station(ops).material(
    { id: accountant.id, role: "accountant", customer_id: null },
    randomUUID(),
    {
      name,
      category: "recycling",
      rate_cents_per_tonne: 5000,
      minimum_charge_cents: 0,
    },
  );
  await login(page, user);
  await page
    .getByRole("button", { name: "▧ Material stock", exact: true })
    .click();
  await page
    .getByLabel("Stock material", { exact: true })
    .selectOption(material.id);
  await page.getByLabel("Stock site or bin name", { exact: true }).fill(site);
  await page
    .getByLabel("Verified opening stock (kg)", { exact: true })
    .fill("1000");
  await page
    .getByLabel("Opening count source", { exact: true })
    .fill("Verified browser fixture count");
  await page
    .getByRole("button", { name: "Open stock account", exact: true })
    .click();
  const sourceRow = page.getByRole("row").filter({ hasText: site });
  await expect(sourceRow).toContainText("1,000");
  await page.getByLabel("Stock site or bin name", { exact: true }).fill(target);
  await page
    .getByLabel("Verified opening stock (kg)", { exact: true })
    .fill("0");
  await page
    .getByRole("button", { name: "Open stock account", exact: true })
    .click();
  const targetRow = page.getByRole("row").filter({ hasText: target });
  await expect(targetRow).toBeVisible();
  const accounts = (
      await pool.query(
        "SELECT * FROM material_stock_accounts WHERE material_id=$1",
        [material.id],
      )
    ).rows,
    from = accounts.find((a) => a.site_name === site),
    to = accounts.find((a) => a.site_name === target);
  await page.getByLabel("Transfer from", { exact: true }).selectOption(from.id);
  await page.getByLabel("Transfer to", { exact: true }).selectOption(to.id);
  await page.getByLabel("Transfer quantity (kg)", { exact: true }).fill("200");
  await page
    .getByLabel("Material transfer reason", { exact: true })
    .fill("Recorded internal site movement");
  await page
    .getByRole("button", { name: "Record material transfer", exact: true })
    .click();
  await expect(sourceRow).toContainText("800");
  await expect(targetRow).toContainText("200");
  await page
    .getByRole("button", { name: "▧ Transfer station", exact: true })
    .click();
  await page
    .getByLabel("Scale customer", { exact: true })
    .selectOption(customer.id);
  await page.getByLabel("Material", { exact: true }).selectOption(material.id);
  await page
    .getByLabel("Material stock site", { exact: true })
    .selectOption(from.id);
  await page
    .getByLabel("Vehicle number", { exact: true })
    .fill("BROWSER-STOCK");
  await page.getByLabel("First weight (kg)", { exact: true }).fill("3000");
  await page
    .getByLabel("Scale reference / operator attestation", { exact: true })
    .fill("Verified manual test reading");
  await page
    .getByRole("button", { name: "Open scale ticket", exact: true })
    .click();
  const ticket = page.locator("article.order").filter({ hasText: name });
  await expect(ticket).toContainText("Material stock: " + site);
  await ticket
    .getByLabel("Outbound tare weight (kg)", { exact: true })
    .fill("1000");
  await ticket
    .getByRole("button", { name: "Record second weighing", exact: true })
    .click();
  await expect(ticket).toContainText("Net: 2000 kg");
  await page
    .getByRole("button", { name: "▧ Material stock", exact: true })
    .click();
  await expect(sourceRow).toContainText("2,800");
  await sourceRow
    .getByRole("button", { name: "Review stock", exact: true })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: "scale_inbound" }),
  ).toContainText("2,000");
  const movements = (
    await pool.query(
      "SELECT delta_kg FROM material_stock_movements WHERE account_id=ANY($1::uuid[])",
      [[from.id, to.id]],
    )
  ).rows;
  expect(movements.reduce((n, r) => n + Number(r.delta_kg), 0)).toBe(3000);
});

test("assigned driver verifies the actual rental container before completion and a wrong number cannot move inventory", async ({
  page,
}) => {
  const dispatcher = await account("dispatcher"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Rentals } = await import("../../apps/api/src/rentals");
  const ops = new Operations(pool),
    rentals = new Rentals(ops),
    office = { id: dispatcher.id, role: "dispatcher", customer_id: null },
    name = "Physical browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(office, randomUUID(), {
    name,
    kind: "commercial",
    email: "physical@example.test",
    billing_address: "Physical billing",
  });
  const location: any = await ops.createLocation(
    office,
    randomUUID(),
    customer.id,
    { address: "Physical confirmation street" },
  );
  const container: any = await rentals.createContainer(office, randomUUID(), {
    number: "PHYS-" + randomUUID().slice(0, 8),
    kind: "roll_off",
    capacity_yards: 20,
  });
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "PHYS-" + randomUUID(),
    ])
  ).rows[0];
  const r: any = await rentals.reserve(office, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    container_id: container.id,
    start_date: "2026-11-07",
    pickup_date: "2026-11-14",
    base_price_cents: 40000,
    extension_daily_cents: 1000,
    included_weight_kg: 2000,
    overweight_cents_per_tonne: 5000,
  });
  await ops.assign(office, randomUUID(), r.delivery_order_id, {
    driver_id: driver.id,
    truck_id: truck.id,
    version: 1,
  });
  await ops.transition(
    { id: driver.id, role: "driver", customer_id: null },
    randomUUID(),
    r.delivery_order_id,
    { status: "in_progress", version: 2 },
  );
  await login(page, driver);
  const row = page.locator("article.order").filter({ hasText: name });
  await row.getByLabel("Service date", { exact: true }).fill("2026-11-07");
  await row
    .getByLabel("Physically verified container number", { exact: true })
    .fill("WRONG-CONTAINER");
  await row
    .getByRole("checkbox", {
      name: "I checked these numbers on the physical equipment",
      exact: true,
    })
    .check();
  await row
    .getByRole("button", { name: "Complete service", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Physically verify");
  expect(
    (
      await pool.query("SELECT status FROM containers WHERE id=$1", [
        container.id,
      ])
    ).rows[0].status,
  ).toBe("yard");
  await row
    .getByLabel("Physically verified container number", { exact: true })
    .fill(container.number);
  await row
    .getByRole("button", { name: "Complete service", exact: true })
    .click();
  await expect(row.locator(".badge")).toHaveText("completed");
  const proof = (
    await pool.query(
      "SELECT container_id,container_number,actor_id FROM container_verifications WHERE order_id=$1",
      [r.delivery_order_id],
    )
  ).rows[0];
  expect(proof).toEqual({
    container_id: container.id,
    container_number: container.number,
    actor_id: driver.id,
  });
});

test("dispatch creates a quarterly anniversary contract and accounting bills its verified closed period", async ({
  page,
}) => {
  const dispatcher = await account("dispatcher"),
    accountant = await account("accountant"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Workflows } = await import("../../apps/api/src/workflows");
  const ops = new Operations(pool),
    actor = { id: dispatcher.id, role: "dispatcher", customer_id: null },
    name = "Cycle browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "cycle@example.test",
    billing_address: "Cycle billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Anniversary collection street" },
  );
  await login(page, dispatcher);
  await page.getByRole("button", { name: "▧ Agreements", exact: true }).click();
  const form = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "New recurring service agreement",
      exact: true,
    }),
  });
  await form.getByLabel("Customer", { exact: true }).selectOption(customer.id);
  await form
    .getByLabel("Service location", { exact: true })
    .selectOption(location.id);
  await form.getByLabel("Billing schedule").selectOption("monthly");
  await form.getByLabel("Monthly contract rate ($)").fill("125.00");
  await form
    .getByLabel("Contract billing alignment")
    .selectOption("anniversary");
  await form.getByLabel("Contract billing cycle").selectOption("3");
  await form.getByLabel("First service date").fill("2026-07-31");
  await form.getByLabel("Last service date (optional)").fill("2026-10-30");
  await form
    .getByRole("button", { name: "Create agreement", exact: true })
    .click();
  await expect(
    page.locator("article.order").filter({ hasText: name }),
  ).toContainText("3-month anniversary cycle");
  const agreement = (
    await pool.query("SELECT * FROM service_agreements WHERE customer_id=$1", [
      customer.id,
    ])
  ).rows[0];
  expect(agreement.next_billing_month).toBe("2026-07-31");
  await new Workflows(ops).generate(actor, randomUUID(), {
    through_date: "2026-10-30",
  });
  const orders = (
    await pool.query(
      "SELECT * FROM orders WHERE agreement_id=$1 ORDER BY scheduled_date",
      [agreement.id],
    )
  ).rows;
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "CYCLE-" + randomUUID(),
    ])
  ).rows[0];
  for (const order of orders) {
    await ops.assign(actor, randomUUID(), order.id, {
      driver_id: driver.id,
      truck_id: truck.id,
      version: 1,
    });
    const d = { id: driver.id, role: "driver", customer_id: null };
    await ops.transition(d, randomUUID(), order.id, {
      status: "in_progress",
      version: 2,
    });
    await ops.transition(d, randomUUID(), order.id, {
      status: "completed",
      version: 3,
      service_date: order.scheduled_date,
    });
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, accountant);
  await page
    .getByRole("button", { name: "▧ Scheduled work", exact: true })
    .click();
  const card = page.locator("article.order").filter({ hasText: name });
  await expect(card).toContainText("$375.00");
  await expect(card).toContainText("2026-07-31 through 2026-10-30");
  await card
    .getByRole("button", {
      name: "Invoice verified contract period",
      exact: true,
    })
    .click();
  await expect(card).toHaveCount(0);
  const invoice = (
    await pool.query(
      "SELECT i.amount_cents,p.billing_alignment,p.billing_cycle_months FROM invoices i JOIN monthly_billing_periods p ON p.id=i.monthly_period_id WHERE p.agreement_id=$1",
      [agreement.id],
    )
  ).rows[0];
  expect(invoice).toEqual({
    amount_cents: 37500,
    billing_alignment: "anniversary",
    billing_cycle_months: 3,
  });
});

test("dispatch records yard/truck stock and places then recovers a customer cart without generating an invoice", async ({
  page,
}) => {
  const user = await account("dispatcher");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Rentals } = await import("../../apps/api/src/rentals");
  const ops = new Operations(pool),
    rentals = new Rentals(ops),
    actor = { id: user.id, role: "dispatcher", customer_id: null },
    name = "Cart browser " + randomUUID().slice(0, 8),
    yardName = "Yard browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "residential",
    email: "cart@example.test",
    billing_address: "Cart billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Cart collection street" },
  );
  const cart: any = await rentals.createContainer(actor, randomUUID(), {
    number: "CART-" + randomUUID().slice(0, 8),
    kind: "cart",
    capacity_yards: 1,
  });
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING *", [
      "CART-TRUCK-" + randomUUID(),
    ])
  ).rows[0];
  await login(page, user);
  await page
    .getByRole("button", { name: "▧ Equipment stock", exact: true })
    .click();
  await page.getByLabel("Equipment yard name", { exact: true }).fill(yardName);
  await page
    .getByLabel("Equipment yard address", { exact: true })
    .fill("Verified company yard street");
  await page
    .getByRole("button", { name: "Save equipment yard", exact: true })
    .click();
  await expect(
    page.locator("article.order").filter({ hasText: yardName }),
  ).toBeVisible();
  const yard = (
    await pool.query("SELECT * FROM equipment_yards WHERE name=$1", [yardName])
  ).rows[0];
  await page
    .getByLabel("Review equipment", { exact: true })
    .selectOption(cart.id);
  const move = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Record equipment relocation",
      exact: true,
    }),
  });
  await move
    .getByLabel("Observed equipment number", { exact: true })
    .fill(cart.number);
  await move
    .getByLabel("Equipment movement reason", { exact: true })
    .fill("Verified load onto collection truck");
  await move
    .getByLabel("Equipment destination type", { exact: true })
    .selectOption("truck");
  await move
    .getByLabel("Equipment destination", { exact: true })
    .selectOption(truck.id);
  await move
    .getByRole("button", { name: "Record equipment move", exact: true })
    .click();
  await expect(
    page.getByText("on_truck · Truck " + truck.number + " · version 2", {
      exact: true,
    }),
  ).toBeVisible();
  const place = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Record actual cart/commercial placement",
      exact: true,
    }),
  });
  await place
    .getByLabel("Observed equipment number", { exact: true })
    .fill(cart.number);
  await place
    .getByLabel("Equipment movement reason", { exact: true })
    .fill("Actual cart placed at customer entrance");
  await place
    .getByLabel("Placement customer", { exact: true })
    .selectOption(customer.id);
  await place
    .getByLabel("Placement service location", { exact: true })
    .selectOption(location.id);
  await place
    .getByRole("button", { name: "Record equipment placement", exact: true })
    .click();
  await expect(
    page.getByText("deployed · Cart collection street · version 3", {
      exact: true,
    }),
  ).toBeVisible();
  const recovery = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Record cart/commercial recovery",
      exact: true,
    }),
  });
  await recovery
    .getByLabel("Observed equipment number", { exact: true })
    .fill(cart.number);
  await recovery
    .getByLabel("Equipment movement reason", { exact: true })
    .fill("Actual recovery back to company yard");
  await recovery
    .getByLabel("Equipment destination type", { exact: true })
    .selectOption("yard");
  await recovery
    .getByLabel("Equipment destination", { exact: true })
    .selectOption(yard.id);
  await recovery
    .getByRole("button", { name: "Record equipment recovery", exact: true })
    .click();
  await expect(
    page.getByText("yard · " + yardName + " · version 4", { exact: true }),
  ).toBeVisible();
  const saved = (
    await pool.query(
      "SELECT status,yard_id,carried_by_truck_id,location_id FROM containers WHERE id=$1",
      [cart.id],
    )
  ).rows[0];
  expect(saved).toEqual({
    status: "yard",
    yard_id: yard.id,
    carried_by_truck_id: null,
    location_id: null,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM equipment_storage_events WHERE container_id=$1",
        [cart.id],
      )
    ).rows[0].n,
  ).toBe(3);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1",
        [customer.id],
      )
    ).rows[0].n,
  ).toBe(0);
});

test("office configures advance billing and finance verifies closed prepaid service without creating another invoice", async ({
  page,
}) => {
  const dispatcher = await account("dispatcher"),
    accountant = await account("accountant"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Workflows } = await import("../../apps/api/src/workflows");
  const { MonthlyBilling } = await import("../../apps/api/src/monthly-billing");
  const ops = new Operations(pool),
    wf = new Workflows(ops);
  const dispatch = { id: dispatcher.id, role: "dispatcher", customer_id: null };
  const finance = { id: accountant.id, role: "accountant", customer_id: null };
  const name = "Advance browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(dispatch, randomUUID(), {
    name,
    kind: "commercial",
    email: "advance@example.test",
    billing_address: "Advance billing address",
  });
  const location: any = await ops.createLocation(
    dispatch,
    randomUUID(),
    customer.id,
    { address: "Advance collection street" },
  );
  const dates = (
    await pool.query(
      "SELECT date_trunc('month',now() AT TIME ZONE timezone)::date AS first,(date_trunc('month',now() AT TIME ZONE timezone)+interval '1 month - 1 day')::date AS last FROM company_settings WHERE singleton",
    )
  ).rows[0];
  await login(page, dispatcher);
  await page.getByRole("button", { name: "▧ Agreements", exact: true }).click();
  const form = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "New recurring service agreement",
      exact: true,
    }),
  });
  await form.getByLabel("Customer", { exact: true }).selectOption(customer.id);
  await form
    .getByLabel("Service location", { exact: true })
    .selectOption(location.id);
  await form.getByLabel("Billing schedule").selectOption("monthly");
  await form.getByLabel("Monthly contract rate ($)").fill("180.00");
  await form.getByLabel("Contract billing timing").selectOption("advance");
  await form.getByLabel("First service date").fill(dates.first);
  await form.getByLabel("Last service date (optional)").fill(dates.last);
  await form
    .getByRole("button", { name: "Create agreement", exact: true })
    .click();
  await expect(
    page.locator("article.order").filter({ hasText: name }),
  ).toContainText("billed in advance");
  const agreement = (
    await pool.query("SELECT * FROM service_agreements WHERE customer_id=$1", [
      customer.id,
    ])
  ).rows[0];
  expect(agreement.billing_timing).toBe("advance");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, accountant);
  await page
    .getByRole("button", { name: "▧ Scheduled work", exact: true })
    .click();
  const card = page.locator("article.order").filter({ hasText: name });
  await card
    .getByRole("button", {
      name: "Invoice advance contract period",
      exact: true,
    })
    .click();
  await expect(card).toHaveCount(0);
  const invoice = (
    await pool.query(
      "SELECT i.* FROM invoices i JOIN monthly_billing_periods p ON p.id=i.monthly_period_id WHERE p.agreement_id=$1",
      [agreement.id],
    )
  ).rows[0];
  const journal = (
    await pool.query(
      "SELECT debit_account,credit_account,amount_cents FROM journal WHERE invoice_id=$1",
      [invoice.id],
    )
  ).rows;
  expect(journal).toEqual([
    {
      debit_account: "accounts_receivable",
      credit_account: "deferred_revenue",
      amount_cents: 18000,
    },
  ]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM monthly_invoice_orders WHERE invoice_id=$1",
        [invoice.id],
      )
    ).rows[0].n,
  ).toBe(0);

  const closedName = "Prepaid verified " + randomUUID().slice(0, 8);
  const closedCustomer: any = await ops.createCustomer(dispatch, randomUUID(), {
    name: closedName,
    kind: "commercial",
    email: "prepaid@example.test",
    billing_address: "Prepaid address",
  });
  const closedLocation: any = await ops.createLocation(
    dispatch,
    randomUUID(),
    closedCustomer.id,
    { address: "Prepaid service street" },
  );
  const closed: any = await wf.agreement(dispatch, randomUUID(), {
    customer_id: closedCustomer.id,
    location_id: closedLocation.id,
    kind: "commercial",
    price_cents: 0,
    monthly_rate_cents: 12500,
    billing_mode: "monthly",
    billing_timing: "advance",
    interval_days: 14,
    next_service_date: "2026-10-01",
    contract_end_date: "2026-10-31",
  });
  const prepaid: any = await new MonthlyBilling(ops).invoice(
    finance,
    randomUUID(),
    closed.id,
    { period_start: "2026-10-01" },
  );
  await wf.generate(dispatch, randomUUID(), { through_date: "2026-10-31" });
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "ADVANCE-" + randomUUID(),
    ])
  ).rows[0];
  const orders = (
    await pool.query(
      "SELECT * FROM orders WHERE agreement_id=$1 ORDER BY scheduled_date",
      [closed.id],
    )
  ).rows;
  for (const order of orders) {
    const assigned: any = await ops.assign(dispatch, randomUUID(), order.id, {
      driver_id: driver.id,
      truck_id: truck.id,
      version: order.version,
    });
    const actor = { id: driver.id, role: "driver", customer_id: null };
    const started: any = await ops.transition(actor, randomUUID(), order.id, {
      status: "in_progress",
      version: assigned.version,
    });
    await ops.transition(actor, randomUUID(), order.id, {
      status: "completed",
      version: started.version,
      service_date: order.scheduled_date,
    });
  }
  await page.reload();
  await page
    .getByRole("button", { name: "▧ Scheduled work", exact: true })
    .click();
  const recognition = page
    .locator("article.order")
    .filter({ hasText: closedName });
  await expect(recognition).toContainText("Original charge $125.00");
  await recognition
    .getByRole("button", {
      name: "Verify service and recognize revenue",
      exact: true,
    })
    .click();
  await expect(recognition).toHaveCount(0);
  const entry = (
    await pool.query(
      "SELECT amount_cents FROM journal WHERE invoice_id=$1 AND source_kind='contract_revenue'",
      [prepaid.id],
    )
  ).rows;
  expect(entry).toEqual([{ amount_cents: 12500 }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM invoices WHERE customer_id=$1",
        [closedCustomer.id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1",
        [prepaid.id],
      )
    ).rows[0].n,
  ).toBe(0);
});

test("finance records a vendor credit and returned-payment reversal with the original history intact", async ({
  page,
}) => {
  const user = await account("accountant");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Finance } = await import("../../apps/api/src/finance");
  const finance = new Finance(new Operations(pool)),
    actor = { id: user.id, role: "accountant", customer_id: null };
  const vendor = "Credit bill browser " + randomUUID().slice(0, 8),
    payRef = "RETURN-" + randomUUID();
  const bill: any = await finance.expense(actor, randomUUID(), {
    category: "repair",
    vendor,
    reference: "BILL-" + randomUUID(),
    amount_cents: 10000,
    expense_date: "2026-11-01",
    due_date: "2026-11-05",
    payment_mode: "payable",
  });
  await finance.expensePayment(actor, randomUUID(), bill.id, {
    amount_cents: 3500,
    method: "check",
    reference: payRef,
    payment_date: "2026-11-03",
  });
  await login(page, user);
  await page.getByRole("button", { name: "▧ Expenses", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: vendor })
    .getByRole("button", { name: "Review bill", exact: true })
    .click();
  const panel = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: "Vendor bill · " + vendor,
      exact: true,
    }),
  });
  await panel
    .getByLabel("Vendor credit amount ($)", { exact: true })
    .fill("20.00");
  await panel
    .getByLabel("Vendor credit date", { exact: true })
    .fill("2026-11-04");
  await panel
    .getByLabel("Vendor credit reference", { exact: true })
    .fill("SUPPLIER-" + randomUUID());
  await panel
    .getByLabel("Reason for vendor credit", { exact: true })
    .fill("Supplier reduced parts charge");
  await panel
    .getByRole("button", { name: "Record vendor credit", exact: true })
    .click();
  await expect(panel).toContainText("Credited $20.00 · Unpaid $45.00");
  const paymentRow = panel.getByRole("row").filter({ hasText: payRef });
  await paymentRow
    .getByLabel("Payment reversal date", { exact: true })
    .fill("2026-11-06");
  await paymentRow
    .getByLabel("Payment reversal reference", { exact: true })
    .fill("REVERSAL-" + randomUUID());
  await paymentRow
    .getByLabel("Reason for payment reversal", { exact: true })
    .fill("Check returned, cash restored");
  await paymentRow
    .getByRole("button", { name: "Record bill payment reversal", exact: true })
    .click();
  await expect(panel).toContainText("Credited $20.00 · Unpaid $80.00");
  await expect(paymentRow).toContainText("Reversed 2026-11-06");
  await expect(panel).toContainText("Supplier reduced parts charge");
  const history = await finance.expenseHistory(actor, bill.id);
  expect(Number(history.balance_cents)).toBe(8000);
  expect(history.payments.length).toBe(1);
  expect(history.payments[0].reversal_id).toBeTruthy();
  expect(history.credits.length).toBe(1);
});

test("finance previews and archives historical transactions without reposting money and can retain them through rollback", async ({
  page,
}) => {
  const user = await account("accountant"),
    source = "Archive browser " + randomUUID().slice(0, 8);
  await login(page, user);
  await page.getByRole("button", { name: "▧ Imports", exact: true }).click();
  await page
    .getByLabel("Import type", { exact: true })
    .selectOption("legacy_transactions");
  await expect(
    page.getByText("Historical source archive only:", { exact: false }),
  ).toBeVisible();
  const csv =
    "external_id,source_system,source_reference,transaction_kind,transaction_date,amount_cents,currency,vendor,memo\n" +
    [
      randomUUID(),
      source,
      "LEGACY-1",
      "expense",
      "2026-01-10",
      1500,
      "USD",
      "Original supplier",
      "Authorized historical receipt",
    ].join(",");
  const before = (await pool.query("SELECT count(*)::int AS n FROM journal"))
    .rows[0].n;
  await page.getByLabel("CSV contents", { exact: true }).fill(csv);
  await page
    .getByRole("button", { name: "Validate and preview", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Batch preview · legacy transactions",
      exact: true,
    }),
  ).toBeVisible();
  const batch = (
    await pool.query(
      "SELECT id FROM import_batches WHERE actor_id=$1 AND kind='legacy_transactions' ORDER BY created_at DESC LIMIT 1",
      [user.id],
    )
  ).rows[0];
  await page
    .getByLabel("Apply confirmation", { exact: true })
    .fill("APPLY " + batch.id);
  await page
    .getByRole("button", { name: "Apply reviewed import", exact: true })
    .click();
  await expect(
    page.getByLabel("Rollback confirmation", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await pool.query(
        "SELECT amount_cents FROM legacy_transactions WHERE batch_id=$1",
        [batch.id],
      )
    ).rows,
  ).toEqual([{ amount_cents: 1500 }]);
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM journal")).rows[0].n,
  ).toBe(before);
  await page
    .getByLabel("Rollback confirmation", { exact: true })
    .fill("ROLLBACK " + batch.id);
  await page
    .getByRole("button", { name: "Roll back this batch", exact: true })
    .click();
  await expect(
    page.getByLabel("Rollback confirmation", { exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await pool.query("SELECT status FROM import_batches WHERE id=$1", [
        batch.id,
      ])
    ).rows[0].status,
  ).toBe("rolled_back");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM legacy_transactions WHERE batch_id=$1",
        [batch.id],
      )
    ).rows[0].n,
  ).toBe(1);
});

test("dispatch saves customer arrival windows and service duration with audit and notice but no price changes", async ({
  page,
}) => {
  const user = await account("dispatcher");
  const { Operations } = await import("../../apps/api/src/domain");
  const ops = new Operations(pool),
    actor = { id: user.id, role: "dispatcher", customer_id: null },
    name = "Timing browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(actor, randomUUID(), {
    name,
    kind: "commercial",
    email: "timing@example.test",
    billing_address: "Timing billing",
  });
  const location: any = await ops.createLocation(
    actor,
    randomUUID(),
    customer.id,
    { address: "Customer access hours street" },
  );
  const order: any = await ops.createOrder(actor, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "bulk",
    scheduled_date: "2026-11-10",
    price_cents: 18500,
  });
  await login(page, user);
  await page.getByRole("button", { name: "▤ Orders", exact: true }).click();
  const row = page.locator("article.order").filter({ hasText: name });
  await row
    .getByText("Arrival window and service time", { exact: true })
    .click();
  await row.getByLabel("Arrival window start", { exact: true }).fill("09:00");
  await row.getByLabel("Arrival window end", { exact: true }).fill("11:00");
  await row.getByLabel("Planned service minutes", { exact: true }).fill("20");
  await row
    .getByLabel("Service timing change reason", { exact: true })
    .fill("Customer confirmed gate access");
  await row
    .getByRole("button", { name: "Save service timing", exact: true })
    .click();
  await expect(row).toContainText("09:00–11:00");
  await expect(row).toContainText("Planned work: 20 minutes");
  const stored = (
    await pool.query(
      "SELECT service_window_start,service_window_end,service_duration_minutes,price_cents,version FROM orders WHERE id=$1",
      [order.id],
    )
  ).rows[0];
  expect(stored).toEqual({
    service_window_start: "09:00:00",
    service_window_end: "11:00:00",
    service_duration_minutes: 20,
    price_cents: 18500,
    version: 2,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_log WHERE action='order.service_timing' AND entity_id=$1",
        [order.id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM notifications WHERE customer_id=$1 AND source_key=$2",
        [customer.id, "service-timing:" + order.id + ":2"],
      )
    ).rows[0].n,
  ).toBe(1);
});

test("finance reviews provider refunds while unconfigured and a signed Stripe receipt settles once through HTTP", async ({
  page,
}) => {
  const accountant = await account("accountant"),
    dispatcher = await account("dispatcher"),
    driver = await account("driver");
  const { Operations } = await import("../../apps/api/src/domain");
  const { Finance } = await import("../../apps/api/src/finance");
  const { StripePayments } = await import("../../apps/api/src/stripe-payments");
  const { default: Stripe } = await import("stripe");
  const ops = new Operations(pool),
    office = { id: dispatcher.id, role: "dispatcher", customer_id: null },
    finance = { id: accountant.id, role: "accountant", customer_id: null },
    d = { id: driver.id, role: "driver", customer_id: null };
  const name = "Refund browser " + randomUUID().slice(0, 8);
  const customer: any = await ops.createCustomer(office, randomUUID(), {
    name,
    kind: "commercial",
    email: "refund@example.test",
    billing_address: "Refund billing",
  });
  const location: any = await ops.createLocation(
    office,
    randomUUID(),
    customer.id,
    { address: "Refund collection street" },
  );
  const order: any = await ops.createOrder(office, randomUUID(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "bulk",
    scheduled_date: "2026-11-07",
    price_cents: 10000,
  });
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "REFUND-" + randomUUID(),
    ])
  ).rows[0];
  const assigned: any = await ops.assign(office, randomUUID(), order.id, {
    driver_id: driver.id,
    truck_id: truck.id,
    version: 1,
  });
  const started: any = await ops.transition(d, randomUUID(), order.id, {
    status: "in_progress",
    version: assigned.version,
  });
  await ops.transition(d, randomUUID(), order.id, {
    status: "completed",
    version: started.version,
    service_date: "2026-11-07",
  });
  const invoice: any = await ops.invoice(finance, randomUUID(), order.id),
    pi = "pi_browser_" + randomUUID().replaceAll("-", "");
  const attempt = (
    await pool.query(
      "INSERT INTO payment_attempts(invoice_id,amount_cents) VALUES($1,10000) RETURNING id",
      [invoice.id],
    )
  ).rows[0];
  await new StripePayments(ops, new Finance(ops)).process({
    id: "evt_browser_" + randomUUID(),
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_browser_" + randomUUID(),
        metadata: { corewaste_attempt_id: attempt.id },
        currency: "usd",
        amount_total: 10000,
        payment_status: "paid",
        payment_intent: pi,
      },
    },
  } as any);
  const payment = (
    await pool.query(
      "SELECT * FROM payments WHERE method='stripe' AND reference=$1",
      [pi],
    )
  ).rows[0];
  // Seed a pre-existing, unsubmitted authorization to test local review with the provider intentionally disabled.
  const unsubmitted = (
    await pool.query(
      "INSERT INTO stripe_refund_requests(payment_id,invoice_id,customer_id,payment_intent,amount_cents,reason,actor_id) VALUES($1,$2,$3,$4,3000,'Reviewed payment return',$5) RETURNING *",
      [payment.id, invoice.id, customer.id, pi, accountant.id],
    )
  ).rows[0];
  await login(page, accountant);
  await page
    .getByRole("button", { name: "▧ Provider refunds", exact: true })
    .click();
  await expect(
    page.getByText("Stripe refunds are not configured.", { exact: false }),
  ).toBeVisible();
  const card = page.locator("article.order").filter({ hasText: name });
  await expect(
    card.getByRole("button", { name: "Submit refund to Stripe", exact: true }),
  ).toBeDisabled();
  await card
    .getByRole("button", { name: "Cancel unsubmitted refund", exact: true })
    .click();
  await expect(card).toContainText("cancelled");
  expect(
    (
      await pool.query("SELECT state FROM stripe_refund_requests WHERE id=$1", [
        unsubmitted.id,
      ])
    ).rows[0].state,
  ).toBe("cancelled");
  const providerId = "re_browser_" + randomUUID().replaceAll("-", "");
  const pending = (
    await pool.query(
      "INSERT INTO stripe_refund_requests(payment_id,invoice_id,customer_id,payment_intent,amount_cents,reason,actor_id,state,attempted_at,provider_refund_id) VALUES($1,$2,$3,$4,2000,'Previously submitted partial return',$5,'pending',now(),$6) RETURNING *",
      [payment.id, invoice.id, customer.id, pi, accountant.id, providerId],
    )
  ).rows[0];
  const event = {
    id: "evt_refund_browser_" + randomUUID(),
    type: "refund.updated",
    livemode: false,
    data: {
      object: {
        id: providerId,
        payment_intent: pi,
        currency: "usd",
        amount: 2000,
        status: "succeeded",
        livemode: false,
        metadata: { corewaste_refund_request_id: pending.id },
      },
    },
  };
  const payload = JSON.stringify(event),
    url = "http://127.0.0.1:3100/api/payments/stripe/webhook";
  const bad = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": "invalid",
    },
    body: payload,
  });
  expect(bad.status).toBe(400);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: "whsec_local_browser_only",
  });
  for (let i = 0; i < 2; i++)
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": signature,
          },
          body: payload,
        })
      ).ok,
    ).toBeTruthy();
  await page
    .getByRole("button", { name: "Refresh provider refunds", exact: true })
    .click();
  await expect(
    page.locator("article.order").filter({ hasText: pending.id }),
  ).toContainText("succeeded");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM refunds WHERE payment_id=$1",
        [payment.id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    Number(
      (
        await pool.query(
          "SELECT balance_cents FROM invoice_balances WHERE id=$1",
          [invoice.id],
        )
      ).rows[0].balance_cents,
    ),
  ).toBe(2000);
});
