export type SecureKV = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};
type Pointer = { generation: string; parts: number };
// Values are chunked on Unicode code-point boundaries, below SecureStore's per-item size limit.
// The pointer is the commit record. A failed write keeps the previous committed generation readable.
export class EncryptedStorage {
  private locks = new Map<string, Promise<void>>();
  constructor(
    private kv: SecureKV,
    private digest: (key: string) => Promise<string>,
    private random: () => string,
  ) {}
  private async exclusive<T>(key: string, fn: () => Promise<T>) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
  private async pointer(base: string) {
    const value = await this.kv.getItemAsync(base);
    if (value === null) return null;
    const p = JSON.parse(value) as Pointer;
    if (
      typeof p.generation !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(p.generation) ||
      !Number.isInteger(p.parts) ||
      p.parts < 1 ||
      p.parts > 2048
    )
      throw Error("Encrypted storage metadata is invalid");
    return p;
  }
  async getItem(key: string) {
    return this.exclusive(key, async () => {
      const base = "cw.secure." + (await this.digest(key)),
        p = await this.pointer(base);
      if (!p) return null;
      let value = "";
      for (let i = 0; i < p.parts; i++) {
        const chunk = await this.kv.getItemAsync(
          `${base}.${p.generation}.${i}`,
        );
        if (chunk === null)
          throw Error(
            "Encrypted local data is incomplete; synchronize or contact support",
          );
        value += chunk;
      }
      return value;
    });
  }
  async setItem(key: string, value: string) {
    return this.exclusive(key, async () => {
      const base = "cw.secure." + (await this.digest(key)),
        old = await this.pointer(base),
        chars = Array.from(value),
        parts = Math.max(1, Math.ceil(chars.length / 400));
      if (parts > 2048)
        throw Error("Local record exceeds encrypted storage limit");
      const generation = this.random().replaceAll("-", "_");
      for (let i = 0; i < parts; i++)
        await this.kv.setItemAsync(
          `${base}.${generation}.${i}`,
          chars.slice(i * 400, (i + 1) * 400).join(""),
        );
      await this.kv.setItemAsync(base, JSON.stringify({ generation, parts }));
      if (old)
        for (let i = 0; i < old.parts; i++)
          await this.kv
            .deleteItemAsync(`${base}.${old.generation}.${i}`)
            .catch(() => undefined);
    });
  }
  async removeItem(key: string) {
    return this.exclusive(key, async () => {
      const base = "cw.secure." + (await this.digest(key)),
        old = await this.pointer(base);
      await this.kv.deleteItemAsync(base);
      if (old)
        for (let i = 0; i < old.parts; i++)
          await this.kv
            .deleteItemAsync(`${base}.${old.generation}.${i}`)
            .catch(() => undefined);
    });
  }
}
