import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { UniversalUpdateModal } from "./UniversalUpdateModal";

const mockPlatform = jest.fn();
const mockCheck = jest.fn();
const mockFetch = jest.fn();
const mockGetVersion = jest.fn();

jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));
jest.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));
jest.mock("@tauri-apps/plugin-process", () => ({
  relaunch: jest.fn(),
}));
jest.mock("@tauri-apps/api/app", () => ({
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
}));
jest.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));
jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetVersion.mockResolvedValue("2.8.4");
  mockCheck.mockResolvedValue(null);
  mockFetch.mockReturnValue(new Promise(() => {}));
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("UniversalUpdateModal", () => {
  it("uses the GitHub APK checker on Android", async () => {
    mockPlatform.mockReturnValue("android");
    render(<UniversalUpdateModal onClose={jest.fn()} />);

    expect(await screen.findByText("Android Update")).toBeInTheDocument();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it.each(["windows", "macos", "linux"])("uses the built-in updater on %s", async (os) => {
    mockPlatform.mockReturnValue(os);
    render(<UniversalUpdateModal onClose={jest.fn()} />);

    expect(await screen.findByText("Software Update")).toBeInTheDocument();
    expect(await screen.findByText("You are up to date!")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to the desktop updater, which then reports the problem, if the platform is unknown", async () => {
    mockPlatform.mockImplementation(() => {
      throw new Error("no os plugin");
    });
    render(<UniversalUpdateModal onClose={jest.fn()} />);

    expect(await screen.findByText("Update Failed")).toBeInTheDocument();
    expect(screen.getByText(/Initialization failed/)).toBeInTheDocument();
  });

  it("passes its close handler through to the chosen updater", async () => {
    mockPlatform.mockReturnValue("windows");
    const onClose = jest.fn();
    render(<UniversalUpdateModal onClose={onClose} />);
    await screen.findByText("You are up to date!");
    screen.getByRole("button", { name: "Close" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
