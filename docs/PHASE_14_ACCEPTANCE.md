# Phase 14 acceptance — Cloud Accounts, Device Identity & Sync Foundation

## Result

**ACCEPTED — cloud account/device identity and the local replication foundation are certified.**

## Acceptance criteria

- browser startup remains local-first and does not require network
- no cloud request is required to open/edit local data
- public Supabase configuration contains no service-role/secret key
- email/password sign-in works through the Auth boundary
- refresh session is durable
- offline refresh failure does not erase stored session
- invalid refresh credentials clear the session
- local sign-out works even when network is unavailable
- Google browser OAuth handoff/callback plumbing exists
- Supabase Auth identity maps to provider-independent AccountId
- browser installation receives a stable random DeviceId
- DeviceId survives reload/sign-out
- server device identity is account-scoped
- device label is coarse rather than fingerprinting data
- other device revocation is available
- revocation is irreversible through normal client updates
- login alone does not adopt/upload local Vaults
- Vault cloud adoption is explicit
- adopted remote UUID equals existing local Vault UUID
- adopted remote epoch is immutable
- adoption initializes cursor at zero
- same cloud binding is idempotent
- cross-account/epoch/device rebinding fails closed
- sign-out leaves canonical local Vault data intact
- sign-out leaves local cloud binding intact
- outbox keeps exact immutable operation bytes + SHA-256
- duplicate identical outbox enqueue is idempotent
- reused operation ID with different bytes is rejected
- pending outbox rows are owner-bound
- sync cursor is owner-bound and epoch-bound
- cursor never moves backward
- live Supabase Phase 14 tables have RLS policies
- live device/Vault immutability triggers are deployed
- desktop Cloud panel passes
- mobile Cloud panel passes
- existing Phase 1–13 browser workflows pass
- all core and performance gates pass

## Certification

Functional CI: **35733360370 / #278**

- **107 core tests passed**
- **31 applicable Chromium scenarios passed**
- **31 opposite-device scenarios skipped by design**
- **0 failures**

Sync benchmark: 10k operations / 10k events / 1k seals in **38.2 ms / 8.0 ms / 49.2 ms** respectively.

## Explicit non-goals

Phase 14 does not:

- upload Markdown notes to the backend
- upload attachment blobs
- download remote Vault contents
- apply remote revisions
- resolve cross-device conflicts
- claim full cross-device content synchronization
- claim end-to-end encryption
- store user passwords itself

Those content-replication responsibilities begin in **Phase 15 — Remote Replication, Conflict Handling & Cross-Device Sync**.
