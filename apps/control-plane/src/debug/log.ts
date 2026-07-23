/** Compact JSON for debug logs; truncates long strings. */
export function debugPreview(value: unknown, max = 200): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  } catch {
    return String(value);
  }
}

export function cpLog(...args: unknown[]): void {
  console.log("[cp:debug]", ...args);
}

export function vmLog(...args: unknown[]): void {
  console.log("[vm:debug]", ...args);
}
