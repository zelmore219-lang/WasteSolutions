import { providerValue } from "./provider-runtime";
import { ServiceUnavailableException } from "@nestjs/common";
import Stripe from "stripe";
import { HttpsProxyAgent } from "https-proxy-agent";
export function stripeClient() {
  if (
    process.env.NODE_ENV === "production" &&
    providerValue("PAYMENTS_MODE") !== "live"
  )
    throw new ServiceUnavailableException(
      "Production payments require explicit live mode",
    );
  const key = providerValue("STRIPE_SECRET_KEY");
  if (!key)
    throw new ServiceUnavailableException("Online payments are not configured");
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return new Stripe(key, {
    timeout: 10000,
    maxNetworkRetries: 1,
    ...(proxy ? { httpAgent: new HttpsProxyAgent(proxy) } : {}),
  });
}
export function paymentReturnOrigin() {
  const value = providerValue("PUBLIC_WEB_URL");
  if (!value)
    throw new ServiceUnavailableException(
      "Payment return address is not configured",
    );
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw new ServiceUnavailableException(
      "Payment return address must use HTTPS",
    );
  return url.origin;
}
