// App version comparison for the minimum-version gate ("1.2.10" > "1.2.9"; "1.3.0-beta.1" < "1.3.0").

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && VERSION.test(value);
}

function parse(version: string) {
  const [core, pre = ''] = version.split(/-(.*)/s, 2);
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number(part) || 0);
  return { parts: [major, minor, patch], pre };
}

/** <0 when a is older than b, 0 when equal, >0 when newer. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1; // a release is newer than its pre-releases
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, 'en', { numeric: true });
}
