/**
 * Shared bounded-text helpers. Every model-facing textual result (MCP tool
 * results, read resources, execute envelopes) is truncated with an explicit
 * marker so the model can tell evidence was cut off.
 */
export const TRUNCATION_MARKER = '\n[content truncated]';

export function truncateUtf8(value: string, maxBytes: number, marker: string = TRUNCATION_MARKER): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  const markerBytes = new TextEncoder().encode(marker);
  if (markerBytes.byteLength >= maxBytes) {
    return new TextDecoder().decode(markerBytes.subarray(0, maxBytes));
  }
  const available = Math.max(0, maxBytes - markerBytes.byteLength);
  let end = available;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  const prefix = new TextDecoder().decode(encoded.subarray(0, end));
  return `${prefix}${marker}`;
}

/** JSON.stringify that never throws and is bounded to maxBytes. */
export function safeJson(value: unknown, maxBytes: number): string {
  try {
    return truncateUtf8(JSON.stringify(value), maxBytes);
  } catch {
    return 'null';
  }
}
