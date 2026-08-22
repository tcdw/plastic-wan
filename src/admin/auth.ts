import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';

const SESSION_TOKEN_BYTES = 32;
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60_000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const HASH_OPTIONS = { algorithm: 'argon2id' } as const;

export interface AdminCredentials {
  readonly username: string;
  readonly password: string;
}

export interface AdminSession {
  readonly userId: bigint;
  readonly username: string;
  readonly expiresAt: string;
}

export class AdminAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface UserRow {
  readonly id: bigint;
  readonly password_hash: string;
}

interface SessionRow {
  readonly id: bigint;
  readonly user_id: bigint;
  readonly username: string;
  readonly expires_at: string;
}

export class AdminAuth {
  readonly #db: Database;
  readonly #ttlMs: number;
  readonly #failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(db: Database, sessionTtlHours: number) {
    this.#db = db;
    this.#ttlMs = sessionTtlHours * 3_600_000;
  }

  setupRequired(): boolean {
    const row = this.#db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM admin_users').get();
    return (row?.count ?? 0n) === 0n;
  }

  async createFirstUser(credentials: AdminCredentials, now = new Date()): Promise<string> {
    assertCredentials(credentials);
    const passwordHash = await Bun.password.hash(credentials.password, HASH_OPTIONS);
    const iso = now.toISOString();
    const userId = this.#db
      .transaction(() => {
        if (!this.setupRequired()) {
          throw new AdminAuthError(409, 'setup_complete', 'Administrator account already exists');
        }
        const created = this.#db
          .query(
            'INSERT INTO admin_users(username, password_hash, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(credentials.username, passwordHash, iso, iso, iso);
        return BigInt(created.lastInsertRowid);
      })
      .immediate();
    return this.#createSession(userId, now);
  }
  async changeCredentials(userId: bigint, credentials: AdminCredentials, now = new Date()): Promise<string> {
    assertCredentials(credentials);
    const passwordHash = await Bun.password.hash(credentials.password, HASH_OPTIONS);
    const iso = now.toISOString();
    return this.#db
      .transaction(() => {
        const existing = this.#db
          .query<{ id: bigint }, [string]>('SELECT id FROM admin_users WHERE username = ?')
          .get(credentials.username);
        if (existing !== null && existing.id !== userId) {
          throw new AdminAuthError(409, 'username_taken', 'Username is already in use');
        }
        const updated = this.#db
          .query('UPDATE admin_users SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?')
          .run(credentials.username, passwordHash, iso, userId);
        if (updated.changes === 0) throw new AdminAuthError(401, 'unauthenticated', 'Admin session is required');
        this.#db.query('DELETE FROM admin_sessions WHERE user_id = ?').run(userId);
        return this.#createSession(userId, now);
      })
      .immediate();
  }

  async login(credentials: AdminCredentials, now = new Date(), clientKey = 'unknown'): Promise<string> {
    const username = typeof credentials.username === 'string' ? credentials.username : '';
    const password = typeof credentials.password === 'string' ? credentials.password : '';
    const failureKey = `${clientKey}|${username.toLowerCase()}`;
    const failure = this.#failures.get(failureKey);
    if (failure !== undefined && failure.lockedUntil > now.getTime()) {
      throw new AdminAuthError(429, 'too_many_attempts', 'Too many failed attempts; retry later');
    }
    const row = this.#db
      .query<UserRow, [string]>('SELECT id, password_hash FROM admin_users WHERE username = ?')
      .get(username);
    let verified = false;
    if (row === null) {
      // Burn comparable time on unknown usernames so response latency does not leak account existence.
      await Bun.password.hash(password.length === 0 ? 'absent-account-placeholder' : password, HASH_OPTIONS);
    } else {
      verified = await Bun.password.verify(password, row.password_hash);
    }
    if (row === null || !verified) {
      const count = (failure?.count ?? 0) + 1;
      this.#failures.set(failureKey, {
        count,
        lockedUntil: count >= MAX_FAILED_ATTEMPTS ? now.getTime() + LOCKOUT_MS : 0,
      });
      throw new AdminAuthError(401, 'invalid_credentials', 'Invalid username or password');
    }
    this.#failures.delete(failureKey);
    this.#db
      .query('UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .run(now.toISOString(), now.toISOString(), row.id);
    return this.#createSession(row.id, now);
  }

  authenticate(token: string, now = new Date()): AdminSession | null {
    if (token.length === 0) return null;
    const row = this.#db
      .query<SessionRow, [string]>(
        `SELECT s.id, s.user_id, u.username, s.expires_at
         FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token));
    if (row === null) return null;
    if (row.expires_at <= now.toISOString()) {
      this.#db.query('DELETE FROM admin_sessions WHERE id = ?').run(row.id);
      return null;
    }
    this.#db.query('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.id);
    return { userId: row.user_id, username: row.username, expiresAt: row.expires_at };
  }

  logout(token: string): void {
    if (token.length === 0) return;
    this.#db.query('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  purgeExpired(now = new Date()): void {
    this.#db.query('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now.toISOString());
  }

  get sessionTtlMs(): number {
    return this.#ttlMs;
  }

  #createSession(userId: bigint, now: Date): string {
    this.purgeExpired(now);
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const iso = now.toISOString();
    this.#db
      .query(
        'INSERT INTO admin_sessions(user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(userId, hashToken(token), iso, new Date(now.getTime() + this.#ttlMs).toISOString(), iso);
    return token;
  }
}

function assertCredentials(credentials: AdminCredentials): void {
  if (typeof credentials.username !== 'string' || !USERNAME_PATTERN.test(credentials.username)) {
    throw new AdminAuthError(
      400,
      'invalid_username',
      'Username must be 3-32 characters of letters, digits, dot, underscore, or hyphen',
    );
  }
  if (
    typeof credentials.password !== 'string' ||
    credentials.password.length < MIN_PASSWORD_LENGTH ||
    credentials.password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new AdminAuthError(
      400,
      'invalid_password',
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
