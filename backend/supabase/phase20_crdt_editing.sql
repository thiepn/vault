-- Phase 20 — Live CRDT Text Co-Editing & Shared Undo Foundation
--
-- Active Markdown co-editing uses a separate private Realtime Broadcast topic:
--   vault-edit:<vault-id>:<epoch>:<entry-id>
--
-- Yjs update bytes are ephemeral transport state only. Canonical Markdown,
-- durable revisions, attachments, and conflict history remain in the existing
-- Phase 15–18 sync/storage path.
--
-- Only active owner/editor memberships may subscribe or publish. Viewers keep
-- Phase 19 presence and canonical read-only sync but never receive live text.

drop policy if exists vault_realtime_crdt_read on realtime.messages;
create policy vault_realtime_crdt_read
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension='broadcast'
  and split_part((select realtime.topic()),':',1)='vault-edit'
  and split_part((select realtime.topic()),':',5)=''
  and split_part((select realtime.topic()),':',4)
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1
    from public.vault_cloud_vaults v
    join public.vault_memberships m
      on m.vault_id=v.id
     and m.auth_user_id=(select auth.uid())
     and m.revoked_at is null
     and m.role in ('owner','editor')
    where v.id::text=split_part((select realtime.topic()),':',2)
      and v.epoch::text=split_part((select realtime.topic()),':',3)
      and v.disabled_at is null
  )
);

drop policy if exists vault_realtime_crdt_write on realtime.messages;
create policy vault_realtime_crdt_write
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension='broadcast'
  and split_part((select realtime.topic()),':',1)='vault-edit'
  and split_part((select realtime.topic()),':',5)=''
  and split_part((select realtime.topic()),':',4)
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1
    from public.vault_cloud_vaults v
    join public.vault_memberships m
      on m.vault_id=v.id
     and m.auth_user_id=(select auth.uid())
     and m.revoked_at is null
     and m.role in ('owner','editor')
    where v.id::text=split_part((select realtime.topic()),':',2)
      and v.epoch::text=split_part((select realtime.topic()),':',3)
      and v.disabled_at is null
  )
);
