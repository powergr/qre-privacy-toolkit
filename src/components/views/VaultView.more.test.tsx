import { render, screen, fireEvent, waitFor, within, act } from "../../test-support/rtl";
import "@testing-library/jest-dom";
import { VaultView } from "./VaultView";
import { VaultEntry } from "../../hooks/useVault";

const mockInvoke = jest.fn();
const mockWriteText = jest.fn();
const mockOpen = jest.fn();
const mockSave = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
  save: (...args: unknown[]) => mockSave(...args),
}));
// The health check has its own tests; here it is only a way to reach the editor.
jest.mock("../modals/VaultHealthModal", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VaultHealthModal: (p: any) => (
    <div data-testid="health">
      <button onClick={p.onClose}>health: close</button>
      <button onClick={() => p.onEditEntry(p.entries[0])}>health: edit first</button>
    </div>
  ),
}));

function makeEntry(id: string, service: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id,
    service,
    username: `${id}@example.com`,
    password: `pw-${id}`,
    notes: "",
    is_pinned: false,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

const SECRET = "JBSWY3DPEHPK3PXP";

let saveGate: Promise<void> | null;
let saveFailure: string | null;
let fileContents: string;
let totpHandler: (secret: string) => Promise<[string, number]>;

function backend(entries: VaultEntry[]) {
  mockInvoke.mockImplementation((cmd: string, args: { secret?: string }) => {
    switch (cmd) {
      case "load_password_vault":
        return Promise.resolve({ entries: entries.map((e) => ({ ...e })) });
      case "save_password_vault":
        if (saveFailure) return Promise.reject(saveFailure);
        return saveGate ? saveGate.then(() => null) : Promise.resolve(null);
      case "read_text_file_content":
        return Promise.resolve(fileContents);
      case "generate_totp_code":
        return totpHandler(args.secret as string);
      default:
        return Promise.resolve(null);
    }
  });
}

async function renderVault(entries: VaultEntry[] = []) {
  backend(entries);
  const utils = render(<VaultView />);
  await waitFor(() => expect(screen.queryByText("Loading Vault...")).not.toBeInTheDocument());
  return utils;
}

function savedVaults(): VaultEntry[][] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "save_password_vault")
    .map(([, args]) => (args as { vault: { entries: VaultEntry[] } }).vault.entries);
}
const lastSaved = () => savedVaults().slice(-1)[0];
const totpCalls = () =>
  mockInvoke.mock.calls.filter(([c]) => c === "generate_totp_code").map(([, a]) => a.secret);

