import type { RefObject } from "react";
import { ComposerHint } from "./ComposerHint.js";
import { useAutoGrow } from "./useAutoGrow.js";

/**
 * The one input, and the button that says what sending will do.
 *
 * The send button only appears for an intake, where "what will happen" is not
 * obvious from the box — a plain message or a single-option decision goes on
 * Enter, as it always has.
 *
 * It is a textarea because it was an `<input>`, which cannot hold a newline at
 * all: a brief with two paragraphs in it went to the specialist as one line.
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
  inputRef: RefObject<HTMLTextAreaElement | null>;
  error: string | null;
}) {
  useAutoGrow(inputRef, text);

  return (
    <>
      <form
        id="composer-form"
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <textarea
          id="composer-text"
          rows={1}
          autoComplete="off"
          ref={inputRef}
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter still sends — that is the whole rhythm of the cockpit.
            // Shift+Enter is the newline, and a textarea no longer submits the
            // form by itself, so sending happens here or not at all.
            if (event.key !== "Enter" || event.shiftKey) return;
            // Mid-composition Enter belongs to the IME, not to us.
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSubmit();
          }}
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
