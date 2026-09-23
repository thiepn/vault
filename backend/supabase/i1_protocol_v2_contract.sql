-- I1 — Protocol v2 & Encrypted Sync Contract
--
-- This migration advertises the v2 ciphertext contract without enabling content
-- ingestion yet. I2 (crypto), I3 (device/recovery keys) and I4 (encrypted remote
-- state) must be deployed before accepting any Protocol v2 canonical content.
--
-- Historical Phase 14/15 migrations remain immutable.

create or replace function public.vault_sync_capabilities_v2()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select jsonb_build_object(
    'contractVersion', 1,
    'protocolVersions', jsonb_build_array(1, 2),
    'encryptedContentV2', jsonb_build_object(
      'contractAvailable', true,
      'acceptingContent', false
    ),
    'maxMutations', 1000,
    'maxPageEvents', 1000
  );
$fn$;

revoke all on function public.vault_sync_capabilities_v2() from public, anon;
grant execute on function public.vault_sync_capabilities_v2() to authenticated;

comment on function public.vault_sync_capabilities_v2() is
  'I1 capability negotiation. Protocol v2 contract is available but ciphertext content ingestion stays disabled until I2-I4 are deployed.';
