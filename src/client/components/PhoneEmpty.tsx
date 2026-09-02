import { Mark } from "./Mark.js";

/**
 * Nothing is waiting. Said plainly and then out of the way - this is what a
 * working bench looks like most of the time, so it is a designed screen
 * rather than a blank roster that reads as broken (see #57).
 */
export function PhoneEmpty({ onBrowseRoster }: { onBrowseRoster: () => void }) {
  return (
    <section id="empty">
      <Mark size={34} />
      <strong id="empty-title">Nothing needs you.</strong>
      <p id="empty-note">
        Every specialist is either working or has already been answered.
        This screen will find you when one of them wants you.
      </p>
      <button type="button" id="empty-roster" onClick={onBrowseRoster}>See what's running</button>
    </section>
  );
}
