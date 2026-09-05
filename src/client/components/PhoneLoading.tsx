import { Mark } from "./Mark.js";
import { Skeleton } from "./Skeleton.js";

/**
 * The phone's front door before the roster has ever settled - not
 * `PhoneEmpty`'s "Nothing needs you.", which used to draw here the instant
 * the socket had not so much as opened yet (#80). Both of the phone's real
 * screens are still possible at this point, so this does not guess at
 * either one - it is just the wait, shaped rather than blank or false.
 */
export function PhoneLoading() {
  return (
    <section id="phone-loading">
      <Mark size={34} />
      <Skeleton width="55%" height="1.1em" />
      <Skeleton width="75%" height="1em" />
    </section>
  );
}
