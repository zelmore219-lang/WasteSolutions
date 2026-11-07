import { File, Directory, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { EncryptedStorage } from "./encrypted-storage";
import { sealMedia, openMedia } from "./media-crypto";
export type CapturedMedia = {
  id: string;
  orderId: string;
  kind: "photo" | "signature";
  capturedAt: string;
  signerName?: string;
  filename: string;
};
let keyPromise: Promise<Uint8Array> | null = null;
async function encryptionKey() {
  if (!keyPromise)
    keyPromise = (async () => {
      const stored = await SecureStore.getItemAsync("cw.media.encryption-key");
      if (stored) {
        const numbers = JSON.parse(stored);
        if (
          !Array.isArray(numbers) ||
          numbers.length !== 32 ||
          numbers.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
        )
          throw Error("Media encryption key is invalid");
        return new Uint8Array(numbers);
      }
      const key = await Crypto.getRandomBytesAsync(32);
      await SecureStore.setItemAsync(
        "cw.media.encryption-key",
        JSON.stringify(Array.from(key)),
        { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
      );
      return key;
    })();
  return keyPromise;
}
const directory = new Directory(Paths.document, "corewaste-encrypted-media");
let pending: Promise<unknown> = Promise.resolve();
async function serial<T>(fn: () => Promise<T>) {
  const next = pending.then(fn, fn);
  pending = next.catch(() => undefined);
  return next;
}
export async function mediaQueue(
  store: EncryptedStorage,
  uid: string,
): Promise<CapturedMedia[]> {
  return JSON.parse((await store.getItem("media-queue:" + uid)) || "[]");
}
export async function queueMedia(
  store: EncryptedStorage,
  uid: string,
  orderId: string,
  kind: "photo" | "signature",
  bytes: Uint8Array,
  signerName?: string,
) {
  return serial(async () => {
    const items = await mediaQueue(store, uid);
    if (items.length >= 25)
      throw Error("Synchronize pending photographs before recording more");
    directory.create({ intermediates: true, idempotent: true });
    const id = Crypto.randomUUID(),
      record: CapturedMedia = {
        id,
        orderId,
        kind,
        capturedAt: new Date().toISOString(),
        ...(signerName ? { signerName } : {}),
        filename: `CoreWaste-${kind}-${id}.${kind === "signature" ? "png" : "jpg"}`,
      };
    const file = new File(directory, id + ".enc"),
      encrypted = sealMedia(
        await encryptionKey(),
        await Crypto.getRandomBytesAsync(12),
        bytes,
        "order:" + orderId,
      );
    file.create();
    file.write(encrypted);
    try {
      await store.setItem(
        "media-queue:" + uid,
        JSON.stringify([...items, record]),
      );
    } catch (error) {
      file.delete();
      throw error;
    }
    return record;
  });
}
export async function sendQueuedMedia(
  store: EncryptedStorage,
  uid: string,
  send: (data: FormData, key: string) => Promise<void>,
) {
  return serial(async () => {
    let items = await mediaQueue(store, uid),
      sent = 0;
    for (const item of items) {
      const encrypted = new File(directory, item.id + ".enc");
      const bytes = openMedia(
          await encryptionKey(),
          await encrypted.bytes(),
          "order:" + item.orderId,
        ),
        temporary = new File(
          Paths.cache,
          "cw-upload-" +
            item.id +
            "." +
            (item.kind === "signature" ? "png" : "jpg"),
        );
      try {
        temporary.create({ overwrite: true });
        temporary.write(bytes);
        const data = new FormData();
        data.append("entity_kind", "order");
        data.append("entity_id", item.orderId);
        data.append("kind", item.kind);
        data.append(
          "visibility",
          item.kind === "signature" ? "customer" : "office",
        );
        data.append("captured_at", item.capturedAt);
        if (item.kind === "signature") {
          data.append("signer_name", item.signerName || "");
          data.append("signed_at", item.capturedAt);
        }
        data.append("file", {
          uri: temporary.uri,
          name: item.filename,
          type: item.kind === "signature" ? "image/png" : "image/jpeg",
        } as unknown as Blob);
        await send(data, item.id);
        items = items.filter((x) => x.id !== item.id);
        await store.setItem("media-queue:" + uid, JSON.stringify(items));
        encrypted.delete();
        sent++;
      } finally {
        if (temporary.exists) temporary.delete();
      }
    }
    return sent;
  });
}
export function clearInterruptedUploads() {
  for (const entry of new Directory(Paths.cache).list()) {
    if (entry instanceof File && entry.name.startsWith("cw-upload-"))
      entry.delete();
  }
}