const SERVICE = "Service Name (e.g. Google)";
const fill = (placeholder: string, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const field = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement;
const clickSave = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
const openNew = () => fireEvent.click(screen.getByRole("button", { name: "Add New" }));
const grid = () => fireEvent.click(screen.getByTitle("Grid View"));
const card = (service: string) => screen.getByText(service).closest(".modern-card") as HTMLElement;
const listRow = (service: string) => screen.getByText(service).closest(".vault-list-row") as HTMLElement;
const editorCard = () => document.querySelector(".ui-drawer") as HTMLElement;

beforeEach(() => {
  jest.clearAllMocks();
  saveGate = null;
  saveFailure = null;
  fileContents = "";
  totpHandler = () => Promise.resolve(["123456", 20]);
  mockWriteText.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─── Live 2FA codes ──────────────────────────────────────────────────────────

describe("VaultView - 2FA code on a card", () => {
  async function gridWith(secret: string) {
    await renderVault([makeEntry("a", "GitHub", { totp_secret: secret })]);
    grid();
  }
  const pill = () => document.querySelector(".secret-pill[title]") as HTMLElement;
  const codeText = () => pill().querySelector("span")!.textContent;

  it("shows the code in two groups of three", async () => {
    await gridWith(SECRET);
    await waitFor(() => expect(codeText()).toBe("123 456"));
    expect(totpCalls()[0]).toBe(SECRET);
  });

  it("shows dashes and asks the backend nothing for a key that is too short", async () => {
    await gridWith("TOOSHORT");
    expect(codeText()).toBe("--- ---");
    expect(totpCalls()).toHaveLength(0);
    fireEvent.click(pill());
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it("copies the code when anywhere on the pill is clicked, without opening the editor", async () => {
    await gridWith(SECRET);
    await waitFor(() => expect(codeText()).toBe("123 456"));
    await act(async () => {
      fireEvent.click(pill());
    });
    expect(mockWriteText).toHaveBeenCalledWith("123456");
    expect(screen.getByText(/2FA Code copied/)).toBeInTheDocument();
    expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument();
  });

  it("does not copy the dashes while the first code is still loading", async () => {
    totpHandler = () => new Promise(() => {});
    await gridWith(SECRET);
    fireEvent.click(pill());
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it("says INVALID KEY, and copies nothing, when the backend rejects the key", async () => {
    totpHandler = () => Promise.reject("bad base32");
    await gridWith(SECRET);
    await waitFor(() => expect(codeText()).toBe("INVALID KEY"));
    expect(pill()).toHaveAttribute("title", "Invalid Secret Key");
    fireEvent.click(pill());
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it("recovers when a later refresh succeeds", async () => {
    jest.useFakeTimers();
    try {
      let fail = true;
      totpHandler = () => (fail ? Promise.reject("blip") : Promise.resolve(["654321", 10]));
      await gridWith(SECRET);
      await act(async () => {});
      expect(codeText()).toBe("INVALID KEY");
      fail = false;
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(codeText()).toBe("654 321");
    } finally {
      jest.useRealTimers();
    }
  });

  it("refreshes every second and stops once the card is gone", async () => {
    jest.useFakeTimers();
    try {
      const { unmount } = await renderVault([makeEntry("a", "GitHub", { totp_secret: SECRET })]);
      grid();
      await act(async () => {});
      const before = totpCalls().length;
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });
      expect(totpCalls().length).toBe(before + 3);
      unmount();
      const after = totpCalls().length;
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(totpCalls()).toHaveLength(after);
    } finally {
      jest.useRealTimers();
    }
  });

  it("turns red in the last five seconds", async () => {
    totpHandler = () => Promise.resolve(["123456", 5]);
    await gridWith(SECRET);
    await waitFor(() => expect(codeText()).toBe("123 456"));
    expect(pill().querySelector("span")).toHaveStyle({ color: "var(--btn-danger)" });
  });

  it("stays in the normal colour with six seconds left", async () => {
    totpHandler = () => Promise.resolve(["123456", 6]);
    await gridWith(SECRET);
    await waitFor(() => expect(codeText()).toBe("123 456"));
    expect(pill().querySelector("span")).toHaveStyle({ color: "var(--text-main)" });
  });

  it("draws the countdown ring in proportion to the time left", async () => {
    totpHandler = () => Promise.resolve(["123456", 15]);
    await gridWith(SECRET);
    await waitFor(() => expect(codeText()).toBe("123 456"));
    const ring = pill().querySelectorAll("circle")[1];
    const circumference = 2 * Math.PI * 8;
    expect(Number(ring.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference / 2, 1);
  });

  it("accepts a key typed with spaces and in lower case, as the editor does", async () => {
    await gridWith("jbsw y3dp ehpk 3pxp");
    await waitFor(() => expect(codeText()).toBe("123 456"));
    expect(totpCalls()[0]).toBe(SECRET);
  });
});

describe("VaultView - 2FA code in the editor", () => {
  const key = () => field("2FA Authenticator Key (e.g. JBSWY3DP...)");

  it("shows a live code once the key is long enough", async () => {
    await renderVault([]);
    openNew();
    fireEvent.change(key(), { target: { value: "JBSWY3DP" } });
    expect(editorCard().textContent).not.toMatch(/\d{3} \d{3}/);
    fireEvent.change(key(), { target: { value: SECRET } });
    await waitFor(() => expect(editorCard()).toHaveTextContent("123 456"));
  });

  it("shows no code while the key is still too short once its spaces are ignored", async () => {
    await renderVault([]);
    openNew();
    fireEvent.change(key(), { target: { value: "jbsw y3dp ehpk 3px" } }); // 18 typed, 15 real
    expect(editorCard().textContent).not.toMatch(/-{3} -{3}/);
    expect(totpCalls()).toHaveLength(0);
  });

  it("shows a code for a long key typed in groups with spaces", async () => {
    await renderVault([]);
    openNew();
    fireEvent.change(key(), { target: { value: "jbsw y3dp ehpk 3pxp" } });
    await waitFor(() => expect(editorCard()).toHaveTextContent("123 456"));
    expect(totpCalls()[0]).toBe(SECRET);
  });

  it("copies the code from the editor", async () => {
    await renderVault([]);
    openNew();
    fireEvent.change(key(), { target: { value: SECRET } });
    await waitFor(() => expect(editorCard()).toHaveTextContent("123 456"));
    await act(async () => {
      fireEvent.click(editorCard().querySelector('[title="Click to Copy 2FA Code"]') as HTMLElement);
    });
    expect(mockWriteText).toHaveBeenCalledWith("123456");
  });

  it("ignores a slow answer for a key that was replaced meanwhile", async () => {
    let releaseOld!: (v: [string, number]) => void;
    totpHandler = (secret) =>
      secret === SECRET
        ? new Promise((r) => {
            releaseOld = r;
          })
        : Promise.resolve(["999999", 20]);
    await renderVault([]);
    openNew();
    fireEvent.change(key(), { target: { value: SECRET } });
    await waitFor(() => expect(totpCalls()).toContain(SECRET));
    fireEvent.change(key(), { target: { value: "ABCDEFGHIJKLMNOP" } });
    await waitFor(() => expect(editorCard()).toHaveTextContent("999 999"));
    await act(async () => {
      releaseOld(["111111", 20]);
    });
    expect(editorCard()).toHaveTextContent("999 999");
    expect(editorCard()).not.toHaveTextContent("111 111");
  });

  it("hides the code again when the key is cleared", async () => {
    await renderVault([]);
    openNew();
    fireEvent.change(key(), { target: { value: SECRET } });
    await waitFor(() => expect(editorCard()).toHaveTextContent("123 456"));
    fireEvent.change(key(), { target: { value: "" } });
    expect(editorCard()).not.toHaveTextContent("123 456");
  });
});

// ─── Editor ──────────────────────────────────────────────────────────────────

describe("VaultView - editor", () => {
  it("closes without saving when the dark area is clicked", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("does not close when the click is inside the editor", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.mouseDown(editorCard());
    expect(screen.getByText("Edit Entry")).toBeInTheDocument();
  });

  it("does not pop up an old validation error after the editor was closed from outside", async () => {
    await renderVault([]);
    openNew();
    clickSave();
    await screen.findByText("Service name is required.");
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(screen.queryByText("Service name is required.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
  });

  it("does not show an old error when the next entry is opened", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    openNew();
    clickSave();
    await screen.findByText("Service name is required.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.queryByText("Service name is required.")).not.toBeInTheDocument();
  });

  it("hides the password again for the next entry after it was revealed", async () => {
    await renderVault([makeEntry("a", "GitHub"), makeEntry("b", "Zoom")]);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByTitle("Show password"));
    expect(field("Password")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByText("Zoom"));
    expect(field("Password")).toHaveAttribute("type", "password");
    expect(screen.getByTitle("Show password")).toBeInTheDocument();
  });

  it("hides the password again for a new entry after it was revealed", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByTitle("Show password"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openNew();
    expect(field("Password")).toHaveAttribute("type", "password");
  });

  it("toggles the password between hidden and visible", async () => {
    await renderVault([makeEntry("a", "GitHub", { password: "hunter2" })]);
    fireEvent.click(screen.getByText("GitHub"));
    expect(field("Password")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByTitle("Show password"));
    expect(field("Password")).toHaveAttribute("type", "text");
    expect(field("Password").value).toBe("hunter2");
    fireEvent.click(screen.getByTitle("Hide password"));
    expect(field("Password")).toHaveAttribute("type", "password");
  });

  it("shows the strength of the password while typing, and nothing while empty", async () => {
    await renderVault([]);
    openNew();
    expect(editorCard().querySelector('div[style*="height: 4px"]')).toBeNull();
    fill("Password", "abc");
    expect(editorCard().querySelector('div[style*="height: 4px"]')).not.toBeNull();
    expect(editorCard()).toHaveTextContent("Very Weak");
    fill("Password", "correct horse battery staple");
    expect(editorCard()).toHaveTextContent("Excellent");
  });

  it("pins and unpins from inside the editor, and saves the choice", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(within(editorCard()).getByTitle("Pin"));
    expect(within(editorCard()).getByTitle("Unpin")).toBeInTheDocument();
    clickSave();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].is_pinned).toBe(true);
  });

  it("saves the web address and keeps the colour and notes it cannot edit", async () => {
    await renderVault([
      makeEntry("a", "GitHub", { color: "#E50914", notes: "recovery in the safe" }),
    ]);
    fireEvent.click(screen.getByText("GitHub"));
    fill("Website URL (Optional)", "https://github.com");
    clickSave();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0]).toMatchObject({
      url: "https://github.com",
      color: "#E50914",
      notes: "recovery in the safe",
    });
  });

  it("gives a new entry the default colour and an empty address", async () => {
    await renderVault([]);
    openNew();
    fill(SERVICE, "Site");
    fill("Password", "pw");
    clickSave();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0]).toMatchObject({ url: "", color: "#555555", notes: "", username: "" });
  });

  it("keeps a 2FA key through an edit that does not touch it", async () => {
    await renderVault([makeEntry("a", "GitHub", { totp_secret: SECRET })]);
    fireEvent.click(screen.getByText("GitHub"));
    clickSave();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].totp_secret).toBe(SECRET);
  });

  it("removes the 2FA key when the field is emptied", async () => {
    await renderVault([makeEntry("a", "GitHub", { totp_secret: SECRET })]);
    fireEvent.click(screen.getByText("GitHub"));
    fill("2FA Authenticator Key (e.g. JBSWY3DP...)", "   ");
    clickSave();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].totp_secret).toBeUndefined();
  });

  it("stores one entry even if Save is pressed twice quickly", async () => {
    let release!: () => void;
    saveGate = new Promise<void>((r) => {
      release = r;
    });
    await renderVault([]);
    openNew();
    fill(SERVICE, "Site");
    fill("Password", "pw");
    clickSave();
    clickSave();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByText("New Entry")).not.toBeInTheDocument());
    expect(lastSaved()).toHaveLength(1);
    expect(savedVaults()).toHaveLength(1);
  });

  it("can be saved again after a failed save", async () => {
    saveFailure = "disk full";
    await renderVault([]);
    openNew();
    fill(SERVICE, "Site");
    fill("Password", "pw");
    clickSave();
    await screen.findByText(/disk full/);
    saveFailure = null;
    clickSave();
    await waitFor(() => expect(screen.queryByText("New Entry")).not.toBeInTheDocument());
    expect(lastSaved()).toHaveLength(1);
  });

  it("opens from the health check and saves a changed password", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByTitle("Security Health Check"));
    expect(screen.getByTestId("health")).toBeInTheDocument();
    fireEvent.click(screen.getByText("health: edit first"));
    expect(screen.getByText("Edit Entry")).toBeInTheDocument();
    fill("Password", "a-much-better-password");
    clickSave();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].password).toBe("a-much-better-password");
  });

  it("closes the health check", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByTitle("Security Health Check"));
    fireEvent.click(screen.getByText("health: close"));
    expect(screen.queryByTestId("health")).not.toBeInTheDocument();
  });
});

