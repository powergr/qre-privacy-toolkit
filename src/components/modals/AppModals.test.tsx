import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  InfoModal,
  BackupModal,
  BackupReminderModal,
  ErrorModal,
  ProcessingModal,
  ThemeModal,
  EntryDeleteModal,
  DeleteConfirmModal,
  CompressionModal,
  AboutModal,
  ResetConfirmModal,
  ChangePassModal,
  ExportSuccessModal,
  TimeoutWarningModal,
  ExportWarningModal,
  DriveInitModal,
  DriveInitSuccessModal,
  DriveUnlockModal,
} from "./AppModals";
// @ts-ignore - same direct import the About dialog uses for its version
import pkg from "../../../package.json";

const mockOpenUrl = jest.fn();
const mockInvoke = jest.fn();
const mockClipboardWrite = jest.fn();

jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const overlay = () => document.querySelector(".modal-overlay") as HTMLElement;
const clickX = () => fireEvent.click(document.querySelector("svg.lucide-x")!);

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoke.mockResolvedValue("generated-passphrase");
  mockClipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockClipboardWrite },
    configurable: true,
  });
});

describe("InfoModal", () => {
  it("shows a success message and closes with OK, the X, Enter or Escape", () => {
    const onClose = jest.fn();
    render(<InfoModal message="All done" onClose={onClose} />);
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("All done")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    clickX();
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("shows an error style when asked", () => {
    render(<InfoModal message="Broke" type="error" onClose={jest.fn()} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByText("Success")).not.toBeInTheDocument();
  });

  it("ignores other keys and stops listening once closed", () => {
    const onClose = jest.fn();
    const { unmount } = render(<InfoModal message="x" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    unmount();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("simple confirmations", () => {
  it("BackupModal exports on Save Backup and cancels three ways", () => {
    const onProceed = jest.fn();
    const onCancel = jest.fn();
    render(<BackupModal onProceed={onProceed} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Backup..." }));
    expect(onProceed).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    clickX();
    fireEvent.click(overlay());
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("BackupReminderModal offers Backup Now or Later, and cannot be dismissed by clicking outside", () => {
    const onBackup = jest.fn();
    const onCancel = jest.fn();
    render(<BackupReminderModal onBackup={onBackup} onCancel={onCancel} />);
    fireEvent.click(overlay());
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Backup Now" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onBackup).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ErrorModal shows the message and closes from Close, the X and a click outside", () => {
    const onClose = jest.fn();
    render(<ErrorModal message={"Line one\nLine two"} onClose={onClose} />);
    expect(screen.getByText(/Line one/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    clickX();
    fireEvent.click(overlay());
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("EntryDeleteModal names the item and confirms or cancels", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(<EntryDeleteModal title="My Bank" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText('"My Bank"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(overlay());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("ResetConfirmModal confirms or cancels", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(<ResetConfirmModal onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ExportWarningModal describes what is exported and asks to confirm", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { rerender } = render(<ExportWarningModal onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText("data")).toBeInTheDocument();
    rerender(<ExportWarningModal type="note" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText("note")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(overlay());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("ExportSuccessModal shows the path with a warning that the file is not encrypted", () => {
    const onClose = jest.fn();
    render(<ExportSuccessModal filePath="C:\out\passwords.csv" onClose={onClose} />);
    expect(screen.getByText("C:\\out\\passwords.csv")).toBeInTheDocument();
    expect(screen.getByText(/not encrypted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    clickX();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("progress and timeout", () => {
  it("ProcessingModal shows the status and a matching progress bar", () => {
    render(<ProcessingModal status="Encrypting: a.txt" percentage={42} />);
    expect(screen.getByText("Encrypting: a.txt")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(document.querySelector(".progress-fill")).toHaveStyle({ width: "42%" });
  });

  it("TimeoutWarningModal counts down and lets the user stay", () => {
    const onStay = jest.fn();
    const { rerender } = render(<TimeoutWarningModal seconds={42} onStay={onStay} />);
    expect(screen.getByText("42")).toBeInTheDocument();
    rerender(<TimeoutWarningModal seconds={41} onStay={onStay} />);
    expect(screen.getByText("41")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I'm still here" }));
    expect(onStay).toHaveBeenCalledTimes(1);
  });
});

describe("choosers", () => {
  it("ThemeModal saves the chosen theme", () => {
    const onSave = jest.fn();
    render(<ThemeModal currentTheme="system" onSave={onSave} onCancel={jest.fn()} />);
    fireEvent.click(screen.getByText("Dark Mode"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("dark");
  });

  it("ThemeModal keeps the current theme if nothing is changed, and highlights it", () => {
    const onSave = jest.fn();
    render(<ThemeModal currentTheme="light" onSave={onSave} onCancel={jest.fn()} />);
    expect(screen.getByText("Light Mode")).toHaveStyle({ fontWeight: "bold" });
    expect(screen.getByText("Dark Mode")).toHaveStyle({ fontWeight: "normal" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("light");
  });

  it("ThemeModal cancels from Cancel, the X and a click outside, without saving", () => {
    const onSave = jest.fn();
    const onCancel = jest.fn();
    render(<ThemeModal currentTheme="system" onSave={onSave} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Light Mode"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    clickX();
    fireEvent.click(overlay());
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([
    ["Extreme (Slow)", "extreme"],
    ["Store (None)", "store"],
    ["Auto (Smart)", "auto"],
  ])("CompressionModal saves %s as %s", (label, id) => {
    const onSave = jest.fn();
    render(<CompressionModal current="auto" onSave={onSave} onCancel={jest.fn()} />);
    fireEvent.click(screen.getByText(label));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(id);
  });

  it("CompressionModal keeps the current mode if nothing is changed", () => {
    const onSave = jest.fn();
    render(<CompressionModal current="store" onSave={onSave} onCancel={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("store");
  });
});

describe("DeleteConfirmModal", () => {
  function setup(items: string[]) {
    const props = { onTrash: jest.fn(), onShred: jest.fn(), onCancel: jest.fn() };
    render(<DeleteConfirmModal items={items} {...props} />);
    return props;
  }

  it("names a single item by its file name, for either kind of path", () => {
    setup(["C:\\Users\\me\\report.pdf"]);
    expect(screen.getByRole("heading", { name: "Delete Item" })).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("names a Unix path by its file name too", () => {
    setup(["/home/me/report.pdf"]);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("counts several items", () => {
    setup(["/a", "/b", "/c"]);
    expect(screen.getByRole("heading", { name: "Delete Items" })).toBeInTheDocument();
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("offers trash, secure shred and cancel as separate choices", () => {
    const props = setup(["/a"]);
    fireEvent.click(screen.getByRole("button", { name: /Move to Trash/ }));
    expect(props.onTrash).toHaveBeenCalledTimes(1);
    expect(props.onShred).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Secure Shred/ }));
    expect(props.onShred).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(overlay());
    expect(props.onCancel).toHaveBeenCalledTimes(2);
    expect(props.onTrash).toHaveBeenCalledTimes(1);
  });
});

describe("AboutModal", () => {
  it("shows the version from package.json", () => {
    render(<AboutModal onClose={jest.fn()} />);
    expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument();
  });

  it("opens the project links in the browser", () => {
    render(<AboutModal onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Source Code/ }));
    expect(mockOpenUrl).toHaveBeenLastCalledWith("https://github.com/powergr/QRE-Privacy-Toolkit");
    fireEvent.click(screen.getByText("Project QRE"));
    expect(mockOpenUrl).toHaveBeenLastCalledWith("https://powergr.github.io/privacy_toolkit/");
  });

  it("closes from Close and from a click outside, but not from a click inside", () => {
    const onClose = jest.fn();
    render(<AboutModal onClose={onClose} />);
    fireEvent.click(screen.getByText("QRE Privacy Toolkit"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(overlay());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("ChangePassModal", () => {
  function setup(error?: string) {
    const props = {
      currentPass: "",
      setCurrentPass: jest.fn(),
      pass: "",
      setPass: jest.fn(),
      confirm: "",
      setConfirm: jest.fn(),
      onUpdate: jest.fn(),
      onCancel: jest.fn(),
      error,
    };
    render(<ChangePassModal {...props} />);
    return props;
  }

  it("sends each field to its own setter", () => {
    const p = setup();
    fireEvent.change(screen.getByPlaceholderText("Current Password"), { target: { value: "old" } });
    fireEvent.change(screen.getByPlaceholderText("New Password"), { target: { value: "new" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm New Password"), { target: { value: "new2" } });
    expect(p.setCurrentPass).toHaveBeenCalledWith("old");
    expect(p.setPass).toHaveBeenCalledWith("new");
    expect(p.setConfirm).toHaveBeenCalledWith("new2");
  });

  it("updates or cancels", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onUpdate).toHaveBeenCalledTimes(1);
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a failure inline", () => {
    setup("Current password is incorrect.");
    expect(screen.getByText(/Password change failed: Current password is incorrect\./)).toBeInTheDocument();
  });

  it("shows no failure text when there is no error", () => {
    setup();
    expect(screen.queryByText(/Password change failed/)).not.toBeInTheDocument();
  });
});

describe("portable drive dialogs", () => {
  it("DriveInitModal shows the drive, the three security levels, and passes choices through", () => {
    const props = {
      password: "",
      setPassword: jest.fn(),
      confirm: "",
      setConfirm: jest.fn(),
      tier: "Standard" as const,
      setTier: jest.fn(),
      onInit: jest.fn(),
      onCancel: jest.fn(),
    };
    render(<DriveInitModal driveName="USB (E:)" {...props} />);
    expect(screen.getByText("USB (E:)")).toBeInTheDocument();

    fireEvent.click(screen.getByText("High"));
    fireEvent.click(screen.getByText("Paranoid"));
    expect(props.setTier.mock.calls.map(([t]) => t)).toEqual(["High", "Paranoid"]);

    fireEvent.change(screen.getByPlaceholderText("Vault Password"), { target: { value: "pw" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm Password"), { target: { value: "pw2" } });
    expect(props.setPassword).toHaveBeenCalledWith("pw");
    expect(props.setConfirm).toHaveBeenCalledWith("pw2");

    fireEvent.click(screen.getByRole("button", { name: "Format Drive" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    clickX();
    expect(props.onInit).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it("DriveInitModal shows an error from the caller", () => {
    render(
      <DriveInitModal
        driveName="USB"
        password=""
        setPassword={jest.fn()}
        confirm=""
        setConfirm={jest.fn()}
        tier="Standard"
        setTier={jest.fn()}
        onInit={jest.fn()}
        onCancel={jest.fn()}
        error="Passwords do not match."
      />,
    );
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
  });

  function unlockProps(overrides: Record<string, unknown> = {}) {
    return {
      driveName: "USB (E:)",
      vaultUuid: "1234-abcd",
      password: "",
      setPassword: jest.fn(),
      onUnlock: jest.fn(),
      onCancel: jest.fn(),
      showTrustedWarning: false,
      onAcknowledgeWarning: jest.fn(),
      ...overrides,
    };
  }

  it("DriveUnlockModal first asks the user to confirm the computer is trusted", () => {
    const props = unlockProps({ showTrustedWarning: true });
    render(<DriveUnlockModal {...props} />);
    expect(screen.getByText("Trusted Computer Only")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Vault Password")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "This is my trusted device" }));
    expect(props.onAcknowledgeWarning).toHaveBeenCalledTimes(1);
    expect(props.onUnlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("DriveUnlockModal shows the vault UUID to check, then takes the password", () => {
    const props = unlockProps();
    render(<DriveUnlockModal {...props} />);
    expect(screen.getByText("1234-abcd")).toBeInTheDocument();
    expect(screen.getByText(/Verify this matches your written record/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Vault Password"), { target: { value: "secret" } });
    expect(props.setPassword).toHaveBeenCalledWith("secret");
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(props.onUnlock).toHaveBeenCalledTimes(1);
  });

  it("DriveUnlockModal copes with a drive that has no UUID and shows errors", () => {
    render(<DriveUnlockModal {...unlockProps({ vaultUuid: undefined, error: "Incorrect password" })} />);
    expect(screen.queryByText(/Vault UUID/)).not.toBeInTheDocument();
    expect(screen.getByText("Incorrect password")).toBeInTheDocument();
  });

  it("DriveUnlockModal cancels from Cancel and the X", () => {
    const props = unlockProps();
    render(<DriveUnlockModal {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    clickX();
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("DriveInitSuccessModal", () => {
  const CODE = "ABCD-EFGH-IJKL-MNOP";
  const UUID = "11111111-2222-3333-4444-555555555555";

  function setup() {
    const onClose = jest.fn();
    const utils = render(<DriveInitSuccessModal recoveryCode={CODE} vaultUuid={UUID} onClose={onClose} />);
    return { onClose, ...utils };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("shows both values and a once-only warning", () => {
    setup();
    expect(screen.getByText(CODE)).toBeInTheDocument();
    expect(screen.getByText(UUID)).toBeInTheDocument();
    expect(screen.getByText(/These are shown once/)).toBeInTheDocument();
  });

  it("copies each value and briefly shows a tick", async () => {
    setup();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy recovery code"));
    });
    expect(mockClipboardWrite).toHaveBeenLastCalledWith(CODE);
    expect(screen.getByTitle("Copy recovery code").querySelector("svg")!.getAttribute("class")).toMatch(/check/);
    expect(screen.getByTitle("Copy vault UUID").querySelector("svg")!.getAttribute("class")).not.toMatch(/check/);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByTitle("Copy recovery code").querySelector("svg")!.getAttribute("class")).not.toMatch(/check/);

    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy vault UUID"));
    });
    expect(mockClipboardWrite).toHaveBeenLastCalledWith(UUID);
  });

  it("shows no tick if the clipboard is unavailable", async () => {
    mockClipboardWrite.mockRejectedValue(new Error("denied"));
    setup();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy recovery code"));
    });
    expect(screen.getByTitle("Copy recovery code").querySelector("svg")!.getAttribute("class")).not.toMatch(/check/);
  });

  it("wipes the clipboard 30 seconds after the recovery code was copied", async () => {
    setup();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy recovery code"));
    });
    act(() => {
      jest.advanceTimersByTime(29_999);
    });
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(mockClipboardWrite).toHaveBeenLastCalledWith("");
  });

  it("restarts the 30 second window when something is copied again", async () => {
    setup();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy recovery code"));
    });
    act(() => {
      jest.advanceTimersByTime(20_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy vault UUID"));
    });
    act(() => {
      jest.advanceTimersByTime(20_000);
    });
    expect(mockClipboardWrite).not.toHaveBeenCalledWith("");
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockClipboardWrite).toHaveBeenLastCalledWith("");
  });

  it("still wipes the clipboard if the dialog is closed first", async () => {
    const { unmount } = setup();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy recovery code"));
    });
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(mockClipboardWrite).toHaveBeenLastCalledWith("");
  });

  it("continues only when the user says both values are saved", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /I have saved both/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
