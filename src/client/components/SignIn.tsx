/**
 * The cockpit's first screen when it knows no daemon and nobody has signed
 * in - a phone opening the hosted cockpit for the first time. Offers Google
 * sign-in; "point at a daemon directly" is the fallback for someone who
 * meant to type an address, not the gate everyone has to get through first.
 * See "The phone's first screen is sign-in, not 'Where is Bench running?'"
 * in the design.
 */
export function SignIn({ onSignIn, onUseAddressInstead, busy, error }: {
  onSignIn: () => void;
  onUseAddressInstead: () => void;
  busy: boolean;
  error: string;
}) {
  return (
    <div id="sign-in" role="dialog" aria-modal="true" aria-labelledby="sign-in-title">
      <div className="setup-card">
        <h2 id="sign-in-title">Sign in to Bench</h2>
        <p>
          Sign in with the Google account your daemon is connected to. Once
          you are in, every specialist you have broadcast from any of your
          machines shows up here.
        </p>

        <button type="button" id="sign-in-google" disabled={busy} onClick={onSignIn}>
          Sign in with Google
        </button>

        {error && <p id="sign-in-error" className="error">{error}</p>}

        <p className="field-note">
          <button type="button" id="sign-in-use-address" className="link" onClick={onUseAddressInstead}>
            Or point this browser at a daemon directly
          </button>
        </p>
      </div>
    </div>
  );
}
