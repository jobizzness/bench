import type { RefObject } from "react";
import { ComposerHint } from "./ComposerHint.js";

/**
 * The one input, and the button that says what sending will do.
 *
 * The send button only appears for an intake, where "what will happen" is not
 * obvious from the box — a plain message or a single-option decision goes on
 * Enter, as it always has.
 */
export function Composer({
  text, setText, onSubmit, disabled, placeholder, hint, optionCount, send, inputRef, error,
}: {
  text: string;
  setText: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
  hint: "none" | "working" | "intake" | "options" | "reply";
  optionCount?: number;
  send: { label: string; blocked: boolean } | null;
  inputRef: RefObject<HTMLInputElement | null>;
  error: string | null;
}) {
  return (
    <>
      <form
        id="composer-form"
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <input
          id="composer-text"
          type="text"
          autoComplete="off"
          ref={inputRef}
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {send && (
          <button
            id="composer-send"
            type="submit"
            disabled={send.blocked}
            data-pending={send.blocked}
          >
            {send.label}
          </button>
        )}
      </form>
      {error ? <p id="composer-hint">{error}</p> : <ComposerHint kind={hint} optionCount={optionCount} />}
    </>
  );
}
