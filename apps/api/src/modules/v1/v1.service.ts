import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { resolve4, resolve6, resolveMx } from 'node:dns/promises';
import { promisify } from 'node:util';
import {
  V1AuthStore,
  type EmailVerificationPurpose,
  type StoredEmailVerificationCodeRecord,
  type StoredUserRecord,
} from './v1.auth-store.js';

const scryptAsync = promisify(scrypt);
const tokenTtlMilliseconds = 3 * 24 * 60 * 60 * 1000;
const maxFailedLoginAttempts = 5;
const accountLockMilliseconds = 15 * 60 * 1000;
const loginChallengeTtlMilliseconds = 5 * 60 * 1000;
const loginChallengeDifficulty = 3;
const loginChallengePrefix = '0'.repeat(loginChallengeDifficulty);
const emailCodeTtlMilliseconds = 10 * 60 * 1000;
const emailCodeCooldownMilliseconds = 60 * 1000;
const emailCodeEmailHourlyLimit = 5;
const emailCodeIpHourlyLimit = 20;
const maxEmailCodeAttempts = 5;
const loginEmailTicketTtlMilliseconds = 5 * 60 * 1000;
const emailDomainLookupTimeoutMilliseconds = 3000;
const emailDomainValidationCacheTtlMilliseconds = 15 * 60 * 1000;
const freeDailyQuota = 5;
const proDailyQuota = 100;
const unlimitedDailyQuota = -1;
const commonWeakPasswords = new Set(['password', 'password123', '12345678', '123456789', 'qwerty123', 'vidlive123']);
const emailDomainValidationCache = new Map<string, { canReceiveMail: boolean; expiresAt: number }>();

export interface V1AuthRequestContext {
  requestIp: string;
  userAgent: string;
  deviceId: string;
}

export interface V1ServiceOptions {
  emailCodeWebhookUrl?: string | null;
  emailCodeFrom?: string;
  emailCodeLogEnabled?: boolean;
  emailCodeGenerator?: () => string;
}

export interface V1UserProfile {
  id: string;
  email: string;
  username: string;
  planType: 'free' | 'pro';
  dailyQuota: number;
  createdAt: string;
}

export interface V1UsageSummary {
  quotaLimit: number;
  usedToday: number;
  remainingToday: number;
}

export interface V1AuthChallenge {
  id: string;
  nonce: string;
  algorithm: 'sha256-prefix-v1';
  difficulty: number;
  prefix: string;
  expiresAt: string;
}

export interface V1EmailCodeRequestResult {
  ok: true;
  purpose: EmailVerificationPurpose;
  email: string;
  expiresAt: string;
  cooldownSeconds: number;
  delivery: 'webhook' | 'log';
  message: string;
}

export type V1LoginResult =
  | { user: V1UserProfile; token: string }
  | {
      requiresEmailCode: true;
      loginTicket: string;
      email: string;
      expiresAt: string;
      message: string;
    };

export interface V1VerifiedLoginResult {
  user: V1UserProfile;
  token: string;
  remember: boolean;
}

export interface KeyframeRecommendationInput {
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  hasAudio?: boolean | null;
}

export interface KeyframeRecommendation {
  seconds: number;
  score: number;
  reasons: string[];
}

interface StoredUser extends V1UserProfile {
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
}

interface UsageLog {
  userId: string;
  action: string;
  timestamp: string;
  metadata: unknown;
}

interface CompatibilityFeedback {
  id: string;
  createdAt: string;
  userId: string | null;
  presetId: string;
  device: string;
  iosVersion: string;
  savedToPhotos: boolean;
  lockScreenPlayed: boolean;
  notes: string;
}

interface CheckoutIntent {
  id: string;
  userId: string;
  planId: 'pro-monthly';
  status: 'requires_payment' | 'paid' | 'cancelled';
  provider: 'mock-stripe';
  amountCents: number;
  currency: 'usd';
  checkoutUrl: string;
  createdAt: string;
}

interface BatchJob {
  id: string;
  userId: string;
  status: 'queued' | 'completed' | 'failed';
  requestedOutputs: number;
  outputQuality: 'standard' | '4k';
  createdAt: string;
  items: Array<{
    id: string;
    fileName: string;
    status: 'queued' | 'completed' | 'failed';
  }>;
}

interface ExperimentAssignment {
  id: string;
  visitorId: string;
  experiment: string;
  variant: 'control' | 'pro-benefits';
  createdAt: string;
}

interface ApiKeyRecord {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface LoginChallengeRecord {
  nonce: string;
  prefix: string;
  expiresAt: number;
}

interface StoredEmailVerificationCode extends Omit<StoredEmailVerificationCodeRecord, 'expiresAt' | 'consumedAt' | 'createdAt'> {
  expiresAt: number;
  consumedAt: number | null;
  createdAt: number;
}

interface KnownAuthDevice {
  userId: string;
  deviceHash: string;
  requestIpHash: string;
  userAgentHash: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface LoginEmailTicket {
  userId: string;
  email: string;
  remember: boolean;
  deviceHash: string;
  requestIpHash: string;
  userAgentHash: string;
  expiresAt: number;
}

export class V1Service {
  private readonly users = new Map<string, StoredUser>();
  private readonly usersByEmail = new Map<string, StoredUser>();
  private readonly usageLogs: UsageLog[] = [];
  private readonly feedback: CompatibilityFeedback[] = [];
  private readonly checkoutIntents = new Map<string, CheckoutIntent>();
  private readonly batches = new Map<string, BatchJob>();
  private readonly experiments = new Map<string, ExperimentAssignment>();
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly loginChallenges = new Map<string, LoginChallengeRecord>();
  private readonly emailVerificationCodes = new Map<string, StoredEmailVerificationCode>();
  private readonly knownAuthDevices = new Map<string, KnownAuthDevice>();
  private readonly loginEmailTickets = new Map<string, LoginEmailTicket>();

  private readonly permanentMemberEmails: Set<string>;
  private readonly emailCodeFrom: string;
  private readonly emailCodeWebhookUrl: string | null;
  private readonly emailCodeLogEnabled: boolean;
  private readonly emailCodeGenerator: () => string;

  constructor(
    private readonly jwtSecret: string,
    private readonly authStore: V1AuthStore | null = null,
    permanentMemberEmails: readonly string[] = [],
    options: V1ServiceOptions = {},
  ) {
    this.permanentMemberEmails = new Set(permanentMemberEmails.map((email) => normalizeEmail(email)).filter(Boolean));
    this.emailCodeFrom = options.emailCodeFrom ?? 'VidLive <no-reply@vidlive.local>';
    this.emailCodeWebhookUrl = options.emailCodeWebhookUrl ?? null;
    this.emailCodeLogEnabled = options.emailCodeLogEnabled ?? process.env.NODE_ENV !== 'production';
    this.emailCodeGenerator = options.emailCodeGenerator ?? generateEmailCode;
  }

  static async create(
    jwtSecret: string,
    databaseUrl: string | null,
    permanentMemberEmails: readonly string[] = [],
    options: V1ServiceOptions = {},
  ): Promise<V1Service> {
    const authStore = databaseUrl ? await V1AuthStore.connect(databaseUrl) : null;

    return new V1Service(jwtSecret, authStore, permanentMemberEmails, options);
  }

