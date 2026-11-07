import { describe, expect, it } from "vitest";
import { claimKey, hashRequest, type Tx } from "./idempotency";

/** A scripted stand-in for the transaction: each insert and select answers from a queue. */
function scripted(inserts: unknown[][], selects: unknown[][]) {
  const calls = { insert: 0, select: 0, shared: 0 };
  const tx = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => inserts[calls.insert++] ?? [] }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => {
            calls.shared += 1;
            return selects[calls.select++] ?? [];
          },
        }),
      }),
    }),
  } as unknown as Tx;
  return { tx, calls };
}

const scope = { userId: "u", key: "k-0000001" };
const hash = hashRequest("create", { a: 1 });

describe("claimKey", () => {
  it("claims a fresh key", async () => {
    const { tx } = scripted([[{ key: "k" }]], []);
    expect(await claimKey(tx, scope, "create", hash)).toEqual({ kind: "claimed" });
  });

  it("replays a stored outcome, reading it with a share lock", async () => {
    const stored = { requestHash: hash, statusCode: 201, response: { ok: true } };
    const { tx, calls } = scripted([[]], [[stored]]);
    expect(await claimKey(tx, scope, "create", hash)).toEqual({
      kind: "replay",
      statusCode: 201,
      response: { ok: true },
    });
    expect(calls.shared).toBe(1);
  });

  it("reports a different body under the same key as a mismatch", async () => {
    const { tx } = scripted([[]], [[{ requestHash: "other", statusCode: 201, response: {} }]]);
    expect(await claimKey(tx, scope, "create", hash)).toEqual({ kind: "mismatch" });
  });

  it("claims afresh when a purge removed the conflicting record between the two statements", async () => {
    // First insert conflicts, the select finds nothing (purged), the second insert succeeds.
    const { tx, calls } = scripted([[], [{ key: "k" }]], [[]]);
    expect(await claimKey(tx, scope, "create", hash)).toEqual({ kind: "claimed" });
    expect(calls.insert).toBe(2);
  });

  it("gives up with an error rather than looping forever", async () => {
    const { tx } = scripted([[], [], []], [[], [], []]);
    await expect(claimKey(tx, scope, "create", hash)).rejects.toThrow("could not claim");
  });
});
