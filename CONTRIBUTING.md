# Contributing to pastel

Thanks for wanting to help out! pastel is a small, opinionated codebase, and the bar for contributions is "does it ship without breaking the golden path." This guide explains how to get there.

## Quick links

- [Repo layout](#repo-layout)
- [Core files (discuss first)](#core-files-discuss-first)
- [Local dev setup](#local-dev-setup)
- [Branch and PR flow](#branch-and-pr-flow)
- [What should work before you open a PR](#what-should-work-before-you-open-a-pr)
- [Writing tests](#writing-tests)
- [Code style](#code-style)
- [Commit messages](#commit-messages)
- [Where help is most welcome](#where-help-is-most-welcome)

## Repo layout

```
crates/
  pastel-proto/      wire format (postcard binary), shared types
  pastel-room/       room actor, game loop, scoring, word lists
  pastel-server/     axum HTTP + WebSocket entrypoint
  pastel-loadtest/   k-client load harness
frontend/
  src/               TypeScript app (Vite)
  tests/             vitest specs
  scripts/og.mjs     Satori OG image generator
```

## Core files (discuss first)

A few files encode tuned, cross-cutting invariants that a well-meaning refactor can break invisibly: the change looks clean, the tests still pass, and the game quietly desyncs in production. These are off-limits for drive-by PRs. If you have a real reason to touch them, open an issue first; changes here merge only with maintainer sign-off.

- `frontend/src/canvas.ts`: the drawing + stroke pipeline. It holds the 960x600 logical-coordinate contract that every client and the server snapshot replay agree on, the per-point signed-byte (i8) delta encoding, and the jitter-buffer (50ms) plus batch (16ms) timings. Those three are tuned together; nudging one in isolation degrades every player's experience without failing a test.
- `frontend/src/proto.ts` and `crates/pastel-proto/`: the binary wire format. The canvas delta encoding is coupled to this. Change one side without the other and strokes corrupt on the wire.
- Stroke handling and snapshots in `crates/pastel-room/`: the server has to store and replay strokes in the same coordinate space clients draw in.

Genuine bug fixes (a real crash, a correctness fix) are still welcome. What needs a prior conversation is reworking *how* any of this functions: "I rewrote the canvas layer to use X" without a scoped issue will get bounced on process, not quality.

## Local dev setup

You'll need:

- Rust (stable, latest)
- Node 20+ and npm
- A modern browser

```bash
# backend
cargo build --workspace

# frontend
cd frontend
npm install
```

Run both in two terminals:

```bash
# terminal 1
cargo run -p pastel-server

# terminal 2
cd frontend && npm run dev
```

Open `http://localhost:5173`. Vite proxies `/ws`, `/bot`, `/voice` to the backend on `127.0.0.1:7070`.

## Branch and PR flow

**Do not push directly to `main`.** `main` is the deploy branch. Cloud Run auto-deploys what lands there, so a broken commit on `main` is a broken production game.

Workflow:

1. Branch off `main` with a descriptive name. Good: `fix/mobile-mute-icon`, `feat/themed-mode`, `chore/bump-deps`. Bad: `patch-1`, `temp`, `yashaswi/stuff`.
2. Make your changes. Keep commits small and self-contained when you can.
3. Open a PR against `main`. Fill in the PR template (what changed, why, how you tested).
4. Wait for review and CI. Address feedback.
5. Squash-merge once approved.

If you're a maintainer, you still go through a PR. No "just this once" pushes to `main`.

## What should work before you open a PR

These are gates. If any of them fail on your branch, the PR is not ready.

### 1. Backend tests pass

```bash
cargo test --workspace
```

This runs:
- `pastel-proto` codec round-trip tests
- `pastel-room` integration tests (full game loops, reconnect, kick, bot, etc.)

If you changed wire format, scoring, or the room state machine, you almost certainly need new tests here.

### 2. Backend lints clean

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

`-D warnings` means warnings fail the build. Fix or `#[allow]` with a comment explaining why.

### 3. Frontend typechecks

```bash
cd frontend
npx tsc -b --noEmit
```

Zero errors. No `// @ts-ignore` or `as any` unless you have a written reason. If a third-party type is wrong, narrow it locally and link to the upstream issue.

### 4. Frontend tests pass

```bash
cd frontend
npm test
```

Currently the suite is small: postcard codec parity and identity helpers. Extend it when you touch protocol code or pure logic.

### 5. Frontend builds

```bash
cd frontend
npm run build
```

A production build must succeed. Vite catches dynamic-import wiring issues that `tsc` misses.

### 6. Manual smoke on the golden path

Open the dev server, then:

- Land on the home page, pick a name + avatar, click "Start a room"
- A bot should join, you should be host
- Pick a word, draw, watch the timer
- Open the room link in a second tab, join as a second player, guess correctly
- Round ends, scores update, next round starts
- Game ends with a podium

If any of that breaks on your branch, do not open the PR.

For mobile work, open Chrome devtools in a phone preset (iPhone 14, Pixel 7, etc.) and walk through the same flow.

## Writing tests

Tests are the contract. If you add a feature without tests, expect to be asked to add them in review.

### Backend tests

Live next to the code they cover (`crates/pastel-room/tests/game.rs` etc.). Use `tokio::test(start_paused = true)` so the long pick/draw windows pass instantly via `advance`. The pattern is:

1. Spawn a room with a known word list
2. Join N players via the helper
3. Drive the state machine with `send_action` / `set_secret` / time advances
4. Assert on the broadcast/unicast stream

Tests should be _deterministic_ — no real timers, no real RNG dependence, no real network.

### Frontend tests

`frontend/tests/*.test.ts`, run by vitest. Focused on pure logic right now (codec, identity). UI is exercised manually until we add Playwright (PRs welcome).

When you add a new pure module (a parser, a state reducer, a math helper), add a `*.test.ts` next to it.

### What not to test

- Implementation details (private fns, exact class hierarchies)
- Snapshot tests of HTML strings — they're noise
- The framework itself (vite, tokio, axum)

## Code style

A few firm preferences:

- **No em-dashes** in prose, markdown, or code comments. Use periods, semicolons, parentheses, or hyphens. (This is enforced by review, not a linter.)
- **No "removed X" comments** for deleted code. The git log has it. Just delete.
- **Don't over-comment.** Default to no comment. Only write one when the _why_ is non-obvious (a workaround, a constraint, a subtle invariant).
- **No `as any` / `unwrap()` shortcuts** unless commented with why.
- **Match existing patterns** in the file you're editing. If you disagree with a pattern, raise it in an issue first; don't quietly diverge in a feature PR.

Rust: `cargo fmt`'s output is canonical. Don't fight it.

TypeScript: existing files set the bar — 2-space indent, double quotes, semicolons, trailing commas in multiline. `tsc` enforces the rest.

## Commit messages

Format:

```
area: short imperative summary (under 70 chars)

Optional body wrapped at ~72 cols explaining why, not what.
The diff already says what. The body says why.
```

Examples that fit:

```
mobile: floating tool panel with palette tabs and thickness
voice: track remote mute by name so it survives republish
room: reject non-drawer Clear during Drawing phase
```

Examples that don't:

```
fix bug                  # which bug?
updates                  # not a sentence
WIP                      # squash before merging
```

## Where help is most welcome

If you're looking for somewhere to start, these areas always need eyes:

- **Mobile UX polish.** Phones reveal layout cracks the design didn't anticipate. Real-device testing helps.
- **More word lists.** Themed packs (animals, food, movies, slang) are low-risk and high-impact.
- **Playwright smoke tests.** Replacing the manual golden-path walkthrough with an automated browser test would prevent a class of regressions.
- **Accessibility.** Keyboard-only play, screen reader labels, color-contrast on swatches and the timer.
- **Bot intelligence.** Better guesses, better drawings, varied behavior per difficulty.

Open an issue first if you're planning anything larger than ~50 lines so we can scope it together. PRs that start with "I rewrote the canvas layer to use" without a prior issue are likely to get bounced for scope, not quality.

Thanks for reading this far. pastel exists because a bunch of small contributions added up. Yours will too.
