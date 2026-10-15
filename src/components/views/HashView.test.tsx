import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HashView } from "./HashView";

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockWindowListen = jest.fn();
const mockOpen = jest.fn();
const mockSave = jest.fn();
const mockWriteText = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: (...args: unknown[]) => mockWindowListen(...args) }),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
  save: (...args: unknown[]) => mockSave(...args),
}));
jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));

const SHA256 = "a".repeat(64);
const SHA1 = "b".repeat(40);
const MD5 = "c".repeat(32);

let metadata: { size: number; is_file: boolean; is_symlink: boolean };
let hashResult: Promise<unknown> | (() => Promise<unknown>);
let windowHandlers: Record<string, (e: unknown) => void>;
let progressHandler: (e: { payload: { bytes_processed: number; total_bytes: number; percentage: number } }) => void;

function backend() {
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "get_file_metadata":
        return Promise.resolve(metadata);
      case "calculate_file_hashes":
        return typeof hashResult === "function" ? hashResult() : hashResult;
      default:
        return Promise.resolve(null);
    }
  });
}

async function renderHash() {
  const utils = render(<HashView />);
  await waitFor(() => {
    expect(windowHandlers["tauri://drag-drop"]).toBeDefined();
    expect(progressHandler).toBeDefined();
  });
  return utils;
}

async function hashFile(path = "C:\\files\\setup.iso") {
  mockOpen.mockResolvedValue(path);
  fireEvent.click(screen.getByRole("button", { name: /Select File/ }));
  await screen.findByText("Hashing completed successfully");
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
}

const compareInput = () => screen.getByPlaceholderText("Paste SHA256 / SHA1 / MD5 here...") as HTMLInputElement;
const typeCompare = (v: string) => fireEvent.change(compareInput(), { target: { value: v } });

