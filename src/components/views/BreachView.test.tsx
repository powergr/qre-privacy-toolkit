import "../../test-support/webCrypto";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BreachView } from "./BreachView";

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockOpen = jest.fn();
const mockOpenUrl = jest.fn();
const mockClipboardWrite = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));
jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));

interface Finding {
  filename: string;
  path: string;
  category: string;
}

let progress: (e: { payload: string }) => void;
let unlisteners: jest.Mock[];
let scanImpl: (dir: string) => Promise<Finding[]>;
let breachImpl: (hash: string) => Promise<{ found: boolean; count: number }>;
let ipImpl: () => Promise<{ ip: string; is_warp: boolean; service_used: string }>;

function backend() {
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "scan_local_secrets":
        return scanImpl(args.dirPath as string);
      case "check_password_breach":
        return breachImpl(args.sha1Hash as string);
      case "get_public_ip_address":
        return ipImpl();
      default:
        return Promise.resolve(null);
    }
  });
}

const tab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const calls = (cmd: string) => mockInvoke.mock.calls.filter(([c]) => c === cmd);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function startScan(folder = "C:\\Users\\me\\Documents") {
  mockOpen.mockResolvedValueOnce(folder);
  fireEvent.click(screen.getByRole("button", { name: "Select Folder to Scan" }));
}

