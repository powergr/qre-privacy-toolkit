import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsView } from "./SettingsView";

function setup() {
  const props = {
    onTheme: jest.fn(),
    onBackup: jest.fn(),
    onChangePassword: jest.fn(),
    onReset2FA: jest.fn(),
    onUpdate: jest.fn(),
    onLogout: jest.fn(),
  };
  render(<SettingsView {...props} />);
  return props;
}

describe("SettingsView", () => {
  it("lists the settings in order, with Log Out last", () => {
    setup();
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Theme", "Backup", "Change Password", "Reset 2FA", "Check Updates", "Log Out"]);
  });

  it.each([
    ["Theme", "onTheme"],
    ["Backup", "onBackup"],
    ["Change Password", "onChangePassword"],
    ["Reset 2FA", "onReset2FA"],
    ["Check Updates", "onUpdate"],
    ["Log Out", "onLogout"],
  ] as const)("%s calls %s and nothing else", (label, handler) => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: label }));

    for (const [name, fn] of Object.entries(props)) {
      expect(fn).toHaveBeenCalledTimes(name === handler ? 1 : 0);
    }
  });

  it("marks Log Out as the one destructive action", () => {
    setup();
    expect(screen.getByRole("button", { name: "Log Out" })).toHaveClass("settings-row--danger");
    expect(screen.getByRole("button", { name: "Theme" })).not.toHaveClass("settings-row--danger");
  });
});

describe("SettingsView - groups, hints and Help", () => {
  const noop = () => {};
  const base = { onTheme: noop, onBackup: noop, onChangePassword: noop, onReset2FA: noop, onUpdate: noop, onLogout: noop };

  it("sorts the rows into Appearance, Security and App", () => {
    render(<SettingsView {...base} />);
    const groups = screen.getAllByRole("region").map((g) => ({
      title: g.querySelector("h3")!.textContent,
      rows: Array.from(g.querySelectorAll("button")).map((b) => b.getAttribute("aria-label")),
    }));
    expect(groups).toEqual([
      { title: "Appearance", rows: ["Theme"] },
      { title: "Security", rows: ["Backup", "Change Password", "Reset 2FA"] },
      { title: "App", rows: ["Check Updates"] },
    ]);
  });

  it("describes each row in a line of its own, without changing the button's name", () => {
    render(<SettingsView {...base} />);
    const row = screen.getByRole("button", { name: "Backup" });
    expect(row).toHaveAccessibleDescription("Save a copy of your keychain.");
  });

  it("has no Help rows unless it is given somewhere to send them", () => {
    render(<SettingsView {...base} />);
    expect(screen.queryByRole("button", { name: "Help Topics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "About" })).not.toBeInTheDocument();
  });

  it("adds Help Topics and About to the App group, before Log Out", () => {
    const onHelp = jest.fn();
    const onAbout = jest.fn();
    render(<SettingsView {...base} onHelp={onHelp} onAbout={onAbout} />);
    const app = screen.getByRole("region", { name: "App" });
    expect(Array.from(app.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Check Updates",
      "Help Topics",
      "About",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Help Topics" }));
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(onHelp).toHaveBeenCalledTimes(1);
    expect(onAbout).toHaveBeenCalledTimes(1);
    const all = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(all[all.length - 1]).toBe("Log Out");
  });
});
