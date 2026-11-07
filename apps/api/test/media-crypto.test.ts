import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealMedia, openMedia } from "../../driver/media-crypto";
test("offline media encryption authenticates contents and binds evidence to its order", () => {
  const key = randomBytes(32),
    data = randomBytes(16384),
    encrypted = sealMedia(key, randomBytes(12), data, "order:fixture-one");
  assert.notDeepEqual(encrypted.subarray(0, data.length), data);
  assert.deepEqual(
    Buffer.from(openMedia(key, encrypted, "order:fixture-one")),
    data,
  );
  assert.throws(() => openMedia(key, encrypted, "order:another-order"));
  const tampered = encrypted.slice();
  tampered[20] ^= 1;
  assert.throws(() => openMedia(key, tampered, "order:fixture-one"));
});
test("invalid encryption parameters and oversized media are rejected", () => {
  assert.throws(
    () =>
      sealMedia(randomBytes(16), randomBytes(12), randomBytes(1), "order:one"),
    /key/,
  );
  assert.throws(
    () =>
      sealMedia(
        randomBytes(32),
        randomBytes(12),
        new Uint8Array(10485761),
        "order:one",
      ),
    /10 MB/,
  );
});