beforeEach(() => {
  jest.clearAllMocks();
  unlisteners = [];
  mockListen.mockImplementation((_event: string, handler: typeof progress) => {
    progress = handler;
    const un = jest.fn();
    unlisteners.push(un);
    return Promise.resolve(un);
  });
  scanImpl = () => Promise.resolve([]);
  breachImpl = () => Promise.resolve({ found: false, count: 0 });
  ipImpl = () => Promise.resolve({ ip: "203.0.113.7", is_warp: false, service_used: "ipify" });
  mockOpenUrl.mockResolvedValue(undefined);
  mockClipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockClipboardWrite },
    configurable: true,
  });
  backend();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("BreachView - local secret scanner", () => {
  it("starts with the scanner tab and an invitation to pick a folder", () => {
    render(<BreachView />);
    expect(screen.getByText("Scan for Exposed Secrets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Folder to Scan" })).toBeInTheDocument();
  });

  it("does nothing if the folder picker is cancelled", async () => {
    render(<BreachView />);
    mockOpen.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Select Folder to Scan" }));
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(calls("scan_local_secrets")).toHaveLength(0);
    expect(screen.getByText("Scan for Exposed Secrets")).toBeInTheDocument();
  });

  it("lists what the scan found", async () => {
    scanImpl = () =>
      Promise.resolve([
        { filename: "passwords.txt", path: "C:\\docs\\passwords.txt", category: "Password" },
        { filename: ".env", path: "C:\\docs\\app\\.env", category: "API Key" },
      ]);
    render(<BreachView />);
    await startScan();

    expect(await screen.findByText("2 Exposed Secrets Found")).toBeInTheDocument();
    expect(screen.getByText("passwords.txt")).toBeInTheDocument();
    expect(screen.getByText("C:\\docs\\app\\.env")).toBeInTheDocument();
    expect(screen.getByText("API Key")).toBeInTheDocument();
    expect(calls("scan_local_secrets")[0][1]).toEqual({ dirPath: "C:\\Users\\me\\Documents" });
  });

  it("reports a clean folder", async () => {
    render(<BreachView />);
    await startScan();
    expect(await screen.findByText("No secrets exposed!")).toBeInTheDocument();
    expect(screen.getByText("Your local files are clean.")).toBeInTheDocument();
  });

  it("shows live progress with long paths shortened, then stops listening", async () => {
    const pending = deferred<Finding[]>();
    scanImpl = () => pending.promise;
    render(<BreachView />);
    await startScan();

    expect(await screen.findByText("Scanning local files...")).toBeInTheDocument();
    const longPath = "C:\\" + "deep\\".repeat(20) + "file.txt";
    act(() => progress({ payload: longPath }));
    expect(screen.getByText(`> ...${longPath.slice(-47)}`)).toBeInTheDocument();
    act(() => progress({ payload: "C:\\short.txt" }));
    expect(screen.getByText("> C:\\short.txt")).toBeInTheDocument();

    await act(async () => {
      pending.resolve([]);
    });
    await screen.findByText("No secrets exposed!");
    expect(unlisteners[0]).toHaveBeenCalledTimes(1);
  });

  it("lets the user scan again", async () => {
    render(<BreachView />);
    await startScan();
    await screen.findByText("No secrets exposed!");
    fireEvent.click(screen.getByRole("button", { name: "Scan Again" }));
    expect(screen.getByText("Scan for Exposed Secrets")).toBeInTheDocument();
  });

  it("explains an access problem without exposing the raw backend error", async () => {
    scanImpl = () => Promise.reject("Permission denied: C:\\Windows\\secret");
    render(<BreachView />);
    await startScan("C:\\Windows");
    expect(await screen.findByText(/Access denied: the selected folder contains protected system files/)).toBeInTheDocument();
    expect(screen.queryByText(/C:\\Windows\\secret/)).not.toBeInTheDocument();
  });

  it("gives a generic message for any other failure", async () => {
    scanImpl = () => Promise.reject("internal error at scanner.rs:88");
    render(<BreachView />);
    await startScan();
    expect(await screen.findByText(/Scan failed\. Please try a different folder\./)).toBeInTheDocument();
    expect(screen.queryByText(/scanner\.rs/)).not.toBeInTheDocument();
  });

  it("cancels a running scan and ignores its late results", async () => {
    const pending = deferred<Finding[]>();
    scanImpl = () => pending.promise;
    render(<BreachView />);
    await startScan();
    fireEvent.click(await screen.findByRole("button", { name: /Cancel Scan/ }));

    expect(await screen.findByText("Scan Cancelled")).toBeInTheDocument();
    expect(calls("cancel_secret_scan")).toHaveLength(1);
    expect(unlisteners[0]).toHaveBeenCalled();

    await act(async () => {
      pending.resolve([{ filename: "late.txt", path: "/late.txt", category: "Password" }]);
    });
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
    expect(screen.getByText("Scan Cancelled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Scan Again" }));
    expect(screen.getByText("Scan for Exposed Secrets")).toBeInTheDocument();
  });

  it("is not disturbed by a cancelled scan finishing after a new one started", async () => {
    const first = deferred<Finding[]>();
    const second = deferred<Finding[]>();
    scanImpl = (dir) => (dir === "/first" ? first.promise : second.promise);
    render(<BreachView />);

    await startScan("/first");
    fireEvent.click(await screen.findByRole("button", { name: /Cancel Scan/ }));
    await screen.findByText("Scan Cancelled");
    fireEvent.click(screen.getByRole("button", { name: "Scan Again" }));

    await startScan("/second");
    await screen.findByText("Scanning local files...");

    await act(async () => {
      first.resolve([{ filename: "from-first-folder.txt", path: "/first/x", category: "Password" }]);
    });

    expect(screen.queryByText("from-first-folder.txt")).not.toBeInTheDocument();
    expect(screen.getByText("Scanning local files...")).toBeInTheDocument();

    await act(async () => {
      second.resolve([{ filename: "from-second-folder.txt", path: "/second/y", category: "Password" }]);
    });
    expect(await screen.findByText("from-second-folder.txt")).toBeInTheDocument();
    expect(screen.queryByText("from-first-folder.txt")).not.toBeInTheDocument();
  });
});

