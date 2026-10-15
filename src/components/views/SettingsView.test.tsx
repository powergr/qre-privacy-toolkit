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
    const labels = screen.getAllByRole("button").map((b) => b.textContent?.trim());
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
    expect(screen.getByRole("button", { name: "Log Out" })).toHaveStyle({ color: "var(--btn-danger)" });
    expect(screen.getByRole("button", { name: "Theme" })).not.toHaveStyle({ color: "var(--btn-danger)" });
  });
});
