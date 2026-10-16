import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommandPalette } from "./CommandPalette";
import { filterCommands, type PaletteCommand } from "./paletteCommands";

function makeCommands() {
  const run = {
    notes: jest.fn(),
    vault: jest.fn(),
    qr: jest.fn(),
    shred: jest.fn(),
    lock: jest.fn(),
    theme: jest.fn(),
  };
  const commands: PaletteCommand[] = [
    { id: "notes", label: "Secure Notes", section: "Tools", hint: "Protect", keywords: ["write", "markdown"], run: run.notes },
    { id: "vault", label: "Passwords Vault", section: "Tools", hint: "Protect", keywords: ["login", "2fa"], run: run.vault },
    { id: "qr", label: "QR Generator", section: "Tools", hint: "Create", keywords: ["wifi", "code"], run: run.qr },
    { id: "shred", label: "Shredder", section: "Tools", hint: "Clean up", keywords: ["delete", "wipe"], run: run.shred },
    { id: "lock", label: "Lock now", section: "Actions", keywords: ["logout"], run: run.lock },
    { id: "theme", label: "Change theme", section: "Actions", keywords: ["dark", "light"], run: run.theme },
  ];
  return { commands, run };
}

function open() {
  const { commands, run } = makeCommands();
  const onClose = jest.fn();
  const utils = render(<CommandPalette commands={commands} onClose={onClose} />);
  const input = screen.getByRole("combobox", { name: "Jump to a tool or action" }) as HTMLInputElement;
  const type = (text: string) => fireEvent.change(input, { target: { value: text } });
  const key = (k: string) => fireEvent.keyDown(input, { key: k });
  const options = () => screen.queryAllByRole("option").map((o) => o.textContent);
  return { ...utils, run, onClose, input, type, key, options };
}

