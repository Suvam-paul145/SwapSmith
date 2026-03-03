import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, desc, and, sql as drizzleSql } from 'drizzle-orm';
import {
  adminAuditLogs,
  type AdminAuditLog,
} from '../../shared/schema';

const rawSql = neon(process.env.DATABASE_URL!);
const db = drizzle(rawSql);

/** Record an admin action in the audit log. */
export async function logAdminAction(params: {
  adminId: string;
  adminEmail: string;
  action: AdminAuditLog['action'];
  targetId?: string;
  targetType?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}): Promise<void> {
  await db.insert(adminAuditLogs).values({
    adminId: params.adminId,
    adminEmail: params.adminEmail,
    action: params.action,
    targetId: params.targetId ?? null,
    targetType: params.targetType ?? null,
    details: params.details ?? null,
    ipAddress: params.ipAddress ?? null,
  });
}

/** Fetch recent audit log entries. */
export async function getAuditLogs(options: {
  limit?: number;
  offset?: number;
  adminId?: string;
  action?: AdminAuditLog['action'];
} = {}): Promise<AdminAuditLog[]> {
  const { limit = 50, offset = 0, adminId, action } = options;

  const conditions = [];
  if (adminId) conditions.push(eq(adminAuditLogs.adminId, adminId));
  if (action) conditions.push(eq(adminAuditLogs.action, action));

  const query = db.select().from(adminAuditLogs);

  if (conditions.length > 0) {
    return query
      .where(and(...conditions))
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(limit)
      .offset(offset);
  }

  return query
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

/** Get the total count of audit log entries. */
export async function getAuditLogCount(options: {
  adminId?: string;
  action?: AdminAuditLog['action'];
} = {}): Promise<number> {
  const { adminId, action } = options;

  const conditions = [];
  if (adminId) conditions.push(eq(adminAuditLogs.adminId, adminId));
  if (action) conditions.push(eq(adminAuditLogs.action, action));

  const result = conditions.length > 0
    ? await db.select({ count: drizzleSql<number>`count(*)` })
        .from(adminAuditLogs)
        .where(and(...conditions))
    : await db.select({ count: drizzleSql<number>`count(*)` })
        .from(adminAuditLogs);

  return Number(result[0]?.count ?? 0);
}
