/**
 * A short buzz for a decisive tap - choosing an option, sending an answer,
 * dismissing the sheet (#93). Tens of milliseconds, not a buzz: this is a
 * confirmation, not an alert.
 *
 * Android's Chrome is the only place this ever fires. iOS Safari has never
 * implemented `navigator.vibrate` - not "does nothing", the property is
 * simply absent - so this is feature-detected rather than assumed, and a
 * browser without it gets silence, not an error.
 */
export function tap(ms = 12): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(ms);
  }
}

/**
 * A failure, not a success (#95). `tap()` already fires the instant a send is
 * initiated - the acknowledgement of the gesture, not a promise about the
 * network - so a send that comes back bad needs a second, different buzz or
 * it feels identical to one that went through. A double pulse rather than one
 * longer buzz: length alone is hard to tell apart from `tap()`'s own duration
 * by feel, a *shape* is not.
 */
export function tapFailed(): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate([12, 60, 12]);
  }
}