describe("filterCommands", () => {
  const { commands } = makeCommands();
  const ids = (q: string) => filterCommands(commands, q).map((c) => c.id);

  it("returns everything, in order, for an empty search", () => {
    expect(ids("")).toEqual(["notes", "vault", "qr", "shred", "lock", "theme"]);
    expect(ids("   ")).toEqual(["notes", "vault", "qr", "shred", "lock", "theme"]);
  });

  it("matches part of a name without regard to case", () => {
    expect(ids("SHRED")).toEqual(["shred"]);
    expect(ids("gen")).toEqual(["qr"]);
  });

  it("matches the extra search words", () => {
    expect(ids("wifi")).toEqual(["qr"]);
    expect(ids("login")).toEqual(["vault"]);
    expect(ids("logout")).toEqual(["lock"]);
  });

  it("matches the extra search words from their start only", () => {
    expect(ids("log")).toEqual(["vault", "lock"]);
    expect(ids("ogin")).toEqual([]);
    expect(ids("2f")).toEqual(["vault"]);
  });

  it("matches each part of a search word that has a space or a hyphen", () => {
    const list: PaletteCommand[] = [
      { id: "a", label: "Alpha", section: "Tools", keywords: ["time-lock", "new code"], run: () => {} },
    ];
    expect(filterCommands(list, "lock").map((c) => c.id)).toEqual(["a"]);
    expect(filterCommands(list, "code").map((c) => c.id)).toEqual(["a"]);
    expect(filterCommands(list, "ock")).toEqual([]);
  });

  it("needs every typed word to match, in any order", () => {
    expect(ids("notes secure")).toEqual(["notes"]);
    expect(ids("qr wifi")).toEqual(["qr"]);
    expect(ids("notes wifi")).toEqual([]);
  });

  it("finds nothing for text that matches nothing", () => {
    expect(ids("zzz")).toEqual([]);
  });

  it("ranks a name that starts with the text before one that only contains it", () => {
    const list: PaletteCommand[] = [
      { id: "b", label: "Metadata Cleaner", section: "Tools", run: () => {} },
      { id: "a", label: "Clean Up", section: "Tools", run: () => {} },
    ];
    expect(filterCommands(list, "clean").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("ranks the start of a word before the middle of one", () => {
    const list: PaletteCommand[] = [
      { id: "middle", label: "Retools", section: "Tools", run: () => {} },
      { id: "word", label: "Photo Tools", section: "Tools", run: () => {} },
      { id: "name", label: "Toolbox", section: "Tools", run: () => {} },
    ];
    expect(filterCommands(list, "too").map((c) => c.id)).toEqual(["name", "word", "middle"]);
  });

  it("ranks a match in the search words below a match in the name", () => {
    const list: PaletteCommand[] = [
      { id: "kw", label: "Alpha", section: "Tools", keywords: ["shred"], run: () => {} },
      { id: "name", label: "Shredder", section: "Tools", run: () => {} },
    ];
    expect(filterCommands(list, "shred").map((c) => c.id)).toEqual(["name", "kw"]);
  });

  it("keeps the given order for equal matches, and does not change the input", () => {
    const first: PaletteCommand = { id: "a", label: "Alpha Tool", section: "Tools", run: () => {} };
    const second: PaletteCommand = { id: "b", label: "Beta Tool", section: "Tools", run: () => {} };
    const input = [first, second];
    expect(filterCommands(input, "tool").map((c) => c.id)).toEqual(["a", "b"]);
    expect(filterCommands([second, first], "tool").map((c) => c.id)).toEqual(["b", "a"]);
    expect(input).toEqual([first, second]);
  });
});

describe("CommandPalette", () => {
  it("is a dialog with a search box that has focus", () => {
    const { input } = open();
    expect(screen.getByRole("dialog", { name: "Jump to a tool or action" })).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("lists everything under its section headings before anything is typed", () => {
    const { options } = open();
    expect(options()).toEqual(["Secure NotesProtect", "Passwords VaultProtect", "QR GeneratorCreate", "ShredderClean up", "Lock now", "Change theme"]);
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });

  it("filters as you type and names the section instead of headings", () => {
    const { type, options } = open();
    type("wifi");
    expect(options()).toEqual(["QR GeneratorTools"]);
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  it("drops the section headings while searching, and brings them back when cleared", () => {
    const { type } = open();
    expect(document.querySelectorAll(".palette__section")).toHaveLength(2);
    type("e");
    expect(document.querySelectorAll(".palette__section")).toHaveLength(0);
    type("");
    expect(document.querySelectorAll(".palette__section")).toHaveLength(2);
  });

  it("highlights the first match and moves with the arrow keys, wrapping around", () => {
    const { key } = open();
    const selected = () => screen.getByRole("option", { selected: true }).textContent;
    expect(selected()).toMatch(/^Secure Notes/);
    key("ArrowDown");
    expect(selected()).toMatch(/^Passwords Vault/);
    key("ArrowUp");
    key("ArrowUp");
    expect(selected()).toMatch(/^Change theme/);
    key("ArrowDown");
    expect(selected()).toMatch(/^Secure Notes/);
  });

  it("jumps to the first and last result with Home and End", () => {
    const { key } = open();
    key("End");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Change theme");
    key("Home");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Secure Notes");
  });

  it("points the search box at the highlighted result for screen readers", () => {
    const { input, key } = open();
    const active = () => document.getElementById(input.getAttribute("aria-activedescendant")!);
    expect(active()).toHaveTextContent("Secure Notes");
    key("ArrowDown");
    expect(active()).toHaveTextContent("Passwords Vault");
  });

  it("starts again at the best match after the search changes", () => {
    const { key, type } = open();
    key("ArrowDown");
    key("ArrowDown");
    type("s");
    expect(screen.getByRole("option", { selected: true })).toBeInTheDocument();
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
  });

  it("runs the highlighted command with Enter and closes first", () => {
    const { key, run, onClose } = open();
    const order: string[] = [];
    onClose.mockImplementation(() => order.push("close"));
    run.vault.mockImplementation(() => order.push("run"));
    key("ArrowDown");
    key("Enter");
    expect(run.vault).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["close", "run"]);
  });

  it("runs the best match for what was typed", () => {
    const { type, key, run } = open();
    type("wipe");
    key("Enter");
    expect(run.shred).toHaveBeenCalledTimes(1);
    expect(run.notes).not.toHaveBeenCalled();
  });

  it("runs a command that is clicked", () => {
    const { run, onClose } = open();
    fireEvent.click(screen.getByRole("option", { name: /Lock now/ }));
    expect(run.lock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("follows the mouse with the highlight", () => {
    open();
    const row = screen.getByRole("option", { name: /Shredder/ });
    fireEvent.mouseMove(row);
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  it("says so when nothing matches, and Enter does nothing", () => {
    const { type, key, run, onClose } = open();
    type("zzzz");
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches “zzzz”");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    key("Enter");
    key("ArrowDown");
    key("ArrowUp");
    expect(onClose).not.toHaveBeenCalled();
    Object.values(run).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it("closes with Escape", () => {
    const { onClose } = open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with Ctrl K, the key that opened it", () => {
    const { onClose } = open();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the dimmed page around it is pressed, but not when the box is", () => {
    const { onClose } = open();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".palette-overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("counts as an open dialog, so shortcuts behind it pause", () => {
    open();
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
  });

  it("ignores other keys", () => {
    const { key, onClose } = open();
    key("a");
    key("Tab");
    expect(onClose).not.toHaveBeenCalled();
  });
});
