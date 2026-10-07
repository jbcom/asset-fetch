import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** True when `candidate` is `root` or lies below it. Both must already be resolved. */
function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  // `relative` yields an absolute path across Windows drives, and a leading
  // `..` segment (not a name that merely starts with two dots) means "above".
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/**
 * Refuse a path that is not inside one of `roots`, and return it resolved.
 *
 * Call it before anything is written, so a manifest or remote name that
 * resolves to an absolute or `..` destination is rejected before a byte lands
 * rather than audited afterwards. The comparison is path-segment aware: a
 * sibling directory that merely shares a string prefix with a root is outside.
 */
export function assertWithin(candidate: string, roots: readonly string[]): string {
  const resolved = resolve(candidate);
  if (!roots.some((root) => isInside(resolve(root), resolved))) {
    throw new Error(`refusing path outside the asset tree: ${resolved}`);
  }
  return resolved;
}

/**
 * Audit an extraction directory after the extractor has run and before it is
 * moved into place.
 *
 * Archive member names are checked lexically before extraction, but a symlink
 * member passes that check and can still point anywhere. This walks the tree,
 * resolves every entry's real path, and throws on the first one that is not
 * inside `dir`, so the caller can discard the whole extraction.
 *
 * Every entry is inspected with `lstat` and a symlink is never descended into,
 * so a link to a directory outside is refused rather than followed and a
 * self-referential link cannot loop. A symlink whose target cannot be resolved
 * is refused too: its destination cannot be proven to be inside.
 */
export function assertExtractionContained(dir: string): void {
  const root = realpathSync(dir);
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const entry = join(current, name);
      const kind = lstatSync(entry);
      let real: string;
      try {
        real = realpathSync(entry);
      } catch {
        throw new Error(`archive entry cannot be resolved: ${entry}`);
      }
      if (!isInside(root, real)) {
        throw new Error(`archive entry escapes extraction dir: ${entry} -> ${real}`);
      }
      if (kind.isDirectory()) walk(entry);
    }
  };
  walk(root);
}

/**
 * The shape an itch.io API key is allowed to have: 8 to 128 characters of
 * letters, digits, `.`, `_` and `-`.
 *
 * Deliberately strict. It is the only thing between a value read from the
 * environment or a `.env` file and an outbound `Authorization` header, so a key
 * carrying a newline, a shell metacharacter or an accidental `KEY=value` prefix
 * is rejected rather than sent.
 */
export const KEY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Return the trimmed key only if it matches {@link KEY_PATTERN}; otherwise `undefined`. Never throws. */
export function sanitizeKey(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return KEY_PATTERN.test(trimmed) ? trimmed : undefined;
}
