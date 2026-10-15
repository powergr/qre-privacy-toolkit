import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Toolbar } from "./Toolbar";
import type { PortableDriveState } from "../../hooks/usePortableVault";

const mockPlatform = jest.fn();
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

function drive(
  path: string,
  opts: { name?: string; qre?: boolean; unlocked?: boolean } = {},
): PortableDriveState {
  return {
    drive: {
      path,
      name: opts.name ?? "",
      is_qre_portable: opts.qre ?? false,
    },
    isUnlocked: opts.unlocked ?? false,
  } as unknown as PortableDriveState;
}

function setup(over: Record<string, unknown> = {}) {
  const props = {
    onLock: jest.fn(),
    onUnlock: jest.fn(),
    onNavigate: jest.fn(),
    keyFile: null as string | null,
    setKeyFile: jest.fn(),
    selectKeyFile: jest.fn(),
    isParanoid: false,
    setIsParanoid: jest.fn(),
    compressionMode: "auto",
    onOpenCompression: jest.fn(),
    portable: {
      drives: [] as PortableDriveState[],
      isScanning: false,
      scanDrives: jest.fn(),
      lockVault: jest.fn(),
    },
    onInitDrive: jest.fn(),
    onUnlockDrive: jest.fn(),
    ...over,
  };
  const utils = render(<Toolbar {...props} />);
  return { props, ...utils };
}

const usbButton = () => screen.getByTitle("Portable USB Vaults");
const advancedButton = () => {
  const all = document.querySelectorAll("button.tool-btn");
  return all[all.length - 1] as HTMLElement;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.mockReturnValue("windows");
});

