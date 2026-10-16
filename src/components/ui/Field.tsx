import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";
import "./ui.css";

type NativeProps = InputHTMLAttributes<HTMLInputElement> &
  TextareaHTMLAttributes<HTMLTextAreaElement>;

export interface FieldProps extends Omit<NativeProps, "id"> {
  label: string;
  /** Short help shown under the field. Replaced by the error while there is one. */
  hint?: string;
  /** Text that explains what is wrong and how to fix it. Marks the field invalid. */
  error?: string | null;
  /** Adds an "Optional" tag next to the label. */
  optional?: boolean;
  /** Renders a multi-line text area instead of a single-line input. */
  multiline?: boolean;
  id?: string;
}

/**
 * A labelled text field. The label, hint and error are wired to the control for screen
 * readers, so every form in the app gets the same behaviour without repeating it.
 * (Passwords keep using PasswordInput, which adds the strength meter and generator.)
 */
export const Field = forwardRef<HTMLInputElement & HTMLTextAreaElement, FieldProps>(
  function Field(
    { label, hint, error, optional, multiline, id, className, ...rest },
    ref,
  ) {
    const auto = useId();
    const fieldId = id ?? auto;
    const messageId = `${fieldId}-msg`;
    const message = error || hint;
    const props = {
      id: fieldId,
      className: cx("ui-input", className),
      "aria-invalid": error ? true : undefined,
      "aria-describedby": message ? messageId : undefined,
      ...rest,
    };

    return (
      <div className="ui-field">
        <label className="ui-field__label" htmlFor={fieldId}>
          {label}
          {optional && <span className="ui-field__optional">Optional</span>}
        </label>
        {multiline ? (
          <textarea ref={ref} {...props} />
        ) : (
          <input ref={ref} {...props} />
        )}
        {error ? (
          <p id={messageId} className="ui-field__error" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p id={messageId} className="ui-field__hint">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