// ─── Lists and cards ─────────────────────────────────────────────────────────

describe("VaultView - list rows", () => {
  it("starts in list view and marks the active view button", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    expect(document.querySelector(".vault-list")).not.toBeNull();
    expect(screen.getByTitle("List View")).toHaveClass("active");
    expect(screen.getByTitle("Grid View")).not.toHaveClass("active");
    grid();
    expect(document.querySelector(".vault-list")).toBeNull();
    expect(screen.getByTitle("Grid View")).toHaveClass("active");
    fireEvent.click(screen.getByTitle("List View"));
    expect(document.querySelector(".modern-grid")).toBeNull();
  });

  it("shows the first letter of the service, ignoring a web prefix", async () => {
    await renderVault([
      makeEntry("a", "https://www.example.com"),
      makeEntry("b", "bank"),
      makeEntry("c", "?"),
    ]);
    const icons = Array.from(document.querySelectorAll(".service-icon")).map((i) => i.textContent);
    expect(icons.sort()).toEqual(["?", "B", "E"].sort());
  });

  it("uses the entry's colour for the icon, or the default", async () => {
    await renderVault([
      makeEntry("a", "Colored", { color: "#E50914" }),
      makeEntry("b", "Plain"),
    ]);
    expect(within(listRow("Colored")).getByText("C")).toHaveStyle({ backgroundColor: "#E50914" });
    expect(within(listRow("Plain")).getByText("P")).toHaveStyle({ backgroundColor: "#555555" });
  });

  it("opens the editor from a row but not from its buttons", async () => {
    await renderVault([makeEntry("a", "GitHub", { totp_secret: SECRET })]);
    fireEvent.click(within(listRow("GitHub")).getByTitle("Copy Password"));
    fireEvent.click(within(listRow("GitHub")).getByTitle("Delete"));
    fireEvent.click(within(listRow("GitHub")).getByText("2FA"));
    expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByText("Edit Entry")).toBeInTheDocument();
  });

  it("marks pinned rows", async () => {
    await renderVault([makeEntry("a", "Starred", { is_pinned: true }), makeEntry("b", "Plain")]);
    expect(listRow("Starred")).toHaveClass("pinned");
    expect(listRow("Starred").querySelector("svg.lucide-pin")).not.toBeNull();
    expect(listRow("Plain")).not.toHaveClass("pinned");
  });
});

