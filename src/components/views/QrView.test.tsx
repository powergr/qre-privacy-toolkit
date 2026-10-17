import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QrView } from "./QrView";

// jsdom has no TextEncoder/TextDecoder; the real webview does.
const env = globalThis as unknown as Record<string, unknown>;
env.TextEncoder = class {
  encode(s: string) {
    return Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0));
  }
};
env.TextDecoder = class {
  decode(b: Uint8Array) {
    return decodeURIComponent(escape(String.fromCharCode(...b)));
  }
};

const mockInvoke = jest.fn();
const mockSave = jest.fn();
const mockWriteFile = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
}));
jest.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

interface Validation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  estimated_size?: string;
}

let validation: Validation;
let generateOverride: ((options: Record<string, unknown>) => Promise<unknown>) | null;
let wifiFailure: string | null;

function svgFor(label: string) {
  return { svg: `<svg data-qr="${label}"></svg>`, size: 25, version: 2 };
}

function backend() {
  mockInvoke.mockImplementation((cmd: string, args: { text?: string; options?: Record<string, unknown> }) => {
    switch (cmd) {
      case "validate_qr_input":
        return Promise.resolve(validation);
      case "generate_qr":
        return generateOverride
          ? generateOverride(args.options!)
          : Promise.resolve(svgFor(String(args.options!.text)));
      case "generate_wifi_qr":
        return wifiFailure ? Promise.reject(wifiFailure) : Promise.resolve(svgFor("wifi:" + args.options!.ssid));
      default:
        return Promise.resolve(null);
    }
  });
}

