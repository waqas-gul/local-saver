import { describe, expect, it } from "vitest";
import { createUploadsStore } from "@/lib/client/stores/uploads";

/** Upload queue and progress live in Zustand (DEC-034); no URLs or server data. */
describe("uploads store", () => {
  it("tracks a batch from queued to done", () => {
    const store = createUploadsStore();
    const batchId = store.getState().addBatch([
      { name: "a.txt", size: 10 },
      { name: "b.png", size: 20 },
    ]);
    const [a, b] = store.getState().items.filter((i) => i.batchId === batchId);
    expect(a).toMatchObject({ name: "a.txt", size: 10, loaded: 0, status: "queued" });

    store.getState().update(a!.id, { status: "uploading", loaded: 5 });
    store.getState().update(b!.id, { status: "done", loaded: 20 });
    expect(store.getState().items.find((i) => i.id === a!.id)).toMatchObject({ status: "uploading", loaded: 5 });

    store.getState().failBatch(batchId, "Upload rejected");
    expect(store.getState().items.find((i) => i.id === a!.id)).toMatchObject({ status: "error", error: "Upload rejected" });
    expect(store.getState().items.find((i) => i.id === b!.id)).toMatchObject({ status: "done" });

    store.getState().clearFinished();
    expect(store.getState().items).toEqual([]);
  });

  it("never stores URLs", () => {
    const store = createUploadsStore();
    store.getState().addBatch([{ name: "a.txt", size: 1 }]);
    expect(JSON.stringify(store.getState().items)).not.toMatch(/https?:\/\//);
  });
});
