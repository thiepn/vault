-- Phase 19 — Live Presence & Collaborative Session Foundation
--
-- Ephemeral collaboration runs on a separate private Realtime topic:
--   vault-collab:<vault-id>:<epoch>
-- It never carries canonical Markdown or attachment bytes.
--
-- All active owner/editor/viewer memberships may publish and receive presence
-- and cursor metadata. Canonical writes remain controlled by Phase 18 sync and
-- Storage authorization.

drop policy if exists vault_realtime_collaboration_read on realtime.messages;
create policy vault_realtime_collaboration_read
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast','presence')
  and split_part((select realtime.topic()),':',1)='vault-collab'
  and split_part((select realtime.topic()),':',4)=''
  and exists (
    select 1
    from public.vault_cloud_vaults v
    join public.vault_memberships m
      on m.vault_id=v.id
     and m.auth_user_id=(select auth.uid())
     and m.revoked_at is null
    where v.id::text=split_part((select realtime.topic()),':',2)
      and v.epoch::text=split_part((select realtime.topic()),':',3)
      and v.disabled_at is null
  )
);

drop policy if exists vault_realtime_collaboration_write on realtime.messages;
create policy vault_realtime_collaboration_write
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension in ('broadcast','presence')
  and split_part((select realtime.topic()),':',1)='vault-collab'
  and split_part((select realtime.topic()),':',4)=''
  and exists (
    select 1
    from public.vault_cloud_vaults v
    join public.vault_memberships m
      on m.vault_id=v.id
     and m.auth_user_id=(select auth.uid())
     and m.revoked_at is null
    where v.id::text=split_part((select realtime.topic()),':',2)
      and v.epoch::text=split_part((select realtime.topic()),':',3)
      and v.disabled_at is null
  )
);
