# Bench over Firestore — design

Status: approved 2026-08-31. Revised 2026-09-01 for more than one machine per
account, again for broadcast — remote is opt-in per specialist rather than
on for everything — and again for what #46 found while building the wire:
the daemon polls rather than holding a listener, and broadcast is what makes
that affordable. See "The daemon polls" below.

## What this is

Bench on a phone, from anywhere, behind a Google login. No second server, no
open port on the developer's machine, no billing account.

The daemon and the specialists stay exactly where they are. What changes is
that a browser somewhere else can reach them, through a Firestore database
both ends are signed into.

One account, several machines. The developer signs into two laptops, each
running its own daemon, and every device sees one roster covering both.

Nothing goes remote on its own. A specialist is broadcast, deliberately, from
its own page — and then it and its sub-agent tabs are reachable from anywhere.

## The problem

Three things stand between a phone and the daemon today.

**There is no route.** The daemon binds `127.0.0.1`. `BENCH_LAN=1` binds every
interface, which reaches your own wifi and nothing beyond it. Off the LAN there
is no path to the machine at all.

**Mixed content.** The cockpit is already deployable to Firebase Hosting, and
that copy is served over HTTPS. The daemon speaks plain HTTP on a private
address. Browsers refuse that pairing outright, and the code already knows it —
`src/client/endpoint.ts:106`.

**There is no user.** One shared token, in the URL, is the whole gate in front
of a process with a full shell:

```ts
// src/daemon/server.ts:350
const token = req.headers["x-bench-token"] ?? url.searchParams.get("token");
if (token !== config.token) { json(res, 401, { error: "unauthorized" }); return; }
```

That is a fair trade on loopback. It is not one to make on the open internet,
which is why the route and the login have to be designed together.

## Why Firestore, and not a relay

A relay the daemon dials out to is the textbook answer: one outbound socket,
nothing on the machine reachable, the existing HTTP surface tunnelled whole.
It needs a service to run, and a service needs billing.

The constraint here is the free plan. Firestore and Firebase Auth are both
fully available on Spark; Cloud Functions and Cloud Run are not. So the
database *is* the transport. Two processes that can both write to the same
documents can talk, and Firestore's security rules — keyed on
`request.auth.uid` — are the authentication, with no code of ours in the middle
to get it wrong.

What we give up: it is not a general tunnel. Anything chatty has to change
shape, and the free plan is a hard ceiling rather than a bill. Both are dealt
with below.

## The seam

Every network call the cockpit makes goes through four things, and nothing else
in the client touches the network:

| Today | Where | Becomes |
|---|---|---|
| `authFetch(path, init)` | `api.ts:56` | a command document, and its result |
| `postJson(path, body)` | `api.ts:79` | the same, with a body |
| `artifactUrl(...)` | `api.ts:75` | the report's HTML, fetched and rendered via `srcdoc` |
| `new WebSocket(eventsUrl())` | `useRoster.ts:38` | a listener on one mirrored document |

Forty-five call sites across the cockpit go through those four. They do not
change. What changes is that a transport belongs to a *machine* rather than to
the page: direct when the daemon served this page, relayed for every other
machine on the account. Which machine a call is for follows from the session it
names, and the roster knows that — see "More than one machine" below.

`artifactUrl` is the one that genuinely changes rather than moves. It hands a
URL to an `<iframe>`, and over Firestore there is no URL. The daemon already
builds the complete themed document (`src/daemon/artifact-page.ts`), so the
relayed transport fetches that HTML as content and the frame renders it with
`srcdoc`. Same sandbox, same document, different delivery.

## Two kinds of traffic

They want opposite shapes, and conflating them is how a design like this
becomes unaffordable.

### Things you do — a request and a reply

Sending a prompt, answering a decision, stopping a turn, changing a model.
Low volume, initiated by the phone, wants an answer.

```
/users/{uid}/machines/{machineId}/commands/{id}   { method, path, body, at }   phone writes
/users/{uid}/machines/{machineId}/results/{id}    { status, body }             daemon writes
```

The daemon reads `commands` on the same poll that serves the mirror — see "The
daemon polls" below for why it cannot listen. It executes each one **against its
own HTTP server on loopback, carrying its own token**, and writes the response
to `results/{id}`. The phone's listener on `results` resolves the promise that
`authFetch` returned. Both documents are then deleted.

