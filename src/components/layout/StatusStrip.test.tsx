import { act, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StatusStrip, formatCountdown, secondsLeft } from "./StatusStrip";

function setup(over: { deadline?: number; backupDone?: boolean } = {}) {
  const idleDeadlineRef = { current: over.deadline ?? 0 };
  const onBackup = jest.fn();
  const onLock = jest.fn();
  const utils = render(
    <StatusStrip idleDeadlineRef={idleDeadlineRef} backupDone={over.backupDone ?? true} onBackup={onBackup} onLock={onLock} />,
  );
  return { idleDeadlineRef, onBackup, onLock, ...utils };
}

beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:00:00Z")));
afterEach(() => jest.useRealTimers());

describe("formatCountdown", () => {
  it("writes minutes and two-digit seconds", () => {
    expect(formatCountdown(905)).toBe("15:05");
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(9)).toBe("0:09");
  });

  it("never shows a negative time and ignores fractions", () => {
    expect(formatCountdown(-5)).toBe("0:00");
    expect(formatCountdown(61.9)).toBe("1:01");
  });
});

describe("secondsLeft", () => {
  it("rounds up, so the last second still reads 0:01", () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(11_000, 10_000)).toBe(1);
    expect(secondsLeft(11_001, 10_000)).toBe(2);
  });

  it("stops at zero once the time has passed", () => {
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(5_000, 10_000)).toBe(0);
  });
});

describe("StatusStrip", () => {
  it("says the vault is unlocked", () => {
    setup();
    expect(screen.getByRole("region", { name: "Vault status" })).toHaveTextContent("Unlocked");
  });

  it("shows the time left before the app locks itself", () => {
    setup({ deadline: Date.now() + 905_000 });
    expect(screen.getByRole("timer")).toHaveTextContent("Auto-lock in 15:05");
  });

  it("counts down every second", () => {
    setup({ deadline: Date.now() + 65_000 });
    expect(screen.getByRole("timer")).toHaveTextContent("1:05");
    act(() => void jest.advanceTimersByTime(1000));
    expect(screen.getByRole("timer")).toHaveTextContent("1:04");
    act(() => void jest.advanceTimersByTime(4000));
    expect(screen.getByRole("timer")).toHaveTextContent("1:00");
  });

  it("follows a new deadline when activity pushes it back", () => {
    const { idleDeadlineRef } = setup({ deadline: Date.now() + 30_000 });
    expect(screen.getByRole("timer")).toHaveTextContent("0:30");
    idleDeadlineRef.current = Date.now() + 900_000;
    act(() => void jest.advanceTimersByTime(1000));
    expect(screen.getByRole("timer")).toHaveTextContent("14:59");
  });

  it("stops at 0:00", () => {
    setup({ deadline: Date.now() + 2000 });
    act(() => void jest.advanceTimersByTime(10_000));
    expect(screen.getByRole("timer")).toHaveTextContent("0:00");
  });

  it("shows no countdown when none is running", () => {
    setup({ deadline: 0 });
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("does not announce every tick to screen readers", () => {
    setup({ deadline: Date.now() + 60_000 });
    expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
  });

  it("confirms the keychain is backed up", () => {
    setup({ backupDone: true });
    expect(screen.getByText("Keychain backed up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Back up/ })).not.toBeInTheDocument();
  });

  it("warns when it is not, with a button to fix it", () => {
    const { onBackup } = setup({ backupDone: false });
    expect(screen.queryByText("Keychain backed up")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Keychain not backed up/ });
    expect(button).toHaveTextContent("Back up now");
    fireEvent.click(button);
    expect(onBackup).toHaveBeenCalledTimes(1);
  });

  it("has a Lock button", () => {
    const { onLock } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("stops its timer when it goes away", () => {
    const { unmount } = setup({ deadline: Date.now() + 60_000 });
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