const preview = () => document.querySelector("svg[data-qr]") as SVGElement | null;
const previewLabel = () => preview()?.getAttribute("data-qr") ?? null;
const generateCalls = () => mockInvoke.mock.calls.filter(([c]) => c === "generate_qr");
const lastGenerate = () => generateCalls().slice(-1)[0][1].options as Record<string, unknown>;
const goTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const typeInto = (placeholder: string, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

beforeEach(() => {
  jest.clearAllMocks();
  validation = { valid: true, errors: [], warnings: [], estimated_size: "Version 2, 25x25 modules" };
  generateOverride = null;
  wifiFailure = null;
  backend();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("QrView - generating codes", () => {
  it("starts on the website tab with nothing to show", () => {
    render(<QrView />);
    expect(screen.getByText("Enter content to generate QR code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SVG/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /PNG/ })).toBeDisabled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("adds https:// to a website typed without a scheme", async () => {
    render(<QrView />);
    typeInto("https://example.com", "example.com");
    await waitFor(() => expect(previewLabel()).toBe("https://example.com"));
  });

  it.each(["http://example.com", "https://example.com", "HTTPS://Example.com", "Http://example.com"])(
    "leaves %s as typed",
    async (typed) => {
      render(<QrView />);
      typeInto("https://example.com", typed);
      await waitFor(() => expect(previewLabel()).toBe(typed));
    },
  );

  it("encodes text as typed and counts characters", async () => {
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "hello world");
    await waitFor(() => expect(previewLabel()).toBe("hello world"));
    expect(screen.getByText("11 / 2048 characters")).toBeInTheDocument();
  });

  it("builds mailto: and tel: links", async () => {
    render(<QrView />);
    goTab("Email");
    typeInto("your@email.com", "me@example.com");
    await waitFor(() => expect(previewLabel()).toBe("mailto:me@example.com"));

    goTab("Phone");
    typeInto("+1234567890", "+441234567890");
    await waitFor(() => expect(previewLabel()).toBe("tel:+441234567890"));
  });

  it("shows the size estimate once a code exists", async () => {
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "abc");
    expect(await screen.findByText("Version 2, 25x25 modules")).toBeInTheDocument();
  });

  it("clears the preview when the content is emptied", async () => {
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "abc");
    await waitFor(() => expect(previewLabel()).toBe("abc"));
    typeInto("Enter any text...", "");
    await waitFor(() => expect(previewLabel()).toBeNull());
    expect(screen.getByRole("button", { name: /SVG/ })).toBeDisabled();
  });

  it("sends colours, error correction and border with the request", async () => {
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "styled");
    await waitFor(() => expect(previewLabel()).toBe("styled"));

    const [fg, bg] = Array.from(document.querySelectorAll('input[type="color"]')) as HTMLInputElement[];
    fireEvent.change(fg, { target: { value: "#112233" } });
    fireEvent.change(bg, { target: { value: "#ffeeaa" } });
    fireEvent.click(screen.getByText("High (30%)"));
    fireEvent.change(document.querySelector('input[type="range"]')!, { target: { value: "7" } });

    await waitFor(() =>
      expect(lastGenerate()).toEqual({
        text: "styled",
        fg_color: "#112233",
        bg_color: "#ffeeaa",
        ecc: "high",
        border: 7,
      }),
    );
    expect(screen.getByText("Border Size: 7 modules")).toBeInTheDocument();
  });
});

describe("QrView - validation and errors", () => {
  it("lists problems and shows no code when the input is invalid", async () => {
    validation = { valid: false, errors: ["Content is too long"], warnings: [] };
    generateOverride = () => Promise.reject("Content is too long");
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "x".repeat(50));

    expect(await screen.findByText("• Content is too long")).toBeInTheDocument();
    expect(previewLabel()).toBeNull();
    expect(screen.getByRole("button", { name: /SVG/ })).toBeDisabled();
  });

  it("shows warnings but still produces the code", async () => {
    validation = { valid: true, errors: [], warnings: ["Dense code, may be hard to scan"] };
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "dense");
    expect(await screen.findByText(/Dense code, may be hard to scan/)).toBeInTheDocument();
    await waitFor(() => expect(previewLabel()).toBe("dense"));
  });

  it("shows a generation failure and lets the user dismiss it", async () => {
    generateOverride = () => Promise.reject("encoder crashed");
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "boom");

    const banner = await screen.findByText(/encoder crashed/);
    expect(previewLabel()).toBeNull();
    fireEvent.click(banner.parentElement!.querySelector("button")!);
    expect(screen.queryByText(/encoder crashed/)).not.toBeInTheDocument();
  });

  it("keeps the newest code when responses arrive out of order", async () => {
    const pending: Record<string, (v: unknown) => void> = {};
    generateOverride = (options) =>
      new Promise((resolve) => {
        pending[String(options.text)] = resolve;
      });
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "first");
    typeInto("Enter any text...", "second");
    await waitFor(() => expect(Object.keys(pending)).toEqual(["first", "second"]));

    await act(async () => {
      pending["second"](svgFor("second"));
    });
    await act(async () => {
      pending["first"](svgFor("first"));
    });

    expect(previewLabel()).toBe("second");
  });

  it("ignores a late failure from an older request", async () => {
    const pending: Record<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }> = {};
    generateOverride = (options) =>
      new Promise((resolve, reject) => {
        pending[String(options.text)] = { resolve, reject };
      });
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "old");
    typeInto("Enter any text...", "new");
    await waitFor(() => expect(Object.keys(pending)).toEqual(["old", "new"]));

    await act(async () => {
      pending["new"].resolve(svgFor("new"));
    });
    await act(async () => {
      pending["old"].reject("stale failure");
    });

    expect(previewLabel()).toBe("new");
    expect(screen.queryByText(/stale failure/)).not.toBeInTheDocument();
  });
});

