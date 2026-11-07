import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
export function encryptIntegration(value: string, key: Buffer, scope: string) {
  if (key.length !== 32)
    throw Error("Integration encryption requires a 32-byte key");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(scope));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
export function decryptIntegration(value: string, key: Buffer, scope: string) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 28) throw Error("Encrypted integration data is invalid");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(scope));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
let cached: Promise<Buffer> | null = null;
export async function integrationKey() {
  if (process.env.INTEGRATION_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.INTEGRATION_ENCRYPTION_KEY, "base64");
    if (key.length !== 32)
      throw Error(
        "INTEGRATION_ENCRYPTION_KEY must contain 32 random bytes in base64",
      );
    return key;
  }
  if (process.env.NODE_ENV === "production")
    throw Error("Production integration encryption is not configured");
  if (!cached)
    cached = (async () => {
      const dir = resolve(".local");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, "integration-encryption.key");
      try {
        await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const key = await readFile(file);
      if (key.length !== 32) throw Error("Local integration key is invalid");
      return key;
    })();
  return cached;
}