Routing back through the daemon's own HTTP server rather than calling the
registry directly is deliberate: there is one implementation of every route,
one place where validation lives, and the direct transport stays the reference
behaviour rather than becoming a second code path that can drift.

Cost per action: 2 writes, 2 reads, 2 deletes.

### Things you watch — a mirror the daemon pushes

The roster, the thread, the plan, the trail, the current report. Today the
cockpit pulls these. The plan polls every two seconds while a turn is live
(`useSessionPlan.ts:29`), and polling is the one thing this transport cannot
afford.

So they invert. The daemon writes what you are looking at into a document, and
the phone listens:

```
/users/{uid}/machines/{machineId}/mirror/roster        the whole roster, as the socket sends it today
/users/{uid}/machines/{machineId}/mirror/{sessionId}   thread, plan, trail, latest report metadata
```

One document per thing, updated in place. Firestore's guidance is explicit that
this is the right shape for a live trail: an update in place costs one write and
delivers one read to each listener however often it changes, where append-only
documents burn the daily write quota and the storage cap on data nobody wants
after the turn ends.

The daemon's roster socket already works this way — it sends the entire roster
on every change (`server.ts:1073`). It is a mirror already. It only has the
wrong pipe.

### Presence gates the mirror

The daemon does not mirror unless somebody is watching, and mirrors only what
they are watching.

```
/users/{uid}/machines/{machineId}/presence/state   { viewers: { [deviceId]: { at, watching } } }
```

**One document, not a collection.** The daemon reads this on a timer, and a
collection listing bills one read per document where a single document bills
one read flat, forever, however many devices you own. Same reason the mirror is
one document per thing rather than an append-only log.

