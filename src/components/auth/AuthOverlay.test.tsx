import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AuthOverlay } from "./AuthOverlay";

const mockWriteText = jest.fn();
const mockInvoke = jest.fn();

jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

type Props = React.ComponentProps<typeof AuthOverlay>;

function makeProps(over: Partial<Props> = {}): Props {
  return {
    view: "login",
    password: "",
    setPassword: jest.fn(),
    confirmPass: "",
    setConfirmPass: jest.fn(),
    recoveryCode: "QRE-AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD",
    setRecoveryCode: jest.fn(),
    onLogin: jest.fn(),
    onInit: jest.fn(),
    onRestoreBackup: jest.fn(),
    onRecovery: jest.fn(),
    onAckRecoveryCode: jest.fn(),
    onSwitchToRecovery: jest.fn(),
    onCancelRecovery: jest.fn(),
    ...over,
  };
}

function renderOverlay(over: Partial<Props> = {}) {
  const props = makeProps(over);
  const utils = render(<AuthOverlay {...props} />);
  return { props, ...utils };
}

function renderRecoveryDisplay() {
  return renderOverlay({ view: "recovery_display" });
}

const form = () => document.querySelector("form") as HTMLFormElement;
const fields = () => Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
const submitButton = () => document.querySelector("button[type='submit']") as HTMLButtonElement;

beforeEach(() => {
  mockInvoke.mockResolvedValue("alpha-bravo-charlie-delta");
});

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

  it("copies exactly the recovery code", async () => {
    renderRecoveryDisplay();
    await act(async () => {
      fireEvent.click(screen.getByText("Copy to Clipboard"));
    });
    expect(mockWriteText).toHaveBeenCalledWith("QRE-AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD");
  });

  it("still clears the clipboard if the user moves on before the 30 seconds are up", async () => {
    const { unmount } = renderRecoveryDisplay();
    await act(async () => {
      fireEvent.click(screen.getByText("Copy to Clipboard"));
    });
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(mockWriteText).toHaveBeenCalledWith("");
  });

  it("confirms the copy briefly, then goes back to the button", async () => {
    renderRecoveryDisplay();
    expect(screen.queryByText("Clipboard will clear in 30s")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("Copy to Clipboard"));
    });
    expect(screen.getByText("Copied!")).toBeInTheDocument();
    expect(screen.getByText("Clipboard will clear in 30s")).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Copy to Clipboard")).toBeInTheDocument();
    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
  });

  it("keeps showing 'Copied!' for two full seconds after the latest copy", async () => {
    renderRecoveryDisplay();
    await act(async () => {
      fireEvent.click(screen.getByText("Copy to Clipboard")); // t=0
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Copied!")); // t=1.5s
    });
    await act(async () => {
      jest.advanceTimersByTime(1000); // t=2.5s: the first copy's 2s are over, the second's are not
    });
    expect(screen.getByText("Copied!")).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(1000); // t=3.5s: 2s after the latest copy
    });
    expect(screen.getByText("Copy to Clipboard")).toBeInTheDocument();
  });

  it("shows no confirmation and schedules no wipe if the copy failed", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockWriteText.mockRejectedValue(new Error("denied"));
    renderRecoveryDisplay();
    await act(async () => {
      fireEvent.click(screen.getByText("Copy to Clipboard"));
    });
    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
    mockWriteText.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockWriteText).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("AuthOverlay - recovery code screen", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the code and a warning, and no sign-in form", () => {
    renderRecoveryDisplay();
    expect(screen.getByRole("heading", { name: "Recovery Code" })).toBeInTheDocument();
    expect(screen.getByText("QRE-AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD")).toBeInTheDocument();
    expect(screen.getByText("SAVE THIS CODE SECURELY")).toBeInTheDocument();
    expect(screen.getByText(/ONLY way to recover your data/)).toBeInTheDocument();
    expect(form()).toBeNull();
  });

  it("continues when the user says it is saved", () => {
    const { props } = renderRecoveryDisplay();
    fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
    expect(props.onAckRecoveryCode).toHaveBeenCalledTimes(1);
  });
});

describe("AuthOverlay - login", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows one password field and the right labels", () => {
    renderOverlay();
    expect(screen.getByRole("heading", { name: "Unlock Vault" })).toBeInTheDocument();
    expect(fields()).toHaveLength(1);
    expect(screen.getByPlaceholderText("Master Password")).toHaveAttribute("type", "password");
    expect(submitButton()).toHaveTextContent("Unlock");
  });

  it("has no strength meter, generator, restore link or cancel button", () => {
    renderOverlay({ password: "something" });
    expect(screen.queryByTitle("Generate Strong Passphrase")).not.toBeInTheDocument();
    expect(screen.queryByText("Restore from Backup instead")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByText("Very Weak")).not.toBeInTheDocument();
  });

  it("focuses the password field", () => {
    renderOverlay();
    expect(screen.getByPlaceholderText("Master Password")).toHaveFocus();
  });

  it("shows the typed password it was given and reports edits", () => {
    const { props } = renderOverlay({ password: "abc" });
    const field = screen.getByPlaceholderText("Master Password") as HTMLInputElement;
    expect(field.value).toBe("abc");
    fireEvent.change(field, { target: { value: "abcd" } });
    expect(props.setPassword).toHaveBeenCalledWith("abcd");
  });

  it("signs in on submit (Enter) and nothing else", () => {
    const { props } = renderOverlay();
    fireEvent.submit(form());
    expect(props.onLogin).toHaveBeenCalledTimes(1);
    expect(props.onInit).not.toHaveBeenCalled();
    expect(props.onRecovery).not.toHaveBeenCalled();
  });

  it("stops the browser from reloading the page on submit", () => {
    renderOverlay();
    expect(fireEvent.submit(form())).toBe(false);
  });

  it("offers the recovery route", () => {
    const { props } = renderOverlay();
    fireEvent.click(screen.getByText("Forgot Password?"));
    expect(props.onSwitchToRecovery).toHaveBeenCalledTimes(1);
  });
});

