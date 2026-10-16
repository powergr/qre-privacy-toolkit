import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Field } from "./Field";

describe("Field", () => {
  it("connects the label to the input", () => {
    render(<Field label="Service name" />);
    const input = screen.getByLabelText("Service name");
    expect(input.tagName).toBe("INPUT");
  });

  it("gives two fields different ids", () => {
    render(
      <>
        <Field label="One" />
        <Field label="Two" />
      </>,
    );
    expect(screen.getByLabelText("One").id).not.toBe(screen.getByLabelText("Two").id);
  });

  it("uses an id it is given", () => {
    render(<Field label="Name" id="custom" />);
    expect(screen.getByLabelText("Name")).toHaveAttribute("id", "custom");
  });

  it("shows a hint and links it to the input", () => {
    render(<Field label="Address" hint="Include https://" />);
    const input = screen.getByLabelText("Address");
    const hint = screen.getByText("Include https://");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("shows an error instead of the hint, announces it, and marks the field invalid", () => {
    render(<Field label="Address" hint="Include https://" error="That is not a web address." />);
    const input = screen.getByLabelText("Address");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("That is not a web address.");
    expect(screen.queryByText("Include https://")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
  });

  it("treats a null error as no error", () => {
    render(<Field label="Name" error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
  });

  it("has no description when there is no hint or error", () => {
    render(<Field label="Name" />);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-describedby");
  });

  it("marks an optional field", () => {
    render(<Field label="Notes" optional />);
    expect(screen.getByText("Optional")).toBeInTheDocument();
  });

  it("renders a text area for multi-line text", () => {
    render(<Field label="Notes" multiline />);
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
  });

  it("works as a controlled input", () => {
    const onChange = jest.fn();
    render(<Field label="Name" value="Ada" onChange={onChange} />);
    const input = screen.getByLabelText("Name");
    expect(input).toHaveValue("Ada");
    fireEvent.change(input, { target: { value: "Grace" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("passes disabled and placeholder through", () => {
    render(<Field label="Name" disabled placeholder="Your name" />);
    const input = screen.getByLabelText("Name");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "Your name");
  });

  it("keeps extra class names on the control", () => {
    render(<Field label="Name" className="mine" />);
    expect(screen.getByLabelText("Name")).toHaveClass("ui-input", "mine");
  });

  it("passes its ref to the control", () => {
    const ref = createRef<HTMLInputElement & HTMLTextAreaElement>();
    render(<Field label="Name" ref={ref} />);
    expect(ref.current).toBe(screen.getByLabelText("Name"));
  });
});
