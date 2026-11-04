/** Only Microsoft's documented compiler/linter aliases are allowed, with stable exact versions. */
export function isApprovedVersion(name: string, version: unknown): boolean {
  if (typeof version !== 'string') {
    return false;
  }
  if (name === '@typescript/native') {
    return /^npm:typescript@7\.\d+\.\d+$/u.test(version);
  }
  if (name === 'typescript') {
    return /^npm:@typescript\/typescript6@6\.0\.\d+$/u.test(version);
  }
  return /^\d+\.\d+\.\d+$/u.test(version);
}
