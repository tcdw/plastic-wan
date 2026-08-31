import { createHash, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { type Orm, asRunResult } from '../database.ts';
import { adminSessions, adminUsers } from '../schema.ts';

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
  readonly passwordHash: string;
}

interface SessionRow {
  readonly id: bigint;
  readonly userId: bigint;
  readonly username: string;
  readonly expiresAt: string;
}

export class AdminAuth {
  readonly #orm: Orm;
  readonly #ttlMs: number;
  readonly #failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(orm: Orm, sessionTtlHours: number) {
    this.#orm = orm;
    this.#ttlMs = sessionTtlHours * 3_600_000;
  }

  setupRequired(): boolean {
    const row = this.#orm.select({ count: sql<bigint>`count(*)` }).from(adminUsers).get();
    return (row?.count ?? 0n) === 0n;
  }

  async createFirstUser(credentials: AdminCredentials, now = new Date()): Promise<string> {
    assertCredentials(credentials);
    const passwordHash = await Bun.password.hash(credentials.password, HASH_OPTIONS);
    const iso = now.toISOString();
    const userId = this.#orm.transaction(
      () => {
        if (!this.setupRequired()) {
          throw new AdminAuthError(409, 'setup_complete', 'Administrator account already exists');
        }
        const created = this.#orm
          .insert(adminUsers)
          .values({
            username: credentials.username,
            passwordHash,
            createdAt: iso,
            updatedAt: iso,
            lastLoginAt: iso,
          })
          .returning({ id: adminUsers.id })
          .get();
        if (created === undefined) {
          throw new Error('admin_users insert returned no row');
        }
        return created.id;
      },
      { behavior: 'immediate' },
    );
    return this.#createSession(userId, now);
  }
  async changeCredentials(userId: bigint, credentials: AdminCredentials, now = new Date()): Promise<string> {
    assertCredentials(credentials);
    const passwordHash = await Bun.password.hash(credentials.password, HASH_OPTIONS);
    const iso = now.toISOString();
    return this.#orm.transaction(
      () => {
        const existing = this.#orm
          .select({ id: adminUsers.id })
          .from(adminUsers)
          .where(eq(adminUsers.username, credentials.username))
          .get();
        if (existing !== undefined && existing.id !== userId) {
          throw new AdminAuthError(409, 'username_taken', 'Username is already in use');
        }
        const updated = asRunResult(
          this.#orm
            .update(adminUsers)
            .set({ username: credentials.username, passwordHash, updatedAt: iso })
            .where(eq(adminUsers.id, userId))
            .run(),
        );
        if (updated.changes === 0) {
          throw new AdminAuthError(401, 'unauthenticated', 'Admin session is required');
        }
        this.#orm.delete(adminSessions).where(eq(adminSessions.userId, userId)).run();
        return this.#createSession(userId, now);
      },
      { behavior: 'immediate' },
    );
  }

  async login(credentials: AdminCredentials, now = new Date(), clientKey = 'unknown'): Promise<string> {
    const username = typeof credentials.username === 'string' ? credentials.username : '';
    const password = typeof credentials.password === 'string' ? credentials.password : '';
    const failureKey = `${clientKey}|${username.toLowerCase()}`;
    const failure = this.#failures.get(failureKey);
    if (failure !== undefined && failure.lockedUntil > now.getTime()) {
      throw new AdminAuthError(429, 'too_many_attempts', 'Too many failed attempts; retry later');
    }
    const row = this.#orm
      .select({ id: adminUsers.id, passwordHash: adminUsers.passwordHash })
      .from(adminUsers)
      .where(eq(adminUsers.username, username))
      .get() satisfies UserRow | undefined;
    let verified = false;
    if (row === undefined) {
      // Burn comparable time on unknown usernames so response latency does not leak account existence.
      await Bun.password.hash(password.length === 0 ? 'absent-account-placeholder' : password, HASH_OPTIONS);
    } else {
      verified = await Bun.password.verify(password, row.passwordHash);
    }
    if (row === undefined || !verified) {
      const count = (failure?.count ?? 0) + 1;
      this.#failures.set(failureKey, {
        count,
        lockedUntil: count >= MAX_FAILED_ATTEMPTS ? now.getTime() + LOCKOUT_MS : 0,
      });
      throw new AdminAuthError(401, 'invalid_credentials', 'Invalid username or password');
    }
    this.#failures.delete(failureKey);
    this.#orm
      .update(adminUsers)
      .set({ lastLoginAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(eq(adminUsers.id, row.id))
      .run();
    return this.#createSession(row.id, now);
  }

  authenticate(token: string, now = new Date()): AdminSession | null {
    if (token.length === 0) {
      return null;
    }
    const row = this.#orm
      .select({
        id: adminSessions.id,
        userId: adminSessions.userId,
        username: adminUsers.username,
        expiresAt: adminSessions.expiresAt,
      })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
      .where(eq(adminSessions.tokenHash, hashToken(token)))
      .get() satisfies SessionRow | undefined;
    if (row === undefined) {
      return null;
    }
    if (row.expiresAt <= now.toISOString()) {
      this.#orm.delete(adminSessions).where(eq(adminSessions.id, row.id)).run();
      return null;
    }
    this.#orm.update(adminSessions).set({ lastSeenAt: now.toISOString() }).where(eq(adminSessions.id, row.id)).run();
    return { userId: row.userId, username: row.username, expiresAt: row.expiresAt };
  }

  logout(token: string): void {
    if (token.length === 0) {
      return;
    }
    this.#orm
      .delete(adminSessions)
      .where(eq(adminSessions.tokenHash, hashToken(token)))
      .run();
  }

  purgeExpired(now = new Date()): void {
    this.#orm.run(sql`DELETE FROM admin_sessions WHERE expires_at <= ${now.toISOString()}`);
  }

  get sessionTtlMs(): number {
    return this.#ttlMs;
  }

  #createSession(userId: bigint, now: Date): string {
    this.purgeExpired(now);
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const iso = now.toISOString();
    this.#orm
      .insert(adminSessions)
      .values({
        userId,
        tokenHash: hashToken(token),
        createdAt: iso,
        expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
        lastSeenAt: iso,
      })
      .run();
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
