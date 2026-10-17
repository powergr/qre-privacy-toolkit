import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PlacesRail, samePlace } from "./PlacesRail";

const mockHome = jest.fn();
const mockDesktop = jest.fn();
const mockDocuments = jest.fn();
const mockDownloads = jest.fn();

jest.mock("@tauri-apps/api/path", () => ({
  homeDir: () => mockHome(),
  desktopDir: () => mockDesktop(),
  documentDir: () => mockDocuments(),
  downloadDir: () => mockDownloads(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockHome.mockResolvedValue("C:\\Users\\me");
  mockDesktop.mockResolvedValue("C:\\Users\\me\\Desktop");
  mockDocuments.mockResolvedValue("C:\\Users\\me\\Documents");
  mockDownloads.mockResolvedValue("C:\\Users\\me\\Downloads");
});

const places = () => Array.from(document.querySelectorAll(".places-rail__item")).map((b) => b.textContent);

describe("samePlace", () => {
  it("ignores slash kind, a trailing slash and letter case", () => {
    expect(samePlace("C:\\Users\\Me", "c:/users/me/")).toBe(true);
    expect(samePlace("/home/me", "/home/me/")).toBe(true);
  });
  it("tells different folders apart", () => {
    expect(samePlace("/home/me", "/home/me2")).toBe(false);
    expect(samePlace("/home/me", "/home/me/docs")).toBe(false);
  });
  it("never matches an empty path", () => {
    expect(samePlace("", "")).toBe(false);
    expect(samePlace("/", "")).toBe(false);
  });
});

describe("PlacesRail", () => {
  it("lists Home, Desktop, Documents and Downloads, in that order", async () => {
    render(<PlacesRail currentPath="" onNavigate={() => {}} />);
    await screen.findByText("Home");
    expect(places()).toEqual(["Home", "Desktop", "Documents", "Downloads"]);
    expect(screen.getByRole("navigation", { name: "Places" })).toBeInTheDocument();
  });

  it("opens the folder of a place when it is pressed", async () => {
    const onNavigate = jest.fn();
    render(<PlacesRail currentPath="" onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
    expect(onNavigate).toHaveBeenCalledWith("C:\\Users\\me\\Documents");
  });

  it("marks the place that is open, however its path is written", async () => {
    render(<PlacesRail currentPath="c:/users/me/downloads/" onNavigate={() => {}} />);
    const open = await screen.findByRole("button", { name: "Downloads" });
    expect(open).toHaveAttribute("aria-current", "page");
    expect(open).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("marks nothing when a subfolder of a place is open", async () => {
    render(<PlacesRail currentPath="C:\\Users\\me\\Documents\\Taxes" onNavigate={() => {}} />);
    await screen.findByText("Home");
    expect(document.querySelector(".places-rail__item.active")).toBeNull();
  });

  it("leaves out a folder the system cannot name", async () => {
    mockDesktop.mockRejectedValue(new Error("no desktop"));
    mockDocuments.mockResolvedValue("");
    render(<PlacesRail currentPath="" onNavigate={() => {}} />);
    await screen.findByText("Home");
    expect(places()).toEqual(["Home", "Downloads"]);
  });

  it("shows nothing at all when no folder can be found", async () => {
    mockHome.mockRejectedValue(new Error("x"));
    mockDesktop.mockRejectedValue(new Error("x"));
    mockDocuments.mockRejectedValue(new Error("x"));
    mockDownloads.mockRejectedValue(new Error("x"));
    const { container } = render(<PlacesRail currentPath="" onNavigate={() => {}} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("does not update after it was closed before the folders were known", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    let release!: (v: string) => void;
    mockHome.mockReturnValue(new Promise<string>((r) => (release = r)));
    const { unmount } = render(<PlacesRail currentPath="" onNavigate={() => {}} />);
    unmount();
    await act(async () => release("C:\\Users\\me"));
    await waitFor(() => expect(error).not.toHaveBeenCalled());
    error.mockRestore();
  });
});
