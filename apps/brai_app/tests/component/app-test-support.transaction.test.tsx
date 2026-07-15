import { afterEach, describe, expect, it, vi } from "vitest";
import { clientDb } from "@/shared/storage/db";
import { clearBraiAppTestDatabase } from "./app-test-support";

describe("clearBraiAppTestDatabase", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rolls back earlier table clears when a later clear fails", async () => {
    const db = clientDb();
    await db.meta.put({ key: "rollback-probe", value: true });
    vi.spyOn(db.tables[1], "clear").mockRejectedValueOnce(new Error("clear failed"));

    await expect(clearBraiAppTestDatabase()).rejects.toThrow("clear failed");
    await expect(db.meta.get("rollback-probe")).resolves.toMatchObject({ value: true });
  });
});
