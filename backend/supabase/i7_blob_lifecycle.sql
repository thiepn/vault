-- I7 — Blob reference lifecycle.
--
-- Physical ciphertext deletion is deliberately NOT performed here. Entity
-- history and an in-flight fixed bootstrap snapshot can still require an older
-- BlobId after it leaves current entity_heads. We therefore mark unreferenced
-- READY blobs ORPHANED and retain their immutable Storage object. A later
-- history-retention/GC protocol may delete only after proving no retained
-- version or bootstrap reader can reference it.

create or replace function vault_private.refresh_blob_ref_lifecycle_v2()
returns trigger
language plpgsql
set search_path=''
as $fn$
declare
  v_old_referenced boolean;
begin
  if tg_op in ('UPDATE','DELETE') and old.blob_id is not null
    and (
      tg_op='DELETE'
      or new.blob_id is distinct from old.blob_id
      or new.key_generation is distinct from old.key_generation
      or new.account_id is distinct from old.account_id
      or new.vault_id is distinct from old.vault_id
    ) then
    select exists(
      select 1
      from vault_private.entity_heads h
      where h.vault_id=old.vault_id
        and h.account_id=old.account_id
        and h.blob_id=old.blob_id
        and h.key_generation=old.key_generation
        and (tg_op='DELETE' or h.entity_id<>old.entity_id)
    ) into v_old_referenced;

    if not v_old_referenced then
      update vault_private.blob_refs b
      set state='orphaned'
      where b.vault_id=old.vault_id
        and b.account_id=old.account_id
        and b.blob_id=old.blob_id
        and b.key_generation=old.key_generation
        and b.state='ready';
    end if;
  end if;

  if tg_op<>'DELETE' and new.blob_id is not null then
    update vault_private.blob_refs b
    set state='ready',
        ready_at=coalesce(b.ready_at,now())
    where b.vault_id=new.vault_id
      and b.account_id=new.account_id
      and b.blob_id=new.blob_id
      and b.key_generation=new.key_generation
      and b.state in ('ready','orphaned');
  end if;

  return case when tg_op='DELETE' then old else new end;
end;
$fn$;

drop trigger if exists entity_heads_blob_lifecycle_v2 on vault_private.entity_heads;
create trigger entity_heads_blob_lifecycle_v2
after insert or update or delete on vault_private.entity_heads
for each row execute function vault_private.refresh_blob_ref_lifecycle_v2();

comment on function vault_private.refresh_blob_ref_lifecycle_v2() is
  'I7 current-head blob lifecycle: READY while referenced; ORPHANED when no current head references the BlobId. Immutable bytes are retained for history/bootstrap safety.';
