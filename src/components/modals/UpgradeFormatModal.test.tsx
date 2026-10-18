import { render, screen, fireEvent, waitFor, act } from "../../test-support/rtl";
import "@testing-library/jest-dom";
import { UpgradeFormatModal } from "./UpgradeFormatModal";
import type { BatchResult, OldFormatFile } from "../../types";

const mockInvoke = jest.fn();
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const FOLDER = "C:\\Users\\me\\Documents";
const FAR_FUTURE = 4_000_000_000; // the year 2096
const LONG_AGO = 1_000_000_000; // 2001

function file(name: string, version = 6, lockedUntil: number | null = null): OldFormatFile {
  return { path: `${FOLDER}\\${name}`, name, version, locked_until: lockedUntil };
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

let found: OldFormatFile[] | Error;

function setup(over: Partial<React.ComponentProps<typeof UpgradeFormatModal>> = {}) {
  const props = {
    folder: FOLDER,
    keyFile: null as string | null,
    onClose: jest.fn(),
    ...over,
    // Always a mock, so the tests can set what it answers.
    onRun: (over.onRun ?? jest.fn().mockResolvedValue([] as BatchResult[])) as jest.Mock,
  };
  const utils = render(<UpgradeFormatModal {...props} />);
  return { props, ...utils };
}

const scans = () => mockInvoke.mock.calls.filter(([c]) => c === "find_old_format_files").map(([, a]) => a);
const upgradeButton = () => screen.getByRole("button", { name: /^Upgrade \d+ files?$/ });

beforeEach(() => {
  jest.clearAllMocks();
  found = [file("a.pdf.qre"), file("b.docx.qre", 7)];
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "find_old_format_files") return found instanceof Error ? Promise.reject(found.message) : Promise.resolve(found);
    return Promise.resolve(null);
  });
});

