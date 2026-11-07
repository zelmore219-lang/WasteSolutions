import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EncryptedStorage } from "../../driver/encrypted-storage";
function fixture() {
  const data = new Map<string, string>();
  let failPointer = false;
  const kv = {
    getItemAsync: async (k: string) => data.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => {
      if (failPointer && k.split(".").length === 3)
        throw Error("Power interrupted before commit");
      assert.ok(Buffer.byteLength(v) <= 2048);
      data.set(k, v);
    },
    deleteItemAsync: async (k: string) => {
      data.delete(k);
    },
  };
  const store = new EncryptedStorage(
    kv,
    async (k) => createHash("sha256").update(k).digest("hex"),
    randomUUID,
  );
  return {
    data,
    store,
    fail: () => {
      failPointer = true;
    },
  };
}
test("encrypted adapter preserves large Unicode records across storage chunks and removes them completely", async () => {
  const { data, store } = fixture(),
    value = "Customer ♻️ 🚛 漢字 ".repeat(400);
  await store.setItem("identity-private-key", value);
  assert.equal(await store.getItem("identity-private-key"), value);
  assert.ok(data.size > 1);
  await store.removeItem("identity-private-key");
  assert.equal(data.size, 0);
  assert.equal(await store.getItem("identity-private-key"), null);
});
test("interrupted commit leaves the previous generation intact", async () => {
  const { store, fail } = fixture();
  await store.setItem("route", "Original committed route");
  fail();
  await assert.rejects(
    store.setItem("route", "Uncommitted replacement"),
    /Power interrupted/,
  );
  assert.equal(await store.getItem("route"), "Original committed route");
});
test("concurrent writes are serialized without interleaving generations or losing records", async () => {
  const { store } = fixture();
  await Promise.all([
    store.setItem("same-key", "first".repeat(1000)),
    store.setItem("same-key", "second".repeat(1000)),
  ]);
  assert.equal(await store.getItem("same-key"), "second".repeat(1000));
});
