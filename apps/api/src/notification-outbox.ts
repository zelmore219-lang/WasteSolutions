import { PoolClient } from "pg";
const variables = ["company_name", "customer_name", "subject", "message"];
export function renderTemplate(
  template: string,
  values: Record<string, string>,
) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => {
    if (!variables.includes(key))
      throw Error("Unsupported notification template field");
    return values[key] || "";
  });
}
export async function notify(
  c: PoolClient,
  customerId: string,
  kind: string,
  subject: string,
  message: string,
  source: string,
) {
  const n = (
    await c.query(
      "INSERT INTO notifications(customer_id,kind,subject,message,source_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_key) DO NOTHING RETURNING id",
      [customerId, kind, subject, message, source],
    )
  ).rows[0];
  if (!n) return;
  const customer = (
      await c.query("SELECT name,email,phone FROM customers WHERE id=$1", [
        customerId,
      ])
    ).rows[0],
    company = (
      await c.query("SELECT name FROM company_settings WHERE singleton")
    ).rows[0],
    prefs = (
      await c.query(
        "SELECT * FROM notification_preferences WHERE customer_id=$1",
        [customerId],
      )
    ).rows[0],
    template = (
      await c.query("SELECT * FROM notification_templates WHERE kind=$1", [
        kind,
      ])
    ).rows[0];
  const values = {
      company_name: company.name,
      customer_name: customer.name,
      subject,
      message,
    },
    renderedSubject = template
      ? renderTemplate(template.subject, values)
      : subject,
    renderedBody = template
      ? renderTemplate(template.message, values)
      : message;
  if (template?.enabled !== false) {
    if (prefs?.email_enabled !== false)
      await c.query(
        "INSERT INTO notification_outbox(notification_id,channel,destination,rendered_subject,rendered_body) VALUES($1,'email',$2,$3,$4)",
        [n.id, customer.email, renderedSubject, renderedBody],
      );
    if (prefs?.sms_enabled && /^\+[1-9][0-9]{7,14}$/.test(customer.phone))
      await c.query(
        "INSERT INTO notification_outbox(notification_id,channel,destination,rendered_subject,rendered_body) VALUES($1,'sms',$2,$3,$4)",
        [n.id, customer.phone, renderedSubject, renderedBody.slice(0, 1500)],
      );
  }
  await c.query("SELECT pg_notify('corewaste_changes',$1)", [
    JSON.stringify({ customer_id: customerId }),
  ]);
}
