import { VaultError } from './errors.js';
import type { DeviceId, EntryId } from './model.js';

declare const canonicalIdBrand: unique symbol;
declare const localDateBrand: unique symbol;

export const CANONICAL_ENTITY_TYPES = [
  'vault',
  'note',
  'folder',
  'tag',
  'property-definition',
  'task',
  'event',
  'project',
  'person',
  'attachment',
  'capture',
  'collection',
  'link',
] as const;

export type CanonicalEntityType = typeof CANONICAL_ENTITY_TYPES[number];
export type CanonicalEntityId<K extends CanonicalEntityType = CanonicalEntityType> =
  string & { readonly [canonicalIdBrand]: K };

export type VaultDomainId = CanonicalEntityId<'vault'>;
export type NoteId = CanonicalEntityId<'note'>;
export type FolderId = CanonicalEntityId<'folder'>;
export type TagId = CanonicalEntityId<'tag'>;
export type PropertyDefinitionId = CanonicalEntityId<'property-definition'>;
export type TaskId = CanonicalEntityId<'task'>;
export type EventId = CanonicalEntityId<'event'>;
export type ProjectId = CanonicalEntityId<'project'>;
export type PersonId = CanonicalEntityId<'person'>;
export type AttachmentId = CanonicalEntityId<'attachment'>;
export type CaptureId = CanonicalEntityId<'capture'>;
export type CollectionId = CanonicalEntityId<'collection'>;
export type LinkId = CanonicalEntityId<'link'>;

export type LocalDate = string & { readonly [localDateBrand]: true };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/iu;

export function isStableUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && uuidV7Pattern.test(value);
}

export function asCanonicalId<K extends CanonicalEntityType>(entityType: K, value: string): CanonicalEntityId<K> {
  if (!isStableUuid(value)) {
    throw new VaultError('CORRUPT', 'Canonical entity IDs must be UUIDs.');
  }
  void entityType;
  return value as CanonicalEntityId<K>;
}

/**
 * Generates an offline-safe UUIDv7. Existing Vault UUIDv4 EntryIds remain valid
 * canonical identities through asCanonicalId/canonicalIdFromEntry; A1 never re-IDs data.
 */
export function newCanonicalId<K extends CanonicalEntityType>(entityType: K): CanonicalEntityId<K> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  const value =
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('');

  void entityType;
  return value as CanonicalEntityId<K>;
}

/** Bridge existing Phase 1–11 entry identities into the A1 domain without changing bytes. */
export function canonicalIdFromEntry<K extends 'note' | 'folder' | 'attachment'>(
  entityType: K,
  entryId: EntryId,
): CanonicalEntityId<K> {
  return asCanonicalId(entityType, entryId);
}

/** Bridge an A1 canonical file identity back into the legacy EntryId layer without changing bytes. */
export function entryIdFromCanonical(
  entityId: CanonicalEntityId<'note' | 'folder' | 'attachment'>,
): EntryId {
  if (!isStableUuid(entityId)) {
    throw new VaultError('CORRUPT', 'Canonical file entity IDs must remain UUIDs.');
  }
  return entityId as unknown as EntryId;
}

export function asLocalDate(value: string): LocalDate {
  if (!localDatePattern.test(value)) {
    throw new VaultError('CORRUPT', 'A semantic local date must use YYYY-MM-DD.');
  }
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new VaultError('CORRUPT', 'The semantic local date is invalid.');
  }
  return value as LocalDate;
}

export interface EntityReference<K extends CanonicalEntityType = CanonicalEntityType> {
  entityType: K;
  entityId: CanonicalEntityId<K>;
}

export type MutationActorType = 'user' | 'system' | 'automation' | 'ai' | 'import' | 'external';

export interface MutationProvenance {
  actorType: MutationActorType;
  actorId?: string;
  deviceId?: DeviceId;
}

