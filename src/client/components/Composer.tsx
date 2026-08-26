import type { RefObject } from "react";
import { modelLabel, isProxied } from "../../shared/models.js";
import { ComposerHint } from "./ComposerHint.js";
import { UsagePopover } from "./UsagePopover.js";
import { CreditPopover } from "./CreditPopover.js";
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
  model, onChangeModel,
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
  /** What the selected specialist runs on. Absent when none is selected, and
   * on a row from a daemon that predates the field. */
  model?: string;
  onChangeModel?: () => void;
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
      {/* What the keys do, and at the far end what this will be spent on and
          what there is left to spend — the three things you want at the
          moment you are deciding to send more work. The usage panel lives
          here rather than in the roster header because it is wider than that
          column and was being cut off by it. */}
      <div id="composer-foot">
        {error ? <p id="composer-hint">{error}</p> : <ComposerHint kind={hint} optionCount={optionCount} />}
        {/* What this specialist is running on, where you are looking when you
            decide to send it work. It used to be visible only in the header
            badge and settable only at creation, which made the model
            something you chose once and then could not see at the moment it
            mattered. */}
        {model && (
          <button
            type="button"
            id="composer-model"
            title="Change the model this specialist runs on"
            onClick={onChangeModel}
          >
            {modelLabel(model)}
          </button>
        )}
        {/* Which account, not just how much. The meter follows the model
            beside it because they are one question: a specialist on
            OpenRouter is not spending the Anthropic subscription, and a bar
            about that subscription beside its name is a true number about
            the wrong account. */}
        {model !== undefined && isProxied(model) ? <CreditPopover /> : <UsagePopover />}
      </div>
    </>
  );
}
