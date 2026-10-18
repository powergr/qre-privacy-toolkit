import { cancelNotice, isCancelledResult, summarizeCancel } from "./cancelled";
import type { BatchResult } from "../types";

const ok = (name = "a.txt", message = "Locked"): BatchResult => ({ name, success: true, message });
const bad = (message: string, name = "a.txt"): BatchResult => ({ name, success: false, message });

describe("isCancelledResult", () => {
  it.each(["Cancelled.", "Cancelled. Not started.", "Cancelled. The old file was not changed."])("recognises %p", (m) => {
    expect(isCancelledResult(bad(m))).toBe(true);
  });

  it.each(["Locked", "Decryption Denied", "Could not save", "cancelled", "Not cancelled", ""])("does not take %p for a stop", (m) => {
    expect(isCancelledResult(bad(m))).toBe(false);
  });

  it("never treats a success as a stop, whatever it says", () => {
    expect(isCancelledResult({ name: "a", success: true, message: "Cancelled." })).toBe(false);
  });
});

describe("summarizeCancel", () => {
  it("says nothing was stopped when every result is an ordinary one", () => {
    expect(summarizeCancel([ok(), bad("Wrong password")])).toEqual({ cancelled: false, finished: 1, problems: [bad("Wrong password")] });
  });

  it("counts the files finished before the stop and keeps real problems apart from the stop", () => {
    const results = [ok("a"), bad("Wrong password", "b"), bad("Cancelled.", "c"), bad("Cancelled. Not started.", "2 more files")];
    const s = summarizeCancel(results);
    expect(s.cancelled).toBe(true);
    expect(s.finished).toBe(1);
    expect(s.problems.map((p) => p.name)).toEqual(["b"]);
  });

  it("handles an empty list", () => {
    expect(summarizeCancel([])).toEqual({ cancelled: false, finished: 0, problems: [] });
  });

  it("handles a job stopped before anything finished", () => {
    expect(summarizeCancel([bad("Cancelled.")])).toEqual({ cancelled: true, finished: 0, problems: [] });
  });
});

describe("cancelNotice", () => {
  it("says nothing was changed when no file was finished", () => {
    expect(cancelNotice(0, "locked")).toBe("Cancelled. Nothing was changed.");
    expect(cancelNotice(-1, "locked")).toBe("Cancelled. Nothing was changed.");
  });

  it("names the number of finished files, singular and plural, and the verb", () => {
    expect(cancelNotice(1, "locked")).toBe("Cancelled. 1 file was locked before you stopped. The rest were left as they were.");
    expect(cancelNotice(3, "upgraded")).toBe("Cancelled. 3 files were upgraded before you stopped. The rest were left as they were.");
  });
});
