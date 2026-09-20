import { VaultError } from '../domain/errors.js';
export interface Command {
  id: string;
  label: string;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}
export class CommandRegistry {
  private commands = new Map<string, Command>();
  register(command: Command): () => void {
    if (this.commands.has(command.id)) throw new VaultError('CONFIGURATION', `Duplicate command: ${command.id}`);
    this.commands.set(command.id, command);
    return () => { if (this.commands.get(command.id) === command) this.commands.delete(command.id); };
  }
  list(query = ''): Command[] {
    const tokens = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    return [...this.commands.values()].filter(command => tokens.every(token => `${command.label} ${command.id}`.toLocaleLowerCase().includes(token)));
  }
  async execute(id: string): Promise<void> {
    const command = this.commands.get(id);
    if (!command) throw new VaultError('NOT_FOUND', `Unknown command: ${id}`);
    if (command.enabled && !command.enabled()) throw new VaultError('UNSUPPORTED', 'This command is not available in the current context.');
    await command.run();
  }
}
export interface FeatureModule {
  id: string;
  activate(registry: CommandRegistry): () => void;
}
export class ModuleRegistry {
  private cleanup = new Map<string, () => void>();
  enable(module: FeatureModule, registry: CommandRegistry): void {
    if (this.cleanup.has(module.id)) return;
    this.cleanup.set(module.id, module.activate(registry));
  }
  disable(id: string): void { this.cleanup.get(id)?.(); this.cleanup.delete(id); }
  dispose(): void { for (const id of this.cleanup.keys()) this.disable(id); }
}