export interface SourceProvenance {
  sourceType: 'native' | 'import' | 'external';
  provider?: string;
  externalIdentifier?: string;
  importedAt?: string;
}

export type PropertyScalarValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: LocalDate }
  | { type: 'datetime'; value: string }
  | { type: 'url'; value: string }
  | { type: 'entity'; value: EntityReference }
  | { type: 'null'; value: null };

export type PropertyValue =
  | PropertyScalarValue
  | { type: 'list'; value: readonly PropertyScalarValue[] };

export type EntityProperties = Readonly<Record<string, PropertyValue>>;

export interface CanonicalEntityBase<K extends CanonicalEntityType, I extends CanonicalEntityId<K>> {
  id: I;
  entityType: K;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdByDeviceId?: DeviceId;
  lastModifiedByDeviceId?: DeviceId;
  properties: EntityProperties;
  origin?: SourceProvenance;
}

export interface VaultEntity extends CanonicalEntityBase<'vault', VaultDomainId> {
  name: string;
}

export type NoteKind = 'standard' | 'daily' | 'template';

export interface NoteEntity extends CanonicalEntityBase<'note', NoteId> {
  vaultId: VaultDomainId;
  title: string;
  body: string;
  folderId: FolderId | null;
  aliases: readonly string[];
  noteKind: NoteKind;
  dailyDate?: LocalDate;
  icon?: string;
  coverAttachmentId?: AttachmentId;
  pinned?: boolean;
}

export interface FolderEntity extends CanonicalEntityBase<'folder', FolderId> {
  vaultId: VaultDomainId;
  name: string;
  parentFolderId: FolderId | null;
}

export interface TagEntity extends CanonicalEntityBase<'tag', TagId> {
  vaultId: VaultDomainId;
  name: string;
  normalizedName: string;
}

export type PropertyType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'url' | 'entity' | 'list';

export interface PropertyDefinitionEntity extends CanonicalEntityBase<'property-definition', PropertyDefinitionId> {
  vaultId: VaultDomainId;
  name: string;
  propertyType: PropertyType;
  allowedEntityTypes: readonly CanonicalEntityType[] | null;
  options: readonly string[] | null;
}

export type TaskStatus = 'open' | 'completed' | 'cancelled';

export interface TaskEntity extends CanonicalEntityBase<'task', TaskId> {
  vaultId: VaultDomainId;
  title: string;
  status: TaskStatus;
  scheduledAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  priority: 'high' | 'medium' | 'low' | null;
  projectId: ProjectId | null;
  parentTaskId: TaskId | null;
  sourceNoteId: NoteId | null;
  sourceBlockId: string | null;
  recurrenceRule: string | null;
}

export interface EventEntity extends CanonicalEntityBase<'event', EventId> {
  vaultId: VaultDomainId;
  title: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  timezone: string | null;
  location: string | null;
  description: string | null;
  recurrenceRule: string | null;
  projectId: ProjectId | null;
  externalSource: {
    provider: string;
    accountId: string;
    externalId: string;
  } | null;
}

export type ProjectStatus = 'planned' | 'active' | 'paused' | 'completed' | 'archived';

export interface ProjectEntity extends CanonicalEntityBase<'project', ProjectId> {
  vaultId: VaultDomainId;
  title: string;
  status: ProjectStatus;
  description: string | null;
  startDate: LocalDate | null;
  targetDate: LocalDate | null;
  completedAt: string | null;
  parentProjectId: ProjectId | null;
  noteId: NoteId | null;
}

export interface PersonEntity extends CanonicalEntityBase<'person', PersonId> {
  vaultId: VaultDomainId;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  aliases: readonly string[];
  description: string | null;
  profileNoteId: NoteId | null;
}

