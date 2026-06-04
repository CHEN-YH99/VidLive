import { createHmac, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

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
  passwordSalt: string;
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

export class V1Service {
  private readonly users = new Map<string, StoredUser>();
  private readonly usersByEmail = new Map<string, StoredUser>();
  private readonly usageLogs: UsageLog[] = [];
  private readonly feedback: CompatibilityFeedback[] = [];
  private readonly checkoutIntents = new Map<string, CheckoutIntent>();
  private readonly batches = new Map<string, BatchJob>();
  private readonly experiments = new Map<string, ExperimentAssignment>();

  constructor(private readonly jwtSecret: string) {}

  async register(input: { email: string; password: string; username: string }): Promise<{ user: V1UserProfile; token: string }> {
    const email = normalizeEmail(input.email);

    if (!email || input.password.length < 8 || input.username.trim().length < 2) {
      throw new V1Error('invalid-registration', 'Email, username, and an 8+ character password are required.');
    }

    if (this.usersByEmail.has(email)) {
      throw new V1Error('email-already-registered', 'Email is already registered.');
    }

    const passwordSalt = randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(input.password, passwordSalt);
    const now = new Date().toISOString();
    const user: StoredUser = {
      id: randomUUID(),
      email,
      username: input.username.trim(),
      planType: 'free',
      dailyQuota: 5,
      createdAt: now,
      passwordHash,
      passwordSalt,
    };

    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user);
    this.recordUsage(user.id, 'user.registered', {});

    return {
      user: toPublicUser(user),
      token: this.signToken(user),
    };
  }

  async login(input: { email: string; password: string }): Promise<{ user: V1UserProfile; token: string }> {
    const user = this.usersByEmail.get(normalizeEmail(input.email));

    if (!user) {
      throw new V1Error('invalid-credentials', 'Email or password is incorrect.');
    }

    const passwordHash = await hashPassword(input.password, user.passwordSalt);

    if (passwordHash !== user.passwordHash) {
      throw new V1Error('invalid-credentials', 'Email or password is incorrect.');
    }

    this.recordUsage(user.id, 'user.logged_in', {});

    return {
      user: toPublicUser(user),
      token: this.signToken(user),
    };
  }

  authenticate(token: string | null): V1UserProfile | null {
    if (!token) {
      return null;
    }

    const [payloadRaw, signature] = token.split('.');

    if (!payloadRaw || !signature || sign(payloadRaw, this.jwtSecret) !== signature) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadRaw, 'base64url').toString('utf8')) as { sub?: string; exp?: number };

      if (!payload.sub || !payload.exp || payload.exp < Date.now()) {
        return null;
      }

      const user = this.users.get(payload.sub);

      return user ? toPublicUser(user) : null;
    } catch {
      return null;
    }
  }

  getUsage(userId: string): V1UsageSummary {
    const user = this.users.get(userId);

    if (!user) {
      throw new V1Error('user-not-found', 'User was not found.');
    }

    const usedToday = this.usageLogs.filter((log) => {
      return log.userId === userId && log.action === 'conversion.created' && isToday(log.timestamp);
    }).length;

    return {
      quotaLimit: user.dailyQuota,
      usedToday,
      remainingToday: Math.max(0, user.dailyQuota - usedToday),
    };
  }

  consumeConversionQuota(userId: string, metadata: unknown): V1UsageSummary {
    const summary = this.getUsage(userId);

    if (summary.remainingToday <= 0) {
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
        status: 'warn',
        detail: 'Prisma schema exists, but this V1 service is still using in-memory storage until Prisma client is wired.',
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
        label: 'Free',
        priceCents: 0,
        quota: 5,
        features: ['本地导出', '标准预设', '基础保存指引'],
      },
      {
        id: 'pro-monthly',
        label: 'Pro Monthly',
        priceCents: 900,
        quota: 100,
        features: ['云端优先队列', '批量处理', '4K 输出', '历史记录', '高级编辑'],
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
      throw new V1Error('checkout-not-found', 'Checkout intent was not found.');
    }

    const user = this.requireUser(intent.userId);
    intent.status = 'paid';
    user.planType = 'pro';
    user.dailyQuota = 100;
    this.recordUsage(user.id, 'billing.subscription_started', intent);

    return {
      intent,
      user: toPublicUser(user),
    };
  }

  cancelSubscription(userId: string): V1UserProfile {
    const user = this.requireUser(userId);
    user.planType = 'free';
    user.dailyQuota = 5;
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
      throw new V1Error('pro-required', 'Batch processing and 4K output require Pro.');
    }

    if (input.fileNames.length < 2 || input.fileNames.length > 20) {
      throw new V1Error('invalid-batch-size', 'Batch size must be between 2 and 20 files.');
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

  private signToken(user: StoredUser): string {
    const payload = Buffer.from(
      JSON.stringify({
        sub: user.id,
        email: user.email,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
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
  }

  private requireUser(userId: string): StoredUser {
    const user = this.users.get(userId);

    if (!user) {
      throw new V1Error('user-not-found', 'User was not found.');
    }

    return user;
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

async function hashPassword(password: string, salt: string): Promise<string> {
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;

  return hash.toString('hex');
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
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

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
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
