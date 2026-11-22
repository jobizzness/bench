# Remote terminal — design

Status: proposed 2026-11-21. Not built. Feasibility spiked: `node-pty` spawns
a login shell on a real `/dev/pts`, and `werift` opens a WebRTC data channel
over DTLS between two Node peers, both in a clean container with no native
toolchain beyond what `pnpm install` brings.

## What this is

A real shell on the machine at home, from the phone or another laptop, through
`bench remote`. It is a full shell: `vim`, `htop`, `ssh`, job control, Ctrl-C.
It is not a "run one command" box.

## Why this needs its own design

A remote shell is a backdoor that you chose to install, and it is the most
dangerous thing Bench could ship. Today the worst a stolen Google session can
do is drive a *broadcast* specialist. That is already code execution, but an
agent stands in between and the developer chose which specialists to
broadcast. A terminal removes both. So the bar is not "as safe as remote is
today". The bar is: **compromising the Google account, Firestore, Google
itself, or the hosted cockpit's static files must not, by itself, give anyone
a shell.**

The existing relay fails that bar in three places, and the terminal must not
inherit any of them:

1. **Authority is the Google uid.** The rules admit any session of that
   account, which covers a phishing kit, a stolen cookie, or a shared family
   laptop that is still signed in.
2. **Content is in the clear in Firestore** ("Content in the cloud" in the
   Firestore design). Keystrokes include the passwords typed at `sudo`.
   Output includes `env`, `cat ~/.aws/credentials` and private keys.
3. **Firestore is the pipe.** That is fine for a request and a reply. It is
   wrong for a terminal. An echo per keystroke and a frame per 50ms of output
   would spend Spark's 20,000 writes/day in about an hour of real use, with
   100-300ms of added latency on every key.

## Threat model

| Attacker has | Must get |
|---|---|
| The Google account, or any signed-in browser | nothing, not even a prompt on the machine |
| Read/write access to Firestore (Google, a rules bug, a leaked token) | nothing: cannot read terminal bytes, cannot MITM a session |
| A modified hosted cockpit (a compromised Firebase Hosting deploy) | the ability to attack a device the next time it is *used*, not silently and not retroactively; see "Residual risk" |
| A paired phone, unlocked, in their hand | a shell, but only after a biometric or PIN check, and with the session visible on the machine |
| The local network | nothing new; no port is opened |
| Code on the home machine as another user | nothing new; the PTY runs as the daemon's user and is reachable only through the paths below |

Out of scope: an attacker who already runs code as the developer's user on
the home machine. They already have a shell.

## Architecture

```
 phone (hosted cockpit)                         home machine (daemon)
 ───────────────────────                        ──────────────────────
 passkey (Face ID / PIN)                        terminal off by default
 xterm.js  ◄──── WebRTC data channel (DTLS) ───► node-pty  →  $SHELL -l
              ▲  direct P2P, end-to-end            ▲
              │                                    │
              └── signalling only: one signed ─────┘
                  offer/answer pair in Firestore,
                  deleted once connected
```

Firestore carries only **signalling**: an offer, an answer and ICE candidates,
about 6 writes per session, deleted as soon as the channel opens. Terminal
bytes never touch Firestore or any Google service. WebRTC encrypts the data
channel with DTLS. What stops Firestore from swapping in its own DTLS
fingerprint, the classic WebRTC MITM, is that both sides **sign** the SDP that
carries it, with keys that never leave their device (see the next section).

## Pairing and authentication

### 1. Turning it on happens only at the machine

`bench terminal on` on the CLI, or a switch in the cockpit served on
`127.0.0.1`, enables the feature. The route behind it is loopback-only, in
the same list as the key-lending routes (`loopback-only.ts`), so neither the
relay nor a LAN cockpit can turn it on. `bench terminal off` is the kill
switch: it closes every live session and stops answering offers. There is no
remote way to turn it back on, on purpose.

### 2. Pairing a device needs physical presence at both ends

On the machine, `bench terminal pair` (or a button in the local cockpit)
shows a QR code and a 6-word code. The code carries the machine's public key
fingerprint and a one-time pairing secret. It is valid for 5 minutes, works
once, and allows 5 attempts.

