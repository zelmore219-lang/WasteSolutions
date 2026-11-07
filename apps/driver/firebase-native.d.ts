import "firebase/auth";
// Firebase exposes this API from its React Native runtime. Its top-level "types"
// export currently omits the RN-only declaration even with react-native conditions.
// Match the documented RN adapter contract without changing runtime implementation.
declare module "firebase/auth" {
  export function getReactNativePersistence(storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  }): import("firebase/auth").Persistence;
}
