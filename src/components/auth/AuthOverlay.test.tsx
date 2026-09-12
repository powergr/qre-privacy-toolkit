import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AuthOverlay } from "./AuthOverlay";

const mockWriteText = jest.fn();

jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));

function renderRecoveryDisplay() {
  return render(
    <AuthOverlay
      view="recovery_display"
      password=""
      setPassword={jest.fn()}
      confirmPass=""
      setConfirmPass={jest.fn()}
      recoveryCode="QRE-AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD"
      setRecoveryCode={jest.fn()}
      onLogin={jest.fn()}
      onInit={jest.fn()}
      onRestoreBackup={jest.fn()}
      onRecovery={jest.fn()}
      onAckRecoveryCode={jest.fn()}
      onSwitchToRecovery={jest.fn()}
      onCancelRecovery={jest.fn()}
    />,
  );
}

describe("AuthOverlay - recovery code clipboard auto-clear", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockWriteText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("restarts the 30s clear window on a second copy instead of clearing early", async () => {
    // Regression test: the clear timer used to be a bare setTimeout with no
    // way to cancel a previous one, so copying twice within the window
    // still cleared at the first copy's original 30s mark - here, only 5s
    // after the second copy - instead of extending it.
    renderRecoveryDisplay();
    const copyButton = screen.getByText("Copy to Clipboard");

    await act(async () => {
      fireEvent.click(copyButton); // copy #1 at t=0
    });

    await act(async () => {
      jest.advanceTimersByTime(25_000); // t=25s
    });

    await act(async () => {
      fireEvent.click(copyButton); // copy #2 at t=25s, should reset the window
    });

    await act(async () => {
      jest.advanceTimersByTime(10_000); // t=35s: 35s after copy #1, 10s after copy #2
    });

    // The old bug would have cleared here (30s after copy #1).
    expect(mockWriteText).not.toHaveBeenCalledWith("");

    await act(async () => {
      jest.advanceTimersByTime(20_000); // t=55s: 30s after copy #2
    });

    expect(mockWriteText).toHaveBeenCalledWith("");
  });

  it("clears the clipboard 30s after a single copy", async () => {
    renderRecoveryDisplay();

    await act(async () => {
      fireEvent.click(screen.getByText("Copy to Clipboard"));
    });

    expect(mockWriteText).not.toHaveBeenCalledWith("");

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });

    expect(mockWriteText).toHaveBeenCalledWith("");
  });
});