  createLoginChallenge(): V1AuthChallenge {
    this.pruneExpiredLoginChallenges();

    const id = randomUUID();
    const expiresAt = Date.now() + loginChallengeTtlMilliseconds;
    const challenge = {
      nonce: randomBytes(16).toString('base64url'),
      prefix: loginChallengePrefix,
      expiresAt,
    };

    this.loginChallenges.set(id, challenge);

    return {
      id,
      nonce: challenge.nonce,
      algorithm: 'sha256-prefix-v1',
      difficulty: loginChallengeDifficulty,
      prefix: challenge.prefix,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async requestEmailCode(input: {
    email: string;
    purpose: EmailVerificationPurpose;
    username?: string;
    context: V1AuthRequestContext;
  }): Promise<V1EmailCodeRequestResult> {
    const purpose = input.purpose;

    if (purpose === 'login') {
      throw new V1Error('unsupported-email-code-purpose', '登录验证码会在密码校验通过后自动发送。');
    }

    const email = normalizeEmail(input.email);

    if (!isValidEmail(email)) {
      throw new V1Error('invalid-email', '请输入有效邮箱地址。');
    }

    await assertEmailDomainCanReceiveMail(email);

    if (purpose === 'register') {
      const username = validateRegistrationEmailCodeInput(input.username ?? '');
      const existingEmail = await this.findUserByEmail(email);

      if (existingEmail) {
        throw new V1Error('email-already-registered', '该邮箱已注册，请直接登录。');
      }

      if (await this.isUsernameTaken(username)) {
        throw new V1Error('username-already-registered', '该用户名已被占用，请换一个。');
      }
    }

    if (purpose === 'reset-password') {
      const user = await this.findUserByEmail(email);

      if (!user) {
        return {
          ok: true,
          purpose,
          email,
          expiresAt: new Date(Date.now() + emailCodeTtlMilliseconds).toISOString(),
          cooldownSeconds: Math.ceil(emailCodeCooldownMilliseconds / 1000),
          delivery: this.emailCodeWebhookUrl ? 'webhook' : 'log',
          message: '如果该邮箱已注册，验证码会发送到对应邮箱。',
        };
      }
    }

    return this.issueEmailCode({
      email,
      purpose,
      context: input.context,
    });
  }

  async register(input: {
    email: string;
    password: string;
    username: string;
    emailCode?: string;
    context?: V1AuthRequestContext;
  }): Promise<{ user: V1UserProfile }> {
    const registration = validateRegistrationInput(input);
    await assertEmailDomainCanReceiveMail(registration.email);
    const existingEmail = await this.findUserByEmail(registration.email);

    if (existingEmail) {
      throw new V1Error('email-already-registered', '该邮箱已注册，请直接登录。');
    }

    if (await this.isUsernameTaken(registration.username)) {
      throw new V1Error('username-already-registered', '该用户名已被占用，请换一个。');
    }

    await this.verifyEmailCode({
      email: registration.email,
      purpose: 'register',
      code: input.emailCode ?? '',
    });

    const passwordHash = await hashPassword(registration.password);
    const initialPlan = this.resolveEntitledPlan(registration.email, 'free', freeDailyQuota);
    const userInput = {
      id: randomUUID(),
      email: registration.email,
      username: registration.username,
      passwordHash,
      planType: initialPlan.planType,
      dailyQuota: initialPlan.dailyQuota,
    } as const;
    const now = new Date().toISOString();
    const user: StoredUser = this.authStore
      ? toStoredUser(await this.authStore.createUser(userInput))
      : {
          ...userInput,
          createdAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: null,
        };

    const entitledUser = this.applyUserEntitlements(user);
    this.cacheUser(entitledUser);
    await this.rememberKnownDeviceForContext(entitledUser, input.context);
    this.recordUsage(entitledUser.id, 'user.registered', {});

    return {
      user: toPublicUser(entitledUser),
    };
  }

  async login(input: {
    email: string;
    password: string;
    remember?: boolean;
    challengeId?: string;
    challengeAnswer?: string;
    automationTrap?: string;
    context?: V1AuthRequestContext;
  }): Promise<V1LoginResult> {
    const credentials = validateLoginInput(input);
    this.verifyLoginChallenge(input);
    const storedUser = await this.findUserByEmail(credentials.email);

    if (!storedUser) {
      await delayInvalidLogin();
      throw new V1Error('invalid-credentials', '邮箱或密码不正确。');
    }

    let user = this.authStore ? toStoredUser(storedUser) : storedUser;
    const lockedUntil = user.lockedUntil ? new Date(user.lockedUntil).getTime() : 0;

    if (lockedUntil > Date.now()) {
      throw new V1Error('account-locked', '登录失败次数过多，账号已临时锁定，请稍后再试。');
    }

    if (user.lockedUntil && (!Number.isFinite(lockedUntil) || lockedUntil <= Date.now())) {
      user = await this.clearLoginLock(user);
    }

    const passwordMatches = await verifyPassword(credentials.password, user.passwordHash);

    if (!passwordMatches) {
      await this.recordLoginFailure(user);
      throw new V1Error('invalid-credentials', '邮箱或密码不正确。');
    }

    if (input.context && (await this.shouldRequireLoginEmailCode(user, input.context))) {
      return this.createLoginEmailChallenge(user, input.remember === true, input.context);
    }

    return this.completeLogin(user, input.context);
  }

  async verifyLoginEmailCode(input: {
    loginTicket: string;
    emailCode: string;
    context?: V1AuthRequestContext;
  }): Promise<V1VerifiedLoginResult> {
    this.pruneExpiredLoginEmailTickets();

    const loginTicket = input.loginTicket.trim();
    const ticket = this.loginEmailTickets.get(loginTicket);
    this.loginEmailTickets.delete(loginTicket);

    if (!ticket || ticket.expiresAt <= Date.now()) {
      throw new V1Error('login-ticket-expired', '登录验证已过期，请重新登录。');
    }

    if (input.context) {
      const requestIpHash = this.hashAuthContext('ip', input.context.requestIp);
      const userAgentHash = this.hashAuthContext('ua', input.context.userAgent);

      if (ticket.requestIpHash !== requestIpHash || ticket.userAgentHash !== userAgentHash) {
        throw new V1Error('login-ticket-context-mismatch', '登录环境已变化，请重新登录。');
      }
    }

    await this.verifyEmailCode({
      email: ticket.email,
      purpose: 'login',
      code: input.emailCode,
    });

    const user = await this.findUserById(ticket.userId);

    if (!user) {
      throw new V1Error('user-not-found', '未找到对应的 VidLive 账号。');
    }

    const result = await this.completeLogin(user, input.context, ticket);

    return {
      ...result,
      remember: ticket.remember,
    };
  }

  async resetPassword(input: {
    email: string;
    password: string;
    emailCode: string;
  }): Promise<{ ok: true; message: string }> {
    const email = normalizeEmail(input.email);

    if (!isValidEmail(email)) {
      throw new V1Error('invalid-email', '请输入有效邮箱地址。');
    }

    const user = await this.findUserByEmail(email);

    if (!user) {
      throw new V1Error('invalid-email-code', '验证码无效或已过期。');
    }

    const passwordError = getPasswordValidationError(input.password, email, user.username);

    if (passwordError) {
      throw new V1Error('weak-password', passwordError);
    }

    await this.verifyEmailCode({
      email,
      purpose: 'reset-password',
      code: input.emailCode,
    });

    const passwordHash = await hashPassword(input.password);
    const nextUser = this.authStore
      ? toStoredUser((await this.authStore.updatePassword(user.id, passwordHash)) ?? user)
      : {
          ...user,
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
        };

    this.cacheUser(this.applyUserEntitlements(nextUser));
    this.recordUsage(nextUser.id, 'user.password_reset', {});

    return {
      ok: true,
      message: '密码已重置，请使用新密码登录。',
    };
  }

  private async completeLogin(
    user: StoredUser,
    context?: V1AuthRequestContext,
    rememberedTicket?: Pick<LoginEmailTicket, 'deviceHash' | 'requestIpHash' | 'userAgentHash'>,
  ): Promise<{ user: V1UserProfile; token: string }> {
    const nextUser = this.authStore ? toStoredUser((await this.authStore.markLoginSuccess(user.id)) ?? user) : user;

    nextUser.failedLoginCount = 0;
    nextUser.lockedUntil = null;
    nextUser.lastLoginAt = new Date().toISOString();
    const entitledUser = this.applyUserEntitlements(nextUser);
    this.cacheUser(entitledUser);
    await this.rememberKnownDeviceForContext(entitledUser, context, rememberedTicket);
    this.recordUsage(entitledUser.id, 'user.logged_in', {});

    return {
      user: toPublicUser(entitledUser),
      token: this.signToken(entitledUser),
    };
  }

  async authenticate(token: string | null): Promise<V1UserProfile | null> {
    if (!token) {
      return null;
    }

    const [payloadRaw, signature] = token.split('.');

    if (!payloadRaw || !signature || !verifySignature(payloadRaw, signature, this.jwtSecret)) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadRaw, 'base64url').toString('utf8')) as { sub?: string; exp?: number };

      if (!payload.sub || !payload.exp || payload.exp < Date.now()) {
        return null;
      }

      const cachedUser = this.users.get(payload.sub);

      if (cachedUser) {
        const entitledUser = this.applyUserEntitlements(cachedUser);
        this.cacheUser(entitledUser);

        return toPublicUser(entitledUser);
      }

      const storedUser = this.authStore ? await this.authStore.findUserById(payload.sub) : null;

      if (!storedUser) {
        return null;
      }

      const user = this.applyUserEntitlements(toStoredUser(storedUser));
      this.cacheUser(user);

      return toPublicUser(user);
    } catch {
      return null;
    }
  }