describe("BreachView - password check", () => {
  // SHA-1 of "password", the standard test vector.
  const PASSWORD_SHA1 = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8";

  function openPasswordTab() {
    render(<BreachView />);
    tab("Password Breach");
    return screen.getByPlaceholderText("Enter password to verify...") as HTMLInputElement;
  }
  const type = (input: HTMLInputElement, v: string) => fireEvent.change(input, { target: { value: v } });
  const scanButton = () => screen.getByRole("button", { name: /Scan Password/ });

  it("disables the button until something is typed", () => {
    const input = openPasswordTab();
    expect(scanButton()).toBeDisabled();
    type(input, "x");
    expect(scanButton()).toBeEnabled();
  });

  it("sends only the uppercase SHA-1 of the trimmed password", async () => {
    const input = openPasswordTab();
    type(input, "  password  ");
    fireEvent.click(scanButton());

    expect(await screen.findByText(/CLEAN/)).toBeInTheDocument();
    expect(calls("check_password_breach")[0][1]).toEqual({ sha1Hash: PASSWORD_SHA1 });
    const sent = JSON.stringify(mockInvoke.mock.calls);
    expect(sent).not.toContain("password\"");
  });

  it("warns when the password has been breached, with the count", async () => {
    breachImpl = () => Promise.resolve({ found: true, count: 3861493 });
    const input = openPasswordTab();
    type(input, "password");
    fireEvent.click(scanButton());

    expect(await screen.findByText(/COMPROMISED/)).toBeInTheDocument();
    expect(screen.getByText("3,861,493")).toBeInTheDocument();
    expect(screen.getByText(/Do not use this password anywhere/)).toBeInTheDocument();
  });

  it("shows the strength of a clean password", async () => {
    const input = openPasswordTab();
    type(input, "abc");
    fireEvent.click(scanButton());
    await screen.findByText(/CLEAN/);
    expect(screen.getByText("Very Weak")).toBeInTheDocument();
    expect(screen.getByText(/Consider using a longer password/)).toBeInTheDocument();
  });

  it("reports a connection failure", async () => {
    breachImpl = () => Promise.reject("network unreachable");
    const input = openPasswordTab();
    type(input, "password");
    fireEvent.click(scanButton());
    expect(await screen.findByText(/Connection failed: .*network unreachable/)).toBeInTheDocument();
  });

  it("asks for a real password when only spaces were typed", async () => {
    const input = openPasswordTab();
    type(input, "   ");
    fireEvent.click(scanButton());
    expect(await screen.findByText("Please enter a password.")).toBeInTheDocument();
    expect(calls("check_password_breach")).toHaveLength(0);
  });

  it("refuses very long passwords", async () => {
    const input = openPasswordTab();
    type(input, "a".repeat(1001));
    fireEvent.click(scanButton());
    expect(await screen.findByText("Password is too long.")).toBeInTheDocument();
    expect(calls("check_password_breach")).toHaveLength(0);
  });

  it("makes the user wait two seconds between checks", async () => {
    jest.useFakeTimers();
    const input = openPasswordTab();
    type(input, "password");
    await act(async () => {
      fireEvent.click(scanButton());
    });
    expect(calls("check_password_breach")).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    type(input, "password2");
    await act(async () => {
      fireEvent.click(scanButton());
    });
    expect(screen.getByText("Please wait before checking again.")).toBeInTheDocument();
    expect(calls("check_password_breach")).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    type(input, "password3");
    await act(async () => {
      fireEvent.click(scanButton());
    });
    expect(calls("check_password_breach")).toHaveLength(2);
  });

  it("clears the typed password three seconds after a check by default", async () => {
    jest.useFakeTimers();
    const input = openPasswordTab();
    type(input, "password");
    await act(async () => {
      fireEvent.click(scanButton());
    });
    expect(input.value).toBe("password");

    await act(async () => {
      jest.advanceTimersByTime(2_999);
    });
    expect(input.value).toBe("password");
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(input.value).toBe("");
  });

  it("keeps the password if auto-clear is switched off", async () => {
    jest.useFakeTimers();
    const input = openPasswordTab();
    fireEvent.click(screen.getByLabelText(/Clear password 3 seconds after check/));
    type(input, "password");
    await act(async () => {
      fireEvent.click(scanButton());
    });
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(input.value).toBe("password");
  });

  it("forgets the previous verdict as soon as the password is edited", async () => {
    const input = openPasswordTab();
    type(input, "password");
    fireEvent.click(scanButton());
    await screen.findByText(/CLEAN/);
    type(input, "passwor");
    expect(screen.queryByText(/CLEAN/)).not.toBeInTheDocument();
  });
});

