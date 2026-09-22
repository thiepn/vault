-- Phase 15 follow-up hardening after live advisor verification.
revoke all on public.vault_sync_counters from anon, authenticated;
revoke all on public.vault_sync_entries from anon, authenticated;
revoke all on public.vault_sync_operations from anon, authenticated;
revoke all on public.vault_sync_events from anon, authenticated;

drop policy if exists vault_sync_counters_deny_direct on public.vault_sync_counters;
create policy vault_sync_counters_deny_direct
  on public.vault_sync_counters for all to authenticated
  using (false) with check (false);

drop policy if exists vault_sync_entries_deny_direct on public.vault_sync_entries;
create policy vault_sync_entries_deny_direct
  on public.vault_sync_entries for all to authenticated
  using (false) with check (false);

drop policy if exists vault_sync_operations_deny_direct on public.vault_sync_operations;
create policy vault_sync_operations_deny_direct
  on public.vault_sync_operations for all to authenticated
  using (false) with check (false);

drop policy if exists vault_sync_events_deny_direct on public.vault_sync_events;
create policy vault_sync_events_deny_direct
  on public.vault_sync_events for all to authenticated
  using (false) with check (false);

create index if not exists vault_sync_counters_account_identity_idx
  on public.vault_sync_counters(account_id, auth_user_id);
create index if not exists vault_sync_entries_account_identity_idx
  on public.vault_sync_entries(account_id, auth_user_id);
create index if not exists vault_sync_entries_device_idx
  on public.vault_sync_entries(account_id, updated_by_device);
create index if not exists vault_sync_operations_account_identity_idx
  on public.vault_sync_operations(account_id, auth_user_id);
create index if not exists vault_sync_events_account_identity_idx
  on public.vault_sync_events(account_id, auth_user_id);
create index if not exists vault_sync_events_device_idx
  on public.vault_sync_events(account_id, device_id);
create index if not exists vault_sync_events_entry_idx
  on public.vault_sync_events(vault_id, entry_id);

drop policy if exists vault_sync_objects_select on storage.objects;
create policy vault_sync_objects_select
on storage.objects for select
to authenticated
using (
  bucket_id='vault-sync'
  and (storage.foldername(storage.objects.name))[1]=(select auth.uid())::text
  and exists (
    select 1 from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(storage.objects.name))[2]
      and v.auth_user_id=(select auth.uid())
      and v.disabled_at is null
  )
);

drop policy if exists vault_sync_objects_insert on storage.objects;
create policy vault_sync_objects_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id='vault-sync'
  and (storage.foldername(storage.objects.name))[1]=(select auth.uid())::text
  and exists (
    select 1 from public.vault_cloud_vaults v
    where v.id::text=(storage.foldername(storage.objects.name))[2]
      and v.auth_user_id=(select auth.uid())
      and v.disabled_at is null
  )
);
