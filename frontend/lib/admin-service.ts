import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, desc, sql as drizzleSql, and } from 'drizzle-orm';
import {
  adminUsers,
  adminRequests,
  swapHistory,
  users,
  type AdminUser,
  type AdminRequest,
} from '../../shared/schema';

const rawSql = neon(process.env.DATABASE_URL!);
const db = drizzle(rawSql);

export { adminUsers, adminRequests };

// ── Admin User helpers ─────────────────────────────────────────────────────

export async function getAdminByFirebaseUid(uid: string): Promise<AdminUser | null> {
  const rows = await db.select().from(adminUsers)
    .where(and(eq(adminUsers.firebaseUid, uid), eq(adminUsers.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAdminByEmail(email: string): Promise<AdminUser | null> {
  const rows = await db.select().from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAdminUser(data: {
  firebaseUid: string;
  email: string;
  name: string;
  approvedBy: string;
}): Promise<AdminUser> {
  const rows = await db.insert(adminUsers).values({
    firebaseUid: data.firebaseUid,
    email: data.email,
    name: data.name,
    role: 'admin',
    isActive: true,
    approvedAt: new Date(),
    approvedBy: data.approvedBy,
  }).returning();
  return rows[0];
}

// ── Admin Request helpers ──────────────────────────────────────────────────

export async function getPendingRequestByToken(token: string): Promise<AdminRequest | null> {
  const rows = await db.select().from(adminRequests)
    .where(and(eq(adminRequests.approvalToken, token), eq(adminRequests.status, 'pending')))
    .limit(1);
  return rows[0] ?? null;
}

export async function getRequestByEmail(email: string): Promise<AdminRequest | null> {
  const rows = await db.select().from(adminRequests)
    .where(eq(adminRequests.email, email))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAdminRequest(data: {
  firebaseUid: string;
  email: string;
  name: string;
  reason?: string;
  approvalToken: string;
}): Promise<AdminRequest> {
  const rows = await db.insert(adminRequests).values({
    ...data,
    reason: data.reason ?? 'Admin access requested.',
  }).returning();
  return rows[0];
}

export async function approveAdminRequest(token: string, reviewerEmail: string) {
  await db.update(adminRequests).set({
    status: 'approved',
    reviewedAt: new Date(),
    reviewedBy: reviewerEmail,
    updatedAt: new Date(),
  }).where(eq(adminRequests.approvalToken, token));
}

export async function rejectAdminRequest(token: string, reviewerEmail: string, reason?: string) {
  await db.update(adminRequests).set({
    status: 'rejected',
    reviewedAt: new Date(),
    reviewedBy: reviewerEmail,
    rejectionReason: reason ?? 'Not approved by administrator.',
    updatedAt: new Date(),
  }).where(eq(adminRequests.approvalToken, token));
}

// ── Analytics helpers ──────────────────────────────────────────────────────

export interface PlatformAnalytics {
  totalSwaps: number;
  totalSwapsToday: number;
  totalSwapsWeek: number;
  totalSwapsMonth: number;
  successCount: number;
  failedCount: number;
  totalUsers: number;
  activeUsersToday: number;
  topAssets: { asset: string; network: string; count: number }[];
  topChains: { chain: string; count: number }[];
  recentSwaps: {
    id: number;
    userId: string;
    fromAsset: string;
    toAsset: string;
    fromNetwork: string;
    toNetwork: string;
    fromAmount: number;
    status: string;
    createdAt: Date | null;
  }[];
  swapsByDay: { date: string; count: number }[];
}

export async function getPlatformAnalytics(): Promise<PlatformAnalytics> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek  = new Date(now); startOfWeek.setDate(now.getDate() - 7);
  const startOfMonth = new Date(now); startOfMonth.setDate(now.getDate() - 30);

  const todayStr  = startOfToday.toISOString();
  const weekStr   = startOfWeek.toISOString();
  const monthStr  = startOfMonth.toISOString();

  // All counts in one shot via conditional aggregation
  const [[counts], topAssetsRows, topChainsRows, recentSwapsRows, swapsByDayRows, [userCounts]] = await Promise.all([
    db.select({
      total:      drizzleSql<number>`count(*)::int`,
      today:      drizzleSql<number>`count(*) filter (where "created_at" >= ${todayStr}::timestamptz)::int`,
      week:       drizzleSql<number>`count(*) filter (where "created_at" >= ${weekStr}::timestamptz)::int`,
      month:      drizzleSql<number>`count(*) filter (where "created_at" >= ${monthStr}::timestamptz)::int`,
      success:    drizzleSql<number>`count(*) filter (where "status" = 'settled')::int`,
      failed:     drizzleSql<number>`count(*) filter (where "status" = 'failed')::int`,
    }).from(swapHistory),

    db.select({
      asset:   swapHistory.fromAsset,
      network: swapHistory.fromNetwork,
      cnt:     drizzleSql<number>`count(*)::int`,
    }).from(swapHistory)
      .groupBy(swapHistory.fromAsset, swapHistory.fromNetwork)
      .orderBy(drizzleSql`count(*) desc`)
      .limit(10),

    db.select({
      chain: swapHistory.fromNetwork,
      cnt:   drizzleSql<number>`count(*)::int`,
    }).from(swapHistory)
      .groupBy(swapHistory.fromNetwork)
      .orderBy(drizzleSql`count(*) desc`)
      .limit(10),

    db.select({
      id:          swapHistory.id,
      userId:      swapHistory.userId,
      fromAsset:   swapHistory.fromAsset,
      toAsset:     swapHistory.toAsset,
      fromNetwork: swapHistory.fromNetwork,
      toNetwork:   swapHistory.toNetwork,
      fromAmount:  swapHistory.fromAmount,
      status:      swapHistory.status,
      createdAt:   swapHistory.createdAt,
    }).from(swapHistory)
      .orderBy(desc(swapHistory.createdAt))
      .limit(20),

    db.select({
      date: drizzleSql<string>`date("created_at")::text`,
      cnt:  drizzleSql<number>`count(*)::int`,
    }).from(swapHistory)
      .where(drizzleSql`"created_at" >= ${monthStr}::timestamptz`)
      .groupBy(drizzleSql`date("created_at")`)
      .orderBy(drizzleSql`date("created_at")`),

    db.select({
      total:      drizzleSql<number>`count(*)::int`,
      todayActive: drizzleSql<number>`count(*) filter (where "created_at" >= ${todayStr}::timestamptz)::int`,
    }).from(users),
  ]);

  return {
    totalSwaps:      counts?.total ?? 0,
    totalSwapsToday: counts?.today ?? 0,
    totalSwapsWeek:  counts?.week ?? 0,
    totalSwapsMonth: counts?.month ?? 0,
    successCount:    counts?.success ?? 0,
    failedCount:     counts?.failed ?? 0,
    totalUsers:      userCounts?.total ?? 0,
    activeUsersToday: userCounts?.todayActive ?? 0,
    topAssets:  topAssetsRows.map(r  => ({ asset: r.asset, network: r.network, count: r.cnt })),
    topChains:  topChainsRows.map(r  => ({ chain: r.chain, count: r.cnt })),
    recentSwaps: recentSwapsRows,
    swapsByDay: swapsByDayRows.map(r => ({ date: r.date, count: r.cnt })),
  };
}