export interface AttachmentEntity extends CanonicalEntityBase<'attachment', AttachmentId> {
  vaultId: VaultDomainId;
  filename: string;
  mediaType: string;
  size: number;
  checksumSha256: string;
  originalFilename: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

export type CaptureInputType = 'text' | 'voice-transcript' | 'share' | 'clipboard' | 'file';
export type CaptureProcessingStatus = 'unprocessed' | 'processing' | 'processed' | 'failed';

export interface CaptureEntity extends CanonicalEntityBase<'capture', CaptureId> {
  vaultId: VaultDomainId;
  inputType: CaptureInputType;
  rawContent: string;
  processingStatus: CaptureProcessingStatus;
  sourceDeviceId: DeviceId | null;
  resultingEntities: readonly EntityReference[];
}

export interface CollectionEntity extends CanonicalEntityBase<'collection', CollectionId> {
  vaultId: VaultDomainId;
  title: string;
  mode: 'static' | 'dynamic';
  query: string | null;
  explicitEntities: readonly EntityReference[];
  sort: string | null;
  group: string | null;
}

export type LinkTarget =
  | { kind: 'resolved'; reference: EntityReference }
  | { kind: 'unresolved'; requestedTargetText: string };

export interface LinkEntity extends CanonicalEntityBase<'link', LinkId> {
  vaultId: VaultDomainId;
  source: EntityReference;
  target: LinkTarget;
  relation: string;
  sourceBlockId: string | null;
}

export interface InferredRelationship {
  source: EntityReference;
  target: EntityReference;
  method: 'semantic' | 'rule' | 'ai';
  score: number | null;
  generatedAt: string;
}

export type CanonicalEntity =
  | VaultEntity
  | NoteEntity
  | FolderEntity
  | TagEntity
  | PropertyDefinitionEntity
  | TaskEntity
  | EventEntity
  | ProjectEntity
  | PersonEntity
  | AttachmentEntity
  | CaptureEntity
  | CollectionEntity
  | LinkEntity;

function assertTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || !value.includes('T') || Number.isNaN(Date.parse(value))) {
    throw new VaultError('CORRUPT', field + ' must be an ISO date-time.');
  }
}

function assertTemporal(value: string, field: string): void {
  if (localDatePattern.test(value)) {
    asLocalDate(value);
    return;
  }
  assertTimestamp(value, field);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VaultError('CORRUPT', field + ' must be a positive safe integer.');
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new VaultError('CORRUPT', field + ' must not be empty.');
  }
}

function assertReference(reference: EntityReference): void {
  if (!CANONICAL_ENTITY_TYPES.includes(reference.entityType)) {
    throw new VaultError('CORRUPT', 'Entity reference type is invalid.');
  }
  if (!isStableUuid(reference.entityId)) {
    throw new VaultError('CORRUPT', 'Entity reference ID is invalid.');
  }
}

function assertPropertyValue(value: PropertyValue): void {
  if (value.type === 'list') {
    for (const item of value.value) assertPropertyValue(item);
    return;
  }

  switch (value.type) {
    case 'text':
      if (typeof value.value !== 'string') throw new VaultError('CORRUPT', 'Text property is invalid.');
      return;
    case 'number':
      if (!Number.isFinite(value.value)) throw new VaultError('CORRUPT', 'Number property is invalid.');
      return;
    case 'boolean':
      if (typeof value.value !== 'boolean') throw new VaultError('CORRUPT', 'Boolean property is invalid.');
      return;
    case 'date':
      asLocalDate(value.value);
      return;
    case 'datetime':
      assertTimestamp(value.value, 'Datetime property');
      return;
    case 'url':
      try {
        new URL(value.value);
      } catch {
        throw new VaultError('CORRUPT', 'URL property is invalid.');
      }
      return;
    case 'entity':
      assertReference(value.value);
      return;
    case 'null':
      if (value.value !== null) throw new VaultError('CORRUPT', 'Null property is invalid.');
      return;
  }
}

