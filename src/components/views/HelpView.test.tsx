import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HelpView } from "./HelpView";

function setup() {
  const onOpenHelpModal = jest.fn();
  const onOpenAboutModal = jest.fn();
  render(<HelpView onOpenHelpModal={onOpenHelpModal} onOpenAboutModal={onOpenAboutModal} />);
  return { onOpenHelpModal, onOpenAboutModal };
}

describe("HelpView", () => {
  it("opens the help topics", () => {
    const { onOpenHelpModal, onOpenAboutModal } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Help Topics" }));
    expect(onOpenHelpModal).toHaveBeenCalledTimes(1);
    expect(onOpenAboutModal).not.toHaveBeenCalled();
  });

  it("opens the about box", () => {
    const { onOpenHelpModal, onOpenAboutModal } = setup();
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(onOpenAboutModal).toHaveBeenCalledTimes(1);
    expect(onOpenHelpModal).not.toHaveBeenCalled();
  });
});
