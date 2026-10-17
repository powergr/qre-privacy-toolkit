import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BottomBar } from "./BottomBar";

const labels = () => screen.getAllByRole("button").map((b) => b.textContent);
const current = () => screen.queryAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.textContent);

describe("BottomBar", () => {
  it("has five places, in the order of the thumb: Home, Files, Passwords, Tools, More", () => {
    render(<BottomBar activeTab="home" setTab={() => {}} />);
    expect(labels()).toEqual(["Home", "Files", "Passwords", "Tools", "More"]);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it.each([
    ["Home", "home"],
    ["Files", "files"],
    ["Passwords", "vault"],
    ["Tools", "tools"],
    ["More", "settings"],
  ])("%s opens %s", (label, tab) => {
    const setTab = jest.fn();
    render(<BottomBar activeTab="home" setTab={setTab} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(setTab).toHaveBeenCalledWith(tab);
    expect(setTab).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["home", "Home"],
    ["files", "Files"],
    ["vault", "Passwords"],
    ["settings", "More"],
    ["help", "More"],
  ])("marks only %s's place as current", (tab, label) => {
    render(<BottomBar activeTab={tab} setTab={() => {}} />);
    expect(current()).toEqual([label]);
  });

  it.each(["tools", "notes", "bookmarks", "clipboard", "breach", "hash", "analyzer", "sysclean", "cleaner", "shred", "qr"])(
    "keeps Tools marked while %s is open",
    (tab) => {
      render(<BottomBar activeTab={tab} setTab={() => {}} />);
      expect(current()).toEqual(["Tools"]);
    },
  );
});