The trailing `/state` is one segment more than earlier drafts of this path
had. A Firestore path alternates collection/document/collection/document —
`.../machines/{machineId}/presence` on its own names a *collection* called
`presence`, the same shape `.../machines/{machineId}/mirror` has for
`mirror/roster`. Found by a fake that enforces the same alternation Firestore
itself does (`fake-firestore.ts`'s even/odd segment-count check) refusing to
treat it as a document - the fake caught this before it could have been
caught by hand against the real project.

The phone writes its entry and refreshes `at` on a heartbeat — **every 60
seconds, and only while the page is visible.** A viewer is stale after three
minutes. A phone in a pocket is not a viewer, which is the point: an idle tab
must not spend the day's write budget proving it is still open.

Firestore has no `onDisconnect`, so a phone that is killed or loses signal
cannot tell anyone it has gone; the staleness window is what stands in for it.
Realtime Database does have `onDisconnect`, and the official presence pattern
uses RTDB for exactly this and mirrors the result into Firestore. That is a
second product, a second ruleset and a second SDK in the client, to save a
three-minute delay in noticing a phone has gone. Not worth it here — but it is
the reason the window exists rather than an oversight.

The daemon mirrors the roster while any viewer's heartbeat is fresh, and mirrors
`mirror/{sessionId}` only for sessions some viewer has open. When the last
heartbeat goes stale, the daemon deletes the mirror.

### The daemon polls, and broadcast is what makes that affordable

The daemon cannot hold a listener. Firestore's real-time channel is gRPC and
its SDK takes its token from a component only `firebase/auth` registers, and
`firebase/auth` cannot be signed in from a stored refresh token in Node. Both
ways round that — a custom persistence built on `_`-prefixed internals, or a
hand-rolled gRPC client — work today and rest on parts of Firebase its own
versioning policy refuses to protect. Neither is a thing to put a daily tool on.

So the daemon polls, and the whole question becomes when it is allowed to stop:

- **Nothing broadcast — no polling at all.** Broadcast is strict, so an empty
  broadcast set is an empty mirror, and a phone that arrived could see nothing
  anyway. There is no question worth asking, so it is not asked. At your desk
  with nothing broadcast, remote costs exactly zero.
- **Broadcast, nobody watching for five minutes — idle.** Poll every 60
  seconds instead of every five. Enough to notice a phone within a minute,
  cheap enough to leave on for a fortnight: 1,440 reads a day against a ceiling
  of 50,000.
- **Somebody watching — awake.** Every five seconds, and the mirror runs.

Idling means slowing down, not stopping. A broadcast specialist that became
unreachable while you were at lunch would defeat the point of broadcasting it.

A phone announces itself first and the machine answers, so a machine that does
not answer is asleep — and after an idle period that can take up to a minute.
The cockpit says it is waking rather than inventing a roster for it.

Three things fall out of this, and they are the reason the design is shaped this
way:

- **At your desk with nothing broadcast, Firestore is not touched at all.** No
  poll, no viewer, no mirror. One exception, and it is deliberate: while remote
  is on the daemon refreshes its own machine document every 90 seconds, so the
  roster can say which laptops are alive. That is 960 writes a day against
  20,000.
- **The cleanup is not a chore bolted on.** The mirror's lifetime is the
  viewer's, so "clean up when we are done" is the normal path rather than a
  thing to remember.
- **Reconnecting is cheap.** A phone locks and unlocks all day, and Firestore
  bills a reconnected listener as a fresh query. Because the mirror is a handful
  of documents rather than a collection of hundreds, that reconnect costs a
  handful of reads.

### Broadcast decides what may be mirrored at all

Presence answers "what is being looked at". It does not answer "what should ever
leave this machine", and those are different questions.

Each specialist gets a **broadcast** control on its page. Off by default. A
specialist that is not broadcast does not appear in the mirrored roster, is not
mirrored, and cannot be reached from another device — it is as though remote did
not exist for it. Broadcasting one **includes every sub-agent tab it opened**,
because a specialist and the researcher it spun up are one piece of work and
splitting them would mean broadcasting a parent whose findings you cannot read.

The two gates compose. Broadcast is permission, presence is demand, and the
daemon mirrors the intersection:

```
mirrored = broadcast ∧ watched
```

This earns its place three times over. It is the smallest possible answer to
"what is in the cloud" — one specialist, not a whole machine's work, and nothing
at all until you say so. It cuts the write budget to what you actually intend to
watch from a phone. And it puts the choice where the developer already is: on
the page of the thing they are about to walk away from.

The flag lives with the session record, so it survives a daemon restart. Turning
it off deletes that specialist's mirror immediately rather than waiting for a
viewer to go stale.

The obvious convenience — a machine-wide "broadcast everything" — is not built.
It would undo the property that makes this worth having.

**Broadcast is strict, and this was decided rather than defaulted.** A
specialist that was not broadcast and then hits a decision at eleven in the
morning cannot be answered from a phone, and the phone is not told it is
waiting. Two softenings were on the table and both were rejected: broadcasting a
specialist automatically once it opens a decision, and mirroring the bare fact
that one is waiting without its thread or report. Either would mean something
reaching the cloud that the developer did not put there, which is the one
guarantee broadcast exists to make. The cost is real and accepted: remote is for
work you decided to take with you, not for everything you left running.

Anything softening this is a change to the design, not an improvement to be
added in passing.

### There are no unbounded collections

This is a hard rule of the design rather than a preference, and it comes
straight from the research: there is no free way to delete a collection. The
`recursiveDelete()` convenience is Admin-SDK-only, TTL policies require billing,
and each document delete is billed individually. A collection that can grow
without limit is one that can never be cleaned up.

So: `commands` and `results` are deleted pairwise as they are consumed.
`mirror` holds one document for the roster and one per session being watched.
`viewers` holds one per device. `machines` holds one per laptop. Everything is
nameable, countable, and deletable in a single small batch — which is what makes
`bench remote off` possible: it deletes that machine's subtree, and there is a
known, small number of documents under it.

## More than one machine

The developer signs into two laptops, each running its own daemon, and expects
to manage every session on both from whichever device is to hand. That is why
the paths above are keyed on a machine and not only on a user.

**A machine id is minted once**, when remote is first turned on, and kept beside
the credential in `~/.bench/firebase.json`. It is stable across restarts, and it
survives the machine being renamed. Each daemon registers itself:

```
/users/{uid}/machines/{machineId}   { name, platform, version, lastSeen }
```

`name` defaults to the hostname and is editable, because "which laptop is this"
is a question the cockpit has to answer in a word.

**The roster is the union.** The cockpit listens to every machine's
`mirror/roster` and shows one roster, with each row carrying the machine it is
on. This is the part the requirement is actually about: you open Bench on your
phone and see everyone waiting on you, on either laptop, without choosing a
machine first — every specialist you broadcast, wherever it is running.

**Acting on a row selects its machine.** A call for
`/api/sessions/{id}/message` goes to the machine that session is on, and the
merged roster is what maps one to the other. No call site has to know.

**Machine-global screens follow the machine you have open.** Settings, the API
keys, the project list and the spend meters are per-daemon — there is no single
"the settings" across two laptops. They show the active machine's, and the
machine is named in the header so it is never ambiguous. This is an assumption
rather than an instruction: the alternative, showing both laptops' settings
side by side, is a bigger piece of work and was not asked for.

**A machine that is asleep is shown as asleep**, with its last-known roster
greyed rather than hidden. Knowing that a specialist is waiting on the laptop at
home is useful even when you cannot answer it from here.

Two laptops is not two accounts. The rule below still admits exactly one uid;
what has changed is that one uid can own several machines.

## Identity

One Google account. The same account on the laptop and on the phone, so every
device the developer is already signed into is already allowed.

**The laptop.** The cockpit on localhost gains a "Turn on remote" control. It
signs in with Google in that browser and hands the daemon the resulting refresh
token, which the daemon writes to `~/.bench/firebase.json` at mode `0600` —
along with the machine id it mints for itself on that first connection. Each
laptop does this separately and gets its own machine id under the same account.

**The daemon.** It exchanges that refresh token for a one-hour ID token at
`securetoken.googleapis.com/v1/token`, and keeps doing so. This is a documented
public REST endpoint, not a workaround: no Admin SDK, no service account, no
billing. Firebase refresh tokens do not expire on their own — they end when the
user is deleted or disabled, when the account password changes, or when an admin
revokes them. The `firebase/auth` SDK's default persistence in Node is `none`,
so persisting the token ourselves is the documented requirement rather than an
oversight.

**The phone.** Opens the hosted cockpit and signs in with Google. Same account,
same uid.

The handover between them is one new localhost route: the cockpit posts the
refresh token and the uid to the daemon, which stores them and starts refreshing.
The Firebase web config — API key and project id — is public by design and ships
with the client; the daemon reads the same values from its own config so that
`bench-cockpit` is named in one place rather than two.

**The rules.** One rule is the whole of it:

```
match /users/{owner}/{document=**} {
  allow read, write: if request.auth.uid == owner;
}
```

One uid, everything it owns, however many machines that turns out to be.

**Localhost keeps working with no sign-in.** The token gate on `127.0.0.1` is
unchanged. A laptop with a broken network, an expired credential or a deleted
Firebase project is never locked out of its own cockpit, and Bench without a
Firebase project at all is exactly the Bench that exists today.

## What it costs, and what happens when it runs out

The Spark plan gives 50,000 document reads, 20,000 writes and 20,000 deletes
per day, 1 GiB stored, and 10 GiB of egress per month. The daily figures reset
around midnight Pacific. There is no overage: on Spark there is no billing
account to charge, so once a daily quota is spent, operations fail until the
reset.

Writes are the binding constraint. Reads are 2.5× more plentiful and the mirror
is small; deletes track actions one for one.

An action costs 2 writes. A mirror update costs 1. A watched live turn is
therefore dominated by mirror updates, so the daemon **coalesces them: at most
one write every two seconds per document while a turn is running, and only
while watched.** A ten-minute turn watched end to end is then at most 300
writes, and the day's budget is roughly sixty such turns — far more phone-side
watching than is plausible.

The daemon keeps its own count of what it has spent today and widens the
coalescing window as it approaches the ceiling: 2s normally, 10s past 15,000
writes, and mirror updates only on turn boundaries past 18,000. **It says so in
the cockpit when it does.** A cockpit that quietly stops updating at four in the
afternoon is worse than one that tells you it is slowing down.

Two machines do not double this, because only one session is being watched at a
time and only its machine writes a detail mirror. What a second machine adds is
its own roster mirror and its own heartbeat: at one write a minute per machine
while the page is visible, an hour of watching two laptops costs 120 writes.
Half a percent of the day, and nothing at all when the page is in a pocket.

One caveat with two daemons on one budget: **the quota is the account's, not the
machine's.** Each daemon counts only what it spends itself, so neither sees the
true total and both could degrade later than they should. That is acceptable at
two machines, where the sum is well inside the ceiling. It would not be at ten,
and the honest fix — a shared counter document — costs a write to maintain,
which is the thing it is trying to save.

## Content in the cloud

Mirroring puts threads, prompts and reports into Firestore. It is the
developer's own project and the rules admit exactly one uid, but Google can read
it and a compromised Google account is now a compromised bench. That is a real
departure from a tool whose pitch has been that none of this leaves the machine.

**This slice writes them in the clear.** That follows from what remote is for
here — any device already signed into the account should just work, with nothing
to pair and no key to carry.

What limits the exposure instead is broadcast. Nothing is mirrored until a
specialist is explicitly broadcast, so what is in the cloud is what the
developer chose to put there, one specialist at a time, and only while a device
is watching it. That is a smaller surface than encryption over everything would
have been, and it is legible: the answer to "what is up there" is a list you can
see on the roster.

It is not a one-way door, and the design keeps it that way: everything written
to a command, result or mirror document passes through a single encode
function, and everything read passes through its inverse. Turning on end-to-end
encryption later means implementing that pair against a key established at
pairing time, and changing nothing else. Tracked as its own issue.

## Not in this slice

- **The mobile layout.** "Truly mobile" is its own piece of work, and doing it
  at the same time as the transport means debugging both at once. Separate
  ticket, straight after.
- **Push notifications.** The other half of working from a phone, and its own
  subsystem: FCM, a service worker push handler, per-device subscriptions.
- **More than one account.** The rule above admits one uid. A second person, or
  a second Google account, is a follow-up. Several machines under one account is
  in scope; several accounts is not.
- **Settings across machines.** Each daemon keeps its own house rules and keys.
  The cockpit shows the active machine's and names it; it does not merge them or
  offer to copy one to the other.
- **Offline queueing.** When the laptop is asleep there is nothing to talk to,
  and the cockpit says so rather than holding a prompt that will land hours
  later into stale context.
- **A second Firestore database.** The project gets exactly one on the free
  plan. `bench-cockpit`'s is now committed to this, so there is no separate
  environment to test against without billing.

## Build order

1. **Identity.** Google sign-in on the hosted cockpit, "Turn on remote" on the
   laptop, the daemon holding the same uid from a persisted refresh token, its
   own machine id and registration, security rules deployed. Nothing is mirrored
   yet — the test is that both ends can read and write one document, that two
   laptops register as two machines under one account, and that nobody else can
   read either.
2. **The wire.** The transport behind `api.ts`, command and result documents,
   broadcast, the presence-gated mirror, the merged roster across machines, the
   write budget, `bench remote off`.
3. **The phone.** The cockpit made to work on a small screen with a soft
   keyboard.

Each is a ticket. 1 blocks 2; 3 depends only on 2 being usable.

## How it is tested

The Firestore SDK is faked at the boundary — the transport is a small module
with a document-store interface, and the tests drive it with an in-memory
implementation, in the same style as the existing suite. That covers the
request/response pairing, the coalescing, the presence timeout and the deletion
paths without touching a network.

Three things a green suite will not catch, and they are the end-to-end checks
worth naming now: that the daemon's refresh token actually survives a restart
and keeps working the next day; that a real phone on cellular can open the
hosted cockpit and drive a specialist; and that two laptops signed into the same
account both appear, with one merged roster and each row acting on the right
machine. None is a unit test. All are done by hand, once, against the real
project.

## What #46 actually built

Slice 2's code is in on the daemon side: broadcast (with its cascade to
sub-agent tabs and immediate mirror deletion on turning it off), the
command/result round trip with the daemon refusing anything naming a
non-broadcast session, presence, the coalesced write-budget-aware mirror,
`bench remote off`, and the encode/decode seam - all against a fake
document store, none of it touching a network. See this ticket's own report
and issue comment for the exact list, and "The daemon's listener, in
practice" above for the one place the daemon's behaviour differs from what
this document originally described.

The client side is built to the same shape - the transport switch in
`api.ts`, the merged roster and presence heartbeat in `useRoster.ts`, the
sign-in-first screen, `artifactUrl`'s `srcdoc` change, offline persistence -
but could not be run against a real browser and the real `bench-cockpit`
project from inside this environment. What a green suite proves and what a
phone on cellular proves are different claims; see the report for exactly
which is which.
