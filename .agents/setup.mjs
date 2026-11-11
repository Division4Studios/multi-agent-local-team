/**
 * Shared-skill setup for the repository's agent tools.
 * Creates tool-specific links to the canonical .agents/skills directory, keeping
 * new skills available without copying or synchronizing their contents. Existing
 * conflicting files/directories are rejected rather than replaced, and Windows
 * uses directory junctions so setup does not require elevated privileges.
 * See .agents/README.md for installation and maintenance instructions.
 */
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = realpathSync(join(root, '.agents', 'skills'));

// Link the entire directory so new skills are available without another sync.
for (const agent of ['.claude', '.codex']) {
  const link = join(root, agent, 'skills');
  let existing;
  try {
    existing = lstatSync(link);
  } catch (error) {
    // Only an absent path is safe to create. Permission and filesystem errors
    // must surface instead of being mistaken for permission to replace a path.
    if (error.code !== 'ENOENT') throw error;
  }

  if (existing) {
    // Idempotent setup accepts only a link to the exact canonical target. A
    // conflicting directory may contain user work, so reconciliation is manual.
    if (!existing.isSymbolicLink() || realpathSync(link) !== target) {
      throw new Error(
        `${link} already exists and is not a link to ${target}. Consolidate its contents manually before rerunning setup.`,
      );
    }
    console.log(`${agent}/skills already points to .agents/skills`);
    continue;
  }

  mkdirSync(dirname(link), { recursive: true });
  // Windows junctions do not need Developer Mode or Administrator privileges.
  const windows = process.platform === 'win32';
  symlinkSync(windows ? target : relative(dirname(link), target), link, windows ? 'junction' : 'dir');
  console.log(`${agent}/skills -> .agents/skills`);
}
