import { createApp } from "./app";
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const app = await createApp();
  await app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
