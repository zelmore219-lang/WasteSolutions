import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium, expect } from "@playwright/test";
const require = createRequire(import.meta.url),
  { LocalTestController } = require("../apps/desktop/local-test.cjs");
const directory = path.resolve(
  process.argv[2] || ".local/kit-validation/local-test",
);
if (!directory.includes(path.sep + ".local" + path.sep))
  throw Error("Kit verification requires a private local staging directory");
const controller = new LocalTestController({ kitDir: directory });
const state = JSON.parse(
  await readFile(path.join(directory, ".state", "logins.json"), "utf8"),
);
const accounts = Object.fromEntries(state.accounts.map((a) => [a.role, a]));
process.on("uncaughtException", (error) => {
  let text = error.stack || error.message;
  for (const account of Object.values(accounts))
    text = text.replaceAll(account.password, "[local test password redacted]");
  console.error(text);
  process.exitCode = 1;
});

const root = "http://127.0.0.1:8088",
  name = "Kit acceptance " + randomUUID().slice(0, 8),
  reference = "KIT-" + randomUUID();
const result = {
  owner_mfa: false,
  customer_location: false,
  dispatch_completion: false,
  invoice_payment: false,
  restart_preserves_data: false,
  restart_preserves_identity: false,
  restart_preserves_owner_mfa: false,
  page_errors: [],
};
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
async function login(role) {
  const context = await browser.newContext(),
    page = await context.newPage();
  page.on("pageerror", (error) => result.page_errors.push(error.message));
  await page.goto(root + "/office");
  await page
    .getByLabel("Work email or employee username")
    .fill(accounts[role].email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(accounts[role].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (role === "owner") {
    await page
      .getByRole("button", { name: "Send verification code", exact: true })
      .click();
    let code = "";
    await expect
      .poll(async () => {
        const r = await fetch(
          "http://127.0.0.1:9099/emulator/v1/projects/demo-corewaste/verificationCodes",
        );
        const json = await r.json();
        code =
          json.verificationCodes?.find(
            (c) => c.phoneNumber === accounts.owner.phone,
          )?.code || "";
        return Boolean(code);
      })
      .toBe(true);
    await page.getByLabel("Verification code", { exact: true }).fill(code);
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
  }
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  return { context, page };
}
async function uid() {
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-test-only",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: accounts.accountant.email,
        password: accounts.accountant.password,
        returnSecureToken: true,
      }),
    },
  );
  if (!response.ok) throw Error("Local identity check failed");
  return (await response.json()).localId;
}
try {
  if (!(await controller.ready()))
    throw Error(
      "Start the isolated local test kit before browser verification",
    );
  const firstUid = await uid();
  const owner = await login("owner"),
    page = owner.page;
  await page.getByRole("button", { name: "▧ Company", exact: true }).click();
  await expect(page.getByLabel("Company name")).toHaveValue("CoreWaste");
  result.owner_mfa = true;
  await page.getByRole("button", { name: "◉ Customers", exact: true }).click();
  await page.getByLabel("Company or customer name").fill(name);
  await page
    .getByLabel("Email", { exact: true })
    .fill("kit-" + randomUUID() + "@example.test");
  await page.getByLabel("Billing address").fill("Local test billing address");
  await page
    .getByRole("button", { name: "Create customer", exact: true })
    .click();
  const customer = page.getByRole("row").filter({ hasText: name });
  await expect(customer).toBeVisible();
  await customer
    .getByRole("button", { name: "View locations", exact: true })
    .click();
  await page
    .getByLabel("Service address")
    .fill("Local test collection address");
  await page
    .getByRole("button", { name: "Add service location", exact: true })
    .click();
  await expect(
    page.getByText("Local test collection address", { exact: true }),
  ).toBeVisible();
  result.customer_location = true;
  await page.getByRole("button", { name: "▤ Orders", exact: true }).click();
  await page
    .getByLabel("Customer", { exact: true })
    .selectOption({ label: name });
  await page
    .getByLabel("Service location", { exact: true })
    .selectOption({ label: "Local test collection address" });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(new Date());
  await page.getByLabel("Scheduled date").fill(today);
  await page.getByLabel("Agreed price ($)").fill("185.00");
  await page
    .getByRole("button", { name: "Create service order", exact: true })
    .click();
  const order = page.locator("article.order").filter({ hasText: name });
  await order
    .getByRole("button", { name: "Assign driver and truck", exact: true })
    .click();
  await order
    .getByLabel("Driver", { exact: true })
    .selectOption({ label: "Local test driver" });
  await order
    .getByLabel("Truck", { exact: true })
    .selectOption({ label: "LOCAL-TEST-01" });
  await order
    .getByRole("button", { name: "Save driver assignment", exact: true })
    .click();
  await expect(order).toContainText("Local test driver");
  const driver = await login("driver");
  const job = driver.page.locator("article.order").filter({ hasText: name });
  await job.getByRole("button", { name: "Start service", exact: true }).click();
  await job
    .getByRole("button", { name: "Record arrival", exact: true })
    .click();
  await job
    .getByRole("button", { name: "Complete service", exact: true })
    .click();
  await expect(job.locator(".badge")).toHaveText("completed");
  result.dispatch_completion = true;
  const accountant = await login("accountant");
  await accountant.page
    .getByRole("button", { name: "▤ Orders", exact: true })
    .click();
  await accountant.page
    .locator("article.order")
    .filter({ hasText: name })
    .getByRole("button", { name: "Generate invoice", exact: true })
    .click();
  await accountant.page
    .getByRole("button", { name: "▧ Invoices", exact: true })
    .click();
  const invoice = accountant.page.getByRole("row").filter({ hasText: name });
  await invoice
    .getByRole("button", { name: "View invoice", exact: true })
    .click();
  await accountant.page
    .getByLabel("Amount received ($)", { exact: true })
    .fill("185.00");
  await accountant.page
    .getByLabel("Receipt or check reference", { exact: true })
    .fill(reference);
  await accountant.page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(invoice).toContainText("paid");
  await expect(invoice).toContainText("$0.00");
  result.invoice_payment = true;
  await mkdir(".local/screenshots", { recursive: true });
  await accountant.page.screenshot({
    path: ".local/screenshots/windows-test-kit-paid-invoice.png",
    fullPage: true,
  });
  await Promise.all([
    owner.context.close(),
    driver.context.close(),
    accountant.context.close(),
  ]);
  const stopped = await controller.stop();
  if (stopped.phase !== "stopped")
    throw Error("Local kit did not stop cleanly");
  const restarted = await controller.start();
  if (restarted.phase !== "ready") throw Error("Local kit restart failed");
  result.restart_preserves_identity = firstUid === (await uid());
  expect(result.restart_preserves_identity).toBe(true);
  const ownerAfter = await login("owner");
  await ownerAfter.page
    .getByRole("button", { name: "▧ Company", exact: true })
    .click();
  await expect(ownerAfter.page.getByLabel("Company name")).toHaveValue(
    "CoreWaste",
  );
  result.restart_preserves_owner_mfa = true;
  await ownerAfter.context.close();
  const after = await login("accountant");
  await after.page
    .getByRole("button", { name: "▧ Invoices", exact: true })
    .click();
  const persisted = after.page.getByRole("row").filter({ hasText: name });
  await expect(persisted).toContainText("paid");
  await expect(persisted).toContainText("$0.00");
  result.restart_preserves_data = true;
  await after.context.close();
  expect(result.page_errors).toEqual([]);
  await writeFile(
    ".local/windows-test-kit-acceptance.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
