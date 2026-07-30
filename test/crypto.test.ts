import { describe, expect, it } from "vitest";
import { SecureStore } from "../src/crypto.js";

describe("SecureStore", () => {
  it("encrypts plaintext and binds decryption to session and purpose", () => {
    const store = new SecureStore(Buffer.alloc(32, 9));
    const envelope = store.encryptJson(
      { cookie: "sensitive-cookie", text: "客户私信" },
      "session-a",
      "credentials",
    );

    expect(envelope).not.toContain("sensitive-cookie");
    expect(envelope).not.toContain("客户私信");
    expect(store.decryptJson(envelope, "session-a", "credentials")).toEqual({
      cookie: "sensitive-cookie",
      text: "客户私信",
    });
    expect(() => store.decryptJson(envelope, "session-b", "credentials")).toThrow();
    expect(() => store.decryptJson(envelope, "session-a", "reply:1")).toThrow();
  });

  it("namespaces keyed hashes", () => {
    const store = new SecureStore(Buffer.alloc(32, 3));
    expect(store.keyedHash("id", "a")).not.toBe(store.keyedHash("id", "b"));
    expect(store.keyedHash("id", "a")).toBe(store.keyedHash("id", "a"));
  });
});
