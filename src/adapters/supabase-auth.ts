import { VaultError } from '../domain/errors.js';
import type { AuthIdentity, AuthService } from '../services/ports.js';

/** Structural port accepted by a real supabase-js client's auth object. */
export interface SupabaseAuthPort {
  getUser(): Promise<{ data: { user: { id: string; email?: string } | null }; error: { message: string } | null }>;
  signInWithPassword(input: { email: string; password: string }): Promise<{ error: { message: string } | null }>;
  signOut(options: { scope: 'local' }): Promise<{ error: { message: string } | null }>;
}

export class SupabaseAuthAdapter implements AuthService {
  readonly configured = true;
  constructor(private readonly auth: SupabaseAuthPort) {}
  async identity(): Promise<AuthIdentity | null> {
    const result = await this.auth.getUser();
    if (result.error) throw new VaultError('CONFIGURATION', result.error.message);
    return result.data.user ? { userId: result.data.user.id, email: result.data.user.email ?? null } : null;
  }
  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.auth.signInWithPassword({ email, password });
    if (error) throw new VaultError('CONFIGURATION', error.message);
  }
  async signOut(): Promise<void> {
    // Caller must flush/export unsynced drafts before invoking this; local vault data is not cleared.
    const { error } = await this.auth.signOut({ scope: 'local' });
    if (error) throw new VaultError('CONFIGURATION', error.message);
  }
}

export class UnconfiguredAuth implements AuthService {
  readonly configured = false;
  async identity(): Promise<null> { return null; }
  async signIn(): Promise<never> { throw new VaultError('CONFIGURATION', 'Cloud authentication is not configured.'); }
  async signOut(): Promise<void> { /* There is no session to revoke and no data is deleted. */ }
}
