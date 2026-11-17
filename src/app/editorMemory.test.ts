import { describe, expect, it } from "vite-plus/test";
import { dropWaiting, keepLater, keepWaiting } from "./editorMemory";

describe("keeping what editors hold", () => {
  it("waits for the state to settle, and keeps at once what waits when the page goes", async () => {
    const kept: string[] = [];
    keepLater("a/one", () => kept.push("first"));
    keepLater("a/one", () => kept.push("second"));
    keepLater("a/two", () => kept.push("other"));
    expect(kept).toEqual([]);
    // The page is hidden or left: nothing waits for the delay.
    keepWaiting();
    expect(kept).toEqual(["second", "other"]);
    keepLater("a/one", () => kept.push("dropped"));
    dropWaiting();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(kept).toEqual(["second", "other"]);
  });
});
