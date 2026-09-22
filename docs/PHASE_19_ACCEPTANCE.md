# Phase 19 — Acceptance Contract

## Product behavior

- Shared cloud Vaults expose ephemeral online/member awareness.
- Presence is available to active owner, editor and viewer memberships.
- Presence displays only current-item/session awareness; it does not expose note contents.
- Remote cursor/selection decorations appear only on the same Markdown note.
- Remote cursor/selection decorations require matching document fingerprints.
- A local Markdown divergence immediately removes stale remote decorations.
- Cursor decorations expire when stale and are removed when the remote session leaves.
- Reading mode does not display remote edit cursors.
- Switching Vaults/items updates Presence and clears irrelevant cursors.
- Local-only Vaults never open a collaboration channel.

## Protocol and privacy

- Collaboration uses `vault-collab:<vault>:<epoch>`, separate from canonical sync wakeups.
- Presence uses documented Supabase Presence track/state/diff events.
- Cursor updates use documented Broadcast messages, throttled to at most 10 Hz.
- Runtime validators reject malformed UUIDs, roles, modes, offsets, timestamps and fingerprints.
- No Markdown text, note path/title, selection text, email or attachment bytes are transmitted.
- Collaboration state is never persisted to IndexedDB or the canonical backend.

## Authorization

- Realtime SELECT/INSERT policies require active Vault membership and matching Vault epoch.
- Revoked memberships and disabled Vaults fail RLS authorization on channel authorization/reauthorization.
- Browser-provided role/user/session fields are advisory only and never grant permissions.
- Phase 18 RPC/Storage permissions remain the only canonical write boundary.
- Viewer collaboration does not imply viewer canonical write access.

## Compatibility

- Sync protocol remains version 1.
- Phase 17 realtime wakeups remain on their existing topic and behavior.
- Phase 18 membership/invitation behavior remains unchanged.
- Existing local-first conflict handling remains authoritative.
- Phase 1–18 core tests and browser acceptance must remain green.

## Performance

- 50,000 validated cursor Broadcast frames must process within the existing 2.5-second benchmark budget on CI.
- Presence is not updated for every cursor move.
- Cursor publishing is throttled to a 100 ms minimum interval.

## Release gate

Phase 19 may merge only when:

1. the collaboration RLS migration is applied to THIEPN Core;
2. Supabase security/performance advisors show no new Phase 19 actionable finding;
3. Phase 19 protocol/policy/snapshot tests pass;
4. collaboration performance benchmark passes;
5. production TypeScript/Vite build passes;
6. existing Phase 1–18 tests and benchmarks pass;
7. Chromium desktop/mobile acceptance, including the Phase 19 presence/cursor UI test, passes.