beforeEach(() => {
  jest.clearAllMocks();
  metadata = { size: 1_572_864, is_file: true, is_symlink: false };
  hashResult = Promise.resolve({ sha256: SHA256, sha1: SHA1, md5: MD5 });
  windowHandlers = {};
  progressHandler = undefined as unknown as typeof progressHandler;
  mockWindowListen.mockImplementation((event: string, handler: (e: unknown) => void) => {
    windowHandlers[event] = handler;
    return Promise.resolve(() => {});
  });
  mockListen.mockImplementation((_e: string, handler: typeof progressHandler) => {
    progressHandler = handler;
    return Promise.resolve(() => {});
  });
  mockWriteText.mockResolvedValue(undefined);
  backend();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("HashView - choosing a file", () => {
  it("starts on the drop zone and states the size limit", async () => {
    await renderHash();
    expect(screen.getByText("Drag & Drop a File")).toBeInTheDocument();
    expect(screen.getByText("Maximum file size: 10 GB")).toBeInTheDocument();
  });

  it("hashes the chosen file and shows all three digests", async () => {
    await renderHash();
    await hashFile("C:\\files\\setup.iso");

    expect(screen.getByText("setup.iso")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB")).toBeInTheDocument();
    expect(screen.getByText(SHA256)).toBeInTheDocument();
    expect(screen.getByText(SHA1)).toBeInTheDocument();
    expect(screen.getByText(MD5)).toBeInTheDocument();
    const metaCall = mockInvoke.mock.calls.find(([c]) => c === "get_file_metadata")!;
    expect(metaCall[1]).toEqual({ path: "C:\\files\\setup.iso" });
  });

  it("does nothing if the file picker is cancelled", async () => {
    await renderHash();
    mockOpen.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: /Select File/ }));
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("reports a file dialog failure", async () => {
    await renderHash();
    mockOpen.mockRejectedValue("dialog crashed");
    fireEvent.click(screen.getByRole("button", { name: /Select File/ }));
    expect(await screen.findByText(/Failed to open file dialog: .*dialog crashed/)).toBeInTheDocument();
  });

  it("hashes a file dropped onto the window and highlights the zone while dragging", async () => {
    await renderHash();
    act(() => windowHandlers["tauri://drag-enter"]({}));
    expect(document.querySelector(".shred-zone.active")).not.toBeNull();
    act(() => windowHandlers["tauri://drag-leave"]({}));
    expect(document.querySelector(".shred-zone.active")).toBeNull();

    act(() => windowHandlers["tauri://drag-drop"]({ payload: { paths: ["/home/me/a.bin", "/home/me/b.bin"] } }));
    expect(await screen.findByText("Hashing completed successfully")).toBeInTheDocument();
    expect(screen.getByText("a.bin")).toBeInTheDocument();
    expect(mockInvoke.mock.calls.filter(([c]) => c === "calculate_file_hashes")).toHaveLength(1);
  });
});

describe("HashView - rejecting unsuitable files", () => {
  async function tryFile() {
    await renderHash();
    mockOpen.mockResolvedValue("/data/thing");
    fireEvent.click(screen.getByRole("button", { name: /Select File/ }));
  }
  const hashed = () => mockInvoke.mock.calls.some(([c]) => c === "calculate_file_hashes");

  it("refuses something that is not a regular file", async () => {
    metadata = { size: 0, is_file: false, is_symlink: false };
    await tryFile();
    expect(await screen.findByText("Selected path is not a regular file")).toBeInTheDocument();
    expect(hashed()).toBe(false);
    expect(screen.getByText("Drag & Drop a File")).toBeInTheDocument();
  });

  it("refuses symbolic links", async () => {
    metadata = { size: 10, is_file: true, is_symlink: true };
    await tryFile();
    expect(await screen.findByText(/Symlinks are not supported/)).toBeInTheDocument();
    expect(hashed()).toBe(false);
  });

  it("refuses files over 10 GB and says how big it was", async () => {
    metadata = { size: 11 * 1024 ** 3, is_file: true, is_symlink: false };
    await tryFile();
    expect(await screen.findByText(/File is too large \(11 GB\)\. Maximum size: 10 GB/)).toBeInTheDocument();
    expect(hashed()).toBe(false);
  });

  it("accepts a file of exactly 10 GB", async () => {
    metadata = { size: 10 * 1024 ** 3, is_file: true, is_symlink: false };
    await tryFile();
    expect(await screen.findByText("Hashing completed successfully")).toBeInTheDocument();
  });

  it.each([
    ["Error: operation cancelled", "Hashing cancelled by user"],
    ["permission denied (os error 5)", "Permission denied. Cannot read file."],
    ["file not found", "File not found. It may have been moved or deleted."],
    ["disk exploded", "disk exploded"],
  ])("turns the backend error %p into a friendly message", async (raw, friendly) => {
    hashResult = Promise.reject(raw);
    await tryFile();
    expect(await screen.findByText(friendly)).toBeInTheDocument();
  });

  it("lets the user dismiss an error banner", async () => {
    metadata = { size: 0, is_file: false, is_symlink: false };
    await tryFile();
    const banner = await screen.findByText("Selected path is not a regular file");
    fireEvent.click(banner.parentElement!.querySelector("button")!);
    expect(screen.queryByText("Selected path is not a regular file")).not.toBeInTheDocument();
  });
});

describe("HashView - progress and cancel", () => {
  it("shows live progress and lets the user cancel", async () => {
    let finish!: (v: unknown) => void;
    hashResult = new Promise((r) => {
      finish = r;
    });
    await renderHash();
    mockOpen.mockResolvedValue("/data/big.iso");
    fireEvent.click(screen.getByRole("button", { name: /Select File/ }));

    expect(await screen.findByText("Calculating Hashes...")).toBeInTheDocument();
    expect(screen.getByText("Starting...")).toBeInTheDocument();
    act(() => progressHandler({ payload: { bytes_processed: 5 * 1024 ** 2, total_bytes: 10 * 1024 ** 2, percentage: 50 } }));
    expect(screen.getByText("50% - 5 MB processed")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("cancel_hashing"));
    expect(await screen.findByText("Hashing cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Calculating Hashes...")).not.toBeInTheDocument();

    await act(async () => {
      finish({ sha256: SHA256, sha1: SHA1, md5: MD5 });
    });
  });
});

describe("HashView - comparing against an official hash", () => {
  it("confirms a SHA-256 match regardless of case", async () => {
    await renderHash();
    await hashFile();
    typeCompare(SHA256.toUpperCase());
    expect(screen.getByText(/MATCH CONFIRMED \(SHA-256\)/)).toBeInTheDocument();
  });

  it("confirms SHA-1 and MD5 matches too", async () => {
    await renderHash();
    await hashFile();
    typeCompare(SHA1);
    expect(screen.getByText(/MATCH CONFIRMED \(SHA-1\)/)).toBeInTheDocument();
    typeCompare(MD5);
    expect(screen.getByText(/MATCH CONFIRMED \(MD5\)/)).toBeInTheDocument();
  });

  it("flags a mismatch", async () => {
    await renderHash();
    await hashFile();
    typeCompare("d".repeat(64));
    expect(screen.getByText(/HASH MISMATCH/)).toBeInTheDocument();
    expect(screen.queryByText(/MATCH CONFIRMED/)).not.toBeInTheDocument();
  });

  it("shows no verdict until something is typed, and trims spaces around pasted hashes", async () => {
    await renderHash();
    await hashFile();
    expect(screen.queryByText(/MATCH CONFIRMED|HASH MISMATCH/)).not.toBeInTheDocument();
    typeCompare(`  ${SHA256}  `);
    expect(compareInput().value).toBe(SHA256);
    expect(screen.getByText(/MATCH CONFIRMED/)).toBeInTheDocument();
  });

  it("rejects non-hex characters and keeps the previous value", async () => {
    await renderHash();
    await hashFile();
    typeCompare("abc123");
    typeCompare("abc123zz");
    expect(compareInput().value).toBe("abc123");
    expect(screen.getByText(/Invalid characters/)).toBeInTheDocument();
  });

  it("rejects input longer than 128 characters", async () => {
    await renderHash();
    await hashFile();
    typeCompare("a".repeat(129));
    expect(screen.getByText(/Hash too long \(max 128 characters\)/)).toBeInTheDocument();
    expect(compareInput().value).toBe("");
  });

  it("clears the comparison when another file is checked", async () => {
    await renderHash();
    await hashFile();
    typeCompare(SHA256);
    fireEvent.click(screen.getByRole("button", { name: "Check Another File" }));
    expect(screen.getByText("Drag & Drop a File")).toBeInTheDocument();

    await hashFile("/other/file.bin");
    expect(compareInput().value).toBe("");
  });
});

describe("HashView - copying a hash", () => {
  async function copyFirstHash() {
    await act(async () => {
      fireEvent.click(screen.getAllByTitle(/Copy to clipboard/)[0]);
    });
  }

  it("copies, announces it, and clears the clipboard after 30 seconds", async () => {
    jest.useFakeTimers();
    try {
      await renderHash();
      await hashFile();
      await copyFirstHash();

      expect(mockWriteText).toHaveBeenCalledWith(SHA256);
      expect(screen.getByText(/Hash copied to clipboard/)).toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(29_999);
      });
      expect(mockWriteText).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("restarts the 30 second window when another hash is copied", async () => {
    jest.useFakeTimers();
    try {
      await renderHash();
      await hashFile();
      await copyFirstHash();
      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      await act(async () => {
        fireEvent.click(screen.getAllByTitle(/Copy to clipboard/)[1]);
      });
      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      expect(mockWriteText).not.toHaveBeenCalledWith("");
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("still clears the clipboard if the view is closed first", async () => {
    jest.useFakeTimers();
    try {
      const { unmount } = await renderHash();
      await hashFile();
      await copyFirstHash();
      unmount();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports a clipboard failure", async () => {
    await renderHash();
    await hashFile();
    mockWriteText.mockRejectedValue("clipboard locked");
    await copyFirstHash();
    expect(await screen.findByText(/Failed to copy to clipboard: .*clipboard locked/)).toBeInTheDocument();
  });
});

describe("HashView - exporting a report", () => {
  const savedReport = () => {
    const call = mockInvoke.mock.calls.find(([c]) => c === "save_text_to_file")!;
    return call[1] as { path: string; content: string };
  };

  it("writes the file details and all three hashes", async () => {
    await renderHash();
    await hashFile("C:\\files\\setup.iso");
    mockSave.mockResolvedValue("C:\\reports\\setup.txt");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));

    expect(await screen.findByText("Results exported successfully")).toBeInTheDocument();
    const { path, content } = savedReport();
    expect(path).toBe("C:\\reports\\setup.txt");
    expect(content).toContain("Path: C:\\files\\setup.iso");
    expect(content).toContain("Name: setup.iso");
    expect(content).toContain("Size: 1.5 MB");
    expect(content).toContain(`SHA-256: ${SHA256}`);
    expect(content).toContain(`SHA-1:   ${SHA1}`);
    expect(content).toContain(`MD5:     ${MD5}`);
    expect(content).not.toContain("VERIFICATION");
    expect(mockSave.mock.calls[0][0].defaultPath).toMatch(/^setup\.iso_hashes_.*\.txt$/);
  });

  it("records a confirmed SHA-256 match", async () => {
    await renderHash();
    await hashFile();
    typeCompare(SHA256);
    mockSave.mockResolvedValue("C:\\r.txt");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await screen.findByText("Results exported successfully");

    const { content } = savedReport();
    expect(content).toContain("MATCH CONFIRMED");
    expect(content).toContain("Algorithm: SHA-256");
  });

  it("records a confirmed MD5 or SHA-1 match as a match, not a mismatch", async () => {
    await renderHash();
    await hashFile();
    typeCompare(MD5);
    mockSave.mockResolvedValue("C:\\r.txt");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await screen.findByText("Results exported successfully");

    const { content } = savedReport();
    expect(content).toContain("MATCH CONFIRMED");
    expect(content).not.toContain("HASH MISMATCH");
    expect(content).toContain("Algorithm: MD5");
  });

  it("records a mismatch", async () => {
    await renderHash();
    await hashFile();
    typeCompare("d".repeat(64));
    mockSave.mockResolvedValue("C:\\r.txt");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await screen.findByText("Results exported successfully");

    const { content } = savedReport();
    expect(content).toContain("HASH MISMATCH");
    expect(content).toContain(`Expected:  ${"d".repeat(64)}`);
  });

  it("writes nothing if the save dialog is cancelled", async () => {
    await renderHash();
    await hashFile();
    mockSave.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockInvoke.mock.calls.some(([c]) => c === "save_text_to_file")).toBe(false);
  });

  it("reports a failed export", async () => {
    await renderHash();
    await hashFile();
    mockSave.mockResolvedValue("C:\\r.txt");
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "save_text_to_file" ? Promise.reject("disk full") : Promise.resolve(null),
    );
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByText(/Failed to export results: .*disk full/)).toBeInTheDocument();
  });
});
