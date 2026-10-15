import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { UpdateModal } from "./UpdateModal";

const mockCheck = jest.fn();
const mockRelaunch = jest.fn();
const mockGetVersion = jest.fn();
const mockPlatform = jest.fn();

jest.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));
jest.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => mockRelaunch(...args),
}));
jest.mock("@tauri-apps/api/app", () => ({
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

type Callback = (e: DownloadEvent) => void;

function makeUpdate(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    version: "2.9.0",
    body: "Fixed bugs\nAdded things",
    date: "2030-06-15 12:00:00.0 +00:00:00",
    downloadAndInstall: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function renderModal(update: ReturnType<typeof makeUpdate> | null = makeUpdate()) {
  mockCheck.mockResolvedValue(update);
  const onClose = jest.fn();
  const utils = render(<UpdateModal onClose={onClose} />);
  return { onClose, ...utils };
}

async function availableModal(update = makeUpdate()) {
  const ctx = await renderModal(update);
  await screen.findByText("New Version Available");
  return ctx;
}

const installButton = () => screen.getByRole("button", { name: /Download\s*&\s*Install/ });

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.mockReturnValue("windows");
  mockGetVersion.mockResolvedValue("2.8.4");
  mockRelaunch.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("UpdateModal - checking", () => {
  it("says it is checking, then that the app is up to date", async () => {
    await renderModal(null);
    expect(await screen.findByText("You are up to date!")).toBeInTheDocument();
    expect(screen.getByText("Version 2.8.4 is the latest version.")).toBeInTheDocument();
  });

  it("treats an update that is not available as up to date", async () => {
    await renderModal(makeUpdate({ available: false }));
    expect(await screen.findByText("You are up to date!")).toBeInTheDocument();
  });

  it("shows the new version, the current one, the date and the notes", async () => {
    await availableModal();
    expect(screen.getByText("v2.9.0")).toBeInTheDocument();
    expect(screen.getByText("Current: v2.8.4")).toBeInTheDocument();
    expect(screen.getByText("2030-06-15")).toBeInTheDocument();
    expect(screen.getByText(/Fixed bugs/)).toBeInTheDocument();
  });

  it("copes with an update that has no notes or date", async () => {
    await availableModal(makeUpdate({ body: undefined, date: undefined }));
    expect(screen.getByText("v2.9.0")).toBeInTheDocument();
    expect(screen.queryByText(/Fixed bugs/)).not.toBeInTheDocument();
  });

  it("shows why the check failed", async () => {
    mockCheck.mockRejectedValue("could not reach the update server");
    render(<UpdateModal onClose={jest.fn()} />);
    expect(await screen.findByText("Update Failed")).toBeInTheDocument();
    expect(screen.getByText(/could not reach the update server/)).toBeInTheDocument();
  });

  it("shows why startup failed", async () => {
    mockGetVersion.mockRejectedValue("no version");
    render(<UpdateModal onClose={jest.fn()} />);
    expect(await screen.findByText(/Initialization failed: no version/)).toBeInTheDocument();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("does not check for updates on a phone", async () => {
    mockPlatform.mockReturnValue("android");
    render(<UpdateModal onClose={jest.fn()} />);
    expect(await screen.findByText("Wrong Updater Loaded")).toBeInTheDocument();
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockGetVersion).not.toHaveBeenCalled();
  });
});

describe("UpdateModal - closing", () => {
  it("closes from the X and from Close", async () => {
    const { onClose } = await renderModal(null);
    await screen.findByText("You are up to date!");
    fireEvent.click(document.querySelector("svg.lucide-x")!);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("cannot be closed while downloading", async () => {
    const update = makeUpdate({ downloadAndInstall: jest.fn(() => new Promise(() => {})) });
    await availableModal(update);
    fireEvent.click(installButton());

    expect(await screen.findByText("Downloading...")).toBeInTheDocument();
    expect(document.querySelector("svg.lucide-x")).toBeNull();
  });
});

describe("UpdateModal - installing", () => {
  function controlledUpdate() {
    let callback!: Callback;
    let finish!: () => void;
    let fail!: (e: unknown) => void;
    const downloadAndInstall = jest.fn((cb: Callback) => {
      callback = cb;
      return new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    });
    const update = makeUpdate({ downloadAndInstall });
    return {
      update,
      emit: (e: DownloadEvent) => act(() => callback(e)),
      finish: () => act(async () => finish()),
      fail: (e: unknown) => act(async () => fail(e)),
    };
  }

  it("shows download progress as a percentage", async () => {
    const c = controlledUpdate();
    await availableModal(c.update);
    fireEvent.click(installButton());
    await screen.findByText("Downloading...");

    c.emit({ event: "Started", data: { contentLength: 1000 } });
    c.emit({ event: "Progress", data: { chunkLength: 250 } });
    expect(screen.getByText("25%")).toBeInTheDocument();
    c.emit({ event: "Progress", data: { chunkLength: 500 } });
    expect(screen.getByText("75%")).toBeInTheDocument();
    c.emit({ event: "Progress", data: { chunkLength: 250 } });
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("stays at 0% when the server does not say how big the file is", async () => {
    const c = controlledUpdate();
    await availableModal(c.update);
    fireEvent.click(installButton());
    await screen.findByText("Downloading...");

    c.emit({ event: "Started", data: {} });
    c.emit({ event: "Progress", data: { chunkLength: 500 } });
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("offers a restart once the update is installed, and restarts", async () => {
    const c = controlledUpdate();
    await availableModal(c.update);
    fireEvent.click(installButton());
    await screen.findByText("Downloading...");

    await c.finish();
    expect(await screen.findByText("Update Installed!")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Restart Now/ }));
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("does not say 'installed' when the download has finished but installing has not", async () => {
    const c = controlledUpdate();
    await availableModal(c.update);
    fireEvent.click(installButton());
    await screen.findByText("Downloading...");

    c.emit({ event: "Finished" });

    expect(screen.queryByText("Update Installed!")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restart Now/ })).not.toBeInTheDocument();
  });

  it("reports a failed install instead of 'installed'", async () => {
    const c = controlledUpdate();
    await availableModal(c.update);
    fireEvent.click(installButton());
    await screen.findByText("Downloading...");

    c.emit({ event: "Finished" });
    await c.fail("disk full while installing");

    expect(await screen.findByText("Update Failed")).toBeInTheDocument();
    expect(screen.getByText(/disk full while installing/)).toBeInTheDocument();
    expect(screen.queryByText("Update Installed!")).not.toBeInTheDocument();
  });

  it.each([
    ["Signature mismatch for payload", "Signature verification failed."],
    ["HTTP 404 Not Found", "Update file not found on server."],
    ["connection reset", "connection reset"],
  ])("explains the failure %p", async (raw, shown) => {
    const c = controlledUpdate();
    await availableModal(c.update);
    fireEvent.click(installButton());
    await screen.findByText("Downloading...");

    await c.fail(raw);
    expect(await screen.findByText(shown)).toBeInTheDocument();
  });

  it("shows an error if the server cannot be reached when the download starts", async () => {
    await availableModal();
    mockCheck.mockRejectedValue("offline");
    fireEvent.click(installButton());

    expect(await screen.findByText("Update Failed")).toBeInTheDocument();
    expect(screen.getByText(/offline/)).toBeInTheDocument();
  });

  it("says so if the restart fails", async () => {
    const c = controlledUpdate();
    await availableModal(c.update);
    fireEvent.click(installButton());
    await screen.findByText("Downloading...");
    await c.finish();
    await screen.findByText("Update Installed!");

    mockRelaunch.mockRejectedValue("not permitted");
    fireEvent.click(screen.getByRole("button", { name: /Restart Now/ }));

    expect(await screen.findByText(/Failed to restart: .*not permitted/)).toBeInTheDocument();
  });
});
