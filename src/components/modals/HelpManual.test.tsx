import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HelpManual } from "./HelpManual";

function setup() {
  render(<HelpManual onScrollTo={jest.fn()} />);
}

describe("HelpManual - time-lock", () => {
  it("says what the time-lock does and does not do", () => {
    setup();
    expect(screen.getByRole("heading", { name: "What Time-Lock Does and Does Not Do" })).toBeInTheDocument();
    expect(screen.getByText(/kept by the app, not by the encryption/)).toBeInTheDocument();
  });

  it("admits the ways around it", () => {
    setup();
    expect(screen.getByText(/knows your master password and has the right tools/)).toBeInTheDocument();
    expect(screen.getByText(/setting the device clock forward can also open the file/)).toBeInTheDocument();
  });

  it("says the date can be read without the password", () => {
    setup();
    expect(screen.getByText(/readable without the password/)).toBeInTheDocument();
  });

  it("does not promise the lock holds against its owner", () => {
    setup();
    expect(screen.getByText(/must stay closed even to you, do not rely on this alone/)).toBeInTheDocument();
  });
});

describe("HelpManual - verify after locking", () => {
  it("explains the check and where to switch it off", () => {
    setup();
    expect(screen.getByText(/opens each new file once to check it/)).toBeInTheDocument();
    expect(screen.getByText("Verify After Locking")).toBeInTheDocument();
  });
});

describe("HelpManual - upgrading older locked files", () => {
  it("explains what the upgrade is for and how to start it", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Upgrading Older Locked Files" })).toBeInTheDocument();
    expect(screen.getByText(/show their file names to anyone who has them/)).toBeInTheDocument();
    expect(screen.getByText("Upgrade Older Locked Files…")).toBeInTheDocument();
  });

  it("says each file is checked before it replaces the old one, and that a failure leaves it alone", () => {
    setup();
    expect(screen.getByText(/checked from start to finish, and only then replaces the old one/)).toBeInTheDocument();
    expect(screen.getByText(/that file is left as it was/)).toBeInTheDocument();
  });

  it("covers time-locked files, key files and USB vaults", () => {
    setup();
    expect(screen.getByText(/Upgrade it after the lock ends/)).toBeInTheDocument();
    expect(screen.getByText(/needs that key file/)).toBeInTheDocument();
    expect(screen.getByText(/belong to a USB vault need that vault to be unlocked/)).toBeInTheDocument();
  });

  it("warns that older apps cannot open an upgraded file", () => {
    setup();
    expect(screen.getByText(/Older versions of the app cannot open an upgraded file/)).toBeInTheDocument();
  });
});

describe("HelpManual - the recovery code after a password change", () => {
  it("says the code keeps working and how to replace it", () => {
    setup();
    expect(screen.getByText("The Recovery Code keeps working.")).toBeInTheDocument();
    expect(screen.getByText(/anyone who has seen the code can still open your vault/)).toBeInTheDocument();
    expect(screen.getByText(/the old code stops working at once/i)).toBeInTheDocument();
  });
});

describe("HelpManual - the two shortcuts for upgrading", () => {
  it("explains upgrading a single file from the right-click menu", () => {
    setup();
    expect(screen.getByText("Upgrade Format")).toBeInTheDocument();
    expect(screen.getByText(/appears only for files that need it/)).toBeInTheDocument();
    expect(screen.getByText(/the old ones among them are upgraded/)).toBeInTheDocument();
  });

  it("explains the automatic setting, that it is off by default and why", () => {
    setup();
    expect(screen.getByText("Upgrade Older Files When Unlocking")).toBeInTheDocument();
    expect(screen.getByText(/It is off until you turn it on/)).toBeInTheDocument();
    expect(screen.getByText(/because it replaces files without asking each time/)).toBeInTheDocument();
    expect(screen.getByText(/only touches files that unlocked/)).toBeInTheDocument();
  });
});

describe("HelpManual - seeing which files are old", () => {
  it("points to the Details panel and names both badges", () => {
    setup();
    expect(screen.getByText(/select one and open/)).toBeInTheDocument();
    expect(screen.getByText("Older format")).toBeInTheDocument();
    expect(screen.getByText("Current format")).toBeInTheDocument();
    expect(screen.getByText(/Details counts the older ones/)).toBeInTheDocument();
  });
});

describe("HelpManual - stopping a long job", () => {
  it("says Esc and Cancel stop it, what happens to the file, and what cannot be stopped", () => {
    setup();
    expect(screen.getByText("Stopping a Long Job")).toBeInTheDocument();
    expect(screen.getByText(/stop locking, unlocking, upgrading or time-locking/)).toBeInTheDocument();
    expect(screen.getByText(/your original is not touched/)).toBeInTheDocument();
    expect(screen.getByText(/Files that were already finished before you stopped stay finished/)).toBeInTheDocument();
    expect(screen.getByText(/Copying, moving and deleting cannot be stopped/)).toBeInTheDocument();
  });

  it("lists Esc for cancelling in the shortcuts", () => {
    setup();
    expect(screen.getByText("Files, while locking or unlocking")).toBeInTheDocument();
    expect(screen.getByText(/Cancel the job that is running/)).toBeInTheDocument();
  });
});

describe("HelpManual - copy and paste between programs", () => {
  it("explains the shortcuts, Explorer on Windows, and the limit on other systems", () => {
    setup();
    expect(screen.getByText("Copy and Paste Between Programs")).toBeInTheDocument();
    expect(screen.getByText(/so you can paste them in Explorer/)).toBeInTheDocument();
    expect(screen.getByText(/work only inside QRE for now/)).toBeInTheDocument();
  });

  it("lists the copy, cut and paste keys in the shortcuts", () => {
    setup();
    expect(screen.getByText("Ctrl+C, Ctrl+X, Ctrl+V")).toBeInTheDocument();
    expect(screen.getByText(/files copied there can be pasted here/)).toBeInTheDocument();
  });
});
