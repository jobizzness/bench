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
