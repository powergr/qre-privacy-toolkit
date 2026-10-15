import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TimeLockModal } from "./TimeLockModal";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// 12:00 UTC is 08:00 in New York (jest.global-setup.js fixes the zone), so a mix-up between
// UTC and local time shows up as a 4 hour difference.
const NOW = new Date("2030-06-15T12:00:00Z");
const NOW_SECS = NOW.getTime() / 1000;
const FILE = "C:\\Users\\me\\Documents\\report.pdf";

function pad(n: number) {
  return String(n).padStart(2, "0");
}
/** What a <input type="datetime-local"> expects: the LOCAL date and time, minute precision. */
function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setup(filePath = FILE) {
  const props = { onClose: jest.fn(), onSuccess: jest.fn() };
  const utils = render(<TimeLockModal filePath={filePath} {...props} />);
  return { ...props, ...utils };
}

const customInput = () => screen.getByLabelText("Custom unlock date and time") as HTMLInputElement;
const lockButton = () => screen.getByRole("button", { name: /Lock File|Locking/ });
const preset = (label: string) => fireEvent.click(screen.getByRole("button", { name: label }));
const pickCustom = (v: string) => fireEvent.change(customInput(), { target: { value: v } });
const lockCalls = () => mockInvoke.mock.calls.filter(([c]) => c === "lock_file_with_timelock");

async function confirm() {
  await act(async () => {
    fireEvent.click(lockButton());
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW });
  mockInvoke.mockResolvedValue({ name: "report.pdf", success: true, message: "Time-locked for 1 day" });
});
afterEach(() => jest.useRealTimers());

describe("TimeLockModal - the test environment", () => {
  it("runs in a non-UTC time zone so UTC mix-ups can't hide", () => {
    expect(new Date(NOW).getTimezoneOffset()).not.toBe(0);
  });
});

