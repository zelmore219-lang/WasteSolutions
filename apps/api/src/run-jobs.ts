import { ProviderSettings } from "./provider-settings";
import { Pool } from "pg";
import { Operations, Actor } from "./domain";
import { Workflows } from "./workflows";
import { Finance } from "./finance";
import { BillingControls } from "./billing-controls";
import { StripePayments } from "./stripe-payments";
import { StripeProfiles } from "./stripe-profiles";
import { Automation } from "./automation";
import { deliverBatch, configuredAdapters } from "./delivery";
export async function runJobs() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
    ops = new Operations(pool);
  try {
    const actor = (
      await pool.query(
        "SELECT id,role,customer_id FROM employees WHERE id=$1 AND active AND role IN ('owner','manager')",
        [process.env.JOB_ACTOR_ID],
      )
    ).rows[0] as Actor | undefined;
    if (!actor)
      throw Error(
        "JOB_ACTOR_ID must identify an authorized active owner or manager service principal",
      );
    await new ProviderSettings(ops).refreshRuntime(true);
    const payments = new StripePayments(ops, new Finance(ops)),
      profiles = new StripeProfiles(ops, (e, t) => payments.process(e, t)),
      automation = new Automation(
        ops,
        new Workflows(ops),
        new BillingControls(ops),
        profiles,
      );
    const result = await automation.run(actor, await automation.today());
    const delivery = await deliverBatch(pool, configuredAdapters(), 100);
    console.log(
      JSON.stringify({
        status: result.status,
        summary: result.summary,
        delivery,
      }),
    );
    if (result.status === "failed") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  void runJobs().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Scheduled job failed",
    );
    process.exitCode = 1;
  });
