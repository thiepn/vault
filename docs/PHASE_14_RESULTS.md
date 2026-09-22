# Phase 14 results — Cloud Accounts, Device Identity & Sync Foundation

## Status

**Phase 14 is implemented and browser-certified. The Supabase account/device/Vault registry is deployed to THIEPN Core.**

Functional certification head: `9989825916f6da7617c3e533aac74efe2a8c47c6`

Functional CI: **35733360370 / #278**

## Product boundary

Phase 14 establishes authenticated cloud identity and the durable local replication foundation. It deliberately does **not** upload note or attachment contents.

Signing in and cloud adoption are separate actions:

- sign-in establishes account/device identity only
- local Vaults remain local after sign-in
- the user must explicitly adopt one Vault
- adoption preserves that Vault's UUID
- adoption creates an immutable remote epoch and initializes local cursor `0`
- sign-out removes browser credentials but leaves local data and the cloud binding intact

Actual remote operation pull/push, note replication, attachment blob replication and conflict application remain Phase 15.

## Authentication

Implemented browser auth behavior:

- email/password sign-in
- email/password account creation
- refresh-token session maintenance
- authenticated identity lookup
- best-effort remote + guaranteed local sign-out
- Google OAuth authorize/callback plumbing for the client-only browser flow

Sessions are stored per Supabase project. Offline/network/server refresh failure does not silently erase a stored refresh session. Explicit invalid/rejected refresh credentials do clear the browser session.

Vault never receives or stores a service-role key.

## Account and device identity

- Supabase Auth user ID is mapped to a provider-independent AccountId
- one stable random DeviceId is stored per browser installation
- server device identity is `(account_id, device_id)`
- coarse platform labels avoid fingerprint-style identifiers
- other devices can be revoked
- revocation cannot be silently reversed
- the active device signs out instead of revoking itself

## Explicit Cloud Vault adoption

The local Vault record now supports `mode: local | cloud` and an optional `CloudVaultBinding` containing AccountId, Auth user ID, Supabase project ref, the same remote/local Vault UUID, immutable epoch, protocol version, DeviceId and adoption timestamp.

Local repository rules:

- local → cloud only through explicit adoption
- remote UUID must equal local Vault UUID
- identical adoption is idempotent
- account/epoch/device rebinding fails closed

## Local replication state

`SyncLocalState` implements:

- exact-wire immutable outbox records
- SHA-256 operation integrity
- idempotent enqueue for identical operation bytes
- operation-ID reuse rejection when bytes differ
- account-bound pending outbox validation
- retry metadata and acknowledgement
- account/epoch-bound per-Vault cursor
- PostgreSQL-bigint-compatible decimal cursor validation
- monotonic cursor advancement

Phase 14 initializes a cursor at `0` when a Vault is adopted but does not yet send content operations.

## Deployed Supabase backend

THIEPN Core contains:

- `public.vault_accounts`
- `public.vault_cloud_devices`
- `public.vault_cloud_vaults`

All three tables have Row Level Security enabled. Anonymous table access is revoked. Authenticated policies scope allowed rows to `auth.uid() = auth_user_id`.

Deployed private trigger guards enforce immutable device/Vault identity, immutable sync epoch/protocol version, irreversible device revocation and irreversible remote-Vault disable state.

The final Supabase security advisor reported no Phase 14 RLS findings. Remaining security INFO findings belong to unrelated pre-existing `core.apps` / `core.protocol_versions` tables. Performance INFO findings only report unused Phase 14 indexes while the new tables are empty.

## Browser UI

The responsive Cloud panel provides:

- account sign-in/sign-up
- Google sign-in handoff
- account identity
- current-device identity
- device list and revocation
- local/cloud state for the selected Vault
- explicit adoption button
- adopted remote-Vault metadata list
- local-preserving sign-out

Local app startup and editing remain independent of network/auth availability.

## Certification

CI #278 passed:

- **107 / 107 core tests**
- search benchmark
- knowledge-graph benchmark
- board benchmark
- maximum-size Canvas benchmark
- Obsidian migration benchmark
- sync-foundation benchmark
- production TypeScript/Vite build
- **31 / 31 applicable Chromium desktop/mobile scenarios**
- **31** opposite-device scenarios skipped by design
- **0 failures**

### Sync-foundation benchmark

- **10,000 operations validated in 38.2 ms**
- **10,000 ordered server events validated in 8.0 ms**
- **1,000 operation envelopes SHA-sealed in 49.2 ms**

Same run snapshots:

- graph build: **187.7 ms**
- graph filter: **9.3 ms**
- local graph traversal: **8.0 ms**
- graph grouping: **3.3 ms**
- board projection: **86.5 ms**
- maximum Canvas parse: **294.2 ms**
- maximum Canvas serialize: **101.5 ms**
- 10k Obsidian migration planning: **330 ms**

## Verification note

Browser acceptance uses a deterministic mocked Supabase endpoint to certify the UI/account/adoption invariants. The production Supabase schema/RLS/triggers were separately deployed and inspected directly through the Supabase management connection.
