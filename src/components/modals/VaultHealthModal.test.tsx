import "../../test-support/webCrypto";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { VaultHealthModal } from "./VaultHealthModal";
import { VaultEntry } from "../../hooks/useVault";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const STRONG_A = "Correct-Horse-Battery-Staple-9271!";
const STRONG_B = "Different-Purple-Elephant-Lamp-4408#";
const STRONG_C = "Another-Quiet-Mountain-River-5530$";
const WEAK = "abc";

function makeEntry(id: string, service: string, password: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id,
    service,
    username: `${id}@example.com`,
    password,
    notes: "",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

function setup(entries: VaultEntry[]) {
  const props = { onClose: jest.fn(), onEditEntry: jest.fn() };
  const utils = render(<VaultHealthModal entries={entries} {...props} />);
  return { ...props, ...utils };
}

const scanButton = () => screen.getByRole("button", { name: /Scan for Breaches|Stop/ });
const breachCalls = () => mockInvoke.mock.calls.filter(([c]) => c === "check_password_breach");

function listedServices(): string[] {
  return Array.from(document.querySelectorAll(".modal-body > div > div")).map(
    (row) => (row.querySelector("div[style*='font-weight: 600']") as HTMLElement).textContent ?? "",
  );
}

// The three number cards under the title: Compromised, Reused, Weak.
function stat(label: string): string {
  const grid = document.querySelector(".auth-card")!.children[1];
  const card = Array.from(grid.children).find((c) => c.textContent?.includes(label))!;
  return card.children[0].textContent ?? "";
}

function badgesFor(service: string): string[] {
  const row = screen.getByText(service).closest("div[style*='border-bottom']") as HTMLElement;
  return Array.from(row.querySelectorAll("span")).map((s) => s.textContent ?? "");
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoke.mockResolvedValue({ found: false, count: 0 });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("VaultHealthModal - instant checks", () => {
  it("reports a healthy vault", () => {
    setup([makeEntry("a", "Bank", STRONG_A), makeEntry("b", "Mail", STRONG_B)]);
    expect(screen.getByText("No obvious issues found.")).toBeInTheDocument();
    expect(stat("Compromised")).toBe("0");
    expect(stat("Reused")).toBe("0");
    expect(stat("Weak")).toBe("0");
  });

  it("flags weak passwords", () => {
    setup([makeEntry("a", "Bank", STRONG_A), makeEntry("b", "Forum", WEAK)]);
    expect(stat("Weak")).toBe("1");
    expect(listedServices()).toEqual(["Forum"]);
    expect(badgesFor("Forum")).toEqual(["Weak"]);
  });

  it("draws the weak line between 'okay' and 'good'", () => {
    // 14 lowercase letters score 2 ("Okay"); adding capitals and a digit scores 3 ("Good").
    setup([makeEntry("a", "Okay", "abcdefghijklmn"), makeEntry("b", "Good", "Abcdefghijklm1")]);
    expect(stat("Weak")).toBe("1");
    expect(listedServices()).toEqual(["Okay"]);
  });

  it("flags every entry that shares a password", () => {
    setup([
      makeEntry("a", "Bank", STRONG_A),
      makeEntry("b", "Mail", STRONG_A),
      makeEntry("c", "Shop", STRONG_A),
      makeEntry("d", "Solo", STRONG_B),
    ]);
    expect(stat("Reused")).toBe("3");
    expect(listedServices().sort()).toEqual(["Bank", "Mail", "Shop"]);
    expect(badgesFor("Mail")).toEqual(["Reused"]);
  });

  it("does not call two blank passwords 'reused'", () => {
    setup([makeEntry("a", "A", ""), makeEntry("b", "B", "")]);
    expect(stat("Reused")).toBe("0");
    expect(stat("Weak")).toBe("2");
  });

  it("treats look-alike passwords such as 'constructor' as ordinary text", () => {
    setup([makeEntry("a", "A", "constructor"), makeEntry("b", "B", "toString"), makeEntry("c", "C", "__proto__")]);
    expect(stat("Reused")).toBe("0");
  });

  it("shows several problems on one entry", () => {
    setup([makeEntry("a", "Forum", WEAK), makeEntry("b", "Blog", WEAK)]);
    expect(badgesFor("Forum")).toEqual(["Reused", "Weak"]);
  });

  it("lists the worst entries first, then alphabetically", () => {
    setup([
      makeEntry("a", "Zulu", WEAK),
      makeEntry("b", "Alpha", WEAK),
      makeEntry("c", "Mike", STRONG_A),
      makeEntry("d", "Bravo", STRONG_A),
    ]);
    // Reused (10) outranks weak-only (1); ties fall back to the name.
    expect(listedServices()).toEqual(["Alpha", "Zulu", "Bravo", "Mike"]);
  });
});

describe("VaultHealthModal - buttons", () => {
  it("closes from the X and from a click outside, but not from a click inside", () => {
    const { onClose } = setup([makeEntry("a", "Forum", WEAK)]);
    fireEvent.click(screen.getByText("Security Health"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector("svg.lucide-x")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector(".modal-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("opens the entry for editing from Fix", () => {
    const entries = [makeEntry("a", "Forum", WEAK), makeEntry("b", "Bank", STRONG_A)];
    const { onEditEntry } = setup(entries);
    fireEvent.click(screen.getByRole("button", { name: /Fix/ }));
    expect(onEditEntry).toHaveBeenCalledWith(entries[0]);
  });
});

describe("VaultHealthModal - breach scan", () => {
  it("checks each password by its SHA-1 hash and never sends the password itself", async () => {
    setup([makeEntry("a", "Forum", "password"), makeEntry("b", "Bank", STRONG_A)]);
    fireEvent.click(scanButton());
    await waitFor(() => expect(breachCalls()).toHaveLength(2));

    expect(breachCalls()[0][1]).toEqual({ sha1Hash: "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8" });
    const everything = JSON.stringify(mockInvoke.mock.calls);
    expect(everything).not.toContain("password\"");
    expect(everything).not.toContain(STRONG_A);
  });

  it("marks breached entries as compromised", async () => {
    mockInvoke.mockImplementation((_c: string, args: { sha1Hash: string }) =>
      Promise.resolve({ found: args.sha1Hash.startsWith("5BAA6"), count: 10 }),
    );
    setup([makeEntry("a", "Forum", "password"), makeEntry("b", "Bank", STRONG_A)]);
    fireEvent.click(scanButton());

    await waitFor(() => expect(stat("Compromised")).toBe("1"));
    expect(badgesFor("Forum")).toContain("Compromised");
    expect(screen.queryByText("Bank")).not.toBeInTheDocument();
    expect(listedServices()[0]).toBe("Forum");
  });

  it("ranks a compromised entry above reused and weak ones", async () => {
    mockInvoke.mockImplementation((_c: string, args: { sha1Hash: string }) =>
      Promise.resolve({ found: args.sha1Hash.startsWith("5BAA6"), count: 1 }),
    );
    setup([
      makeEntry("a", "Aaa", WEAK),
      makeEntry("b", "Bbb", WEAK),
      makeEntry("c", "Zzz", "password"),
    ]);
    fireEvent.click(scanButton());
    await waitFor(() => expect(stat("Compromised")).toBe("1"));
    expect(listedServices()[0]).toBe("Zzz");
  });

  it("shows progress while running and returns to the start button when done", async () => {
    const first = deferred<{ found: boolean; count: number }>();
    mockInvoke.mockReturnValueOnce(first.promise);
    setup([makeEntry("a", "A", STRONG_A), makeEntry("b", "B", STRONG_B)]);
    fireEvent.click(scanButton());

    expect(await screen.findByRole("button", { name: /Stop \(0%\)/ })).toBeInTheDocument();
    expect(screen.getByText(/Checking passwords against known leaks/)).toBeInTheDocument();
    await act(async () => {
      first.resolve({ found: false, count: 0 });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan for Breaches" })).toBeInTheDocument());
    expect(screen.getByText(/hashed locally/)).toBeInTheDocument();
  });

  it("counts passwords it could not check, instead of calling them safe", async () => {
    mockInvoke.mockImplementation((_c: string, args: { sha1Hash: string }) =>
      args.sha1Hash.startsWith("5BAA6") ? Promise.reject("network down") : Promise.resolve({ found: false, count: 0 }),
    );
    setup([makeEntry("a", "Forum", "password"), makeEntry("b", "Bank", STRONG_A)]);
    fireEvent.click(scanButton());

    expect(await screen.findByText(/1 password could not be checked/)).toBeInTheDocument();
    expect(stat("Compromised")).toBe("0");
  });

  it("uses the plural when several checks fail", async () => {
    mockInvoke.mockRejectedValue("network down");
    setup([makeEntry("a", "A", STRONG_A), makeEntry("b", "B", STRONG_B), makeEntry("c", "C", STRONG_C)]);
    fireEvent.click(scanButton());
    expect(await screen.findByText(/3 passwords could not be checked/)).toBeInTheDocument();
  });

  it("stops asking once Stop is pressed and keeps what it found so far", async () => {
    const first = deferred<{ found: boolean; count: number }>();
    mockInvoke.mockReturnValueOnce(first.promise);
    setup([makeEntry("a", "A", "password"), makeEntry("b", "B", STRONG_A), makeEntry("c", "C", STRONG_B)]);
    fireEvent.click(scanButton());
    await waitFor(() => expect(breachCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await act(async () => {
      first.resolve({ found: true, count: 5 });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Scan for Breaches" })).toBeInTheDocument());
    expect(breachCalls()).toHaveLength(1);
    expect(stat("Compromised")).toBe("1");
  });

  it("stops asking when the dialog is closed mid-scan", async () => {
    const first = deferred<{ found: boolean; count: number }>();
    mockInvoke.mockReturnValueOnce(first.promise);
    const { unmount } = setup([makeEntry("a", "A", STRONG_A), makeEntry("b", "B", STRONG_B)]);
    fireEvent.click(scanButton());
    await waitFor(() => expect(breachCalls()).toHaveLength(1));

    unmount();
    await act(async () => {
      first.resolve({ found: false, count: 0 });
    });

    expect(breachCalls()).toHaveLength(1);
  });

  it("starts a rescan from a clean slate", async () => {
    mockInvoke.mockResolvedValueOnce({ found: true, count: 3 }).mockRejectedValueOnce("boom");
    setup([makeEntry("a", "A", STRONG_A), makeEntry("b", "B", STRONG_B)]);
    fireEvent.click(scanButton());
    await screen.findByText(/1 password could not be checked/);
    expect(stat("Compromised")).toBe("1");

    mockInvoke.mockResolvedValue({ found: false, count: 0 });
    fireEvent.click(scanButton());

    await waitFor(() => expect(stat("Compromised")).toBe("0"));
    expect(screen.queryByText(/could not be checked/)).not.toBeInTheDocument();
  });

  it("does nothing for an empty vault", async () => {
    setup([]);
    fireEvent.click(scanButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan for Breaches" })).toBeInTheDocument());
    expect(breachCalls()).toHaveLength(0);
    expect(within(document.body).getByText("No obvious issues found.")).toBeInTheDocument();
  });
});
