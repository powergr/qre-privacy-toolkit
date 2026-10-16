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

let saveFailure: string | null;
let fileContents: string;

function backend(entries: VaultEntry[]) {
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "load_password_vault":
        return Promise.resolve({ entries: entries.map((e) => ({ ...e })) });
      case "save_password_vault":
        return saveFailure ? Promise.reject(saveFailure) : Promise.resolve(null);
      case "read_text_file_content":
        return Promise.resolve(fileContents);
      case "generate_totp_code":
        return Promise.resolve(["123456", 20]);
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

function lastSaved(): VaultEntry[] {
  const all = savedVaults();
  return all[all.length - 1];
}

function row(service: string): HTMLElement {
  return screen.getByText(service).closest(".vault-list-row") as HTMLElement;
}

function fill(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}

function openNewEntry() {
  fireEvent.click(screen.getByRole("button", { name: "Add New" }));
}

beforeEach(() => {
  jest.clearAllMocks();
  saveFailure = null;
  fileContents = "";
  mockWriteText.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("VaultView - listing", () => {
  it("shows the empty state for a new vault", async () => {
    await renderVault([]);
    expect(screen.getByText("No Passwords Yet")).toBeInTheDocument();
    expect(screen.getByText("0 logins")).toBeInTheDocument();
  });

  it("lists logins with pinned ones first, then alphabetically", async () => {
    await renderVault([
      makeEntry("z", "Zoom"),
      makeEntry("a", "Amazon"),
      makeEntry("g", "GitHub", { is_pinned: true }),
    ]);
    const names = Array.from(document.querySelectorAll(".vault-list-row .list-info > div:first-child")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["GitHub", "Amazon", "Zoom"]);
    expect(screen.getByText("3 logins")).toBeInTheDocument();
    expect(screen.queryByText("No Passwords Yet")).not.toBeInTheDocument();
  });

  it("shows a 2FA badge only for entries that have a key", async () => {
    await renderVault([
      makeEntry("a", "WithTwoFA", { totp_secret: "JBSWY3DPEHPK3PXP" }),
      makeEntry("b", "Without"),
    ]);
    expect(within(row("WithTwoFA")).getByText("2FA")).toBeInTheDocument();
    expect(within(row("Without")).queryByText("2FA")).not.toBeInTheDocument();
  });

  it("filters by service, username or URL", async () => {
    await renderVault([
      makeEntry("a", "GitHub", { url: "https://github.com" }),
      makeEntry("b", "Bank", { username: "alice@bank.test" }),
      makeEntry("c", "Mail", { url: "https://mail.example.org" }),
    ]);
    const search = screen.getByPlaceholderText("Search Logins...");

    fireEvent.change(search, { target: { value: "git" } });
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("Bank")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "ALICE@" } });
    expect(screen.getByText("Bank")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "example.org" } });
    expect(screen.getByText("Mail")).toBeInTheDocument();
  });

  it("shows no rows, and not the empty-vault message, when a search matches nothing", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.change(screen.getByPlaceholderText("Search Logins..."), { target: { value: "zzz" } });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("No Passwords Yet")).not.toBeInTheDocument();
  });
});

