import { notFound } from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import { guarded, jsonResponse, problemResponse, serviceResponse } from "./http";

describe("guarded", () => {
  it("turns an unexpected error into a generic 500 that leaks nothing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await guarded(async () => {
      throw new Error("connection string postgres://secret@host/db");
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const text = await response.text();
    expect(text).toContain('"code":"internal"');
    expect(text).not.toContain("secret");
    spy.mockRestore();
  });

  it("lets Next.js control-flow errors through instead of swallowing them", async () => {
    await expect(
      guarded(async () => {
        notFound();
      }),
    ).rejects.toBeDefined();
  });

  it("passes a handler's own response through unchanged", async () => {
    const response = await guarded(async () => jsonResponse(200, { ok: true }));
    expect(response.status).toBe(200);
  });
});

describe("responses", () => {
  it("never allow caching and flag replays", async () => {
    const plain = problemResponse(409, "conflict", "Taken");
    expect(plain.headers.get("cache-control")).toBe("no-store");
    const replay = serviceResponse({ status: 201, body: { a: 1 }, replayed: true });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("content-type")).toBe("application/json");
  });
});