  private cacheUser(user: StoredUser): void {
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user);
  }

  private async findUserByEmail(email: string): Promise<StoredUser | null> {
    const storedUser = this.authStore ? await this.authStore.findUserByEmail(email) : this.usersByEmail.get(email) ?? null;

    return storedUser ? toStoredUser(storedUser) : null;
  }

  private async findUserById(userId: string): Promise<StoredUser | null> {
    const storedUser = this.authStore ? await this.authStore.findUserById(userId) : this.users.get(userId) ?? null;

    return storedUser ? toStoredUser(storedUser) : null;
  }

  private async isUsernameTaken(username: string): Promise<boolean> {
    return this.authStore
      ? this.authStore.usernameExists(username)
      : [...this.users.values()].some((user) => user.username.toLowerCase() === username.toLowerCase());
  }

  private async issueEmailCode(input: {
    email: string;
    purpose: EmailVerificationPurpose;
    context: V1AuthRequestContext;
  }): Promise<V1EmailCodeRequestResult> {
    this.pruneExpiredEmailVerificationCodes();

    const now = Date.now();
    const requestIpHash = this.hashAuthContext('ip', input.context.requestIp);
    const userAgentHash = this.hashAuthContext('ua', input.context.userAgent);
    const recentEmailCodes = await this.countEmailCodes({
      email: input.email,
      purpose: input.purpose,
      since: now - emailCodeCooldownMilliseconds,
    });

    if (recentEmailCodes > 0) {
      throw new V1Error('email-code-cooldown', '验证码发送过于频繁，请稍后再试。');
    }

    const hourlyEmailCodes = await this.countEmailCodes({
      email: input.email,
      purpose: input.purpose,
      since: now - 60 * 60 * 1000,
    });

    if (hourlyEmailCodes >= emailCodeEmailHourlyLimit) {
      throw new V1Error('email-code-email-rate-limited', '该邮箱验证码请求过多，请稍后再试。');
    }

    const hourlyIpCodes = await this.countEmailCodes({
      requestIpHash,
      since: now - 60 * 60 * 1000,
    });

    if (hourlyIpCodes >= emailCodeIpHourlyLimit) {
      throw new V1Error('email-code-ip-rate-limited', '当前网络验证码请求过多，请稍后再试。');
    }

    await this.expireActiveEmailCodes(input.email, input.purpose);

    const code = normalizeEmailCode(this.emailCodeGenerator());
    const expiresAt = new Date(now + emailCodeTtlMilliseconds);
    const record: StoredEmailVerificationCode = {
      id: randomUUID(),
      email: input.email,
      purpose: input.purpose,
      codeHash: hashEmailCode(this.jwtSecret, input.email, input.purpose, code),
      expiresAt: expiresAt.getTime(),
      consumedAt: null,
      attemptCount: 0,
      requestIpHash,
      userAgentHash,
      createdAt: now,
    };

    if (this.authStore) {
      const storedRecord = await this.authStore.createEmailVerificationCode({
        id: record.id,
        email: record.email,
        purpose: record.purpose,
        codeHash: record.codeHash,
        expiresAt,
        requestIpHash,
        userAgentHash,
      });
      this.emailVerificationCodes.set(record.id, toStoredEmailVerificationCode(storedRecord));
    } else {
      this.emailVerificationCodes.set(record.id, record);
    }

    const delivery = await this.sendEmailCode({
      email: input.email,
      purpose: input.purpose,
      code,
      expiresAt,
    });

    return {
      ok: true,
      purpose: input.purpose,
      email: input.email,
      expiresAt: expiresAt.toISOString(),
      cooldownSeconds: Math.ceil(emailCodeCooldownMilliseconds / 1000),
      delivery,
      message: '验证码已发送，请在 10 分钟内完成验证。',
    };
  }