describe("VaultView - adding and editing", () => {
  it("saves a new login with trimmed fields and shows it in the list", async () => {
    await renderVault([]);
    openNewEntry();
    expect(screen.getByText("New Entry")).toBeInTheDocument();

    fill("Service Name (e.g. Google)", "  Netflix  ");
    fill("Username / Email", "me@example.com");
    fill("Password", "  s3cret!  ");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByText("New Entry")).not.toBeInTheDocument());
    const saved = lastSaved();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      service: "Netflix",
      username: "me@example.com",
      password: "s3cret!",
      is_pinned: false,
    });
    expect(saved[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved[0].totp_secret).toBeUndefined();
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("1 logins")).toBeInTheDocument();
  });

  it("requires a service name", async () => {
    await renderVault([]);
    openNewEntry();
    fill("Password", "abc");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Service name is required.")).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
    expect(screen.getByText("New Entry")).toBeInTheDocument();
  });

  it("requires a non-blank password", async () => {
    await renderVault([]);
    openNewEntry();
    fill("Service Name (e.g. Google)", "Site");
    fill("Password", "    ");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Password must not be empty.")).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("cleans up the 2FA key before saving", async () => {
    await renderVault([]);
    openNewEntry();
    fill("Service Name (e.g. Google)", "Site");
    fill("Password", "pw");
    fill("2FA Authenticator Key (e.g. JBSWY3DP...)", "jbsw y3dp ehpk 3pxp");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].totp_secret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("generates a strong password into the field", async () => {
    await renderVault([]);
    openNewEntry();
    fireEvent.click(screen.getByTitle("Generate Strong Password"));

    const value = (screen.getByPlaceholderText("Password") as HTMLInputElement).value;
    expect(value).toHaveLength(20);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[0-9]/);
    expect(value).toMatch(/[!@#$%^&*]/);
  });

  it("edits an existing login and keeps its id and creation time", async () => {
    await renderVault([makeEntry("a", "GitHub", { created_at: 1_600_000_000 })]);
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByText("Edit Entry")).toBeInTheDocument();
    expect((screen.getByPlaceholderText("Service Name (e.g. Google)") as HTMLInputElement).value).toBe("GitHub");

    fill("Service Name (e.g. Google)", "GitHub Enterprise");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument());
    const saved = lastSaved();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "a", service: "GitHub Enterprise", created_at: 1_600_000_000 });
    expect(saved[0].updated_at).toBeGreaterThan(1_600_000_000);
    expect(screen.getByText("GitHub Enterprise")).toBeInTheDocument();
  });

  it("cancel closes the editor without saving", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByText("GitHub"));
    fill("Service Name (e.g. Google)", "Changed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Edit Entry")).not.toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("keeps the editor open and shows the error when saving fails", async () => {
    await renderVault([]);
    saveFailure = "disk full";
    openNewEntry();
    fill("Service Name (e.g. Google)", "Site");
    fill("Password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Error saving: .*disk full/)).toBeInTheDocument();
    expect(screen.getByText("New Entry")).toBeInTheDocument();
    expect(screen.queryByText("Site", { selector: ".list-info div" })).not.toBeInTheDocument();
  });
});

describe("VaultView - deleting", () => {
  // The confirmation dialog has its own Delete button; the rows have Delete icons too.
  function confirmDelete() {
    const dialog = screen.getByText("Delete Item").closest(".auth-card") as HTMLElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  }

  function clickDelete(service: string) {
    fireEvent.click(row(service).querySelector(".icon-btn-ghost.danger") as HTMLElement);
  }

  it("asks for confirmation and keeps the login if cancelled", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    clickDelete("GitHub");
    expect(screen.getByText("Delete Item")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Delete Item")).not.toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("deletes the login and saves the shorter vault when confirmed", async () => {
    await renderVault([makeEntry("a", "GitHub"), makeEntry("b", "Bank")]);
    clickDelete("GitHub");
    confirmDelete();

    await waitFor(() => expect(screen.queryByText("GitHub")).not.toBeInTheDocument());
    expect(lastSaved().map((e) => e.id)).toEqual(["b"]);
    expect(screen.getByText("Bank")).toBeInTheDocument();
  });

  it("tells the user when a delete could not be saved", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    saveFailure = "disk full";
    clickDelete("GitHub");
    confirmDelete();

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    // The login was not removed, because the vault was never written.
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });
});

