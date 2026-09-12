import { render, screen } from "@testing-library/react";
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