function assertBase(entity: CanonicalEntity): void {
  if (!isStableUuid(entity.id)) throw new VaultError('CORRUPT', 'Canonical entity ID is invalid.');
  if (!CANONICAL_ENTITY_TYPES.includes(entity.entityType)) throw new VaultError('CORRUPT', 'Canonical entity type is invalid.');
  assertPositiveInteger(entity.schemaVersion, 'schemaVersion');
  assertPositiveInteger(entity.revision, 'revision');
  assertTimestamp(entity.createdAt, 'createdAt');
  assertTimestamp(entity.updatedAt, 'updatedAt');
  if (entity.deletedAt !== null) assertTimestamp(entity.deletedAt, 'deletedAt');
  for (const [name, value] of Object.entries(entity.properties)) {
    assertNonEmpty(name, 'Property name');
    assertPropertyValue(value);
  }
}

export function normalizeTagName(raw: string): string {
  const value = raw.normalize('NFC').trim().replace(/^#+/u, '');
  if (!value || /[\s#]/u.test(value)) {
    throw new VaultError('CORRUPT', 'Tags must be non-empty and cannot contain whitespace or #.');
  }
  return value.toLowerCase();
}

export function assertCanonicalEntity(entity: CanonicalEntity): void {
  assertBase(entity);

  switch (entity.entityType) {
    case 'vault':
      assertNonEmpty(entity.name, 'Vault name');
      return;

    case 'note':
      assertNonEmpty(entity.title, 'Note title');
      if (typeof entity.body !== 'string') throw new VaultError('CORRUPT', 'Note body must be text.');
      if (entity.noteKind === 'daily') {
        if (!entity.dailyDate) throw new VaultError('CORRUPT', 'Daily notes require a semantic dailyDate.');
        asLocalDate(entity.dailyDate);
      } else if (entity.dailyDate !== undefined) {
        throw new VaultError('CORRUPT', 'Only daily notes may define dailyDate.');
      }
      return;

    case 'folder':
      assertNonEmpty(entity.name, 'Folder name');
      if (entity.parentFolderId !== null && entity.parentFolderId === entity.id) {
        throw new VaultError('CYCLE', 'A folder cannot parent itself.');
      }
      return;

    case 'tag':
      assertNonEmpty(entity.name, 'Tag name');
      if (entity.normalizedName !== normalizeTagName(entity.name)) {
        throw new VaultError('CORRUPT', 'Tag normalizedName does not match its name.');
      }
      return;

    case 'property-definition':
      assertNonEmpty(entity.name, 'Property definition name');
      if (entity.allowedEntityTypes) {
        for (const type of entity.allowedEntityTypes) {
          if (!CANONICAL_ENTITY_TYPES.includes(type)) throw new VaultError('CORRUPT', 'Property entity type is invalid.');
        }
      }
      return;

    case 'task':
      assertNonEmpty(entity.title, 'Task title');
      if (entity.scheduledAt !== null) assertTemporal(entity.scheduledAt, 'scheduledAt');
      if (entity.dueAt !== null) assertTemporal(entity.dueAt, 'dueAt');
      if (entity.status === 'completed') {
        if (entity.completedAt === null) throw new VaultError('CORRUPT', 'Completed tasks require completedAt.');
        assertTimestamp(entity.completedAt, 'completedAt');
      } else if (entity.completedAt !== null) {
        throw new VaultError('CORRUPT', 'Only completed tasks may define completedAt.');
      }
      if (entity.parentTaskId !== null && entity.parentTaskId === entity.id) {
        throw new VaultError('CYCLE', 'A task cannot parent itself.');
      }
      return;

    case 'event': {
      assertNonEmpty(entity.title, 'Event title');
      assertTemporal(entity.startAt, 'startAt');
      if (entity.endAt !== null) {
        assertTemporal(entity.endAt, 'endAt');
        if (Date.parse(entity.endAt) < Date.parse(entity.startAt)) {
          throw new VaultError('CORRUPT', 'Event endAt cannot precede startAt.');
        }
      }
      if (entity.externalSource) {
        assertNonEmpty(entity.externalSource.provider, 'External provider');
        assertNonEmpty(entity.externalSource.accountId, 'External account ID');
        assertNonEmpty(entity.externalSource.externalId, 'External event ID');
      }
      return;
    }

    case 'project':
      assertNonEmpty(entity.title, 'Project title');
      if (entity.startDate !== null) asLocalDate(entity.startDate);
      if (entity.targetDate !== null) asLocalDate(entity.targetDate);
      if (entity.completedAt !== null) assertTimestamp(entity.completedAt, 'Project completedAt');
      if (entity.parentProjectId !== null && entity.parentProjectId === entity.id) {
        throw new VaultError('CYCLE', 'A project cannot parent itself.');
      }
      return;

    case 'person':
      assertNonEmpty(entity.displayName, 'Person display name');
      return;

    case 'attachment':
      assertNonEmpty(entity.filename, 'Attachment filename');
      assertNonEmpty(entity.mediaType, 'Attachment media type');
      if (!Number.isSafeInteger(entity.size) || entity.size < 0) throw new VaultError('CORRUPT', 'Attachment size is invalid.');
      if (!sha256Pattern.test(entity.checksumSha256)) throw new VaultError('CORRUPT', 'Attachment checksum must be SHA-256 hex.');
      if (entity.width !== null && (!Number.isFinite(entity.width) || entity.width <= 0)) throw new VaultError('CORRUPT', 'Attachment width is invalid.');
      if (entity.height !== null && (!Number.isFinite(entity.height) || entity.height <= 0)) throw new VaultError('CORRUPT', 'Attachment height is invalid.');
      if (entity.durationSeconds !== null && (!Number.isFinite(entity.durationSeconds) || entity.durationSeconds < 0)) throw new VaultError('CORRUPT', 'Attachment duration is invalid.');
      return;

    case 'capture':
      if (typeof entity.rawContent !== 'string') throw new VaultError('CORRUPT', 'Capture rawContent must be text.');
      for (const reference of entity.resultingEntities) assertReference(reference);
      return;

    case 'collection':
      assertNonEmpty(entity.title, 'Collection title');
      if (entity.mode === 'dynamic') {
        if (!entity.query || !entity.query.trim()) throw new VaultError('CORRUPT', 'Dynamic collections require a query.');
      } else if (entity.query !== null) {
        throw new VaultError('CORRUPT', 'Static collections cannot carry a dynamic query.');
      }
      for (const reference of entity.explicitEntities) assertReference(reference);
      return;

    case 'link':
      assertReference(entity.source);
      assertNonEmpty(entity.relation, 'Link relation');
      if (entity.target.kind === 'resolved') {
        assertReference(entity.target.reference);
      } else {
        assertNonEmpty(entity.target.requestedTargetText, 'Unresolved link target');
      }
      return;
  }
}

export function assertUniqueCanonicalIds(entities: readonly CanonicalEntity[]): void {
  const seen = new Set<string>();
  for (const entity of entities) {
    const id = entity.id as string;
    if (seen.has(id)) throw new VaultError('CORRUPT', 'Canonical entity IDs must be globally unique.');
    seen.add(id);
  }
}

export function assertProjectHierarchy(projects: readonly ProjectEntity[]): void {
  const byId = new Map<string, ProjectEntity>(projects.map(project => [project.id as string, project]));
  for (const project of projects) {
    const seen = new Set<string>();
    let current: ProjectEntity | undefined = project;

    while (current?.parentProjectId) {
      const currentId = current.id as string;
      if (seen.has(currentId)) throw new VaultError('CYCLE', 'Project hierarchy contains a cycle.');
      seen.add(currentId);
      current = byId.get(current.parentProjectId as string);
    }
  }
}

export function entityReference<K extends CanonicalEntityType>(
  entity: Extract<CanonicalEntity, { entityType: K }>,
): EntityReference<K> {
  return {
    entityType: entity.entityType,
    entityId: entity.id,
  } as EntityReference<K>;
}