describe("QrView - WiFi codes", () => {
  it("asks for details first", () => {
    render(<QrView />);
    goTab("WiFi");
    expect(screen.getByText("Enter WiFi details to generate")).toBeInTheDocument();
  });

  it("builds a WPA2 network code with its password and options", async () => {
    render(<QrView />);
    goTab("WiFi");
    typeInto("MyHomeWifi", "CafeNet");
    fireEvent.click(screen.getByText("WPA2 (Recommended)"));
    typeInto("Network Password", "correct-horse");
    fireEvent.click(screen.getByLabelText("Hidden Network"));

    await waitFor(() => {
      const call = mockInvoke.mock.calls.filter(([c]) => c === "generate_wifi_qr").slice(-1)[0];
      expect(call[1].options).toMatchObject({
        ssid: "CafeNet",
        password: "correct-horse",
        hidden: true,
        security: "WPA2",
      });
    });
    await waitFor(() => expect(previewLabel()).toBe("wifi:CafeNet"));
  });

  it("hides and clears the password for an open network", async () => {
    render(<QrView />);
    goTab("WiFi");
    typeInto("MyHomeWifi", "OpenNet");
    typeInto("Network Password", "will-be-cleared");
    fireEvent.click(screen.getByText("Open (No Password)"));

    expect(screen.queryByPlaceholderText("Network Password")).not.toBeInTheDocument();
    await waitFor(() => {
      const call = mockInvoke.mock.calls.filter(([c]) => c === "generate_wifi_qr").slice(-1)[0];
      expect(call[1].options).toMatchObject({ security: "nopass", password: "" });
    });

    fireEvent.click(screen.getByText("WPA"));
    expect((screen.getByPlaceholderText("Network Password") as HTMLInputElement).value).toBe("");
  });

  it("can reveal the password", () => {
    render(<QrView />);
    goTab("WiFi");
    const input = screen.getByPlaceholderText("Network Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(input.parentElement!.querySelector("button")!);
    expect(input.type).toBe("text");
  });

  it("does not run text validation for WiFi", async () => {
    render(<QrView />);
    goTab("WiFi");
    typeInto("MyHomeWifi", "CafeNet");
    await waitFor(() => expect(previewLabel()).toBe("wifi:CafeNet"));
    expect(mockInvoke.mock.calls.some(([c]) => c === "validate_qr_input")).toBe(false);
  });

  it("shows a WiFi generation error", async () => {
    wifiFailure = "SSID must not be empty";
    render(<QrView />);
    goTab("WiFi");
    typeInto("MyHomeWifi", "x");
    expect(await screen.findByText(/SSID must not be empty/)).toBeInTheDocument();
  });
});

describe("QrView - saving", () => {
  async function withCode() {
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "save me");
    await waitFor(() => expect(previewLabel()).toBe("save me"));
  }

  it("saves the SVG text to the chosen file", async () => {
    await withCode();
    mockSave.mockResolvedValue("C:\\out\\qrcode.svg");
    mockWriteFile.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /SVG/ }));

    await waitFor(() => expect(mockWriteFile).toHaveBeenCalled());
    const [path, bytes] = mockWriteFile.mock.calls[0];
    expect(path).toBe("C:\\out\\qrcode.svg");
    expect(new TextDecoder().decode(bytes)).toBe('<svg data-qr="save me"></svg>');
    expect(mockSave.mock.calls[0][0].defaultPath).toBe("qrcode.svg");
  });

  it("writes nothing if the save dialog is cancelled", async () => {
    await withCode();
    mockSave.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: /SVG/ }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("reports a failed SVG save", async () => {
    await withCode();
    mockSave.mockResolvedValue("C:\\out\\qrcode.svg");
    mockWriteFile.mockRejectedValue("disk full");
    fireEvent.click(screen.getByRole("button", { name: /SVG/ }));
    expect(await screen.findByText(/Failed to save SVG: .*disk full/)).toBeInTheDocument();
  });

  describe("PNG", () => {
    const realImage = globalThis.Image;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    const drawImage = jest.fn();
    let revoke: jest.Mock;

    beforeEach(() => {
      revoke = jest.fn();
      URL.createObjectURL = jest.fn(() => "blob:fake");
      URL.revokeObjectURL = revoke;
      HTMLCanvasElement.prototype.getContext = jest.fn(() => ({ drawImage })) as never;
      HTMLCanvasElement.prototype.toDataURL = jest.fn(() => "data:image/png;base64,AAEC");
      class FakeImage {
        onload: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      }
      globalThis.Image = FakeImage as never;
    });
    afterEach(() => {
      globalThis.Image = realImage;
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    });

    it("renders the SVG at 1000x1000 and saves the PNG bytes", async () => {
      await withCode();
      mockSave.mockResolvedValue("C:\\out\\qrcode.png");
      mockWriteFile.mockResolvedValue(undefined);
      fireEvent.click(screen.getByRole("button", { name: /PNG/ }));

      await waitFor(() => expect(mockWriteFile).toHaveBeenCalled());
      const [path, bytes] = mockWriteFile.mock.calls[0];
      expect(path).toBe("C:\\out\\qrcode.png");
      expect(Array.from(bytes as Uint8Array)).toEqual([0, 1, 2]);
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1000, 1000);
      expect(mockSave.mock.calls[0][0].defaultPath).toBe("qrcode.png");
      expect(revoke).toHaveBeenCalledWith("blob:fake");
    });

    it("reports a failed PNG save and still releases the temporary URL", async () => {
      await withCode();
      mockSave.mockResolvedValue("C:\\out\\qrcode.png");
      mockWriteFile.mockRejectedValue("disk full");
      fireEvent.click(screen.getByRole("button", { name: /PNG/ }));

      expect(await screen.findByText(/Failed to save PNG: .*disk full/)).toBeInTheDocument();
      expect(revoke).toHaveBeenCalledWith("blob:fake");
    });
  });
});

