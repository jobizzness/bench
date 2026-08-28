import { useRef, type RefObject } from "react";
import { runningModelLabel, isProxied } from "../../shared/models.js";
import { ComposerHint } from "./ComposerHint.js";
import { UsagePopover } from "./UsagePopover.js";
import { CreditPopover } from "./CreditPopover.js";
import { SpendPopover } from "./SpendPopover.js";
import { useAutoGrow } from "./useAutoGrow.js";
import type { Attachment } from "../../shared/types.js";

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
  model, answeredBy, onChangeModel, project,
  attachments = [], addFiles = async () => {}, removeAttachment = () => {}, attachmentError = null,
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
  /** Which models actually answered its last turn, where `model` is a router
   * rather than a model in its own right. */
  answeredBy?: string[] | null;
  onChangeModel?: () => void;
  /** Which project the selected specialist belongs to, so the spend meter can
   * report this piece of work rather than the whole bench. Absent when none is
   * selected. */
  project?: string;
  /** Attached images to display as thumbnails and submit. */
  attachments?: Attachment[];
  /** Handler to process and attach files (paste, drag & drop, browse). */
  addFiles?: (files: FileList | File[]) => Promise<void>;
  /** Handler to remove an attached image. */
  removeAttachment?: (index: number) => void;
  /** Image-specific validation errors. */
  attachmentError?: string | null;
}) {
  useAutoGrow(inputRef, text);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    if (disabled || !event.dataTransfer.files) return;
    void addFiles(event.dataTransfer.files);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || !event.clipboardData.files || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    void addFiles(event.clipboardData.files);
  };

  const activeError = attachmentError || error;

  return (
    <>
      <form
        id="composer-form"
        style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "stretch" }}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((att, index) => (
              <div key={index} className="composer-attachment">
                <img src={`data:${att.mediaType};base64,${att.data}`} alt="attachment" />
                <button type="button" className="remove" onClick={() => removeAttachment(index)} title="Remove">×</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "flex-end", gap: "10px" }}>
          <button
            type="button"
            className="composer-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title="Attach images"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Attach images"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          </button>
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp"
            disabled={disabled}
            onChange={(event) => {
              if (event.target.files) {
                void addFiles(event.target.files);
                event.target.value = "";
              }
            }}
          />

          <textarea
            id="composer-text"
            rows={1}
            autoComplete="off"
            ref={inputRef}
            disabled={disabled}
            placeholder={placeholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={handlePaste}
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
        </div>
      </form>
      {/* What the keys do, and at the far end what this will be spent on and
          what there is left to spend — the three things you want at the
          moment you are deciding to send more work. The usage panel lives
          here rather than in the roster header because it is wider than that
          column and was being cut off by it. */}
      <div id="composer-foot">
        {activeError ? <p id="composer-hint">{activeError}</p> : <ComposerHint kind={hint} optionCount={optionCount} />}
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
            {runningModelLabel(model, answeredBy)}
          </button>
        )}
        {/* What this work has already cost, before what is left to spend on
            it. The two meters read as one sentence in that order — what it
            runs on, what that has come to, what remains — and the ledger goes
            first because it is the only one of the three that is about work
            that has actually happened. */}
        <SpendPopover project={project} />
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
