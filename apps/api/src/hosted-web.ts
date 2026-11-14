import { access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { NestExpressApplication } from "@nestjs/platform-express";
export async function configureHostedWeb(app: NestExpressApplication) {
  const directory = process.env.COREWASTE_WEB_DIST;
  if (!directory) return;
  const root = resolve(directory);
  await access(join(root, "index.html"));
  const authDomain =
    process.env.VITE_FIREBASE_AUTH_DOMAIN ||
    `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`;
  if (!/^[a-zA-Z0-9.-]+$/.test(authDomain))
    throw Error("Invalid Firebase authentication hostname");
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://www.recaptcha.net/recaptcha/",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://${authDomain} https://www.google.com https://www.recaptcha.net`,
    `frame-src 'self' https://${authDomain} https://www.google.com https://www.recaptcha.net`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.use((req: any, res: any, next: () => void) => {
    if (req.path !== "/api" && !req.path.startsWith("/api/"))
      res.setHeader("Content-Security-Policy", csp);
    next();
  });
  app.useStaticAssets(root, {
    index: false,
    redirect: false,
    dotfiles: "deny",
    setHeaders: (res, file) =>
      res.setHeader(
        "Cache-Control",
        file.includes("/assets/")
          ? "public,max-age=31536000,immutable"
          : "no-store",
      ),
  });
  app.use((req: any, res: any, next: () => void) => {
    if (
      ["GET", "HEAD"].includes(req.method) &&
      ["/", "/office", "/office/", "/portal", "/portal/"].includes(req.path)
    ) {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(join(root, "index.html"));
    } else next();
  });
}
