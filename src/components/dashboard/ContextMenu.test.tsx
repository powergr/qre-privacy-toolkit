import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContextMenu } from "./ContextMenu";

const mockPlatform = jest.fn();
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

const FILE = "C:\\docs\\a.txt";

type Props = Partial<React.ComponentProps<typeof ContextMenu>>;

function renderMenu(props: Props = {}) {
  const onClose = jest.fn();
  const onAction = jest.fn();
  const utils = render(
    <ContextMenu
      x={10}
      y={10}
      targetPath={FILE}
      isBackground={false}
      onClose={onClose}
      onAction={onAction}
      {...props}
    />,
  );
  return { onClose, onAction, ...utils };
}

const menu = () => document.querySelector(".dropdown-menu") as HTMLElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.mockReturnValue("windows");
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

describe("ContextMenu - file entries", () => {
  it("offers Lock (not Unlock) for a plain file and reports each action", () => {
    const { onAction } = renderMenu();
    expect(screen.queryByText("Unlock")).not.toBeInTheDocument();

    const clicks: [string, string][] = [
      ["Lock", "lock"],
      ["Cut", "cut"],
      ["Copy", "copy"],
      ["Rename", "rename"],
      ["Reveal in Explorer", "share"],
      ["Delete", "delete"],
    ];
    for (const [label, action] of clicks) {
      fireEvent.click(screen.getByText(label));
      expect(onAction).toHaveBeenLastCalledWith(action);
    }
    expect(onAction).toHaveBeenCalledTimes(clicks.length);
  });

  it("offers Unlock (not Lock or Time-Lock) for a .qre file", () => {
    const { onAction } = renderMenu({
      targetPath: "C:\\docs\\a.txt.qre",
      onTimeLock: jest.fn(),
    });
    expect(screen.queryByText("Lock")).not.toBeInTheDocument();
    expect(screen.queryByText(/Time-Lock/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Unlock"));
    expect(onAction).toHaveBeenCalledWith("unlock");
  });

  it("only treats the extension as .qre, not a name that merely contains it", () => {
    renderMenu({ targetPath: "C:\\docs\\a.qre.txt" });
    expect(screen.getByText("Lock")).toBeInTheDocument();
    expect(screen.queryByText("Unlock")).not.toBeInTheDocument();
  });

  it("shows Time-Lock only when the parent wired it, and closes before calling it", () => {
    const { rerender, onClose } = renderMenu();
    expect(screen.queryByText(/Time-Lock/)).not.toBeInTheDocument();

    const onTimeLock = jest.fn();
    const order: string[] = [];
    const close = jest.fn(() => order.push("close"));
    onTimeLock.mockImplementation(() => order.push("timelock"));
    rerender(
      <ContextMenu
        x={10}
        y={10}
        targetPath={FILE}
        isBackground={false}
        onClose={close}
        onAction={jest.fn()}
        onTimeLock={onTimeLock}
      />,
    );
    fireEvent.click(screen.getByText(/Time-Lock/));
    expect(onTimeLock).toHaveBeenCalledWith(FILE);
    expect(order).toEqual(["close", "timelock"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("has no background-only items on a file", () => {
    renderMenu({ canPaste: true });
    expect(screen.queryByText("Refresh")).not.toBeInTheDocument();
    expect(screen.queryByText("New Folder")).not.toBeInTheDocument();
    expect(screen.queryByText("Paste Here")).not.toBeInTheDocument();
  });
});

describe("ContextMenu - background", () => {
  it("offers Refresh and New Folder and nothing file-specific", () => {
    const { onAction } = renderMenu({ isBackground: true });
    fireEvent.click(screen.getByText("Refresh"));
    expect(onAction).toHaveBeenLastCalledWith("refresh");
    fireEvent.click(screen.getByText("New Folder"));
    expect(onAction).toHaveBeenLastCalledWith("new_folder");
    for (const label of ["Lock", "Unlock", "Cut", "Copy", "Rename", "Delete"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("shows Paste Here only when something can be pasted", () => {
    const { rerender, onAction } = renderMenu({ isBackground: true });
    expect(screen.queryByText("Paste Here")).not.toBeInTheDocument();

    rerender(
      <ContextMenu
        x={10}
        y={10}
        targetPath=""
        isBackground
        canPaste
        onClose={jest.fn()}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByText("Paste Here"));
    expect(onAction).toHaveBeenCalledWith("paste");
  });
});

describe("ContextMenu - Android", () => {
  it("swaps Reveal in Explorer for Open File", () => {
    mockPlatform.mockReturnValue("android");
    const { onAction } = renderMenu();
    expect(screen.queryByText("Reveal in Explorer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Open File"));
    expect(onAction).toHaveBeenCalledWith("open");
  });

  it("keeps the desktop item if platform() throws", () => {
    mockPlatform.mockImplementation(() => {
      throw new Error("no os plugin");
    });
    renderMenu();
    expect(screen.getByText("Reveal in Explorer")).toBeInTheDocument();
    expect(screen.queryByText("Open File")).not.toBeInTheDocument();
  });
});

describe("ContextMenu - closing", () => {
  it("closes on a click outside, and a right click outside only closes", () => {
    const { onClose } = renderMenu();
    const overlay = document.querySelector(".modal-overlay") as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);

    const notPrevented = fireEvent.contextMenu(overlay);
    expect(notPrevented).toBe(false); // preventDefault was called
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close when the click lands on the menu itself", () => {
    const { onClose } = renderMenu();
    fireEvent.click(menu());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ContextMenu - positioning", () => {
  it("anchors the top-left corner at the pointer in the upper-left area", () => {
    renderMenu({ x: 100, y: 50 });
    expect(menu().style.left).toBe("100px");
    expect(menu().style.top).toBe("50px");
    expect(menu().style.right).toBe("auto");
    expect(menu().style.bottom).toBe("auto");
  });

  it("opens leftwards when it would overflow the right edge", () => {
    renderMenu({ x: 900, y: 50 }); // 900 + 210 > 1000
    expect(menu().style.right).toBe("100px");
    expect(menu().style.left).toBe("auto");
  });

  it("fits exactly against the right edge without flipping", () => {
    renderMenu({ x: 790, y: 50 }); // 790 + 210 == 1000
    expect(menu().style.left).toBe("790px");
  });

  it("opens upwards when the pointer is in the lower half", () => {
    renderMenu({ x: 100, y: 700 });
    expect(menu().style.bottom).toBe("100px");
    expect(menu().style.top).toBe("auto");
  });

  it("stays downwards at exactly half the window height", () => {
    renderMenu({ x: 100, y: 400 });
    expect(menu().style.top).toBe("400px");
  });
});