describe("AuthOverlay - first-time setup", () => {
  beforeEach(() => jest.clearAllMocks());

  it("asks for a new password twice", () => {
    renderOverlay({ view: "setup" });
    expect(screen.getByRole("heading", { name: "Setup QRE" })).toBeInTheDocument();
    expect(fields()).toHaveLength(2);
    expect(screen.getByPlaceholderText("New Master Password")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Confirm Password")).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent("Initialize");
  });

  it("initialises on submit and nothing else", () => {
    const { props } = renderOverlay({ view: "setup" });
    fireEvent.submit(form());
    expect(props.onInit).toHaveBeenCalledTimes(1);
    expect(props.onLogin).not.toHaveBeenCalled();
    expect(props.onRecovery).not.toHaveBeenCalled();
  });

  it("sends each field to its own setter", () => {
    const { props } = renderOverlay({ view: "setup" });
    fireEvent.change(screen.getByPlaceholderText("New Master Password"), { target: { value: "one" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm Password"), { target: { value: "two" } });
    expect(props.setPassword).toHaveBeenCalledWith("one");
    expect(props.setConfirmPass).toHaveBeenCalledWith("two");
  });

  it("rates the new password, but not the confirmation", () => {
    renderOverlay({ view: "setup", password: "abc", confirmPass: "abc" });
    expect(screen.getAllByText("Very Weak")).toHaveLength(1);
  });

  it("offers to generate a passphrase for the new password only", () => {
    renderOverlay({ view: "setup" });
    expect(screen.getAllByTitle("Generate Strong Passphrase")).toHaveLength(1);
  });

  it("puts a generated passphrase into the new password", async () => {
    const { props } = renderOverlay({ view: "setup" });
    fireEvent.click(screen.getByTitle("Generate Strong Passphrase"));
    await waitFor(() => expect(props.setPassword).toHaveBeenCalledWith("alpha-bravo-charlie-delta"));
  });

  it("offers to restore from a backup instead", () => {
    const { props } = renderOverlay({ view: "setup" });
    fireEvent.click(screen.getByText("Restore from Backup instead"));
    expect(props.onRestoreBackup).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Forgot Password?")).not.toBeInTheDocument();
  });

  it("focuses the new password", () => {
    renderOverlay({ view: "setup" });
    expect(screen.getByPlaceholderText("New Master Password")).toHaveFocus();
  });
});

describe("AuthOverlay - recovery", () => {
  beforeEach(() => jest.clearAllMocks());

  it("asks for the code first, then a new password twice", () => {
    renderOverlay({ view: "recovery_entry" });
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeInTheDocument();
    expect(fields()).toHaveLength(3);
    expect(fields()[0]).toHaveAttribute("placeholder", "Recovery Code (QRE-...)");
    expect(fields()[1]).toHaveAttribute("placeholder", "New Master Password");
    expect(fields()[2]).toHaveAttribute("placeholder", "Confirm Password");
    expect(submitButton()).toHaveTextContent("Reset & Login");
  });

  it("focuses the recovery code, not the password", () => {
    renderOverlay({ view: "recovery_entry" });
    expect(fields()[0]).toHaveFocus();
    expect(fields()[1]).not.toHaveFocus();
  });

  it("reports the typed code", () => {
    const { props } = renderOverlay({ view: "recovery_entry" });
    fireEvent.change(fields()[0], { target: { value: "QRE-1234" } });
    expect(props.setRecoveryCode).toHaveBeenCalledWith("QRE-1234");
  });

  it("recovers on submit and nothing else", () => {
    const { props } = renderOverlay({ view: "recovery_entry" });
    fireEvent.submit(form());
    expect(props.onRecovery).toHaveBeenCalledTimes(1);
    expect(props.onLogin).not.toHaveBeenCalled();
    expect(props.onInit).not.toHaveBeenCalled();
  });

  it("rates the new password and can generate one", () => {
    renderOverlay({ view: "recovery_entry", password: "abc" });
    expect(screen.getByText("Very Weak")).toBeInTheDocument();
    expect(screen.getAllByTitle("Generate Strong Passphrase")).toHaveLength(1);
  });

  it("has no link back to itself or to the backup restore", () => {
    renderOverlay({ view: "recovery_entry" });
    expect(screen.queryByText("Forgot Password?")).not.toBeInTheDocument();
    expect(screen.queryByText("Restore from Backup instead")).not.toBeInTheDocument();
  });

  it("goes back to login with Cancel, without submitting", () => {
    const { props } = renderOverlay({ view: "recovery_entry" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancelRecovery).toHaveBeenCalledTimes(1);
    expect(props.onRecovery).not.toHaveBeenCalled();
  });
});

describe("AuthOverlay - while the app is still starting", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not offer a form that could be submitted", () => {
    const { props } = renderOverlay({ view: "loading" });
    expect(form()).toBeNull();
    expect(fields()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Unlock" })).not.toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(props.onLogin).not.toHaveBeenCalled();
  });
});

describe("AuthOverlay - switching screens", () => {
  it("hides a revealed password again when the screen changes", () => {
    const props = makeProps({ view: "setup" });
    const { rerender } = render(<AuthOverlay {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Show password" })[0]);
    expect(screen.getByPlaceholderText("New Master Password")).toHaveAttribute("type", "text");

    rerender(<AuthOverlay {...props} view="recovery_entry" />);
    expect(screen.getByPlaceholderText("New Master Password")).toHaveAttribute("type", "password");
  });
});