  private async sendEmailCode(input: {
    email: string;
    purpose: EmailVerificationPurpose;
    code: string;
    expiresAt: Date;
  }): Promise<'webhook' | 'log'> {
    const subject = getEmailCodeSubject(input.purpose);
    const text = [
      `${subject}`,
      '',
      `验证码：${input.code}`,
      `有效期至：${input.expiresAt.toLocaleString('zh-CN')}`,
      '',
      '如果不是你本人操作，请忽略这封邮件。',
    ].join('\n');

    if (this.emailCodeWebhookUrl) {
      const response = await fetch(this.emailCodeWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.emailCodeFrom,
          to: input.email,
          purpose: input.purpose,
          subject,
          text,
          code: input.code,
          expiresAt: input.expiresAt.toISOString(),
        }),
      });

      if (!response.ok) {
        throw new V1Error('email-code-delivery-failed', '验证码邮件发送失败，请稍后再试。');
      }

      return 'webhook';
    }

    if (!this.emailCodeLogEnabled) {
      throw new V1Error('email-code-delivery-not-configured', '验证码邮件服务未配置，请联系管理员。');
    }

    console.info('[VidLive email code]', {
      to: input.email,
      purpose: input.purpose,
      code: input.code,
      expiresAt: input.expiresAt.toISOString(),
    });

    return 'log';
  }

  private async verifyEmailCode(input: {
    email: string;
    purpose: EmailVerificationPurpose;
    code: string;
  }): Promise<void> {
    const code = input.code.trim();

    if (!/^\d{6}$/u.test(code)) {
      throw new V1Error('invalid-email-code', '请输入 6 位邮箱验证码。');
    }

    const record = await this.findLatestActiveEmailCode(input.email, input.purpose);

    if (!record || record.attemptCount >= maxEmailCodeAttempts) {
      throw new V1Error('invalid-email-code', '验证码无效或已过期。');
    }

    const expectedHash = hashEmailCode(this.jwtSecret, input.email, input.purpose, code);
    const matched = timingSafeHexEqual(expectedHash, record.codeHash);
    const shouldConsume = matched || record.attemptCount + 1 >= maxEmailCodeAttempts;

    await this.markEmailCodeAttempt(record.id, shouldConsume ? new Date() : null);

    if (!matched) {
      throw new V1Error('invalid-email-code', '验证码无效或已过期。');
    }
  }

  private async findLatestActiveEmailCode(
    email: string,
    purpose: EmailVerificationPurpose,
  ): Promise<StoredEmailVerificationCode | null> {
    const now = Date.now();

    if (this.authStore) {
      const record = await this.authStore.findLatestActiveEmailVerificationCode(email, purpose, new Date(now));

      return record ? toStoredEmailVerificationCode(record) : null;
    }

    const activeRecords = [...this.emailVerificationCodes.values()]
      .filter((record) => {
        return record.email === email && record.purpose === purpose && record.consumedAt === null && record.expiresAt > now;
      })
      .sort((left, right) => right.createdAt - left.createdAt);

    return activeRecords[0] ?? null;
  }

  private async markEmailCodeAttempt(id: string, consumedAt: Date | null): Promise<void> {
    if (this.authStore) {
      const record = await this.authStore.markEmailVerificationCodeAttempt(id, consumedAt);

      if (record) {
        this.emailVerificationCodes.set(record.id, toStoredEmailVerificationCode(record));
      }

      return;
    }

    const record = this.emailVerificationCodes.get(id);

    if (!record) {
      return;
    }

    record.attemptCount += 1;
    record.consumedAt = consumedAt ? consumedAt.getTime() : record.consumedAt;
  }

  private async expireActiveEmailCodes(email: string, purpose: EmailVerificationPurpose): Promise<void> {
    if (this.authStore) {
      await this.authStore.expireActiveEmailVerificationCodes(email, purpose);
    }

    const now = Date.now();

    for (const record of this.emailVerificationCodes.values()) {
      if (record.email === email && record.purpose === purpose && record.consumedAt === null) {
        record.consumedAt = now;
      }
    }
  }

  private async countEmailCodes(input: {
    email?: string;
    purpose?: EmailVerificationPurpose;
    requestIpHash?: string;
    since: number;
  }): Promise<number> {
    if (this.authStore) {
      const storeInput: {
        email?: string;
        purpose?: EmailVerificationPurpose;
        requestIpHash?: string;
        since: Date;
      } = {
        since: new Date(input.since),
      };

      if (input.email !== undefined) {
        storeInput.email = input.email;
      }

      if (input.purpose !== undefined) {
        storeInput.purpose = input.purpose;
      }

      if (input.requestIpHash !== undefined) {
        storeInput.requestIpHash = input.requestIpHash;
      }

      return this.authStore.countEmailVerificationCodes(storeInput);
    }

    return [...this.emailVerificationCodes.values()].filter((record) => {
      return (
        record.createdAt >= input.since &&
        (!input.email || record.email === input.email) &&
        (!input.purpose || record.purpose === input.purpose) &&
        (!input.requestIpHash || record.requestIpHash === input.requestIpHash)
      );
    }).length;
  }

  private pruneExpiredEmailVerificationCodes(): void {
    if (this.authStore) {
      return;
    }

    const now = Date.now();

    for (const [id, record] of this.emailVerificationCodes.entries()) {
      if (record.expiresAt <= now || (record.consumedAt !== null && now - record.consumedAt > emailCodeTtlMilliseconds)) {
        this.emailVerificationCodes.delete(id);
      }
    }
  }

  private async shouldRequireLoginEmailCode(user: StoredUser, context: V1AuthRequestContext): Promise<boolean> {
    if (user.failedLoginCount > 0) {
      return true;
    }

    const deviceHash = this.hashAuthContext('device', context.deviceId);

    if (this.authStore) {
      return !(await this.authStore.findKnownDevice(user.id, deviceHash));
    }

    return !this.knownAuthDevices.has(createKnownDeviceKey(user.id, deviceHash));
  }

  private async createLoginEmailChallenge(
    user: StoredUser,
    remember: boolean,
    context: V1AuthRequestContext,
  ): Promise<Extract<V1LoginResult, { requiresEmailCode: true }>> {
    const deviceHash = this.hashAuthContext('device', context.deviceId);
    const requestIpHash = this.hashAuthContext('ip', context.requestIp);
    const userAgentHash = this.hashAuthContext('ua', context.userAgent);
    const expiresAt = Date.now() + loginEmailTicketTtlMilliseconds;
    const loginTicket = randomBytes(24).toString('base64url');

    await this.issueEmailCode({
      email: user.email,
      purpose: 'login',
      context,
    });

    this.loginEmailTickets.set(loginTicket, {
      userId: user.id,
      email: user.email,
      remember,
      deviceHash,
      requestIpHash,
      userAgentHash,
      expiresAt,
    });

    return {
      requiresEmailCode: true,
      loginTicket,
      email: user.email,
      expiresAt: new Date(expiresAt).toISOString(),
      message: '检测到新的登录环境，请输入邮箱验证码完成登录。',
    };
  }

  private pruneExpiredLoginEmailTickets(): void {
    const now = Date.now();

    for (const [id, ticket] of this.loginEmailTickets.entries()) {
      if (ticket.expiresAt <= now) {
        this.loginEmailTickets.delete(id);
      }
    }
  }

  private async rememberKnownDeviceForContext(
    user: StoredUser,
    context?: V1AuthRequestContext,
    rememberedTicket?: Pick<LoginEmailTicket, 'deviceHash' | 'requestIpHash' | 'userAgentHash'>,
  ): Promise<void> {
    const deviceHash = rememberedTicket?.deviceHash ?? (context ? this.hashAuthContext('device', context.deviceId) : null);

    if (!deviceHash) {
      return;
    }

    const requestIpHash = rememberedTicket?.requestIpHash ?? this.hashAuthContext('ip', context?.requestIp ?? '');
    const userAgentHash = rememberedTicket?.userAgentHash ?? this.hashAuthContext('ua', context?.userAgent ?? '');
    const now = Date.now();

    if (this.authStore) {
      await this.authStore.rememberKnownDevice({
        userId: user.id,
        deviceHash,
        requestIpHash,
        userAgentHash,
      });
    }

    this.knownAuthDevices.set(createKnownDeviceKey(user.id, deviceHash), {
      userId: user.id,
      deviceHash,
      requestIpHash,
      userAgentHash,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  private hashAuthContext(kind: 'device' | 'ip' | 'ua', value: string): string {
    return createHmac('sha256', this.jwtSecret).update(`${kind}:${value}`).digest('hex');
  }

  private async recordLoginFailure(user: StoredUser): Promise<void> {
    const nextFailedLoginCount = user.failedLoginCount + 1;
    const lockedUntil =
      nextFailedLoginCount >= maxFailedLoginAttempts ? new Date(Date.now() + accountLockMilliseconds) : null;

    user.failedLoginCount = nextFailedLoginCount;
    user.lockedUntil = lockedUntil?.toISOString() ?? null;
    this.cacheUser(user);

    if (this.authStore) {
      await this.authStore.markLoginFailure(user.id, lockedUntil);
    }
  }

  private async clearLoginLock(user: StoredUser): Promise<StoredUser> {
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    this.cacheUser(user);

    if (!this.authStore) {
      return user;
    }

    const clearedUser = await this.authStore.clearLoginLock(user.id);
    const nextUser = clearedUser ? toStoredUser(clearedUser) : user;
    this.cacheUser(nextUser);

    return nextUser;
  }

  private verifyLoginChallenge(input: {
    challengeId?: string;
    challengeAnswer?: string;
    automationTrap?: string;
  }): void {
    if (input.automationTrap?.trim()) {
      throw new V1Error('auth-challenge-failed', '登录校验失败，请重试。');
    }

    const challengeId = input.challengeId?.trim();
    const challengeAnswer = input.challengeAnswer?.trim();

    if (!challengeId || !challengeAnswer) {
      throw new V1Error('auth-challenge-required', '请完成人机验证后再登录。');
    }

    const challenge = this.loginChallenges.get(challengeId);
    this.loginChallenges.delete(challengeId);

    if (!challenge || challenge.expiresAt < Date.now() || !/^\d{1,10}$/u.test(challengeAnswer)) {
      throw new V1Error('auth-challenge-failed', '登录校验失败，请重试。');
    }

    const digest = createHash('sha256')
      .update(`${challengeId}:${challenge.nonce}:${challengeAnswer}`)
      .digest('hex');

    if (!digest.startsWith(challenge.prefix)) {
      throw new V1Error('auth-challenge-failed', '登录校验失败，请重试。');
    }
  }

  private pruneExpiredLoginChallenges(): void {
    const now = Date.now();

    for (const [id, challenge] of this.loginChallenges.entries()) {
      if (challenge.expiresAt <= now) {
        this.loginChallenges.delete(id);
      }
    }
  }

  getUsage(userId: string): V1UsageSummary {
    const user = this.requireUser(userId);

    const usedToday = this.usageLogs.filter((log) => {
      return log.userId === userId && log.action === 'conversion.created' && isToday(log.timestamp);
    }).length;

    if (isUnlimitedDailyQuota(user.dailyQuota)) {
      return {
        quotaLimit: unlimitedDailyQuota,
        usedToday,
        remainingToday: unlimitedDailyQuota,
      };
    }

    return {
      quotaLimit: user.dailyQuota,
      usedToday,
      remainingToday: Math.max(0, user.dailyQuota - usedToday),
    };
  }

  consumeConversionQuota(userId: string, metadata: unknown): V1UsageSummary {
    const summary = this.getUsage(userId);

    if (!isUnlimitedDailyQuota(summary.remainingToday) && summary.remainingToday <= 0) {
      throw new V1Error('quota-exceeded', 'Daily conversion quota has been used up.');
    }

    this.recordUsage(userId, 'conversion.created', metadata);

    return this.getUsage(userId);
  }

  recommendKeyframes(input: KeyframeRecommendationInput): KeyframeRecommendation[] {
    const duration = Math.max(1, Math.min(input.durationSeconds ?? 3, 30));
    const middle = duration / 2;
    const verticalBonus = input.height && input.width && input.height > input.width ? 8 : 0;
    const audioBonus = input.hasAudio ? 3 : 0;
    const candidates: KeyframeRecommendation[] = [
      {
        seconds: roundSeconds(middle),
        score: 86 + verticalBonus,
        reasons: ['片段中点稳定', '适合作为默认封面'],
      },
      {
        seconds: roundSeconds(Math.max(0.2, duration * 0.38)),
        score: 78 + audioBonus,
        reasons: ['避开开头黑场风险', '更容易保留动作起势'],
      },
      {
        seconds: roundSeconds(Math.min(duration - 0.2, duration * 0.68)),
        score: 74 + verticalBonus,
        reasons: ['避开结尾停顿', '适合锁屏预设复测'],
      },
    ];

    return candidates.sort((left, right) => right.score - left.score).slice(0, 3);
  }

  addCompatibilityFeedback(input: {
    userId: string | null;
    presetId: string;
    device: string;
    iosVersion: string;
    savedToPhotos: boolean;
    lockScreenPlayed: boolean;
    notes?: string;
  }): CompatibilityFeedback {
    const item: CompatibilityFeedback = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      userId: input.userId,
      presetId: input.presetId,
      device: input.device.trim() || 'unknown',
      iosVersion: input.iosVersion.trim() || 'unknown',
      savedToPhotos: input.savedToPhotos,
      lockScreenPlayed: input.lockScreenPlayed,
      notes: input.notes?.trim() ?? '',
    };

    this.feedback.push(item);

    if (input.userId) {
      this.recordUsage(input.userId, 'compatibility.feedback_created', item);
    }

    return item;
  }

  getCompatibilitySummary(): { total: number; savedRate: number; lockScreenRate: number; recent: CompatibilityFeedback[] } {
    const total = this.feedback.length;
    const savedCount = this.feedback.filter((item) => item.savedToPhotos).length;
    const lockScreenCount = this.feedback.filter((item) => item.lockScreenPlayed).length;

    return {
      total,
      savedRate: total > 0 ? savedCount / total : 0,
      lockScreenRate: total > 0 ? lockScreenCount / total : 0,
      recent: this.feedback.slice(-10).reverse(),
    };
  }

  getMetricsSummary(): {
    users: number;
    usageLogs: number;
    compatibilityFeedback: number;
    conversionSuccessRate: number;
  } {
    const conversions = this.usageLogs.filter((log) => log.action === 'conversion.created');
    const failures = this.usageLogs.filter((log) => log.action === 'conversion.failed');
    const totalConversions = conversions.length + failures.length;

    return {
      users: this.users.size,
      usageLogs: this.usageLogs.length,
      compatibilityFeedback: this.feedback.length,
      conversionSuccessRate: totalConversions > 0 ? conversions.length / totalConversions : 1,
    };
  }

  getLaunchReadiness(): Array<{ item: string; status: 'pass' | 'warn'; detail: string }> {
    return [
      {
        item: 'JWT_SECRET',
        status: this.jwtSecret === 'dev-vidlive-secret-change-me' ? 'warn' : 'pass',
        detail:
          this.jwtSecret === 'dev-vidlive-secret-change-me'
            ? 'Using development JWT secret.'
            : 'JWT secret is configured.',
      },
      {
        item: 'database',
        status: this.authStore ? 'pass' : 'warn',
        detail: this.authStore
          ? 'PostgreSQL auth store is enabled for users and login security state.'
          : 'DATABASE_URL is not configured; V1 auth is using in-memory fallback.',
      },
      {
        item: 'error-tracking',
        status: 'warn',
        detail: 'Structured API responses exist; external error tracking is not configured.',
      },
    ];
  }

  getPlans(): Array<{
    id: 'free' | 'pro-monthly';
    label: string;
    priceCents: number;
    quota: number;
    features: string[];
  }> {
    return [
      {
        id: 'free',
        label: '免费版',
        priceCents: 0,
        quota: freeDailyQuota,
        features: ['本地生成', '标准预设', '保存指引'],
      },
      {
        id: 'pro-monthly',
        label: '专业版',
        priceCents: 900,
        quota: proDailyQuota,
        features: ['云端生成', '安卓实况单文件', '预览图', '完整素材包', '兼容验证'],
      },
    ];
  }

  createCheckoutIntent(userId: string): CheckoutIntent {
    const user = this.requireUser(userId);
    const intent: CheckoutIntent = {
      id: randomUUID(),
      userId: user.id,
      planId: 'pro-monthly',
      status: 'requires_payment',
      provider: 'mock-stripe',
      amountCents: 900,
      currency: 'usd',
      checkoutUrl: `/api/v1/billing/checkout-intents/mock/${user.id}`,
      createdAt: new Date().toISOString(),
    };

    this.checkoutIntents.set(intent.id, intent);
    this.recordUsage(user.id, 'billing.checkout_created', intent);

    return intent;
  }

  confirmCheckoutIntent(intentId: string): { intent: CheckoutIntent; user: V1UserProfile } {
    const intent = this.checkoutIntents.get(intentId);

    if (!intent) {
      throw new V1Error('checkout-not-found', '未找到对应的 VidLive 支付确认记录。');
    }

    const user = this.requireUser(intent.userId);
    intent.status = 'paid';
    this.updateUserPlan(user, 'pro', proDailyQuota);
    this.recordUsage(user.id, 'billing.subscription_started', intent);

    return {
      intent,
      user: toPublicUser(user),
    };
  }

  cancelSubscription(userId: string): V1UserProfile {
    const user = this.requireUser(userId);
    this.updateUserPlan(user, 'free', freeDailyQuota);
    this.recordUsage(user.id, 'billing.subscription_cancelled', {});

    return toPublicUser(user);
  }

  createBatch(input: {
    userId: string;
    fileNames: string[];
    outputQuality: 'standard' | '4k';
  }): BatchJob {
    const user = this.requireUser(input.userId);

    if (user.planType !== 'pro') {
      throw new V1Error('pro-required', '批量生成和高规格输出需要专业版账号。');
    }

    if (input.fileNames.length < 2 || input.fileNames.length > 20) {
      throw new V1Error('invalid-batch-size', '批量任务需包含 2 到 20 个文件。');
    }

    const batch: BatchJob = {
      id: randomUUID(),
      userId: user.id,
      status: 'completed',
      requestedOutputs: input.fileNames.length,
      outputQuality: input.outputQuality,
      createdAt: new Date().toISOString(),
      items: input.fileNames.map((fileName) => ({
        id: randomUUID(),
        fileName,
        status: 'completed',
      })),
    };

    this.batches.set(batch.id, batch);
    this.recordUsage(user.id, 'batch.created', batch);

    return batch;
  }

  getBatch(batchId: string): BatchJob | null {
    return this.batches.get(batchId) ?? null;
  }

  getHistory(userId: string): { usage: UsageLog[]; batches: BatchJob[]; checkouts: CheckoutIntent[] } {
    this.requireUser(userId);

    return {
      usage: this.usageLogs.filter((log) => log.userId === userId).slice(-50).reverse(),
      batches: [...this.batches.values()].filter((batch) => batch.userId === userId).slice(-20).reverse(),
      checkouts: [...this.checkoutIntents.values()].filter((intent) => intent.userId === userId).slice(-10).reverse(),
    };
  }

  assignExperiment(visitorId: string): ExperimentAssignment {
    const key = `pro-cta:${visitorId}`;
    const existing = this.experiments.get(key);

    if (existing) {
      return existing;
    }

    const variant = hashVariant(visitorId) % 2 === 0 ? 'control' : 'pro-benefits';
    const assignment: ExperimentAssignment = {
      id: randomUUID(),
      visitorId,
      experiment: 'pro-cta',
      variant,
      createdAt: new Date().toISOString(),
    };

    this.experiments.set(key, assignment);

    return assignment;
  }

  getCommercialSummary(): {
    users: number;
    proUsers: number;
    checkoutStarted: number;
    paidSubscriptions: number;
    freeToPaidRate: number;
    batches: number;
    experiments: number;
  } {
    const users = [...this.users.values()];
    const checkoutStarted = this.checkoutIntents.size;
    const paidSubscriptions = [...this.checkoutIntents.values()].filter((intent) => intent.status === 'paid').length;

    return {
      users: users.length,
      proUsers: users.filter((user) => user.planType === 'pro').length,
      checkoutStarted,
      paidSubscriptions,
      freeToPaidRate: users.length > 0 ? users.filter((user) => user.planType === 'pro').length / users.length : 0,
      batches: this.batches.size,
      experiments: this.experiments.size,
    };
  }

  getExpansionTools(): Array<{
    id: string;
    label: string;
    status: 'available' | 'preview' | 'planned';
    inputs: string[];
    outputs: string[];
    requiresPro: boolean;
    apiEndpoint: string;
  }> {
    return [
      {
        id: 'video-to-live-photo',
        label: '视频/GIF 转安卓实况图',
        status: 'available',
        inputs: ['mp4', 'mov', 'gif'],
        outputs: ['zip', 'mov', 'jpeg'],
        requiresPro: false,
        apiEndpoint: '/api/conversions/cloud-jobs',
      },
      {
        id: 'live-photo-to-gif',
        label: '安卓实况图转 GIF',
        status: 'preview',
        inputs: ['zip', 'mov+jpeg'],
        outputs: ['gif'],
        requiresPro: true,
        apiEndpoint: '/api/v1/tools/live-photo-to-gif/intents',
      },
      {
        id: 'live-photo-to-mp4',
        label: '安卓实况图转 MP4',
        status: 'preview',
        inputs: ['zip', 'mov+jpeg'],
        outputs: ['mp4'],
        requiresPro: true,
        apiEndpoint: '/api/v1/tools/live-photo-to-mp4/intents',
      },
      {
        id: 'image-to-live-photo',
        label: '图片素材转安卓实况图',
        status: 'preview',
        inputs: ['jpg', 'png', 'webp'],
        outputs: ['zip', 'mov', 'jpeg'],
        requiresPro: true,
        apiEndpoint: '/api/v1/tools/image-to-live-photo/intents',
      },
      {
        id: 'ai-image-motion',
        label: '图片动态片段生成',
        status: 'planned',
        inputs: ['jpg', 'png', 'webp'],
        outputs: ['mp4', 'live-photo-zip'],
        requiresPro: true,
        apiEndpoint: '/api/v1/tools/ai-image-motion/intents',
      },
    ];
  }

  getTemplates(): Array<{
    id: string;
    label: string;
    category: 'lock-screen' | 'social' | 'seasonal';
    presetId: string;
    aspectRatioId: string;
    durationSeconds: number;
    requiresPro: boolean;
  }> {
    return [
      {
        id: 'ios-lock-clean',
        label: '竖屏锁屏实况',
        category: 'lock-screen',
        presetId: 'ios-lock-screen',
        aspectRatioId: '9:16',
        durationSeconds: 2,
        requiresPro: false,
      },
      {
        id: 'social-loop-square',
        label: '方形通用动态片段',
        category: 'social',
        presetId: 'social-fallback',
        aspectRatioId: '1:1',
        durationSeconds: 3,
        requiresPro: false,
      },
      {
        id: 'pro-cinematic-4k',
        label: '高规格横屏实况',
        category: 'seasonal',
        presetId: 'standard-live-photo',
        aspectRatioId: '16:9',
        durationSeconds: 5,
        requiresPro: true,
      },
    ];
  }

  createApiKey(userId: string, label: string): ApiKeyRecord {
    this.requireUser(userId);

    const secret = randomBytes(24).toString('base64url');
    const record: ApiKeyRecord = {
      id: randomUUID(),
      userId,
      label: label.trim() || 'VidLive API 密钥',
      prefix: `vl_${secret.slice(0, 10)}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };

    this.apiKeys.set(record.id, record);
    this.recordUsage(userId, 'api_key.created', {
      id: record.id,
      prefix: record.prefix,
    });

    return record;
  }

  listApiKeys(userId: string): ApiKeyRecord[] {
    this.requireUser(userId);

    return [...this.apiKeys.values()].filter((item) => item.userId === userId);
  }

  createToolIntent(userId: string, toolId: string): { id: string; toolId: string; status: 'accepted' | 'pro-required' | 'planned' } {
    const user = this.requireUser(userId);
    const tool = this.getExpansionTools().find((item) => item.id === toolId);

    if (!tool) {
      throw new V1Error('tool-not-found', '未找到对应的 VidLive 工具。');
    }

    if (tool.status === 'planned') {
      return {
        id: randomUUID(),
        toolId,
        status: 'planned',
      };
    }

    if (tool.requiresPro && user.planType !== 'pro') {
      return {
        id: randomUUID(),
        toolId,
        status: 'pro-required',
      };
    }

    this.recordUsage(user.id, 'expansion.tool_intent_created', {
      toolId,
    });

    return {
      id: randomUUID(),
      toolId,
      status: 'accepted',
    };
  }

  getBrowserExtensionManifest(): {
    name: string;
    version: string;
    permissions: string[];
    endpoints: string[];
  } {
    return {
      name: 'VidLive 浏览器下载助手',
      version: '0.1.0',
      permissions: ['contextMenus', 'downloads', 'storage'],
      endpoints: ['/api/v1/tools', '/api/v1/templates', '/api/conversions/cloud-jobs'],
    };
  }

  getDesktopManifest(): {
    name: string;
    platforms: string[];
    coreWorkflows: string[];
    status: 'preview';
  } {
    return {
      name: 'VidLive 桌面处理端',
      platforms: ['macOS', 'Windows'],
      coreWorkflows: ['拖拽导入', '云端生成队列', '原文件传输指引', '本地导出记录'],
      status: 'preview',
    };
  }

  getExpansionSummary(): {
    tools: number;
    templates: number;
    apiKeys: number;
    previewTools: number;
    plannedTools: number;
  } {
    const tools = this.getExpansionTools();

    return {
      tools: tools.length,
      templates: this.getTemplates().length,
      apiKeys: this.apiKeys.size,
      previewTools: tools.filter((tool) => tool.status === 'preview').length,
      plannedTools: tools.filter((tool) => tool.status === 'planned').length,
    };
  }

  private signToken(user: StoredUser): string {
    const payload = Buffer.from(
      JSON.stringify({
        sub: user.id,
        email: user.email,
        exp: Date.now() + tokenTtlMilliseconds,
      }),
    ).toString('base64url');

    return `${payload}.${sign(payload, this.jwtSecret)}`;
  }

  private recordUsage(userId: string, action: string, metadata: unknown): void {
    this.usageLogs.push({
      userId,
      action,
      timestamp: new Date().toISOString(),
      metadata,
    });

    void this.authStore?.recordUsage(userId, action, metadata).catch(() => undefined);
  }

  private persistUserPlan(user: StoredUser): void {
    this.cacheUser(user);
    void this.authStore?.updatePlan(user.id, user.planType, user.dailyQuota).catch(() => undefined);
  }

  private applyUserEntitlements(user: StoredUser): StoredUser {
    if (!this.isPermanentMemberEmail(user.email)) {
      return user;
    }

    if (user.planType === 'pro' && user.dailyQuota === unlimitedDailyQuota) {
      return user;
    }

    user.planType = 'pro';
    user.dailyQuota = unlimitedDailyQuota;
    this.persistUserPlan(user);

    return user;
  }

  private updateUserPlan(user: StoredUser, planType: 'free' | 'pro', dailyQuota: number): StoredUser {
    const entitledPlan = this.resolveEntitledPlan(user.email, planType, dailyQuota);
    user.planType = entitledPlan.planType;
    user.dailyQuota = entitledPlan.dailyQuota;
    this.persistUserPlan(user);

    return user;
  }

  private resolveEntitledPlan(
    email: string,
    planType: 'free' | 'pro',
    dailyQuota: number,
  ): Pick<V1UserProfile, 'planType' | 'dailyQuota'> {
    if (this.isPermanentMemberEmail(email)) {
      return {
        planType: 'pro',
        dailyQuota: unlimitedDailyQuota,
      };
    }

    return {
      planType,
      dailyQuota,
    };
  }

  private isPermanentMemberEmail(email: string): boolean {
    return this.permanentMemberEmails.has(normalizeEmail(email));
  }

  private requireUser(userId: string): StoredUser {
    const user = this.users.get(userId);

    if (!user) {
      throw new V1Error('user-not-found', 'User was not found.');
    }

    return this.applyUserEntitlements(user);
  }
}

export class V1Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;

  return `scrypt:v1:${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [, version, salt, expectedHash] = encodedHash.split(':');

  if (version !== 'v1' || !salt || !expectedHash) {
    return false;
  }

  const hash = (await scryptAsync(password, salt, 64)) as Buffer;

  return timingSafeHexEqual(hash.toString('hex'), expectedHash);
}

function generateEmailCode(): string {
  return randomBytes(4).readUInt32BE(0).toString().padStart(10, '0').slice(0, 6);
}

function normalizeEmailCode(value: string): string {
  const code = value.trim();

  if (!/^\d{6}$/u.test(code)) {
    throw new V1Error('invalid-email-code-generator', '邮箱验证码生成器必须返回 6 位数字。');
  }

  return code;
}

function hashEmailCode(secret: string, email: string, purpose: EmailVerificationPurpose, code: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${normalizeEmail(email)}:${code}`).digest('hex');
}

function getEmailCodeSubject(purpose: EmailVerificationPurpose): string {
  if (purpose === 'register') {
    return 'VidLive 注册邮箱验证码';
  }

  if (purpose === 'login') {
    return 'VidLive 登录邮箱验证码';
  }

  return 'VidLive 重置密码验证码';
}

function validateRegistrationInput(input: { email: string; password: string; username: string }): {
  email: string;
  password: string;
  username: string;
} {
  const email = normalizeEmail(input.email);
  const username = input.username.trim();
  const password = input.password;

  if (!isValidEmail(email)) {
    throw new V1Error('invalid-email', '请输入有效邮箱地址。');
  }

  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) {
    throw new V1Error('invalid-username', '用户名需为 2-32 位，可使用中英文、数字、下划线或短横线。');
  }

  const passwordError = getPasswordValidationError(password, email, username);

  if (passwordError) {
    throw new V1Error('weak-password', passwordError);
  }

  return {
    email,
    password,
    username,
  };
}

function validateRegistrationEmailCodeInput(usernameInput: string): string {
  const username = usernameInput.trim();

  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) {
    throw new V1Error('invalid-username', '用户名需为 2-32 位，可使用中英文、数字、下划线或短横线。');
  }

  return username;
}

function validateLoginInput(input: { email: string; password: string }): { email: string; password: string } {
  const email = normalizeEmail(input.email);

  if (!isValidEmail(email) || input.password.length < 1 || input.password.length > 128) {
    throw new V1Error('invalid-credentials', '邮箱或密码不正确。');
  }

  return {
    email,
    password: input.password,
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isUnlimitedDailyQuota(value: number): boolean {
  return value < 0;
}

function isValidEmail(value: string): boolean {
  if (value.length > 254) {
    return false;
  }

  const parts = value.split('@');

  if (parts.length !== 2) {
    return false;
  }

  const localPart = parts[0];
  const domain = parts[1];

  if (
    !localPart ||
    !domain ||
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart)
  ) {
    return false;
  }

  return isValidEmailDomain(domain);
}

function isValidEmailDomain(domain: string): boolean {
  if (domain.length > 253 || domain.includes('..')) {
    return false;
  }

  const labels = domain.split('.');

  if (labels.length < 2) {
    return false;
  }

  return labels.every((label, index) => {
    const isTopLevelDomain = index === labels.length - 1;

    return (
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label) &&
      (!isTopLevelDomain || /^[a-z]{2,63}$/i.test(label))
    );
  });
}

async function assertEmailDomainCanReceiveMail(email: string): Promise<void> {
  const domain = email.split('@')[1];

  if (!domain || !isValidEmailDomain(domain)) {
    throw new V1Error('invalid-email', '请输入有效邮箱地址。');
  }

  if (shouldBypassEmailDomainLookup(domain)) {
    return;
  }

  if (!(await canEmailDomainReceiveMail(domain))) {
    throw new V1Error('invalid-email-domain', '邮箱域名无法接收邮件，请换用真实邮箱。');
  }
}

function shouldBypassEmailDomainLookup(domain: string): boolean {
  return process.env.NODE_ENV !== 'production' && domain.toLowerCase().endsWith('.test');
}

async function canEmailDomainReceiveMail(domain: string): Promise<boolean> {
  const now = Date.now();
  const cached = emailDomainValidationCache.get(domain);

  if (cached && cached.expiresAt > now) {
    return cached.canReceiveMail;
  }

  const canReceiveMail = await lookupEmailDomain(domain);
  emailDomainValidationCache.set(domain, {
    canReceiveMail,
    expiresAt: now + emailDomainValidationCacheTtlMilliseconds,
  });

  return canReceiveMail;
}

async function lookupEmailDomain(domain: string): Promise<boolean> {
  try {
    const mxRecords = await withDnsTimeout(resolveMx(domain));

    if (mxRecords.length > 0) {
      return mxRecords.some((record) => record.exchange.length > 0 && record.exchange !== '.');
    }
  } catch {
    // Domains without MX can still receive mail via A/AAAA fallback; try that before rejecting.
  }

  const addressLookups = await Promise.allSettled([withDnsTimeout(resolve4(domain)), withDnsTimeout(resolve6(domain))]);

  return addressLookups.some((result) => result.status === 'fulfilled' && result.value.length > 0);
}

async function withDnsTimeout<T>(lookup: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      lookup,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('dns-lookup-timeout'));
        }, emailDomainLookupTimeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function getPasswordValidationError(password: string, email: string, username: string): string | null {
  if (password.length < 10 || password.length > 128) {
    return '密码需为 10-128 位。';
  }

  const categoryCount = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  if (categoryCount < 3) {
    return '密码至少包含大小写字母、数字、符号中的 3 类。';
  }

  const normalizedPassword = password.toLowerCase();
  const emailName = email.split('@')[0] ?? '';

  if (commonWeakPasswords.has(normalizedPassword)) {
    return '密码过于常见，请换一个。';
  }

  if (emailName.length >= 3 && normalizedPassword.includes(emailName)) {
    return '密码不能包含邮箱名称。';
  }

  if (username.length >= 3 && normalizedPassword.includes(username.toLowerCase())) {
    return '密码不能包含用户名。';
  }

  return null;
}

function toPublicUser(user: StoredUser): V1UserProfile {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    planType: user.planType,
    dailyQuota: user.dailyQuota,
    createdAt: user.createdAt,
  };
}

function toStoredUser(record: StoredUserRecord): StoredUser {
  return {
    id: record.id,
    email: record.email,
    username: record.username,
    passwordHash: record.passwordHash,
    planType: record.planType,
    dailyQuota: record.dailyQuota,
    createdAt: record.createdAt,
    failedLoginCount: record.failedLoginCount,
    lockedUntil: record.lockedUntil,
    lastLoginAt: record.lastLoginAt,
  };
}

function toStoredEmailVerificationCode(record: StoredEmailVerificationCodeRecord): StoredEmailVerificationCode {
  return {
    id: record.id,
    email: record.email,
    purpose: record.purpose,
    codeHash: record.codeHash,
    expiresAt: Date.parse(record.expiresAt),
    consumedAt: record.consumedAt ? Date.parse(record.consumedAt) : null,
    attemptCount: record.attemptCount,
    requestIpHash: record.requestIpHash,
    userAgentHash: record.userAgentHash,
    createdAt: Date.parse(record.createdAt),
  };
}

function createKnownDeviceKey(userId: string, deviceHash: string): string {
  return `${userId}:${deviceHash}`;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function delayInvalidLogin(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
}

function isToday(value: string): boolean {
  const target = new Date(value);
  const now = new Date();

  return target.getFullYear() === now.getFullYear() && target.getMonth() === now.getMonth() && target.getDate() === now.getDate();
}

function roundSeconds(value: number): number {
  return Math.round(value * 10) / 10;
}

function hashVariant(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}