On the phone, the hosted cockpit scans the code or takes the typed words and:

- creates a **passkey** (WebAuthn, platform authenticator, `userVerification:
  "required"`) scoped to the cockpit's origin. The private key lives in the
  phone's secure enclave and cannot be exported, not even by the cockpit's
  own JavaScript.
- pins the machine's public key from the code. That is how the phone later
  knows an answer really came from this machine and not from Firestore.
- sends the passkey's public key to the machine, authenticated with the
  pairing secret (an HMAC over the request). Without that, an attacker in
  Firestore could pair themselves in the same window.

The machine stores paired devices in `~/.bench/terminal-devices.json` at mode
0600: name, passkey credential id and public key, paired-at, last-used.
`bench terminal devices` lists them and `bench terminal revoke <name>`
removes one. Revoking also kills that device's live sessions.

The machine's own identity is an Ed25519 keypair in
`~/.bench/terminal-key` at mode 0600, made on first `bench terminal on`.

### 3. Opening a session needs the passkey every time

1. The phone writes an **offer** to
   `users/{uid}/machines/{m}/terminal/{sessionId}`. It holds the SDP (with
   the phone's DTLS fingerprint), a timestamp, a random nonce, and a
   **WebAuthn assertion** whose challenge is `SHA-256(sdp ‖ nonce ‖
   timestamp ‖ machineId)`. Producing it takes Face ID or the device PIN.
2. The daemon, through the Firestore listener it already holds, checks:
   - terminal is on;
   - the credential is a paired device;
   - the assertion's signature, `rpIdHash`, `origin`, user-verified flag,
     and that the signature counter moved forward (catches a cloned
     authenticator, where the platform supports counters);
   - the challenge matches *this* SDP, nonce and machine;
   - the timestamp is within 60s, and the nonce has not been seen before
     (replay protection);
   - the per-device rate limit (5 failed opens in 10 minutes locks that
     device until someone acts at the machine).
3. The daemon writes an **answer**: its SDP, signed with the machine's
   Ed25519 key over `SHA-256(answer-sdp ‖ offer-hash)`. The phone checks the
   signature against the key it pinned at pairing, and refuses on mismatch.
4. ICE runs, DTLS comes up, and both sides check that the fingerprint DTLS
   actually negotiated is the one in the signed SDP. The signalling
   documents are deleted.

All of this verification is in the daemon, against keys on the machine.
Nothing in Firestore, the rules or Google is trusted to decide.

## While a session is open

- **The shell.** `node-pty` runs `$SHELL -l` as the daemon's own user, with
  no elevation and no setuid helper. The environment is the user's login
  environment, *not* the daemon's: no `BENCH_*`, no Anthropic or router keys
  inherited from the daemon process. It starts in the home directory.
- **Everyone can see it on the machine.** An OS notification when a session
  opens ("Terminal opened from Pixel 9"). A banner in the local cockpit with
  a Kill button, for as long as it runs. A line in
  `~/.bench/terminal-audit.log` per open, close, refusal and pairing, with
  device, time, duration and the reason for any refusal. Keystrokes are
  *not* logged by default, because a log of keystrokes is a log of
  passwords.
- **Limits, all configurable locally and none remotely:**
  - closed after 15 minutes with no input;
  - closed after 8 hours regardless;
  - at most 2 sessions at once;
  - a fresh passkey check to reopen after any drop, with no resumable
    session tokens.
- **Frames on the channel** are typed messages (`data`, `resize`, `ping`,
  `exit`), parsed with zod and size-capped (64 KB). Anything else closes the
  channel. `resize` is clamped to sane bounds.
- **No new HTTP route reaches the PTY.** The local cockpit gets its own
  terminal over the existing loopback WebSocket, under the existing token,
  and only from a loopback peer. Every `/api/terminal/*` path is added to
  `LOOPBACK_ONLY_PATHS`, so the command relay cannot reach any of it even
  by accident.

## When a direct connection is impossible

Two phones behind carrier-grade NAT, or a symmetric NAT at home, defeat ICE
with STUN alone. That is roughly 10-20% of attempts on cellular. The options:

1. **TURN relay (recommended).** A TURN server relays packets it cannot
   read: DTLS is end-to-end, so the relay sees only ciphertext. Cloudflare's
   TURN service has a free tier. Its credentials are short-lived and minted
   per session, which needs one small endpoint. Alternatively, a TURN
   server the developer runs themselves, set in config.
2. **Encrypted fallback over Firestore.** The same authenticated keys
   derive a session key through ECDH (Noise-style), and frames are sealed
   with XChaCha20-Poly1305 and batched every 100ms into Firestore. That is
   confidential, but it costs writes and adds latency, so it would be a
   capped "emergency" mode at 30 minutes/day under the write budget.
3. **Refuse,** and say so plainly.

Proposed: ship with STUN plus option 3, and add option 1 next. Option 2 is
real work for a degraded experience. Build it only if (1) turns out not to
be acceptable.

## Residual risk, stated plainly

- **The hosted cockpit's JavaScript is trusted at the moment of use.** If
  the Firebase Hosting deploy were replaced, the next time a paired phone
  opened the terminal, the malicious page could ask for the passkey and
  use that one session. It cannot do so silently (Face ID prompts every
  time), cannot extract the passkey, and cannot touch sessions it was not
  present for. Mitigations: keep `firebase deploy` credentials off shared
  machines, add a strict CSP (no inline script, `connect-src` limited to
  Google and the TURN host), and later add an installed PWA that pins its
  own bundle hash.
- **A shell is a shell.** Once open, it can do anything the developer's
  user can do. The controls above decide *who* opens one. They do not limit
  what it does.
- **The phone's PIN is the floor.** A passkey with "user verification" is
  as strong as the phone's unlock. Say so in the pairing screen.

### A boring alternative, worth naming

Tailscale (or WireGuard) plus `sshd` on the home machine is mature, audited
and free for personal use, and needs no code from us. If all you want is a
shell at home, that is the lowest-risk answer. What Bench adds is having the
terminal next to the specialists, with no separate VPN to install on the
phone and pairing done through the account you already have. This design is
worth building only if that convenience matters. Every control above exists
to make sure the convenience does not cost security.

## Dependencies

| Package | Why | Notes |
|---|---|---|
| `node-pty` | real PTY | native; prebuilt for macOS and Windows, compiles on Linux. Pin it. |
| `werift` | WebRTC in Node, pure TypeScript | no native code. Pin a release at least 2 weeks old; 0.28.0 is 2 days old today. |
| `@xterm/xterm` + `@xterm/addon-fit` | terminal in the browser | client bundle only |
| WebAuthn verification | assertion check on the daemon | about 150 lines with `node:crypto` (ES256 and Ed25519 verify), instead of a framework |

The browser side needs no WebRTC library.

## Build order

Each step is a PR, and none exposes anything remotely until step 4.

1. **Foundations (no remote surface).** Machine key, device store, audit
   log, `bench terminal on|off|pair|devices|revoke`, loopback-only routes.
   Tests: refused from the relay, refused from a non-loopback peer,
   pairing code expiry, single use and attempt limit.
2. **Local terminal.** PTY host, framed protocol, limits, notification
   and banner. A Terminal tab in the cockpit on `127.0.0.1` only. This is
   also how the PTY gets exercised before anything remote exists.
3. **Passkey pairing and assertion verification.** WebAuthn registration
   on the hosted cockpit, verification on the daemon. Tests use real
   assertion vectors: wrong origin, replay, stale timestamp, counter
   regression, revoked device, wrong machine.
4. **Remote session.** Signed offer and answer over the existing Firestore
   listener, a werift data channel, a DTLS fingerprint check, and cleanup
   of the signalling documents. An end-to-end test against the emulator,
   plus an attack test: tamper with the SDP in Firestore and expect a
   refusal on both sides.
5. **Mobile terminal UI.** xterm.js with a key bar (Esc, Tab, Ctrl, arrows,
   `|`, `~`) and soft-keyboard handling.
6. **TURN** for the networks where a direct connection fails.

Step 1 also lays the ground for #48 (end-to-end encryption of the existing
relay): the machine key and the paired device keys are exactly what that
needs.
