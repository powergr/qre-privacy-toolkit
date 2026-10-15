import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PasswordInput } from "./PasswordInput";

const mockInvoke = jest.fn();
const mockStrength = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("../../utils/security", () => ({
  ...jest.requireActual("../../utils/security"),
  getPasswordStrength: (v: string) => mockStrength(v),
}));

type Props = Partial<React.ComponentProps<typeof PasswordInput>>;

function setup(props: Props = {}) {
  const onChange = jest.fn();
  const utils = render(<PasswordInput value="" onChange={onChange} {...props} />);
  return { onChange, ...utils };
}

const input = () => document.querySelector("input") as HTMLInputElement;
const eye = () => screen.getByRole("button", { name: /password$/i });
const generate = () => screen.queryByTitle("Generate Strong Passphrase");

beforeEach(() => {
  jest.clearAllMocks();
  mockStrength.mockReturnValue({ score: 0, feedback: "Very Weak (Too short)" });
  mockInvoke.mockResolvedValue("alpha-bravo-charlie-delta");
});

describe("PasswordInput - the field", () => {
  it("is a hidden password field with a default placeholder", () => {
    setup();
    expect(input()).toHaveAttribute("type", "password");
    expect(input()).toHaveAttribute("placeholder", "Password");
  });

  it("uses the given placeholder, value and class", () => {
    setup({ placeholder: "Master Password", value: "abc", className: "custom" });
    expect(input()).toHaveAttribute("placeholder", "Master Password");
    expect(input().value).toBe("abc");
    expect(input()).toHaveClass("custom", "has-icon");
    expect(input()).not.toHaveClass("auth-input");
  });

  it("uses the auth-input class by default", () => {
    setup();
    expect(input()).toHaveClass("auth-input", "has-icon");
  });

  it("reports what the user types", () => {
    const { onChange } = setup();
    fireEvent.change(input(), { target: { value: "hunter2" } });
    expect(onChange).toHaveBeenCalledWith("hunter2");
  });

  it("takes focus only when asked to", () => {
    const first = setup({ autoFocus: true });
    expect(input()).toHaveFocus();
    first.unmount();
    setup();
    expect(input()).not.toHaveFocus();
  });

  it("makes room for one button, or two when it can generate", () => {
    const first = setup();
    expect(input().style.paddingRight).toBe("40px");
    first.unmount();
    setup({ allowGenerate: true });
    expect(input().style.paddingRight).toBe("70px");
  });
});

describe("PasswordInput - show and hide", () => {
  it("toggles between hidden and visible", () => {
    setup({ value: "secret" });
    expect(input()).toHaveAttribute("type", "password");
    fireEvent.click(eye());
    expect(input()).toHaveAttribute("type", "text");
    expect(input().value).toBe("secret");
    fireEvent.click(eye());
    expect(input()).toHaveAttribute("type", "password");
  });

  it("names the button for what it will do", () => {
    setup();
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
  });

  it("is skipped by the Tab key so typing flows on to the next field", () => {
    setup();
    expect(eye()).toHaveAttribute("tabindex", "-1");
  });

  it("does not submit a surrounding form", () => {
    const onSubmit = jest.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput value="" onChange={jest.fn()} allowGenerate />
      </form>,
    );
    fireEvent.click(eye());
    fireEvent.click(generate()!);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("PasswordInput - generating a passphrase", () => {
  it("offers the generator only when allowed", () => {
    const first = setup();
    expect(generate()).not.toBeInTheDocument();
    first.unmount();
    setup({ allowGenerate: true });
    expect(generate()).toBeInTheDocument();
  });

  it("fills in a passphrase from the backend and reveals it so it can be read", async () => {
    const { onChange } = setup({ allowGenerate: true });
    fireEvent.click(generate()!);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("alpha-bravo-charlie-delta"));
    expect(mockInvoke).toHaveBeenCalledWith("generate_passphrase");
    expect(input()).toHaveAttribute("type", "text");
  });

  it("keeps the field as it was if generating fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValue("no entropy");
    const { onChange } = setup({ allowGenerate: true, value: "mine" });
    fireEvent.click(generate()!);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
    expect(input()).toHaveAttribute("type", "password");
    spy.mockRestore();
  });
});

describe("PasswordInput - strength meter", () => {
  const meter = () => document.querySelector("div[style*='height: 4px'] > div") as HTMLElement;

  it("is hidden unless asked for", () => {
    setup({ value: "abc" });
    expect(mockStrength).toHaveBeenCalled();
    expect(meter()).toBeNull();
  });

  it("is hidden while the field is empty", () => {
    setup({ showStrength: true, value: "" });
    expect(meter()).toBeNull();
    expect(screen.queryByText("Very Weak")).not.toBeInTheDocument();
  });

  it.each([
    [0, "Very Weak", "20%", "rgb(220, 38, 38)"],
    [1, "Weak", "40%", "rgb(234, 88, 12)"],
    [2, "Okay", "60%", "rgb(234, 179, 8)"],
    [3, "Good", "80%", "rgb(132, 204, 22)"],
    [4, "Strong", "100%", "rgb(21, 128, 61)"],
  ])("score %i reads %s with a %s bar in the matching colour", (score, label, width, color) => {
    mockStrength.mockReturnValue({ score, feedback: `feedback ${score}` });
    setup({ showStrength: true, value: "x" });
    const word = screen.getByText(label);
    expect(word).toBeInTheDocument();
    expect(word).toHaveStyle({ color });
    expect(screen.getByText(`feedback ${score}`)).toBeInTheDocument();
    expect(meter()).toHaveStyle({ width, background: color });
  });

  it("scores the current value", () => {
    setup({ showStrength: true, value: "my-password" });
    expect(mockStrength).toHaveBeenLastCalledWith("my-password");
  });
});

describe("PasswordInput - with the real scoring", () => {
  beforeEach(() => {
    mockStrength.mockImplementation(
      jest.requireActual("../../utils/security").getPasswordStrength,
    );
  });

  it("calls a short password very weak and a long passphrase strong", () => {
    const first = setup({ showStrength: true, value: "abc" });
    expect(screen.getByText("Very Weak")).toBeInTheDocument();
    first.unmount();
    setup({ showStrength: true, value: "correct horse battery staple" });
    expect(screen.getByText("Strong")).toBeInTheDocument();
    expect(screen.getByText("Excellent Passphrase")).toBeInTheDocument();
  });
});
