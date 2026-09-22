export type ErrorCode =
  | 'INVALID_NAME' | 'NOT_FOUND' | 'COLLISION' | 'INVALID_PARENT'
  | 'CYCLE' | 'STALE_WRITE' | 'DELETED' | 'STORAGE' | 'CONFIGURATION'
  | 'UNSUPPORTED' | 'PROTOCOL' | 'ACCOUNT_MISMATCH' | 'PERMISSION' | 'CORRUPT' | 'INVALID_VERSION';

export class VaultError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VaultError';
  }
}

export function explainError(error: unknown): string {
  if (error instanceof VaultError) return error.message;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return 'Local storage is full. Your current draft is still in the editor. Export it before closing.';
  }
  return 'The operation could not be saved. Keep this window open and export your draft.';
}