describe("VaultView - grid cards", () => {
  it("shows the service, the username and a masked password", async () => {
    await renderVault([makeEntry("a", "GitHub", { password: "hunter2" })]);
    grid();
    expect(within(card("GitHub")).getByText("a@example.com")).toBeInTheDocument();
    expect(within(card("GitHub")).getByText("•".repeat(12))).toBeInTheDocument();
    expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
  });

  it("reveals one password at a time and hides it again", async () => {
    await renderVault([
      makeEntry("a", "GitHub", { password: "pw-one" }),
      makeEntry("b", "Zoom", { password: "pw-two" }),
    ]);
    grid();
    fireEvent.click(within(card("GitHub")).getByTitle("Show password"));
    expect(screen.getByText("pw-one")).toBeInTheDocument();
    fireEvent.click(within(card("Zoom")).getByTitle("Show password"));
    expect(screen.getByText("pw-two")).toBeInTheDocument();
    expect(screen.queryByText("pw-one")).not.toBeInTheDocument();
    fireEvent.click(within(card("Zoom")).getByTitle("Hide password"));
    expect(screen.queryByText("pw-two")).not.toBeInTheDocument();
  });

  it("copies the password without opening the editor", async () => {
    await renderVault([makeEntry("a", "GitHub", { password: "hunter2" })]);
    grid();
    await act(async () => {
      fireEvent.click(within(card("GitHub")).getByTitle("Copy Password"));
    });
    expect(mockWriteText).toHaveBeenCalledWith("hunter2");
    expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument();
  });

  it("pins and unpins a card", async () => {
    await renderVault([makeEntry("a", "GitHub", { is_pinned: true })]);
    grid();
    expect(card("GitHub")).toHaveClass("pinned");
    expect(card("GitHub").querySelector(".pinned-icon-corner")).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(card("GitHub")).getByTitle("Unpin"));
    });
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].is_pinned).toBe(false);
  });

  it("tells the user when a pin change could not be saved", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    grid();
    saveFailure = "disk full";
    await act(async () => {
      fireEvent.click(within(card("GitHub")).getByTitle("Pin"));
    });
    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(card("GitHub")).not.toHaveClass("pinned");
  });

  it("deletes a card after confirmation", async () => {
    await renderVault([makeEntry("a", "GitHub"), makeEntry("b", "Zoom")]);
    grid();
    fireEvent.click(within(card("GitHub")).getByTitle("Delete"));
    expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument();
    fireEvent.click(within(document.querySelector(".auth-card") as HTMLElement).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("GitHub")).not.toBeInTheDocument());
    expect(lastSaved().map((e) => e.id)).toEqual(["b"]);
  });

  it("opens the editor when a card is clicked, but not when its password area is", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    grid();
    fireEvent.click(card("GitHub").querySelector(".secret-pill") as HTMLElement);
    expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByText("Edit Entry")).toBeInTheDocument();
  });

  it("shows a 2FA code only on cards that have a key", async () => {
    await renderVault([makeEntry("a", "WithKey", { totp_secret: SECRET }), makeEntry("b", "NoKey")]);
    grid();
    expect(card("WithKey").querySelector(".secret-pill[title]")).not.toBeNull();
    expect(card("NoKey").querySelector(".secret-pill[title]")).toBeNull();
  });

  it("searches in grid view too", async () => {
    await renderVault([makeEntry("a", "GitHub"), makeEntry("b", "Zoom")]);
    grid();
    fireEvent.change(screen.getByPlaceholderText("Search Logins..."), { target: { value: "zoo" } });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.getByText("Zoom")).toBeInTheDocument();
  });
});

