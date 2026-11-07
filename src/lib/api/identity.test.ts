import { describe, expect, it } from "vitest";
import { identify } from "./identity";

const request = (headers: Record<string, string>) => new Request("http://lab.test/", { headers });

describe("identify", () => {
  it("reads the opaque subject and display name from the SSO headers", () => {
    const actor = identify(
      request({ "x-sso-subject": "abc-123", "x-sso-display-name": "  Ana Pérez " }),
      {},
    );
    expect(actor).toEqual({ userId: "abc-123", displayName: "Ana Pérez" });
  });

  it("falls back to a neutral name and strips control characters", () => {
    expect(identify(request({ "x-sso-subject": "abc" }), {})?.displayName).toBe("Lab user");
    const name = identify(
      request({ "x-sso-subject": "abc", "x-sso-display-name": "A\u0007b" }),
      {},
    );
    expect(name?.displayName).toBe("Ab");
  });

  it("rejects subjects with spaces, control characters or excess length", () => {
    expect(identify(request({ "x-sso-subject": "a b" }), {})).toBeUndefined();
    expect(identify(request({ "x-sso-subject": "a".repeat(129) }), {})).toBeUndefined();
  });

  it("uses the development identity only outside production", () => {
    const env = { DEV_USER_SUBJECT: "dev-1", DEV_USER_NAME: "Dev" };
    expect(identify(request({}), env)).toEqual({ userId: "dev-1", displayName: "Dev" });
    expect(identify(request({}), { ...env, NODE_ENV: "production" })).toBeUndefined();
  });

  it("never lets a malformed header fall through to the development identity", () => {
    const env = { DEV_USER_SUBJECT: "dev-1" };
    expect(identify(request({ "x-sso-subject": "bad subject" }), env)).toBeUndefined();
  });
});
