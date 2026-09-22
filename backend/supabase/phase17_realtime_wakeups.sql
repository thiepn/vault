-- Phase 17 — private Realtime wakeups for canonical sync events.
--
-- Realtime carries only a tiny wake signal. Markdown, paths and attachment
-- bytes continue to move exclusively through the Phase 15/16 authenticated
-- replication RPCs and private Storage bucket.

drop policy if exists vault_realtime_sync_read on realtime.messages;
create policy vault_realtime_sync_read
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and split_part((select realtime.topic()), ':', 1) = 'vault'
  and exists (
    select 1
    from public.vault_cloud_vaults v
    where v.id::text = split_part((select realtime.topic()), ':', 2)
      and v.epoch::text = split_part((select realtime.topic()), ':', 3)
      and v.auth_user_id = (select auth.uid())
      and v.disabled_at is null
  )
);

create or replace function vault_private.broadcast_sync_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_epoch uuid;
begin
  select v.epoch
  into v_epoch
  from public.vault_cloud_vaults v
  where v.id = new.vault_id
    and v.disabled_at is null;

  if v_epoch is null then
    return new;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'vaultId', new.vault_id::text,
      'sequence', new.sequence::text,
      'operationId', new.operation_id::text,
      'entryId', new.entry_id::text,
      'revision', new.revision,
      'deviceId', new.device_id::text
    ),
    'sync_event',
    'vault:' || new.vault_id::text || ':' || v_epoch::text,
    true
  );

  return new;
end;
$$;

drop trigger if exists vault_sync_events_realtime_wakeup on public.vault_sync_events;
create trigger vault_sync_events_realtime_wakeup
after insert on public.vault_sync_events
for each row execute function vault_private.broadcast_sync_event();