// ─── Copy ────────────────────────────────────────────────────────────────────

describe("VaultView - copying", () => {
  it("restarts the 30 second wipe on a second copy", async () => {
    jest.useFakeTimers();
    try {
      await renderVault([makeEntry("a", "GitHub")]);
      const copy = () => within(listRow("GitHub")).getByTitle("Copy Password");
      await act(async () => {
        fireEvent.click(copy());
      });
      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      await act(async () => {
        fireEvent.click(copy());
      });
      mockWriteText.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(29_999);
      });
      expect(mockWriteText).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(mockWriteText).toHaveBeenCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("tells the user when the clipboard refused, with no wipe scheduled", async () => {
    jest.useFakeTimers();
    try {
      mockWriteText.mockRejectedValue(new Error("denied"));
      await renderVault([makeEntry("a", "GitHub")]);
      await act(async () => {
        fireEvent.click(within(listRow("GitHub")).getByTitle("Copy Password"));
      });
      expect(screen.getByText(/Could not copy/)).toBeInTheDocument();
      expect(screen.queryByText(/Password copied/)).not.toBeInTheDocument();
      mockWriteText.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockWriteText).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("confirms the copy with a toast that can be dismissed", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    await act(async () => {
      fireEvent.click(within(listRow("GitHub")).getByTitle("Copy Password"));
    });
    expect(screen.getByText(/Password copied/).closest(".ui-toast")).toHaveClass("ui-toast--success");
    // Success is no longer a dialog, so there is no OK button to press.
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText(/Password copied/)).not.toBeInTheDocument();
  });
});

// ─── CSV import and export ───────────────────────────────────────────────────

describe("VaultView - CSV import details", () => {
  async function importCsv(text: string, entries: VaultEntry[] = []) {
    await renderVault(entries);
    fileContents = text;
    mockOpen.mockResolvedValue("C:\\in\\logins.csv");
    fireEvent.click(screen.getByTitle("Import CSV"));
  }

  it("reads files with Windows line endings", async () => {
    await importCsv("name,url,username,password\r\nAlpha,,al,pw1\r\nBeta,,be,pw2\r\n");
    await screen.findByText(/Successfully imported 2 passwords/);
    expect(lastSaved().map((e) => e.service).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("reads quoted fields with line breaks and doubled quotes", async () => {
    await importCsv('name,url,username,password,note\nAlpha,,al,pw1,"line one\nline ""two"""\n');
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0].notes).toBe('line one\nline "two"');
  });

  it("ignores the byte-order mark a spreadsheet adds at the start of a file", async () => {
    await importCsv("\uFEFFAlpha,,al,pw1\nBeta,,be,pw2\n");
    await screen.findByText(/Successfully imported 2 passwords/);
    expect(lastSaved().map((e) => e.service).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("treats a file without a header row as all data", async () => {
    await importCsv("Alpha,https://a.test,al,pw1,a note\nBeta,,be,pw2\n");
    await screen.findByText(/Successfully imported 2 passwords/);
    expect(lastSaved().find((e) => e.service === "Alpha")).toMatchObject({
      url: "https://a.test",
      username: "al",
      password: "pw1",
      notes: "a note",
    });
  });

  it("keeps the last text columns of a headerless file together as the note", async () => {
    await importCsv("Alpha,,al,pw1,one,two\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0].notes).toBe("one,two");
  });

  it("recognises the header whatever the capitalisation", async () => {
    await importCsv("Name,URL,UserName,Password\nAlpha,,al,pw1\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0].service).toBe("Alpha");
  });

  it("trims spaces around values", async () => {
    await importCsv("name,url,username,password\n  Alpha , , al ,  pw1  \n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0]).toMatchObject({ service: "Alpha", username: "al", password: "pw1" });
  });

  it("restores the 2FA key and the note from a file this app exported", async () => {
    const exported =
      "name,url,username,password,note,totp_secret\n" +
      `Alpha,https://a.test,al,pw1,my note,${SECRET}\n` +
      `Beta,,be,pw2,,${SECRET}\n`;
    await importCsv(exported);
    await screen.findByText(/Successfully imported 2 passwords/);
    const alpha = lastSaved().find((e) => e.service === "Alpha")!;
    const beta = lastSaved().find((e) => e.service === "Beta")!;
    expect(alpha).toMatchObject({ notes: "my note", totp_secret: SECRET });
    expect(beta).toMatchObject({ notes: "", totp_secret: SECRET });
  });

  it("cleans an imported 2FA key the same way the editor does", async () => {
    await importCsv("name,url,username,password,note,totp_secret\nAlpha,,al,pw1,,jbsw y3dp ehpk 3pxp\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0].totp_secret).toBe(SECRET);
  });

  it("leaves the 2FA key empty when the column is blank", async () => {
    await importCsv("name,url,username,password,note,totp_secret\nAlpha,,al,pw1,,\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0].totp_secret).toBeUndefined();
  });

  it("finds the columns by name when they are in another order", async () => {
    await importCsv("username,password,name,url\nal,pw1,Alpha,https://a.test\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0]).toMatchObject({
      service: "Alpha",
      username: "al",
      password: "pw1",
      url: "https://a.test",
    });
  });

  it("understands the column names other password managers use", async () => {
    await importCsv("title,website,login,login_password,notes,otp\nAlpha,https://a.test,al,pw1,hello," + SECRET + "\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0]).toMatchObject({
      service: "Alpha",
      url: "https://a.test",
      username: "al",
      password: "pw1",
      notes: "hello",
      totp_secret: SECRET,
    });
  });

  it("uses the first of two columns that mean the same thing", async () => {
    await importCsv("name,username,email,password\nAlpha,al,al@example.com,pw1\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0].username).toBe("al");
  });

  it("accepts a file with only a name and a password column", async () => {
    await importCsv("name,password\nAlpha,pw1\n");
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved()[0]).toMatchObject({ service: "Alpha", password: "pw1", username: "" });
  });

  it("counts every row it could not use, short ones included, but not blank lines", async () => {
    await importCsv(
      "name,url,username,password\n" +
        "Alpha,,al,pw1\n" +
        "\n" +
        "JustAName\n" +
        ",,al,pw3\n" +
        "NoPass,,al,\n",
    );
    expect(await screen.findByText(/Successfully imported 1 passwords\. \(3 rows skipped\)/)).toBeInTheDocument();
  });

  it("gives every imported login its own id, timestamps and the default colour", async () => {
    await importCsv("name,url,username,password\nAlpha,,al,pw1\nBeta,,be,pw2\n");
    await screen.findByText(/Successfully imported 2 passwords/);
    const [a, b] = lastSaved();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.created_at).toBeGreaterThan(1_600_000_000);
    expect(a.color).toBe("#555555");
    expect(a.is_pinned).toBe(false);
  });

  it("puts the imported logins ahead of the existing ones and keeps those", async () => {
    await importCsv("name,url,username,password\nAlpha,,al,pw1\n", [makeEntry("old", "Existing")]);
    await screen.findByText(/Successfully imported 1 passwords/);
    expect(lastSaved().map((e) => e.service)).toEqual(["Alpha", "Existing"]);
  });

  it("says so when the file is empty", async () => {
    await importCsv("");
    expect(await screen.findByText("No data found in the selected file.")).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("reports a file that cannot be read", async () => {
    await renderVault([]);
    mockOpen.mockResolvedValue("C:\\in\\x.csv");
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "read_text_file_content"
        ? Promise.reject("not valid UTF-8")
        : Promise.resolve({ entries: [] }),
    );
    fireEvent.click(screen.getByTitle("Import CSV"));
    expect(await screen.findByText(/Import failed: .*not valid UTF-8/)).toBeInTheDocument();
  });

  it("locks the import button while a file is being read", async () => {
    await renderVault([]);
    let release!: (v: string) => void;
    mockOpen.mockResolvedValue("C:\\in\\x.csv");
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "read_text_file_content"
        ? new Promise<string>((r) => {
            release = r;
          })
        : Promise.resolve({ entries: [] }),
    );
    fireEvent.click(screen.getByTitle("Import CSV"));
    await waitFor(() => expect(screen.getByTitle("Import CSV")).toBeDisabled());
    await act(async () => {
      release("");
    });
    await waitFor(() => expect(screen.getByTitle("Import CSV")).not.toBeDisabled());
  });
});

describe("VaultView - CSV export details", () => {
  it("exports nothing special for an empty vault, only the header", async () => {
    await renderVault([]);
    mockSave.mockResolvedValue("C:\\out\\p.csv");
    fireEvent.click(screen.getByTitle("Export CSV"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    await screen.findByText("Export Complete");
    const call = mockInvoke.mock.calls.find(([c]) => c === "write_text_file_content")!;
    expect(call[1].content).toBe("name,url,username,password,note,totp_secret\n\n");
  });

  it("proposes a file name and the CSV type", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    mockSave.mockResolvedValue("C:\\out\\p.csv");
    fireEvent.click(screen.getByTitle("Export CSV"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    await screen.findByText("Export Complete");
    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: "passwords_export.csv",
      filters: [{ name: "CSV File", extensions: ["csv"] }],
    });
  });

  it("tells the user when the file could not be written", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    mockSave.mockResolvedValue("C:\\out\\p.csv");
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "write_text_file_content"
        ? Promise.reject("disk full")
        : Promise.resolve({ entries: [makeEntry("a", "GitHub")] }),
    );
    fireEvent.click(screen.getByTitle("Export CSV"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    expect(await screen.findByText(/Export failed: .*disk full/)).toBeInTheDocument();
    expect(screen.queryByText("Export Complete")).not.toBeInTheDocument();
  });

  it("can be imported straight back, with nothing lost", async () => {
    const original = [
      makeEntry("a", "Acme, Inc", {
        url: "https://acme.test",
        username: 'user "x"',
        password: "p,w\nline",
        notes: "note, with comma",
        totp_secret: SECRET,
      }),
    ];
    await renderVault(original);
    mockSave.mockResolvedValue("C:\\out\\p.csv");
    fireEvent.click(screen.getByTitle("Export CSV"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    await screen.findByText("Export Complete");
    const written = mockInvoke.mock.calls.find(([c]) => c === "write_text_file_content")![1].content;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    fileContents = written;
    mockOpen.mockResolvedValue("C:\\out\\p.csv");
    fireEvent.click(screen.getByTitle("Import CSV"));
    await screen.findByText(/Successfully imported 1 passwords/);
    const imported = lastSaved().find((e) => e.id !== "a")!;
    expect(imported).toMatchObject({
      service: "Acme, Inc",
      url: "https://acme.test",
      username: 'user "x"',
      password: "p,w\nline",
      notes: "note, with comma",
      totp_secret: SECRET,
    });
  });

  it("closes the export confirmation", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    mockSave.mockResolvedValue("C:\\out\\p.csv");
    fireEvent.click(screen.getByTitle("Export CSV"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    await screen.findByText("Export Complete");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Export Complete")).not.toBeInTheDocument();
  });
});

// ─── Password generator ──────────────────────────────────────────────────────

describe("VaultView - generated passwords", () => {
  it("makes a different strong password each time", async () => {
    await renderVault([]);
    openNew();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByTitle("Generate Strong Password"));
      seen.add(field("Password").value);
    }
    expect(seen.size).toBe(20);
    for (const p of seen) {
      expect(p).toHaveLength(20);
      expect(p).toMatch(/^[A-Za-z0-9!@#$%^&*]+$/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[!@#$%^&*]/);
    }
  });

  it("does not submit anything when the generate button is pressed", async () => {
    await renderVault([]);
    openNew();
    fireEvent.click(screen.getByTitle("Generate Strong Password"));
    expect(savedVaults()).toHaveLength(0);
  });
});

// ─── Escape key ──────────────────────────────────────────────────────────────

describe("VaultView - Escape key", () => {
  const escape = () => fireEvent.keyDown(window, { key: "Escape" });

  it("closes the add/edit dialog without saving", async () => {
    await renderVault([]);
    openNew();
    fill(SERVICE, "Draft");

    escape();

    expect(screen.queryByPlaceholderText(SERVICE)).not.toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("closes the delete confirmation first and leaves the editor open", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByPlaceholderText(SERVICE)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Delete"));
    expect(screen.getByText("Delete Item")).toBeInTheDocument();

    escape();
    expect(screen.queryByText("Delete Item")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(SERVICE)).toBeInTheDocument();

    escape();
    expect(screen.queryByPlaceholderText(SERVICE)).not.toBeInTheDocument();
  });
});

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────

describe("VaultView - keyboard shortcuts", () => {
  const ctrl = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });

  it("Ctrl+N opens an empty editor", async () => {
    await renderVault([]);
    ctrl("n");
    expect(screen.getByPlaceholderText(SERVICE)).toHaveValue("");
  });

  it("Ctrl+F puts the cursor in the search box", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    ctrl("f");
    expect(screen.getByPlaceholderText("Search Logins...")).toHaveFocus();
  });

  it("Ctrl+S saves the open entry and closes the editor", async () => {
    await renderVault([]);
    ctrl("n");
    fill(SERVICE, "Shortcut Site");
    fill("Password", "s3cret-pass");
    ctrl("s");

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].service).toBe("Shortcut Site");
    expect(screen.queryByPlaceholderText(SERVICE)).not.toBeInTheDocument();
  });

  it("Ctrl+S with a missing service name shows the same error as the button", async () => {
    await renderVault([]);
    ctrl("n");
    ctrl("s");
    expect(await screen.findByText("Service name is required.")).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("Ctrl+S does nothing when no editor is open", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    ctrl("s");
    expect(savedVaults()).toHaveLength(0);
  });

  it("Ctrl+N does not open a second editor over a dialog", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByTitle("Delete"));
    expect(screen.getByText("Delete Item")).toBeInTheDocument();
    ctrl("n");
    expect(screen.queryByPlaceholderText(SERVICE)).not.toBeInTheDocument();
  });
});

// ─── Shared parts ────────────────────────────────────────────────────────────

describe("VaultView - editor drawer", () => {
  it("opens a new entry in a side drawer", async () => {
    await renderVault([]);
    openNew();
    expect(screen.getByRole("dialog", { name: "New Entry" })).toBe(editorCard());
  });

  it("opens an existing entry in the same drawer, called Edit Entry", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByRole("dialog", { name: "Edit Entry" })).toBe(editorCard());
  });

  it("keeps Cancel and Save together below the form, Save last", async () => {
    await renderVault([]);
    openNew();
    const foot = editorCard().querySelector(".ui-sheet__foot") as HTMLElement;
    expect(Array.from(foot.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
  });

  it("closes with Cancel and keeps nothing", async () => {
    await renderVault([]);
    openNew();
    fill(SERVICE, "Typed");
    fireEvent.click(within(editorCard()).getByRole("button", { name: "Cancel" }));
    expect(editorCard()).toBeNull();
    expect(savedVaults()).toHaveLength(0);
  });

  it("shows a validation message in an error banner inside the drawer", async () => {
    await renderVault([]);
    openNew();
    clickSave();
    const message = await screen.findByText("Service name is required.");
    expect(message.closest(".ui-banner")).toHaveClass("ui-banner--error");
    expect(editorCard()).toContainElement(message);
  });

  it("shows a failed save in an error banner and keeps what was typed", async () => {
    saveFailure = "disk full";
    await renderVault([]);
    openNew();
    fill(SERVICE, "Mail");
    fill("Password", "Sup3r-secret-Pass!");
    clickSave();
    const message = await screen.findByText(/Error saving: .*disk full/);
    expect(message.closest(".ui-banner")).toHaveClass("ui-banner--error");
    expect(field(SERVICE).value).toBe("Mail");
  });

  it("does not leave the Save button usable while a save is running", async () => {
    let release!: () => void;
    saveGate = new Promise<void>((r) => {
      release = r;
    });
    await renderVault([]);
    openNew();
    fill(SERVICE, "Mail");
    fill("Password", "Sup3r-secret-Pass!");
    clickSave();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    await act(async () => release());
  });

  it("uses the shared empty state when there are no passwords", async () => {
    await renderVault([]);
    expect(screen.getByText("No Passwords Yet").closest(".ui-empty")).toBeInTheDocument();
  });
});
