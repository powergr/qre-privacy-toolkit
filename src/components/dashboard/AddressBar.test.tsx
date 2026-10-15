import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AddressBar } from "./AddressBar";

const mockPlatform = jest.fn();

jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

function renderBar(currentPath: string) {
  return render(
    <AddressBar
      currentPath={currentPath}
      onNavigate={jest.fn()}
      onGoUp={jest.fn()}
      onGoHome={jest.fn()}
    />,
  );
}

function setup(currentPath: string) {
  const onNavigate = jest.fn();
  const onGoUp = jest.fn();
  const onGoHome = jest.fn();
  const utils = render(
    <AddressBar
      currentPath={currentPath}
      onNavigate={onNavigate}
      onGoUp={onGoUp}
      onGoHome={onGoHome}
    />,
  );
  return { onNavigate, onGoUp, onGoHome, ...utils };
}

const breadcrumbs = () => document.querySelector(".breadcrumbs") as HTMLElement;
const input = () => screen.getByRole("textbox") as HTMLInputElement;

describe("AddressBar - platform-based path separator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("splits a Unix path on '/' when platform() reports linux", () => {
    mockPlatform.mockReturnValue("linux");
    renderBar("/home/test");

    // If the separator were wrongly '\\', the whole "/home/test" string
    // would render as a single, unsplit breadcrumb instead of two segments.
    expect(screen.getByText("home")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.queryByText("/home/test")).not.toBeInTheDocument();
  });

  it("splits a Windows path on '\\\\' when platform() reports windows", () => {
    mockPlatform.mockReturnValue("windows");
    renderBar("C:\\Users\\test");

    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("falls back to user-agent sniffing without crashing if platform() throws", () => {
    mockPlatform.mockImplementation(() => {
      throw new Error("not available in this context");
    });

    expect(() => renderBar("/home/test")).not.toThrow();
  });
});

describe("AddressBar - breadcrumbs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatform.mockReturnValue("windows");
  });

  it("jumps to the clicked Windows folder, with a trailing slash on the drive", () => {
    const { onNavigate } = setup("C:\\Users\\test\\Docs");
    fireEvent.click(screen.getByText("C:"));
    expect(onNavigate).toHaveBeenLastCalledWith("C:\\");
    fireEvent.click(screen.getByText("Users"));
    expect(onNavigate).toHaveBeenLastCalledWith("C:\\Users");
    fireEvent.click(screen.getByText("Docs"));
    expect(onNavigate).toHaveBeenLastCalledWith("C:\\Users\\test\\Docs");
  });

  it("jumps to the clicked Unix folder with a leading slash", () => {
    mockPlatform.mockReturnValue("linux");
    const { onNavigate } = setup("/home/me/docs");
    fireEvent.click(screen.getByText("home"));
    expect(onNavigate).toHaveBeenLastCalledWith("/home");
    fireEvent.click(screen.getByText("me"));
    expect(onNavigate).toHaveBeenLastCalledWith("/home/me");
  });

  it("clicking a crumb navigates without opening the editor", () => {
    setup("C:\\Users");
    fireEvent.click(screen.getByText("Users"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("the home icon goes home without opening the editor", () => {
    const { onGoHome } = setup("C:\\Users");
    fireEvent.click(document.querySelector(".crumb") as HTMLElement);
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("marks the home crumb active only at the root list", () => {
    const first = setup("");
    expect(document.querySelector(".crumb")).toHaveClass("active");
    first.unmount();
    setup("C:\\");
    expect(document.querySelector(".crumb")).not.toHaveClass("active");
  });

  it("shows no folder crumbs for an empty path", () => {
    setup("");
    expect(document.querySelectorAll(".crumb")).toHaveLength(1);
  });

  it("the up button goes up", () => {
    const { onGoUp } = setup("C:\\Users");
    fireEvent.click(screen.getByTitle("Up One Directory"));
    expect(onGoUp).toHaveBeenCalledTimes(1);
  });
});

describe("AddressBar - editing the path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatform.mockReturnValue("windows");
  });

  it("opens an input with the current path focused and selected", () => {
    setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    expect(input().value).toBe("C:\\Users");
    expect(input()).toHaveFocus();
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("C:\\Users".length);
  });

  it("Enter navigates to the trimmed text and closes the editor", () => {
    const { onNavigate } = setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    fireEvent.change(input(), { target: { value: "  D:\\Data  " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("D:\\Data");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not navigate when nothing changed", () => {
    const { onNavigate } = setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("treats trailing spaces alone as no change", () => {
    const { onNavigate } = setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    fireEvent.change(input(), { target: { value: "C:\\Users   " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("Escape discards the edit", () => {
    const { onNavigate } = setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    fireEvent.change(input(), { target: { value: "D:\\Elsewhere" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    // Reopening starts from the real path again, not the abandoned text.
    fireEvent.click(breadcrumbs());
    expect(input().value).toBe("C:\\Users");
  });

  it("leaving the field commits what was typed", () => {
    const { onNavigate } = setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    fireEvent.change(input(), { target: { value: "D:\\Data" } });
    fireEvent.blur(input());
    expect(onNavigate).toHaveBeenCalledWith("D:\\Data");
  });

  it("ignores other keys", () => {
    const { onNavigate } = setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    fireEvent.keyDown(input(), { key: "a" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(input()).toBeInTheDocument();
  });

  it("the X cancels the edit and does not navigate", async () => {
    // A real click blurs the field first (mouse down moves focus), and the field commits on
    // blur. The X must therefore win that race, or "cancel" would navigate to the typed text.
    const user = userEvent.setup();
    const { onNavigate } = setup("C:\\Users");
    await user.click(breadcrumbs());
    await user.clear(input());
    await user.type(input(), "D:\\Typed");
    await user.click(document.querySelector("svg.lucide-x") as SVGElement);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the new path after the folder changes underneath the editor", () => {
    const { rerender } = setup("C:\\Users");
    fireEvent.click(breadcrumbs());
    rerender(
      <AddressBar
        currentPath={"C:\\Other"}
        onNavigate={jest.fn()}
        onGoUp={jest.fn()}
        onGoHome={jest.fn()}
      />,
    );
    expect(input().value).toBe("C:\\Other");
  });
});
