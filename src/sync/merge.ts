export type TextMerge =
  | { kind: 'resolved'; text: string; reason: 'identical' | 'local-unchanged' | 'remote-unchanged' }
  | { kind: 'conflict'; base: string; local: string; remote: string };

/** Conservative Phase 0 decision. A real diff3 engine is a Phase 6 release gate. */
export function compareVersions(base: string, local: string, remote: string): TextMerge {
  if (local === remote) return { kind: 'resolved', text: local, reason: 'identical' };
  if (local === base) return { kind: 'resolved', text: remote, reason: 'local-unchanged' };
  if (remote === base) return { kind: 'resolved', text: local, reason: 'remote-unchanged' };
  return { kind: 'conflict', base, local, remote };
}
