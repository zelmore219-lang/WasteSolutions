export type ProviderField = {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  options?: string[];
};
export const PROVIDERS: Record<
  string,
  { label: string; help: string; fields: ProviderField[] }
> = {
  firebase: {
    label: "Firebase",
    help: "Public web configuration applies on the next app reload after enabling it. Backend Google Cloud identity is connected securely by the deployment operator; never enter a service-account private key here.",
    fields: [
      { name: "FIREBASE_PROJECT_ID", label: "Project ID", required: true },
      {
        name: "VITE_FIREBASE_AUTH_DOMAIN",
        label: "Authentication domain",
        required: true,
      },
      {
        name: "VITE_FIREBASE_API_KEY",
        label: "Web API key (public)",
        required: true,
      },
      { name: "VITE_FIREBASE_APP_ID", label: "Web app ID" },
      { name: "VITE_FIREBASE_STORAGE_BUCKET", label: "Storage bucket" },
    ],
  },
  stripe: {
    label: "Stripe payments",
    help: "Saving configuration does not charge a card. Live mode requires separate provider acceptance.",
    fields: [
      {
        name: "STRIPE_SECRET_KEY",
        label: "Secret API key",
        secret: true,
        required: true,
      },
      {
        name: "STRIPE_WEBHOOK_SECRET",
        label: "Webhook signing secret",
        secret: true,
        required: true,
      },
      {
        name: "PAYMENTS_MODE",
        label: "Payment mode",
        options: ["test", "live"],
        required: true,
      },
      {
        name: "PUBLIC_WEB_URL",
        label: "Payment return website",
        required: true,
      },
    ],
  },
  quickbooks: {
    label: "QuickBooks",
    help: "After configuration, connect the intended company from QuickBooks and review mappings before exporting.",
    fields: [
      { name: "QUICKBOOKS_CLIENT_ID", label: "Client ID", required: true },
      {
        name: "QUICKBOOKS_CLIENT_SECRET",
        label: "Client secret",
        secret: true,
        required: true,
      },
      {
        name: "QUICKBOOKS_REDIRECT_URI",
        label: "OAuth return address",
        required: true,
      },
      {
        name: "QUICKBOOKS_MODE",
        label: "Environment",
        options: ["sandbox", "production"],
        required: true,
      },
    ],
  },
  email: {
    label: "Email (Resend)",
    help: "Verify your sender domain with Resend. Saving does not send queued messages.",
    fields: [
      {
        name: "RESEND_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
      { name: "EMAIL_FROM", label: "Verified sender email", required: true },
    ],
  },
  sms: {
    label: "SMS (Twilio)",
    help: "Verify the sender number and recipient consent before sending.",
    fields: [
      { name: "TWILIO_ACCOUNT_SID", label: "Account SID", required: true },
      {
        name: "TWILIO_AUTH_TOKEN",
        label: "Auth token",
        secret: true,
        required: true,
      },
      { name: "SMS_FROM", label: "Sender phone number", required: true },
    ],
  },
  routing: {
    label: "Road routing (Amazon Location)",
    help: "Use a restricted routing key and verify truck constraints before dispatch acceptance.",
    fields: [
      {
        name: "ROUTING_API_KEY",
        label: "Routing API key",
        secret: true,
        required: true,
      },
      { name: "ROUTING_REGION", label: "AWS region", required: true },
    ],
  },
  storage: {
    label: "Private file storage",
    help: "Bucket access uses the server’s Google Cloud identity. Files remain authorized through the API.",
    fields: [
      {
        name: "STORAGE_DRIVER",
        label: "Storage type",
        options: ["gcs", "local"],
        required: true,
      },
      { name: "GCS_BUCKET", label: "Private bucket name", required: true },
    ],
  },
};
let configured: Record<string, string | undefined> = {};
export function providerValue(name: string) {
  return Object.hasOwn(configured, name) ? configured[name] : process.env[name];
}
export function setProviderRuntime(values: Record<string, string | undefined>) {
  configured = values;
}
