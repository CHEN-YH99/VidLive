import { Pool, type PoolClient } from 'pg';

export interface StoredUserRecord {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  planType: 'free' | 'pro';
  dailyQuota: number;
  createdAt: string;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
}

export interface CreateUserRecordInput {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  planType: 'free' | 'pro';
  dailyQuota: number;
}

type UserRow = {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  plan_type: string;
  daily_quota: number;
  created_at: Date;
  failed_login_count: number | null;
  locked_until: Date | null;
  last_login_at: Date | null;
};

export class V1AuthStore {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<V1AuthStore> {
    const store = new V1AuthStore(
      new Pool({
        connectionString: normalizePostgresConnectionString(databaseUrl),
        max: 10,
      }),
    );

    await store.ensureSchema();

    return store;
  }

  async findUserByEmail(email: string): Promise<StoredUserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `select id, email, username, password_hash, plan_type, daily_quota, created_at,
              failed_login_count, locked_until, last_login_at
         from users
        where email = $1
        limit 1`,
      [email],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async findUserById(id: string): Promise<StoredUserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `select id, email, username, password_hash, plan_type, daily_quota, created_at,
              failed_login_count, locked_until, last_login_at
         from users
        where id = $1
        limit 1`,
      [id],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async usernameExists(username: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>('select exists(select 1 from users where lower(username) = lower($1))', [
      username,
    ]);

    return result.rows[0]?.exists === true;
  }

  async createUser(input: CreateUserRecordInput): Promise<StoredUserRecord> {
    const result = await this.pool.query<UserRow>(
      `insert into users (id, email, username, password_hash, plan_type, daily_quota, password_changed_at)
       values ($1, $2, $3, $4, $5, $6, now())
       returning id, email, username, password_hash, plan_type, daily_quota, created_at,
                 failed_login_count, locked_until, last_login_at`,
      [input.id, input.email, input.username, input.passwordHash, input.planType, input.dailyQuota],
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error('Failed to create user.');
    }

    return mapUserRow(row);
  }

  async markLoginSuccess(userId: string): Promise<StoredUserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `update users
          set failed_login_count = 0,
              locked_until = null,
              last_login_at = now(),
              updated_at = now()
        where id = $1
        returning id, email, username, password_hash, plan_type, daily_quota, created_at,
                  failed_login_count, locked_until, last_login_at`,
      [userId],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async markLoginFailure(userId: string, lockedUntil: Date | null): Promise<void> {
    await this.pool.query(
      `update users
          set failed_login_count = failed_login_count + 1,
              locked_until = $2,
              updated_at = now()
        where id = $1`,
      [userId, lockedUntil],
    );
  }

  async updatePlan(userId: string, planType: 'free' | 'pro', dailyQuota: number): Promise<StoredUserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `update users
          set plan_type = $2,
              daily_quota = $3,
              updated_at = now()
        where id = $1
        returning id, email, username, password_hash, plan_type, daily_quota, created_at,
                  failed_login_count, locked_until, last_login_at`,
      [userId, planType, dailyQuota],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async recordUsage(userId: string, action: string, metadata: unknown): Promise<void> {
    await this.pool.query('insert into usage_logs (user_id, action, metadata) values ($1, $2, $3)', [
      userId,
      action,
      JSON.stringify(metadata ?? {}),
    ]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('begin');
      await ensureUsersTable(client);
      await ensureUsageLogsTable(client);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

function normalizePostgresConnectionString(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete('schema');

    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

async function ensureUsersTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists users (
      id uuid primary key,
      email text not null unique,
      username text not null unique,
      password_hash text not null,
      plan_type text not null default 'free',
      daily_quota integer not null default 5,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await client.query(`alter table users add column if not exists failed_login_count integer not null default 0`);
  await client.query(`alter table users add column if not exists locked_until timestamptz`);
  await client.query(`alter table users add column if not exists last_login_at timestamptz`);
  await client.query(`alter table users add column if not exists password_changed_at timestamptz not null default now()`);
  await client.query(`create unique index if not exists users_email_lower_idx on users (lower(email))`);
  await client.query(`create unique index if not exists users_username_lower_idx on users (lower(username))`);
}

async function ensureUsageLogsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists usage_logs (
      id bigserial primary key,
      user_id uuid references users(id) on delete cascade,
      action text not null,
      timestamp timestamptz not null default now(),
      metadata jsonb
    )
  `);

  await client.query(`create index if not exists idx_usage_user_time on usage_logs (user_id, timestamp)`);
}

function mapUserRow(row: UserRow): StoredUserRecord {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    planType: row.plan_type === 'pro' ? 'pro' : 'free',
    dailyQuota: row.daily_quota,
    createdAt: row.created_at.toISOString(),
    failedLoginCount: row.failed_login_count ?? 0,
    lockedUntil: row.locked_until?.toISOString() ?? null,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}
