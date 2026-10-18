import { render, screen, fireEvent } from "../../test-support/rtl";
import "@testing-library/jest-dom";
import { RecoveryCodeNoticeModal } from "./RecoveryCodeNoticeModal";

function setup(reason: "password" | "recovery") {
  const props = { reason, onMakeNew: jest.fn(), onKeep: jest.fn() };
  render(<RecoveryCodeNoticeModal {...props} />);
  return props;
}

describe("RecoveryCodeNoticeModal", () => {
  it("after a password change, says the recovery code did not change and still opens the vault", () => {
    setup("password");
    expect(screen.getByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    expect(screen.getByText(/recovery code did not change/)).toBeInTheDocument();
    expect(screen.getByText(/with or without your new password/)).toBeInTheDocument();
  });

  it("after a recovery, says the code that was just used still works", () => {
    setup("recovery");
    expect(screen.getByRole("heading", { name: "Vault recovered" })).toBeInTheDocument();
    expect(screen.getByText(/it still works/)).toBeInTheDocument();
    expect(screen.queryByText(/recovery code did not change/)).not.toBeInTheDocument();
  });

  it.each(["password", "recovery"] as const)("%s: says what a new code does and that the old one stops at once", (reason) => {
    setup(reason);
    expect(screen.getByText(/If anyone else has seen the code, or you are not sure/)).toBeInTheDocument();
    expect(screen.getByText(/old code stops working at once/)).toBeInTheDocument();
  });

  it("offers a new code as the main action and keeping the old one as the other", () => {
    setup("password");
    expect(screen.getByRole("button", { name: "Make a new recovery code" })).toHaveClass("ui-btn--primary");
    expect(screen.getByRole("button", { name: "Keep my current code" })).toHaveClass("ui-btn--secondary");
  });

  it("Make a new recovery code asks for a new one and nothing else", () => {
    const props = setup("password");
    fireEvent.click(screen.getByRole("button", { name: "Make a new recovery code" }));
    expect(props.onMakeNew).toHaveBeenCalledTimes(1);
    expect(props.onKeep).not.toHaveBeenCalled();
  });

  it("Keep my current code, Escape and the close button all keep the code", () => {
    const props = setup("password");
    fireEvent.click(screen.getByRole("button", { name: "Keep my current code" }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onKeep).toHaveBeenCalledTimes(3);
    expect(props.onMakeNew).not.toHaveBeenCalled();
  });
});
