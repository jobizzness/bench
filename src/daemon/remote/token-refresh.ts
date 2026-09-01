/**
 * Keeping a Google session alive from a headless process.
 *
 * `securetoken.googleapis.com/v1/token` is a documented public REST endpoint
 * that trades a refresh token for a one-hour ID token - no Admin SDK, no
 * service account, no billing. Firebase refresh tokens do not expire on
 * their own; they end when the account is deleted or disabled, the password
 * changes, or an admin revokes them. Everything else here exists to keep
 * exchanging one for an ID token before the hour runs out, and to say so
 * plainly - "sign in again" - the one time that stops working, rather than
 * retrying it forever.
 */

/** What the endpoint gives back, translated out of its snake_case and
 * seconds-as-a-string shape into what the rest of the daemon wants. */
export interface Exchanged {
  idToken: string;
  /** The endpoint can rotate this. Persisting whichever one comes back is
   * what keeps the file in `identity-file.ts` valid after a rotation - using
   * the one that was there before would work right up until the moment the
   * server actually rotated it, and then look exactly like a revocation. */
  refreshToken: string;
  uid: string;
  expiresAt: number;
}

/** A refresh token that no longer works - revoked, or the account it named
 * was disabled or deleted. Distinct from a network failure: this one means
 * remote is off until the developer signs in again, not "try later". */
export class RefreshRejected extends Error {}

export async function exchangeRefreshToken(
  apiKey: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Exchanged> {
  let res: Response;
  try {
    res = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
  } catch (error) {
    // Offline, DNS, a proxy in the way - says nothing about the token, so it
    // is not a RefreshRejected. The caller keeps the identity and tries again
    // on its own schedule.
    throw new Error(`could not reach securetoken.googleapis.com: ${String(error)}`);
  }

  if (!res.ok) {
    // A dead refresh token comes back 400 with a body naming the reason
    // (TOKEN_EXPIRED, USER_DISABLED, USER_NOT_FOUND) - the daemon does not
    // need to tell those apart, only that this token is never working again.
    throw new RefreshRejected(`refresh token was rejected: ${res.status}`);
  }

  const body = await res.json() as {
    id_token: string; refresh_token: string; expires_in: string; user_id: string;
  };
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    uid: body.user_id,
    expiresAt: Date.now() + Number(body.expires_in) * 1000,
  };
}

/** Refresh five minutes before the token actually expires, so a slow request
 * or a clock a little off never hands out an ID token that is already dead. */
const REFRESH_SLACK_MS = 5 * 60 * 1000;

/**
 * A floor under every scheduled delay, refresh or retry alike.
 *
 * Real Firebase ID tokens live an hour, comfortably longer than the slack
 * above - but `expiresAt - now - REFRESH_SLACK_MS` clamps to zero the moment
 * a token's lifetime is shorter than the slack, and a zero-delay `setTimeout`
 * that reschedules itself on every tick is a tight loop hammering
 * securetoken.googleapis.com. Caught by hand against the real endpoint with a
 * short-lived token standing in for a misbehaving one; nothing about the
 * ticket's own scenario would ever trigger it, but nothing should be able to.
 */
const MIN_DELAY_MS = 10_000;

export interface RefresherOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** The stored refresh token changed - persist it, or the next boot exchanges
   * one the server has already moved on from. */
  onRotated: (refreshToken: string) => void;
  /** The refresh token is dead. Remote is off from here until a new sign-in
   * happens; the refresher does not retry, which is what "not a crash loop"
   * means in the ticket. */
  onRejected: (error: RefreshRejected) => void;
  /** For tests. Real callers get the platform timer. */
  setTimeoutImpl?: typeof setTimeout;
}

/**
 * Holds one exchanged ID token and keeps it fresh.
 *
 * A class rather than a free function because "the current token" and "the
 * pending timer" are exactly the state a restart-resuming daemon needs to
 * carry for as long as remote is on, and a class is the shape that lets
 * `remote.ts` hold one instance and ask it questions.
 */
export class Refresher {
  private current: Exchanged | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private opts: RefresherOptions) {}

  idToken(): string | null {
    return this.current?.idToken ?? null;
  }

  expiresAt(): number | null {
    return this.current?.expiresAt ?? null;
  }

  /** Exchange now, schedule the next exchange, and report the result. Thrown
   * only for a rejection the caller must act on synchronously (turning
   * remote off on first connect); a background refresh instead calls
   * `onRejected` and stops quietly. */
  async start(refreshToken: string): Promise<Exchanged> {
    const exchanged = await this.exchange(refreshToken);
    this.schedule(exchanged);
    return exchanged;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
  }

  private async exchange(refreshToken: string): Promise<Exchanged> {
    const exchanged = await exchangeRefreshToken(this.opts.apiKey, refreshToken, this.opts.fetchImpl);
    this.current = exchanged;
    if (exchanged.refreshToken !== refreshToken) this.opts.onRotated(exchanged.refreshToken);
    return exchanged;
  }

  private schedule(exchanged: Exchanged): void {
    this.armTimer(Math.max(MIN_DELAY_MS, exchanged.expiresAt - Date.now() - REFRESH_SLACK_MS), exchanged.refreshToken);
  }

  private armTimer(delay: number, refreshToken: string): void {
    if (this.stopped) return;
    const timeout = this.opts.setTimeoutImpl ?? setTimeout;
    this.timer = timeout(() => { void this.tick(refreshToken); }, delay);
    // Node only: never keeps the process alive on its own account.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async tick(refreshToken: string): Promise<void> {
    if (this.stopped) return;
    try {
      const exchanged = await this.exchange(refreshToken);
      this.schedule(exchanged);
    } catch (error) {
      if (error instanceof RefreshRejected) {
        this.stop();
        this.opts.onRejected(error);
        return;
      }
      // Unreachable, not rejected - try again after the same floor rather
      // than decide remote is off because the network hiccupped once. Reuses
      // the refresh token that got us this far, since the exchange that
      // would have rotated it never completed.
      this.armTimer(MIN_DELAY_MS, refreshToken);
    }
  }
}
