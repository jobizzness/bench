/**
 * The daemon's Google identity, in the shape both the daemon and the
 * cockpit read - `GET /api/remote` answers with exactly this, so nothing
 * translates between the two.
 */
export interface RemoteState {
  connected: boolean;
  uid: string | null;
  /** The address shown at sign-in, for "which account is connected" in
   * Settings. Cosmetic only - the security rules gate on `uid`, never on
   * this. */
  email: string | null;
  machineId: string | null;
  machineName: string | null;
  platform: string | null;
  /** When the current ID token expires - proof the refresh loop is running. */
  tokenExpiresAt: number | null;
  /** Set once a refresh token stops working. The developer has to sign in
   * again; the daemon does not retry on its own. */
  error: string | null;
}

export const REMOTE_OFF: RemoteState = {
  connected: false, uid: null, email: null, machineId: null, machineName: null,
  platform: null, tokenExpiresAt: null, error: null,
};
