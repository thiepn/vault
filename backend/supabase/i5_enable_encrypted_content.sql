-- I5 — Enable encrypted Protocol v2 canonical content after client certification.
--
-- I1 deliberately advertised the ciphertext contract with acceptingContent=false.
-- I5 flips this only after the browser has an end-to-end encrypted Note/Folder
-- push/pull/apply path. Attachments remain local until I7.

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
      'acceptingContent', true
    ),
    'maxMutations', 1000,
    'maxPageEvents', 1000
  );
$fn$;

revoke all on function public.vault_sync_capabilities_v2() from public, anon;
grant execute on function public.vault_sync_capabilities_v2() to authenticated;

comment on function public.vault_sync_capabilities_v2() is
  'I5: Protocol v2 Note/Folder ciphertext ingestion is enabled. Attachment blob replication remains deferred to I7.';
