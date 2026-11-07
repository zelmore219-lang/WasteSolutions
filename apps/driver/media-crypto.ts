import { gcm } from "@noble/ciphers/aes.js";
function associated(scope: string) {
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(scope))
    throw Error("Invalid media scope");
  return Uint8Array.from(Array.from(scope).map((c) => c.charCodeAt(0)));
}
export function sealMedia(
  key: Uint8Array,
  nonce: Uint8Array,
  data: Uint8Array,
  scope: string,
) {
  if (key.length !== 32 || nonce.length !== 12)
    throw Error("Invalid encryption key or nonce");
  if (data.length > 10485760) throw Error("Media exceeds 10 MB");
  const ciphertext = gcm(key, nonce, associated(scope)).encrypt(data),
    result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce);
  result.set(ciphertext, nonce.length);
  return result;
}
export function openMedia(key: Uint8Array, data: Uint8Array, scope: string) {
  if (key.length !== 32 || data.length < 28 || data.length > 10485788)
    throw Error("Encrypted media size is invalid");
  return gcm(key, data.subarray(0, 12), associated(scope)).decrypt(
    data.subarray(12),
  );
}
