/**
 * Collects live secrets so unexpected text can be scrubbed before it is ever logged.
 * Only values long enough to be meaningful are tracked, and nothing is ever written
 * out. The core owns one instance per assembled service; there is deliberately no
 * process-global redactor, because secret ownership belongs to the configuration
 * that introduced them.
 */
export class Redactor {
  private secrets = new Set<string>();

  add(secret: string | undefined | null): void {
    if (typeof secret === 'string' && secret.length >= 8) {
      this.secrets.add(secret);
    }
  }

  remove(secret: string): void {
    this.secrets.delete(secret);
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      result = result.split(secret).join('[redacted]');
    }
    return result;
  }
}

export function redactWith(redactor: Redactor, value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return redactor.redact(text);
}