describe("VaultView - copy password", () => {
  it("copies the password, says so, and clears the clipboard after 30 seconds", async () => {
    jest.useFakeTimers();
    try {
      await renderVault([makeEntry("a", "GitHub", { password: "hunter2" })]);
      await act(async () => {
        fireEvent.click(within(row("GitHub")).getByTitle("Copy Password"));
      });

      expect(mockWriteText).toHaveBeenCalledWith("hunter2");
      expect(screen.getByText(/Password copied/)).toBeInTheDocument();

      await act(async () => {
        jest.advanceTimersByTime(29_000);
      });
      expect(mockWriteText).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("VaultView - clipboard wipe after leaving the screen", () => {
  it("still clears the clipboard 30 seconds after copying, even if the view is closed", async () => {
    jest.useFakeTimers();
    try {
      const { unmount } = await renderVault([makeEntry("a", "GitHub", { password: "hunter2" })]);
      await act(async () => {
        fireEvent.click(within(row("GitHub")).getByTitle("Copy Password"));
      });
      expect(mockWriteText).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });

      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("VaultView - grid view", () => {
  it("can pin a login and saves the change", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByTitle("Grid View"));

    const card = screen.getByText("GitHub").closest(".modern-card") as HTMLElement;
    const [pinBtn] = card.querySelectorAll(".card-actions .icon-btn-ghost");
    await act(async () => {
      fireEvent.click(pinBtn);
    });

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0]).toMatchObject({ id: "a", is_pinned: true });
  });

  it("hides the password until the eye button is pressed", async () => {
    await renderVault([makeEntry("a", "GitHub", { password: "hunter2" })]);
    fireEvent.click(screen.getByTitle("Grid View"));

    expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
    const pill = document.querySelector(".secret-pill") as HTMLElement;
    fireEvent.click(pill.querySelectorAll("button")[0]);
    expect(screen.getByText("hunter2")).toBeInTheDocument();
  });
});

describe("VaultView - CSV export", () => {
  it("warns first and does nothing if the user backs out", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    fireEvent.click(screen.getByTitle("Export CSV"));
    expect(screen.getByText("Unencrypted Export")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.queryByText("Unencrypted Export")).not.toBeInTheDocument();
  });

  it("writes a CSV with quoting and a header after confirmation", async () => {
    await renderVault([
      makeEntry("a", "Acme, Inc", { url: "https://acme.test", notes: 'said "hi"', totp_secret: "JBSWY3DPEHPK3PXP" }),
    ]);
    mockSave.mockResolvedValue("C:\\out\\passwords_export.csv");
    fireEvent.click(screen.getByTitle("Export CSV"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));

    await screen.findByText("Export Complete");
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "write_text_file_content")!;
    expect(call[1]).toEqual({
      path: "C:\\out\\passwords_export.csv",
      content:
        "name,url,username,password,note,totp_secret\n" +
        '"Acme, Inc",https://acme.test,a@example.com,pw-a,"said ""hi""",JBSWY3DPEHPK3PXP\n',
    });
  });

  it("writes nothing if the save dialog is cancelled", async () => {
    await renderVault([makeEntry("a", "GitHub")]);
    mockSave.mockResolvedValue(null);
    fireEvent.click(screen.getByTitle("Export CSV"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));

    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "write_text_file_content")).toBe(false);
  });
});

describe("VaultView - CSV import", () => {
  const csv =
    "name,url,username,password,note\n" +
    "Alpha,https://a.test,alice,pw1,first note\n" +
    "NoPassword,https://b.test,bob,,\n" +
    '"Gamma, Ltd",,carol,pw3,"line, with comma"\n';

  it("imports valid rows, skips incomplete ones and reports both", async () => {
    await renderVault([makeEntry("old", "Existing")]);
    fileContents = csv;
    mockOpen.mockResolvedValue("C:\\in\\logins.csv");
    fireEvent.click(screen.getByTitle("Import CSV"));

    expect(await screen.findByText(/Successfully imported 2 passwords\. \(1 rows skipped\)/)).toBeInTheDocument();
    const saved = lastSaved();
    expect(saved.map((e) => e.service).sort()).toEqual(["Alpha", "Existing", "Gamma, Ltd"]);
    expect(saved.find((e) => e.service === "Gamma, Ltd")).toMatchObject({
      username: "carol",
      password: "pw3",
      notes: "line, with comma",
    });
  });

  it("does nothing when the file picker is cancelled", async () => {
    await renderVault([]);
    mockOpen.mockResolvedValue(null);
    fireEvent.click(screen.getByTitle("Import CSV"));

    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(savedVaults()).toHaveLength(0);
  });

  it("explains when a file has no usable rows", async () => {
    await renderVault([]);
    fileContents = "name,url,username,password\nOnlyName,,,\n";
    mockOpen.mockResolvedValue("C:\\in\\empty.csv");
    fireEvent.click(screen.getByTitle("Import CSV"));

    expect(await screen.findByText(/No valid entries found/)).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("does not claim success when the imported logins could not be saved", async () => {
    await renderVault([]);
    saveFailure = "disk full";
    fileContents = csv;
    mockOpen.mockResolvedValue("C:\\in\\logins.csv");
    fireEvent.click(screen.getByTitle("Import CSV"));

    await waitFor(() => expect(savedVaults().length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK" })).toBeInTheDocument());
    expect(screen.queryByText(/Successfully imported/)).not.toBeInTheDocument();
  });
});
