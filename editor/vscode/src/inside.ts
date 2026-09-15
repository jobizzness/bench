import { isAbsolute, relative, resolve } from "node:path";

/**
 * Whether a file the daemon named is any of this window's business.
 *
 * A specialist on another project is editing files at paths this window has
 * never heard of, and opening them would drag an unrelated checkout onto the
 * screen. One daemon serves every project at once, so this filter is what
 * makes several open windows each follow only their own.
 *
 * Done with `relative` rather than a prefix test: `/var/www/bench-old` starts
 * with `/var/www/bench`, and a string comparison would happily open it.
 */
export function insideWorkspace(filePath: string, folders: string[]): boolean {
  // Nothing to resolve a relative path against - the daemon always sends
  // absolute ones, so this is a malformed event rather than a near miss.
  if (!isAbsolute(filePath)) return false;

  const file = resolve(filePath);
  return folders.some((folder) => {
    const step = relative(resolve(folder), file);
    // Empty means the file *is* the folder; a `..` step means it is outside.
    return step === "" || (!step.startsWith("..") && !isAbsolute(step));
  });
}
