import { Pool, type PoolClient } from 'pg';

export interface StoredUserRecord {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  planType: 'free' | 'pro';
  dailyQuota: number;
  localQuotaDaily: number;
  cloudQuotaDaily: number;
  localUsedToday: number;
  cloudUsedToday: number;
  quotaResetDate: string;
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

export type EmailVerificationPurpose = 'register' | 'login' | 'reset-password';

export interface StoredEmailVerificationCodeRecord {
  id: string;
  email: string;
  purpose: EmailVerificationPurpose;
  codeHash: string;
  expiresAt: string;
  consumedAt: string | null;
  attemptCount: number;
  requestIpHash: string;
  userAgentHash: string;
  createdAt: string;
}

export interface CreateEmailVerificationCodeRecordInput {
  id: string;
  email: string;
  purpose: EmailVerificationPurpose;
  codeHash: string;
  expiresAt: Date;
  requestIpHash: string;
  userAgentHash: string;
}

export interface KnownAuthDeviceRecord {
  userId: string;
  deviceHash: string;
  requestIpHash: string;
  userAgentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

type UserRow = {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  plan_type: string;
  daily_quota: number;
  local_quota_daily: number | null;
  cloud_quota_daily: number | null;
  local_used_today: number | null;
  cloud_used_today: number | null;
  quota_reset_date: Date | null;
  created_at: Date;
  failed_login_count: number | null;
  locked_until: Date | null;
  last_login_at: Date | null;
};

type EmailVerificationCodeRow = {
  id: string;
  email: string;
  purpose: string;
  code_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  attempt_count: number | null;
  request_ip_hash: string;
  user_agent_hash: string;
  created_at: Date;
};

type KnownAuthDeviceRow = {
  user_id: string;
  device_hash: string;
  request_ip_hash: string;
  user_agent_hash: string;
  first_seen_at: Date;
  last_seen_at: Date;
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
              failed_login_count, locked_until, last_login_at,
              local_quota_daily, cloud_quota_daily, local_used_today, cloud_used_today, quota_reset_date
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
              failed_login_count, locked_until, last_login_at,
              local_quota_daily, cloud_quota_daily, local_used_today, cloud_used_today, quota_reset_date
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
                 failed_login_count, locked_until, last_login_at,
                 local_quota_daily, cloud_quota_daily, local_used_today, cloud_used_today, quota_reset_date`,
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
                  failed_login_count, locked_until, last_login_at,
                  local_quota_daily, cloud_quota_daily, local_used_today, cloud_used_today, quota_reset_date`,
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

  async clearLoginLock(userId: string): Promise<StoredUserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `update users
          set failed_login_count = 0,
              locked_until = null,
              updated_at = now()
        where id = $1
        returning id, email, username, password_hash, plan_type, daily_quota, created_at,
                  failed_login_count, locked_until, last_login_at,
                  local_quota_daily, cloud_quota_daily, local_used_today, cloud_used_today, quota_reset_date`,
      [userId],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async updatePlan(userId: string, planType: 'free' | 'pro', dailyQuota: number): Promise<StoredUserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `update users
          set plan_type = $2,
              daily_quota = $3,
              updated_at = now()
        where id = $1
        returning id, email, username, password_hash, plan_type, daily_quota, created_at,
                  failed_login_count, locked_until, last_login_at,
                  local_quota_daily, cloud_quota_daily, local_used_today, cloud_used_today, quota_reset_date`,
      [userId, planType, dailyQuota],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async updatePassword(userId: string, passwordHash: string): Promise<StoredUserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `update users
          set password_hash = $2,
              password_changed_at = now(),
              failed_login_count = 0,
              locked_until = null,
              updated_at = now()
        where id = $1
        returning id, email, username, password_hash, plan_type, daily_quota, created_at,
                  failed_login_count, locked_until, last_login_at,
                  local_quota_daily, cloud_quota_daily, local_used_today, cloud_used_today, quota_reset_date`,
      [userId, passwordHash],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async createEmailVerificationCode(
    input: CreateEmailVerificationCodeRecordInput,
  ): Promise<StoredEmailVerificationCodeRecord> {
    const result = await this.pool.query<EmailVerificationCodeRow>(
      `insert into email_verification_codes
        (id, email, purpose, code_hash, expires_at, request_ip_hash, user_agent_hash)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, email, purpose, code_hash, expires_at, consumed_at, attempt_count,
                 request_ip_hash, user_agent_hash, created_at`,
      [input.id, input.email, input.purpose, input.codeHash, input.expiresAt, input.requestIpHash, input.userAgentHash],
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error('Failed to create email verification code.');
    }

    return mapEmailVerificationCodeRow(row);
  }

  async expireActiveEmailVerificationCodes(email: string, purpose: EmailVerificationPurpose): Promise<void> {
    await this.pool.query(
      `update email_verification_codes
          set consumed_at = now()
        where email = $1
          and purpose = $2
          and consumed_at is null`,
      [email, purpose],
    );
  }

  async findLatestActiveEmailVerificationCode(
    email: string,
    purpose: EmailVerificationPurpose,
    now: Date,
  ): Promise<StoredEmailVerificationCodeRecord | null> {
    const result = await this.pool.query<EmailVerificationCodeRow>(
      `select id, email, purpose, code_hash, expires_at, consumed_at, attempt_count,
              request_ip_hash, user_agent_hash, created_at
         from email_verification_codes
        where email = $1
          and purpose = $2
          and consumed_at is null
          and expires_at > $3
        order by created_at desc
        limit 1`,
      [email, purpose, now],
    );

    return result.rows[0] ? mapEmailVerificationCodeRow(result.rows[0]) : null;
  }

  async markEmailVerificationCodeAttempt(
    id: string,
    consumedAt: Date | null,
  ): Promise<StoredEmailVerificationCodeRecord | null> {
    const result = await this.pool.query<EmailVerificationCodeRow>(
      `update email_verification_codes
          set attempt_count = attempt_count + 1,
              consumed_at = coalesce($2, consumed_at)
        where id = $1
        returning id, email, purpose, code_hash, expires_at, consumed_at, attempt_count,
                  request_ip_hash, user_agent_hash, created_at`,
      [id, consumedAt],
    );

    return result.rows[0] ? mapEmailVerificationCodeRow(result.rows[0]) : null;
  }

  async countEmailVerificationCodes(input: {
    email?: string;
    purpose?: EmailVerificationPurpose;
    requestIpHash?: string;
    since: Date;
  }): Promise<number> {
    const clauses = ['created_at >= $1'];
    const values: unknown[] = [input.since];

    if (input.email) {
      values.push(input.email);
      clauses.push(`email = $${values.length}`);
    }

    if (input.purpose) {
      values.push(input.purpose);
      clauses.push(`purpose = $${values.length}`);
    }

    if (input.requestIpHash) {
      values.push(input.requestIpHash);
      clauses.push(`request_ip_hash = $${values.length}`);
    }

    const result = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from email_verification_codes where ${clauses.join(' and ')}`,
      values,
    );

    return Number(result.rows[0]?.count ?? 0);
  }

  async findKnownDevice(userId: string, deviceHash: string): Promise<KnownAuthDeviceRecord | null> {
    const result = await this.pool.query<KnownAuthDeviceRow>(
      `select user_id, device_hash, request_ip_hash, user_agent_hash, first_seen_at, last_seen_at
         from auth_known_devices
        where user_id = $1
          and device_hash = $2
        limit 1`,
      [userId, deviceHash],
    );

    return result.rows[0] ? mapKnownAuthDeviceRow(result.rows[0]) : null;
  }

  async rememberKnownDevice(input: {
    userId: string;
    deviceHash: string;
    requestIpHash: string;
    userAgentHash: string;
  }): Promise<KnownAuthDeviceRecord> {
    const result = await this.pool.query<KnownAuthDeviceRow>(
      `insert into auth_known_devices (user_id, device_hash, request_ip_hash, user_agent_hash)
       values ($1, $2, $3, $4)
       on conflict (user_id, device_hash)
       do update set request_ip_hash = excluded.request_ip_hash,
                     user_agent_hash = excluded.user_agent_hash,
                     last_seen_at = now()
       returning user_id, device_hash, request_ip_hash, user_agent_hash, first_seen_at, last_seen_at`,
      [input.userId, input.deviceHash, input.requestIpHash, input.userAgentHash],
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error('Failed to remember auth device.');
    }

    return mapKnownAuthDeviceRow(row);
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
      await ensureEmailVerificationCodesTable(client);
      await ensureKnownAuthDevicesTable(client);
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

  // 新增：本地和云端独立配额
  await client.query(`alter table users add column if not exists local_quota_daily integer not null default 10`);
  await client.query(`alter table users add column if not exists cloud_quota_daily integer not null default 5`);
  await client.query(`alter table users add column if not exists local_used_today integer not null default 0`);
  await client.query(`alter table users add column if not exists cloud_used_today integer not null default 0`);
  await client.query(`alter table users add column if not exists quota_reset_date date not null default current_date`);

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

async function ensureEmailVerificationCodesTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists email_verification_codes (
      id uuid primary key,
      email text not null,
      purpose text not null,
      code_hash text not null,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      attempt_count integer not null default 0,
      request_ip_hash text not null,
      user_agent_hash text not null,
      created_at timestamptz not null default now()
    )
  `);

  await client.query(`
    create index if not exists idx_email_codes_email_purpose_created
      on email_verification_codes (email, purpose, created_at desc)
  `);
  await client.query(`
    create index if not exists idx_email_codes_ip_created
      on email_verification_codes (request_ip_hash, created_at desc)
  `);
}

async function ensureKnownAuthDevicesTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists auth_known_devices (
      user_id uuid references users(id) on delete cascade,
      device_hash text not null,
      request_ip_hash text not null,
      user_agent_hash text not null,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      primary key (user_id, device_hash)
    )
  `);

  await client.query(`
    create index if not exists idx_auth_known_devices_last_seen
      on auth_known_devices (user_id, last_seen_at desc)
  `);
}

function mapUserRow(row: UserRow): StoredUserRecord {
  const today = new Date().toISOString().substring(0, 10);
  const quotaResetDate = row.quota_reset_date ? row.quota_reset_date.toISOString().substring(0, 10) : today;

  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    planType: row.plan_type === 'pro' ? 'pro' : 'free',
    dailyQuota: row.daily_quota,
    localQuotaDaily: row.local_quota_daily ?? 10,
    cloudQuotaDaily: row.cloud_quota_daily ?? 5,
    localUsedToday: row.local_used_today ?? 0,
    cloudUsedToday: row.cloud_used_today ?? 0,
    quotaResetDate,
    createdAt: row.created_at.toISOString(),
    failedLoginCount: row.failed_login_count ?? 0,
    lockedUntil: row.locked_until?.toISOString() ?? null,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

function mapEmailVerificationCodeRow(row: EmailVerificationCodeRow): StoredEmailVerificationCodeRecord {
  return {
    id: row.id,
    email: row.email,
    purpose: isEmailVerificationPurpose(row.purpose) ? row.purpose : 'register',
    codeHash: row.code_hash,
    expiresAt: row.expires_at.toISOString(),
    consumedAt: row.consumed_at?.toISOString() ?? null,
    attemptCount: row.attempt_count ?? 0,
    requestIpHash: row.request_ip_hash,
    userAgentHash: row.user_agent_hash,
    createdAt: row.created_at.toISOString(),
  };
}

function isEmailVerificationPurpose(value: string): value is EmailVerificationPurpose {
  return value === 'register' || value === 'login' || value === 'reset-password';
}

function mapKnownAuthDeviceRow(row: KnownAuthDeviceRow): KnownAuthDeviceRecord {
  return {
    userId: row.user_id,
    deviceHash: row.device_hash,
    requestIpHash: row.request_ip_hash,
    userAgentHash: row.user_agent_hash,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}