describe("UpgradeFormatModal - looking", () => {
  it("scans the open folder, sub folders included, as soon as it opens", async () => {
    setup();
    expect(screen.getByText("Looking for older locked files…")).toBeInTheDocument();
    await screen.findByText("a.pdf.qre");
    expect(scans()).toEqual([{ folder: FOLDER, recursive: true }]);
  });

  it("explains why, in plain words", async () => {
    setup();
    await screen.findByText("a.pdf.qre");
    expect(screen.getByText(/show their file names to anyone who has them/)).toBeInTheDocument();
    expect(screen.getByText(/checked from start to finish, and only then replaces the old one/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is written to the disk in the clear/)).toBeInTheDocument();
  });

  it("says so when there is nothing to upgrade, and offers only Close", async () => {
    found = [];
    const { props } = setup();
    expect(await screen.findByText(/No locked files in an older format were found here/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Upgrade/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Close")); // the footer button; the corner X is labelled, not worded
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("counts the files and lists their names", async () => {
    setup();
    expect(await screen.findByText("2 locked files")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Older locked files" });
    expect(list).toHaveTextContent("a.pdf.qre");
    expect(list).toHaveTextContent("b.docx.qre");
  });

  it("uses the singular for one file", async () => {
    found = [file("only.qre")];
    setup();
    expect(await screen.findByText("1 locked file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade 1 file" })).toBeInTheDocument();
  });

  it("lists six names and says how many more there are", async () => {
    found = Array.from({ length: 9 }, (_, i) => file(`f${i}.qre`));
    setup();
    await screen.findByText("9 locked files");
    expect(screen.getByText("f5.qre")).toBeInTheDocument();
    expect(screen.queryByText("f6.qre")).not.toBeInTheDocument();
    expect(screen.getByText("and 3 more")).toBeInTheDocument();
  });

  it("shows the full path of a file as a tooltip", async () => {
    setup();
    expect((await screen.findByText("a.pdf.qre")).closest("li")).toHaveAttribute("title", `${FOLDER}\\a.pdf.qre`);
  });

  it("shows why the scan failed", async () => {
    found = new Error("Folder not found.");
    setup();
    expect(await screen.findByText("Folder not found.")).toBeInTheDocument();
    expect(screen.queryByText("Looking for older locked files…")).not.toBeInTheDocument();
  });
});

describe("UpgradeFormatModal - sub folders", () => {
  it("scans again without sub folders when the box is cleared, and with them when it is checked again", async () => {
    setup();
    await screen.findByText("a.pdf.qre");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include sub folders" }));
    await waitFor(() => expect(scans()).toHaveLength(2));
    expect(scans()[1]).toEqual({ folder: FOLDER, recursive: false });
    await screen.findByText("a.pdf.qre");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include sub folders" }));
    await waitFor(() => expect(scans()).toHaveLength(3));
    expect(scans()[2]).toEqual({ folder: FOLDER, recursive: true });
  });

  it("starts with the box checked", async () => {
    setup();
    await screen.findByText("a.pdf.qre");
    expect(screen.getByRole("checkbox", { name: "Include sub folders" })).toBeChecked();
  });

  it("ignores the answer of a scan that was replaced by a newer one", async () => {
    const first = deferred<OldFormatFile[]>();
    mockInvoke.mockImplementationOnce(() => first.promise);
    setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include sub folders" }));
    await screen.findByText("a.pdf.qre"); // the second scan's answer
    await act(async () => first.resolve([file("stale.qre")]));
    expect(screen.queryByText("stale.qre")).not.toBeInTheDocument();
  });
});

describe("UpgradeFormatModal - time-locked files", () => {
  it("marks a file whose lock has not ended, and leaves it out of the count", async () => {
    found = [file("a.qre"), file("locked.qre", 7, FAR_FUTURE)];
    setup();
    await screen.findByText("2 locked files");
    expect(screen.getByText(/locked\.qre \(time-locked, will be skipped\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade 1 file" })).toBeInTheDocument();
    expect(screen.getByText(/1 file is still time-locked/)).toBeInTheDocument();
  });

  it("treats a lock that has already ended as an ordinary file", async () => {
    found = [file("old-lock.qre", 7, LONG_AGO)];
    setup();
    await screen.findByText("1 locked file");
    expect(screen.queryByText(/time-locked, will be skipped/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade 1 file" })).toBeEnabled();
  });

  it("cannot be started when every file is still locked", async () => {
    found = [file("a.qre", 7, FAR_FUTURE), file("b.qre", 7, FAR_FUTURE)];
    setup();
    await screen.findByText("2 locked files");
    expect(screen.getByRole("button", { name: "Upgrade 0 files" })).toBeDisabled();
    expect(screen.getByText(/2 files are still time-locked/)).toBeInTheDocument();
  });
});

describe("UpgradeFormatModal - key file", () => {
  it("says the selected key file will be used", async () => {
    setup({ keyFile: "C:\\keys\\mine.key" });
    await screen.findByText("a.pdf.qre");
    expect(screen.getByText(/The key file you selected will be used/)).toBeInTheDocument();
  });

  it("tells the user to select one first when none is selected", async () => {
    setup();
    await screen.findByText("a.pdf.qre");
    expect(screen.getByText(/Select it in the options menu first/)).toBeInTheDocument();
  });
});

describe("UpgradeFormatModal - running", () => {
  const result = (name: string, message = "Upgraded to the current format"): BatchResult => ({ name, success: true, message });
  const failure = (name: string, message: string): BatchResult => ({ name, success: false, message });

  it("hands only the files that can be upgraded now to the upgrade", async () => {
    found = [file("a.qre"), file("locked.qre", 7, FAR_FUTURE), file("b.qre")];
    const { props } = setup();
    await screen.findByText("3 locked files");
    fireEvent.click(upgradeButton());
    await waitFor(() => expect(props.onRun).toHaveBeenCalledTimes(1));
    expect(props.onRun).toHaveBeenCalledWith([`${FOLDER}\\a.qre`, `${FOLDER}\\b.qre`]);
  });

  it("reports the files that were upgraded", async () => {
    const { props } = setup();
    props.onRun.mockResolvedValue([result("a.pdf.qre"), result("b.docx.qre")]);
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());
    expect(await screen.findByText(/2 files were upgraded to the current format/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the singular for one file", async () => {
    found = [file("a.qre")];
    const { props } = setup();
    props.onRun.mockResolvedValue([result("a.qre")]);
    await screen.findByText("1 locked file");
    fireEvent.click(upgradeButton());
    expect(await screen.findByText(/1 file was upgraded/)).toBeInTheDocument();
  });

  it("lists each file that was not upgraded, with the reason, and says it was left as it was", async () => {
    const { props } = setup();
    props.onRun.mockResolvedValue([result("a.pdf.qre"), failure("b.docx.qre", "Decryption Denied. Password or Keyfile is incorrect.")]);
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());
    expect(await screen.findByText(/1 file was not upgraded and left as they were/)).toBeInTheDocument();
    expect(screen.getByText(/b\.docx\.qre: Decryption Denied/)).toBeInTheDocument();
    expect(screen.getByText(/1 file was upgraded/)).toBeInTheDocument();
  });

  it("shows only the problems when nothing could be upgraded", async () => {
    const { props } = setup();
    props.onRun.mockResolvedValue([failure("a.pdf.qre", "Local Vault is locked."), failure("b.docx.qre", "Local Vault is locked.")]);
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());
    expect(await screen.findByText(/2 files were not upgraded/)).toBeInTheDocument();
    expect(screen.queryByText(/were upgraded to the current format/)).not.toBeInTheDocument();
  });

  it("says nothing needed to change when every file was already current", async () => {
    const { props } = setup();
    props.onRun.mockResolvedValue([result("a.pdf.qre", "Already in the current format")]);
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());
    expect(await screen.findByText("Nothing needed to change.")).toBeInTheDocument();
  });

  it("stays open with a message when the upgrade could not run, and can be tried again", async () => {
    const { props } = setup();
    props.onRun.mockResolvedValueOnce(null).mockResolvedValueOnce([result("a.pdf.qre"), result("b.docx.qre")]);
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());
    expect(await screen.findByText(/The upgrade could not run/)).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(upgradeButton());
    expect(await screen.findByText(/2 files were upgraded/)).toBeInTheDocument();
    expect(screen.queryByText(/The upgrade could not run/)).not.toBeInTheDocument();
  });

  it("cannot be closed or changed while it runs", async () => {
    const run = deferred<BatchResult[] | null>();
    const { props } = setup({ onRun: jest.fn().mockReturnValue(run.promise) });
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Include sub folders" })).toBeDisabled();
    expect(upgradeButton()).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();

    await act(async () => run.resolve([result("a.pdf.qre"), result("b.docx.qre")]));
    expect(await screen.findByText(/2 files were upgraded/)).toBeInTheDocument();
  });

  it("Cancel and Escape close it before anything is started", async () => {
    const { props } = setup();
    await screen.findByText("a.pdf.qre");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("changes nothing until the button is pressed", async () => {
    const { props } = setup();
    await screen.findByText("a.pdf.qre");
    expect(props.onRun).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.every(([c]) => c === "find_old_format_files")).toBe(true);
  });
});

describe("UpgradeFormatModal - a job the user stopped", () => {
  const result = (name: string): BatchResult => ({ name, success: true, message: "Upgraded to the current format" });
  const cancelledResult = (name: string): BatchResult => ({ name, success: false, message: "Cancelled. The old file was not changed." });

  async function runWith(answer: BatchResult[]) {
    const { props } = setup();
    props.onRun.mockResolvedValue(answer);
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());
  }

  it("says how many files were upgraded before the stop, and not that anything failed", async () => {
    await runWith([result("a.pdf.qre"), cancelledResult("b.docx.qre")]);
    expect(
      await screen.findByText("Cancelled. 1 file was upgraded before you stopped. The rest were left as they were."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not upgraded and left as/)).not.toBeInTheDocument();
    expect(screen.queryByText(/were upgraded to the current format/)).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing needed to change.")).not.toBeInTheDocument();
  });

  it("says nothing was changed when the stop came before any file was done", async () => {
    await runWith([cancelledResult("a.pdf.qre"), { name: "1 more file", success: false, message: "Cancelled. Not started." }]);
    expect(await screen.findByText("Cancelled. Nothing was changed.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needed to change.")).not.toBeInTheDocument();
  });

  it("still lists a real problem that happened before the stop", async () => {
    await runWith([
      { name: "a.pdf.qre", success: false, message: "Local Vault is locked." },
      cancelledResult("b.docx.qre"),
    ]);
    expect(await screen.findByText(/a\.pdf\.qre: Local Vault is locked\./)).toBeInTheDocument();
    expect(screen.getByText(/Cancelled\. Nothing was changed\./)).toBeInTheDocument();
    expect(screen.queryByText(/b\.docx\.qre: Cancelled/)).not.toBeInTheDocument();
  });

  it("can be closed with Done after a stop", async () => {
    const { props } = setup();
    props.onRun.mockResolvedValue([cancelledResult("a.pdf.qre")]);
    await screen.findByText("a.pdf.qre");
    fireEvent.click(upgradeButton());
    await screen.findByText("Cancelled. Nothing was changed.");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