describe("QrView - keyboard shortcuts", () => {
  it("Ctrl+Shift+S saves the SVG", async () => {
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "save me");
    await waitFor(() => expect(previewLabel()).toBe("save me"));
    mockSave.mockResolvedValue("C:\\out\\qrcode.svg");
    mockWriteFile.mockResolvedValue(undefined);

    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(mockWriteFile).toHaveBeenCalled());
    expect(mockSave.mock.calls[0][0].defaultPath).toBe("qrcode.svg");
  });

  it("Ctrl+S and Ctrl+Shift+S do nothing before a code exists", () => {
    render(<QrView />);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe("QrView - shared parts", () => {
  it("shows the kinds of code as one set of tabs, with the current kind selected", () => {
    render(<QrView />);
    expect(screen.getByRole("tablist", { name: "Kind of QR code" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Text", "Website", "Email", "Phone", "WiFi"]);
    expect(screen.getByRole("tab", { name: "Website" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves to the next kind with the arrow keys, and shows its form", () => {
    render(<QrView />);
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Email" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText("your@email.com")).toBeInTheDocument();
  });

  it("makes the tabs fill the card, each an equal share", () => {
    render(<QrView />);
    expect(screen.getByRole("tablist")).toHaveClass("ui-seg--fill");
  });

  it("shows problems with the input in an error banner and warnings in a warning banner", async () => {
    validation = { valid: false, errors: ["Content is too long"], warnings: ["Dense code"] };
    generateOverride = () => Promise.reject("Content is too long");
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "x".repeat(50));
    expect((await screen.findByText("• Content is too long")).closest(".ui-banner")).toHaveClass("ui-banner--error");
    expect(screen.getByText("Dense code").closest(".ui-banner")).toHaveClass("ui-banner--warning");
  });

  it("shows a failure to make the code as an error banner you can dismiss", async () => {
    generateOverride = () => Promise.reject("encoder crashed");
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "boom");
    const message = await screen.findByText(/encoder crashed/);
    expect(message.closest(".ui-banner")).toHaveClass("ui-banner--error");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByText(/encoder crashed/)).not.toBeInTheDocument();
  });

  it("shows the size of the code in an info banner", async () => {
    validation = { valid: true, errors: [], warnings: [], estimated_size: "About 3 cm square" };
    render(<QrView />);
    goTab("Text");
    typeInto("Enter any text...", "size");
    await waitFor(() => expect(previewLabel()).toBe("size"));
    expect(screen.getByText("QR Code Info").closest(".ui-banner")).toHaveClass("ui-banner--info");
    expect(screen.getByText("About 3 cm square")).toBeInTheDocument();
  });

  it("shows the keys for saving next to the PNG and SVG buttons", () => {
    render(<QrView />);
    const png = screen.getByRole("button", { name: /PNG/ });
    const svg = screen.getByRole("button", { name: /SVG/ });
    expect(Array.from(png.querySelectorAll("kbd")).map((k) => k.textContent)).toEqual(["Ctrl", "S"]);
    expect(Array.from(svg.querySelectorAll("kbd")).map((k) => k.textContent)).toEqual(["Ctrl", "Shift", "S"]);
  });
});

describe("QrView - save buttons on a touch screen", () => {
  afterEach(() => {
    // @ts-expect-error removed again so other tests see the computer
    delete window.matchMedia;
  });

  it("leaves out the save keys, which a phone cannot press", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    render(<QrView />);
    expect(screen.getByRole("button", { name: /PNG/ }).querySelector("kbd")).toBeNull();
    expect(screen.getByRole("button", { name: /SVG/ }).querySelector("kbd")).toBeNull();
  });
});
