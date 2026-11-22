import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chatConfigured, clerkHost } from "../src/lib/auth/chat-config";

const key = (kind: "test" | "live", decoded: string) => `pk_${kind}_${Buffer.from(decoded).toString("base64")}`;

describe("clerkHost", () => {
  test.each([
    ["test", "calm-lynx-12.clerk.accounts.dev"],
    ["live", "clerk.example.com"],
  ] as const)("a pk_%s_ key decodes to its host", (kind, host) => {
    expect(clerkHost(key(kind, `${host}$`))).toBe(host);
  });

  test("the key is read without its surrounding spaces and without the closing dollar", () => {
    expect(clerkHost(`  ${key("test", "clerk.example.com$")}\n`)).toBe("clerk.example.com");
    expect(clerkHost(key("test", "clerk.example.com"))).toBe("clerk.example.com");
  });

  test.each([
    ["no key", undefined],
    ["an empty key", ""],
    ["a prefix without a host", "pk_test_"],
    ["a secret key", `sk_test_${Buffer.from("clerk.example.com$").toString("base64")}`],
    ["another environment", `pk_dev_${Buffer.from("clerk.example.com$").toString("base64")}`],
    ["a key that is not base64", "pk_test_!!!"],
  ])("%s gives no host", (_, publishableKey) => {
    expect(clerkHost(publishableKey)).toBeNull();
  });

  test.each(["clerk.example.com/path", "clerk.example.com:8443", "user@clerk.example.com", "clerk example.com", "clerk.example.com$$", "'self' https://evil.example"])(
    "a decoded host with a forbidden character is refused: %s",
    (decoded) => {
      expect(clerkHost(key("live", decoded))).toBeNull();
    },
  );
});

describe("chatConfigured", () => {
  const VARIABLES = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "THREADS_DATABASE_URL"] as const;
  const before = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARIABLES) {
      before.set(name, process.env[name]);
      process.env[name] = `value of ${name}`;
    }
  });

  afterEach(() => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("the chat is open with its three variables", () => {
    expect(chatConfigured()).toBe(true);
  });

  test.each(VARIABLES)("the chat stays closed without %s", (name) => {
    delete process.env[name];

    expect(chatConfigured()).toBe(false);
  });

  test.each(VARIABLES)("the chat stays closed when %s is blank", (name) => {
    process.env[name] = "   ";

    expect(chatConfigured()).toBe(false);
  });
});
