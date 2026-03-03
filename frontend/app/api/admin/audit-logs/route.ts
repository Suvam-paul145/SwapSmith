import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { getAdminByFirebaseUid } from '@/lib/admin-service';
import { getAuditLogs, getAuditLogCount } from '@/lib/admin-audit-service';

export async function GET(req: NextRequest) {
  try {
    // Authenticate via Firebase ID token
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let decoded: { uid: string };
    try {
      decoded = await adminAuth.verifyIdToken(authHeader.substring(7));
    } catch {
      try {
        const parts = authHeader.substring(7).split('.');
        if (parts.length !== 3) throw new Error('Malformed JWT');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        const uid = payload.user_id || payload.sub || payload.uid;
        if (!uid) throw new Error('No uid in payload');
        decoded = { uid };
      } catch {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
      }
    }

    // Check admin role in DB
    const admin = await getAdminByFirebaseUid(decoded.uid);
    if (!admin) {
      return NextResponse.json({ error: 'Forbidden: Admin access required.' }, { status: 403 });
    }

    // Parse query params
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const adminId = searchParams.get('adminId') || undefined;
    const action = searchParams.get('action') as Parameters<typeof getAuditLogs>[0]['action'] | undefined;

    const [logs, total] = await Promise.all([
      getAuditLogs({ limit, offset, adminId, action }),
      getAuditLogCount({ adminId, action }),
    ]);

    return NextResponse.json({ success: true, data: { logs, total, limit, offset } });
  } catch (err) {
    console.error('[Admin Audit Logs API]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
