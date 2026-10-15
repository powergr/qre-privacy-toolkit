import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AndroidUpdateChecker } from "./AndroidUpdateChecker";

const mockFetch = jest.fn();
const mockOpenUrl = jest.fn();
const mockGetVersion = jest.fn();
const mockPlatform = jest.fn();

jest.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));
jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));
jest.mock("@tauri-apps/api/app", () => ({
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

interface Release {
  tag_name: string;
  name: string;
  body: string;
  assets: { name: string; browser_download_url: string }[];
}

function release(tag: string, overrides: Partial<Release> = {}): Release {
  return {
    tag_name: tag,
    name: `Release ${tag}`,
    body: "notes",
    assets: [
      { name: "qre-setup.exe", browser_download_url: "https://example.test/qre-setup.exe" },
      { name: "qre-toolkit.apk", browser_download_url: "https://example.test/qre-toolkit.apk" },
    ],
    ...overrides,
  };
}

function reply(rel: unknown, ok = true, status = 200, statusText = "OK") {
  mockFetch.mockResolvedValue({ ok, status, statusText, json: () => Promise.resolve(rel) });
}

function setup(current: string, rel: unknown) {
  mockGetVersion.mockResolvedValue(current);
  reply(rel);
  const onClose = jest.fn();
  render(<AndroidUpdateChecker onClose={onClose} />);
  return { onClose };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.mockReturnValue("android");
  mockOpenUrl.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("AndroidUpdateChecker - asking GitHub", () => {
  it("asks for the latest release with the Tauri HTTP client", async () => {
    setup("2.8.4", release("v2.8.4"));
    await screen.findByText("Up to Date");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/powergr/qre-privacy-toolkit/releases/latest",
      { method: "GET", headers: { "User-Agent": "QRE-Toolkit-Android" } },
    );
  });

  it("says it is connecting while it waits", () => {
    mockGetVersion.mockResolvedValue("2.8.4");
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<AndroidUpdateChecker onClose={jest.fn()} />);
    expect(screen.getByText("Connecting to GitHub...")).toBeInTheDocument();
  });

  it("refuses to run anywhere but Android", async () => {
    mockPlatform.mockReturnValue("windows");
    mockGetVersion.mockResolvedValue("2.8.4");
    render(<AndroidUpdateChecker onClose={jest.fn()} />);
    expect(await screen.findByText("This update checker is only for Android")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("shows why startup failed", async () => {
    mockGetVersion.mockRejectedValue("no version");
    render(<AndroidUpdateChecker onClose={jest.fn()} />);
    expect(await screen.findByText(/Initialization failed: no version/)).toBeInTheDocument();
  });

  it("reports a GitHub error such as a rate limit", async () => {
    mockGetVersion.mockResolvedValue("2.8.4");
    reply({}, false, 403, "rate limit exceeded");
    render(<AndroidUpdateChecker onClose={jest.fn()} />);
    expect(await screen.findByText(/GitHub API Error: 403 rate limit exceeded/)).toBeInTheDocument();
  });

  it("reports a network failure", async () => {
    mockGetVersion.mockResolvedValue("2.8.4");
    mockFetch.mockRejectedValue("offline");
    render(<AndroidUpdateChecker onClose={jest.fn()} />);
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
    expect(screen.getByText("Check Failed")).toBeInTheDocument();
  });

  it("reports a release without an APK", async () => {
    setup("2.8.4", release("v2.9.0", { assets: [{ name: "qre-setup.exe", browser_download_url: "https://x.test/a.exe" }] }));
    expect(await screen.findByText(/no APK file is attached/)).toBeInTheDocument();
  });

  it("finds the APK whatever the capitalisation", async () => {
    setup("2.8.4", release("v2.9.0", { assets: [{ name: "QRE.APK", browser_download_url: "https://x.test/QRE.APK" }] }));
    fireEvent.click(await screen.findByRole("button", { name: /Download APK/ }));
    expect(mockOpenUrl).toHaveBeenCalledWith("https://x.test/QRE.APK");
  });

  it("copes with a malformed reply", async () => {
    setup("2.8.4", { nonsense: true });
    expect(await screen.findByText("Check Failed")).toBeInTheDocument();
  });
});

describe("AndroidUpdateChecker - comparing versions", () => {
  it.each([
    ["2.8.4", "v2.8.5", true],
    ["2.8.9", "v2.8.10", true],
    ["2.9.0", "2.10.0", true],
    ["2.99.99", "v3.0.0", true],
    ["2.9", "v2.9.1", true],
    ["2.8.4", "v2.8.4", false],
    ["2.8.4", "2.8.4", false],
    ["2.8.10", "v2.8.9", false],
    ["3.0.0", "v2.9.9", false],
    ["2.9.0", "v2.9", false],
    ["2.9", "v2.9.0", false],
  ])("installed %s, latest %s: update offered = %s", async (installed, tag, offered) => {
    setup(installed, release(tag));
    if (offered) {
      expect(await screen.findByText("New Version Available")).toBeInTheDocument();
      expect(screen.getByText(`v${tag.replace(/^v/, "")}`)).toBeInTheDocument();
      expect(screen.getByText(`Current: v${installed}`)).toBeInTheDocument();
    } else {
      expect(await screen.findByText("Up to Date")).toBeInTheDocument();
      expect(screen.getByText(`Version ${installed} is the latest version.`)).toBeInTheDocument();
    }
  });
});

describe("AndroidUpdateChecker - downloading", () => {
  it("opens the APK link in the browser and closes", async () => {
    const { onClose } = setup("2.8.4", release("v2.9.0"));
    fireEvent.click(await screen.findByRole("button", { name: /Download APK/ }));

    await screen.findByText(/External browser will open/).catch(() => undefined);
    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.test/qre-toolkit.apk");
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an error and stays open if the link cannot be opened", async () => {
    mockOpenUrl.mockRejectedValue("no browser");
    const { onClose } = setup("2.8.4", release("v2.9.0"));
    fireEvent.click(await screen.findByRole("button", { name: /Download APK/ }));

    expect(await screen.findByText(/Failed to open download link: .*no browser/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the X and from Close", async () => {
    const { onClose } = setup("2.8.4", release("v2.8.4"));
    await screen.findByText("Up to Date");
    fireEvent.click(document.querySelector("svg.lucide-x")!);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