describe("BreachView - email check", () => {
  function openEmailTab() {
    render(<BreachView />);
    tab("Email Breach");
    return screen.getByPlaceholderText("name@example.com") as HTMLInputElement;
  }
  const checkButton = () => screen.getByRole("button", { name: /haveibeenpwned\.com/ });

  it("disables the button for an empty address", () => {
    openEmailTab();
    expect(checkButton()).toBeDisabled();
  });

  it.each(["not-an-email", "a@b", "a b@example.com", "@example.com"])("rejects %p", (bad) => {
    const input = openEmailTab();
    fireEvent.change(input, { target: { value: bad } });
    fireEvent.click(checkButton());
    expect(screen.getByText("Invalid email address format.")).toBeInTheDocument();
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("opens the lookup in the browser with the address encoded", () => {
    const input = openEmailTab();
    fireEvent.change(input, { target: { value: "  me+tag@example.com " } });
    fireEvent.click(checkButton());
    expect(mockOpenUrl).toHaveBeenCalledWith("https://haveibeenpwned.com/account/me%2Btag%40example.com");
    expect(screen.queryByText("Invalid email address format.")).not.toBeInTheDocument();
  });

  it("also works with the Enter key", () => {
    const input = openEmailTab();
    fireEvent.change(input, { target: { value: "me@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenUrl).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to our own backend", () => {
    const input = openEmailTab();
    fireEvent.change(input, { target: { value: "me@example.com" } });
    fireEvent.click(checkButton());
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("BreachView - network check", () => {
  it("looks up the public IP when the tab opens", async () => {
    render(<BreachView />);
    expect(calls("get_public_ip_address")).toHaveLength(0);
    tab("Network Security");

    expect(await screen.findByText("203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText("Unverified Network")).toBeInTheDocument();
    expect(screen.getByText(/Public IP is Visible/)).toBeInTheDocument();
    expect(screen.getByText(/Source: ipify/)).toBeInTheDocument();
    expect(screen.getByText(/Protect Your Traffic/)).toBeInTheDocument();
  });

  it("recognises a protected connection and drops the sales pitch", async () => {
    ipImpl = () => Promise.resolve({ ip: "198.51.100.9", is_warp: true, service_used: "cloudflare" });
    render(<BreachView />);
    tab("Network Security");

    expect(await screen.findByText("Secure Connection")).toBeInTheDocument();
    expect(screen.getByText(/Encrypted via Cloudflare Warp/)).toBeInTheDocument();
    expect(screen.queryByText(/Protect Your Traffic/)).not.toBeInTheDocument();
  });

  it("copes with the lookup service being down", async () => {
    ipImpl = () => Promise.reject("timeout");
    render(<BreachView />);
    tab("Network Security");

    expect(await screen.findByText("Unknown (Service unavailable)")).toBeInTheDocument();
    expect(screen.getByText(/Source: Error/)).toBeInTheDocument();
    expect(screen.queryByTitle("Copy IP Address")).not.toBeInTheDocument();
    expect(calls("get_public_ip_address")).toHaveLength(1);
  });

  it("does not look the IP up again when returning to the tab", async () => {
    render(<BreachView />);
    tab("Network Security");
    await screen.findByText("203.0.113.7");
    tab("Email Breach");
    tab("Network Security");
    expect(await screen.findByText("203.0.113.7")).toBeInTheDocument();
    expect(calls("get_public_ip_address")).toHaveLength(1);
  });

  it("refreshes on request and picks up a changed address", async () => {
    render(<BreachView />);
    tab("Network Security");
    await screen.findByText("203.0.113.7");

    ipImpl = () => Promise.resolve({ ip: "198.51.100.20", is_warp: true, service_used: "cloudflare" });
    fireEvent.click(screen.getByTitle("Refresh IP"));

    expect(await screen.findByText("198.51.100.20")).toBeInTheDocument();
    expect(screen.getByText("Secure Connection")).toBeInTheDocument();
  });

  it("copies the IP address", async () => {
    render(<BreachView />);
    tab("Network Security");
    await screen.findByText("203.0.113.7");
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy IP Address"));
    });
    expect(mockClipboardWrite).toHaveBeenCalledWith("203.0.113.7");
  });
});

describe("BreachView - keyboard shortcuts", () => {
  it("Ctrl+O opens the folder picker on the local scanner tab", async () => {
    mockOpen.mockResolvedValueOnce(null);
    render(<BreachView />);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
  });

  it("Ctrl+O does nothing on the other tabs", async () => {
    render(<BreachView />);
    tab("Password Breach");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
