-- I4 post-deploy advisor hardening
--
-- Cover every foreign key reported by the Supabase database advisor after the
-- I1/I3/I4 production migration. These indexes do not change synchronization
-- semantics; they keep parent-row updates/deletes and FK validation scalable.

create index if not exists accepted_operations_vault_account_idx
  on vault_private.accepted_operations(vault_id,account_id);

create index if not exists device_access_requests_device_idx
  on vault_private.device_access_requests(account_id,device_id);

create index if not exists device_vault_access_device_idx
  on vault_private.device_vault_access(account_id,device_id);

create index if not exists device_vault_key_envelopes_device_idx
  on vault_private.device_vault_key_envelopes(account_id,device_id);

create index if not exists entity_heads_vault_account_idx
  on vault_private.entity_heads(vault_id,account_id);

create index if not exists entity_versions_vault_account_idx
  on vault_private.entity_versions(vault_id,account_id);

create index if not exists sync_events_vault_account_idx
  on vault_private.sync_events(vault_id,account_id);

create index if not exists sync_events_version_idx
  on vault_private.sync_events(vault_id,entity_id,remote_revision);