describe("TimeLockModal - layout", () => {
  it("shows the file name for both kinds of path, with the full path as a tooltip", () => {
    setup(FILE);
    expect(screen.getByText("report.pdf")).toHaveAttribute("title", FILE);
  });

  it("shows the file name of a Unix path", () => {
    setup("/home/me/docs/report.pdf");
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("is an accessible dialog and takes focus", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
  });

  it("offers dates from one minute from now, in local time", () => {
    setup();
    const min = customInput().min;
    const max = customInput().max;
    expect(min).toBe(toLocalInput(new Date(NOW.getTime() + 60_000)));
    expect(max).toBe(toLocalInput(new Date(NOW.getTime() + 50 * 365 * 86400 * 1000)));
  });
});

describe("TimeLockModal - choosing a time", () => {
  it("cannot lock until a time is chosen", () => {
    setup();
    expect(lockButton()).toBeDisabled();
    expect(lockCalls()).toHaveLength(0);
  });

  it.each([
    ["1 Hour", 3600, "1 hour"],
    ["1 Day", 86400, "1 day"],
    ["1 Week", 7 * 86400, "7 days"],
    ["1 Month", 30 * 86400, "30 days"],
    ["1 Year", 365 * 86400, "365 days"],
  ])("%s locks for exactly that long and says so", async (label, secs, wording) => {
    const { onSuccess } = setup();
    preset(label);
    expect(screen.getByText(`Unlocks in ${wording}`)).toBeInTheDocument();
    await confirm();

    expect(lockCalls()[0][1]).toEqual({ filePath: FILE, unlockAt: NOW_SECS + secs, compressionMode: "auto" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("still words a preset the same way a second after it was chosen", () => {
    const { rerender, onClose, onSuccess } = setup();
    preset("1 Hour");
    act(() => {
      jest.setSystemTime(new Date(NOW.getTime() + 1000));
    });
    rerender(<TimeLockModal filePath={FILE} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText("Unlocks in 1 hour")).toBeInTheDocument();

    preset("1 Day");
    act(() => {
      jest.setSystemTime(new Date(NOW.getTime() + 2000));
    });
    rerender(<TimeLockModal filePath={FILE} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText("Unlocks in 1 day")).toBeInTheDocument();
  });

  it("shows the exact unlock date", () => {
    setup();
    preset("1 Day");
    const expected = new Date((NOW_SECS + 86400) * 1000).toLocaleString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("a custom date replaces the preset, and a preset replaces the custom date", () => {
    setup();
    preset("1 Week");
    pickCustom("2030-06-20T10:00");
    expect(screen.getByRole("button", { name: "1 Week" })).toHaveStyle({ background: "var(--bg-color, rgba(255,255,255,0.04))" });
    expect(customInput().value).toBe("2030-06-20T10:00");

    preset("1 Day");
    expect(customInput().value).toBe("");
  });

  it("treats a custom time as the user's local time", async () => {
    setup();
    pickCustom("2030-06-15T10:00"); // 10:00 New York, two hours after the frozen "now"
    expect(screen.getByText("Unlocks in 2 hours")).toBeInTheDocument();
    await confirm();
    expect(lockCalls()[0][1].unlockAt).toBe(NOW_SECS + 2 * 3600);
  });

  it("uses singular and plural wording", () => {
    setup();
    pickCustom("2030-06-15T08:01");
    expect(screen.getByText("Unlocks in 1 minute")).toBeInTheDocument();
    pickCustom("2030-06-15T08:31");
    expect(screen.getByText("Unlocks in 31 minutes")).toBeInTheDocument();
    pickCustom("2030-06-15T09:00");
    expect(screen.getByText("Unlocks in 1 hour")).toBeInTheDocument();
  });
});

describe("TimeLockModal - limits", () => {
  it("accepts a time exactly one minute away", async () => {
    setup();
    pickCustom("2030-06-15T08:01");
    await confirm();
    expect(lockCalls()).toHaveLength(1);
  });

  it("refuses a time that is not at least a minute away", async () => {
    setup();
    pickCustom("2030-06-15T08:00");
    await confirm();
    expect(screen.getByRole("alert")).toHaveTextContent("Unlock time must be at least 1 minute in the future.");
    expect(lockCalls()).toHaveLength(0);
  });

  it("refuses a time in the past", async () => {
    setup();
    pickCustom("2029-01-01T00:00");
    await confirm();
    expect(screen.getByRole("alert")).toHaveTextContent("at least 1 minute in the future");
    expect(lockCalls()).toHaveLength(0);
  });

  it("refuses a time more than 50 years away, and accepts one just inside", async () => {
    setup();
    pickCustom("2080-06-10T08:00");
    await confirm();
    expect(screen.getByRole("alert")).toHaveTextContent("Unlock time cannot exceed 50 years from now.");
    expect(lockCalls()).toHaveLength(0);

    pickCustom("2080-06-01T08:00");
    await confirm();
    expect(lockCalls()).toHaveLength(1);
  });

  it("clears an old error when a new choice is made", async () => {
    setup();
    pickCustom("2029-01-01T00:00");
    await confirm();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    preset("1 Day");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cannot lock after the custom date is cleared again", () => {
    setup();
    pickCustom("2030-06-20T10:00");
    expect(lockButton()).toBeEnabled();
    pickCustom("");
    expect(lockButton()).toBeDisabled();
    expect(screen.queryByText(/Unlocks in/)).not.toBeInTheDocument();
  });
});

describe("TimeLockModal - when the backend answers", () => {
  it("shows the backend's reason when it refuses", async () => {
    mockInvoke.mockResolvedValue({ name: "report.pdf", success: false, message: "Vault is locked. Unlock it first." });
    const { onSuccess } = setup();
    preset("1 Day");
    await confirm();

    expect(screen.getByRole("alert")).toHaveTextContent("Vault is locked. Unlock it first.");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(lockButton()).toBeEnabled();
  });

  it("shows a string error from a failed call", async () => {
    mockInvoke.mockRejectedValue("TIME_LOCKED: nope");
    setup();
    preset("1 Day");
    await confirm();
    expect(screen.getByRole("alert")).toHaveTextContent("TIME_LOCKED: nope");
  });

  it("shows a generic message for an unexpected error", async () => {
    mockInvoke.mockRejectedValue(new Error("secret internal detail"));
    setup();
    preset("1 Day");
    await confirm();
    expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred.");
    expect(screen.queryByText(/secret internal detail/)).not.toBeInTheDocument();
  });

  it("freezes the dialog while locking, then lets go", async () => {
    let finish!: (v: unknown) => void;
    mockInvoke.mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    const { onClose, onSuccess } = setup();
    preset("1 Day");
    await confirm();

    expect(screen.getByText("Locking…")).toBeInTheDocument();
    expect(lockButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1 Week" })).toBeDisabled();
    expect(customInput()).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector("div[style*='position: fixed']")!);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      finish({ name: "report.pdf", success: true, message: "done" });
    });
    expect(onSuccess).toHaveBeenCalledWith("done");
  });
});

describe("TimeLockModal - closing", () => {
  it("closes with Cancel, the X and Escape", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("ignores other keys", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a click outside the box but not inside it", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