describe("Toolbar - Lock and Unlock", () => {
  it("calls the matching handler", () => {
    const { props } = setup();
    fireEvent.click(screen.getByText("Lock"));
    expect(props.onLock).toHaveBeenCalledTimes(1);
    expect(props.onUnlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Unlock"));
    expect(props.onUnlock).toHaveBeenCalledTimes(1);
  });
});

describe("Toolbar - advanced menu", () => {
  it("is closed until the gear is clicked, and toggles", () => {
    setup();
    expect(screen.queryByText("Paranoid Mode")).not.toBeInTheDocument();
    fireEvent.click(advancedButton());
    expect(screen.getByText("Paranoid Mode")).toBeInTheDocument();
    fireEvent.click(advancedButton());
    expect(screen.queryByText("Paranoid Mode")).not.toBeInTheDocument();
  });

  it("picks a keyfile and closes the menu", () => {
    const { props } = setup();
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Select Keyfile"));
    expect(props.selectKeyFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Paranoid Mode")).not.toBeInTheDocument();
  });

  it("shows an active keyfile with a way to clear it", () => {
    const { props } = setup({ keyFile: "C:\\k.bin" });
    fireEvent.click(advancedButton());
    expect(screen.getByText("Keyfile Active")).toBeInTheDocument();
    expect(screen.queryByText("Select Keyfile")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Clear Keyfile"));
    expect(props.setKeyFile).toHaveBeenCalledWith(null);
  });

  it("offers no Clear Keyfile without a keyfile", () => {
    setup();
    fireEvent.click(advancedButton());
    expect(screen.queryByText("Clear Keyfile")).not.toBeInTheDocument();
  });

  it("shows the zip mode in capitals and opens the compression dialog", () => {
    const { props } = setup({ compressionMode: "store" });
    fireEvent.click(advancedButton());
    expect(screen.getByText("STORE")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Zip Options"));
    expect(props.onOpenCompression).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Paranoid Mode")).not.toBeInTheDocument();
  });

  it("flips Paranoid Mode and shows a check only while it is on", () => {
    const { props, rerender } = setup();
    fireEvent.click(advancedButton());
    expect(document.querySelector("svg.lucide-check")).toBeNull();
    fireEvent.click(screen.getByText("Paranoid Mode"));
    expect(props.setIsParanoid).toHaveBeenLastCalledWith(true);

    rerender(<Toolbar {...props} isParanoid />);
    expect(document.querySelector("svg.lucide-check")).not.toBeNull();
    fireEvent.click(screen.getByText("Paranoid Mode"));
    expect(props.setIsParanoid).toHaveBeenLastCalledWith(false);
  });

  it("stays open after toggling Paranoid Mode", () => {
    setup();
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Paranoid Mode"));
    expect(screen.getByText("Paranoid Mode")).toBeInTheDocument();
  });

  it("marks the gear only when a non-default option is on", () => {
    const base = setup();
    expect(advancedButton()).not.toHaveClass("active-settings");
    expect(document.querySelector(".indicator-dot")).toBeNull();
    base.unmount();

    for (const over of [
      { keyFile: "k" },
      { isParanoid: true },
      { compressionMode: "store" },
    ]) {
      const { unmount } = setup(over);
      expect(advancedButton()).toHaveClass("active-settings");
      expect(document.querySelector(".indicator-dot")).not.toBeNull();
      unmount();
    }
  });

  it("closes on a mouse down outside but not inside", () => {
    setup();
    fireEvent.click(advancedButton());
    fireEvent.mouseDown(screen.getByText("Paranoid Mode"));
    expect(screen.getByText("Paranoid Mode")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Paranoid Mode")).not.toBeInTheDocument();
  });

  it("stops listening for outside clicks after unmount", () => {
    const remove = jest.spyOn(document, "removeEventListener");
    const { unmount } = setup();
    unmount();
    expect(remove).toHaveBeenCalledWith("mousedown", expect.any(Function));
    remove.mockRestore();
  });
});

describe("Toolbar - USB menu", () => {
  it("scans when opened, not when closed", () => {
    const { props } = setup();
    fireEvent.click(usbButton());
    expect(props.portable.scanDrives).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Portable Drives")).toBeInTheDocument();
    fireEvent.click(usbButton());
    expect(props.portable.scanDrives).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Portable Drives")).not.toBeInTheDocument();
  });

  it("opening one menu closes the other", () => {
    setup();
    fireEvent.click(advancedButton());
    fireEvent.click(usbButton());
    expect(screen.queryByText("Paranoid Mode")).not.toBeInTheDocument();
    expect(screen.getByText("Portable Drives")).toBeInTheDocument();
    fireEvent.click(advancedButton());
    expect(screen.queryByText("Portable Drives")).not.toBeInTheDocument();
    expect(screen.getByText("Paranoid Mode")).toBeInTheDocument();
  });

  it("says when no drive is found", () => {
    setup();
    fireEvent.click(usbButton());
    expect(screen.getByText("No removable drives detected.")).toBeInTheDocument();
  });

  it("refresh scans again and is disabled mid scan", () => {
    const { props, rerender } = setup();
    fireEvent.click(usbButton());
    const refresh = () =>
      document.querySelector("button.icon-btn-ghost") as HTMLButtonElement;
    fireEvent.click(refresh());
    expect(props.portable.scanDrives).toHaveBeenCalledTimes(2);

    rerender(
      <Toolbar
        {...props}
        portable={{ ...props.portable, isScanning: true }}
      />,
    );
    expect(refresh()).toBeDisabled();
  });

  it("closes on a mouse down outside", () => {
    setup();
    fireEvent.click(usbButton());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Portable Drives")).not.toBeInTheDocument();
  });

  it("describes each drive state and shows the right button", () => {
    const { props } = setup({
      portable: {
        drives: [
          drive("E:\\", { name: "Blank" }),
          drive("F:\\", { name: "Sealed", qre: true }),
          drive("G:\\", { name: "Open", qre: true, unlocked: true }),
        ],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault: jest.fn(),
      },
    });
    fireEvent.click(usbButton());
    expect(screen.getByText(/E:\\ •\s+Unformatted/)).toBeInTheDocument();
    expect(screen.getByText(/F:\\ •\s+Locked Vault/)).toBeInTheDocument();
    expect(screen.getByText(/G:\\ •\s+Unlocked/)).toBeInTheDocument();
    expect(screen.getAllByTitle("Format as Vault")).toHaveLength(1);
    expect(screen.getAllByTitle("Unlock")).toHaveLength(1);
    expect(screen.getAllByTitle("Lock")).toHaveLength(1);
    expect(props.portable.drives).toHaveLength(3);
  });

  it("falls back to the path when a drive has no name", () => {
    setup({
      portable: {
        drives: [drive("E:\\")],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault: jest.fn(),
      },
    });
    fireEvent.click(usbButton());
    expect(screen.getByText("E:\\")).toBeInTheDocument();
  });

  it("formats a blank drive and closes the menu", () => {
    const { props } = setup({
      portable: {
        drives: [drive("E:\\", { name: "Blank" })],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault: jest.fn(),
      },
    });
    fireEvent.click(usbButton());
    fireEvent.click(screen.getByTitle("Format as Vault"));
    expect(props.onInitDrive).toHaveBeenCalledWith("E:\\");
    expect(screen.queryByText("Portable Drives")).not.toBeInTheDocument();
  });

  it("unlocks a sealed drive and closes the menu", () => {
    const { props } = setup({
      portable: {
        drives: [drive("F:\\", { name: "Sealed", qre: true })],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault: jest.fn(),
      },
    });
    fireEvent.click(usbButton());
    fireEvent.click(screen.getByTitle("Unlock"));
    expect(props.onUnlockDrive).toHaveBeenCalledWith("F:\\");
    expect(screen.queryByText("Portable Drives")).not.toBeInTheDocument();
  });

  it("locks an open drive and leaves the menu open", () => {
    const lockVault = jest.fn();
    setup({
      portable: {
        drives: [drive("G:\\", { name: "Open", qre: true, unlocked: true })],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault,
      },
    });
    fireEvent.click(usbButton());
    fireEvent.click(screen.getByTitle("Lock"));
    expect(lockVault).toHaveBeenCalledWith("G:\\");
    expect(screen.getByText("Portable Drives")).toBeInTheDocument();
  });

  it("jumps into Secure_Locker when an unlocked drive name is clicked", () => {
    const { props } = setup({
      portable: {
        drives: [drive("G:\\", { name: "Open", qre: true, unlocked: true })],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault: jest.fn(),
      },
    });
    fireEvent.click(usbButton());
    fireEvent.click(screen.getByText("Open"));
    expect(props.onNavigate).toHaveBeenCalledWith("G:\\Secure_Locker");
    expect(screen.queryByText("Portable Drives")).not.toBeInTheDocument();
  });

  it("does not navigate when a locked drive name is clicked", () => {
    const { props } = setup({
      portable: {
        drives: [drive("F:\\", { name: "Sealed", qre: true })],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault: jest.fn(),
      },
    });
    fireEvent.click(usbButton());
    fireEvent.click(screen.getByText("Sealed"));
    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("Portable Drives")).toBeInTheDocument();
  });

  it("tints the USB icon green only while a drive is unlocked", () => {
    const first = setup();
    expect(usbButton().querySelector("svg")).toHaveAttribute("stroke", "currentColor");
    first.unmount();

    setup({
      portable: {
        drives: [drive("G:\\", { qre: true, unlocked: true })],
        isScanning: false,
        scanDrives: jest.fn(),
        lockVault: jest.fn(),
      },
    });
    expect(usbButton().querySelector("svg")).toHaveAttribute(
      "stroke",
      "var(--btn-success)",
    );
  });
});

describe("Toolbar - Android", () => {
  it("hides the USB menu", () => {
    mockPlatform.mockReturnValue("android");
    setup();
    expect(screen.queryByTitle("Portable USB Vaults")).not.toBeInTheDocument();
    expect(screen.getByText("Lock")).toBeInTheDocument();
  });

  it("keeps the USB menu if platform() throws", () => {
    mockPlatform.mockImplementation(() => {
      throw new Error("no os plugin");
    });
    setup();
    expect(usbButton()).toBeInTheDocument();
  });
});
