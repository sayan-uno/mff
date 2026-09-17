import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { cookies } from 'next/headers';
import { connectToDatabase } from '@/lib/mongodb';
import { isAdminAuthenticated } from '@/app/actions';
import { rateLimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import type { SupportTicket } from '@/lib/support-definitions';
import {
    saveUploadChunk,
    assembleUpload,
    getUploadLimitBytes,
    classifyKind,
    sweepStaleUploadChunks,
    MAX_UPLOAD_LIMIT_BYTES,
    type SupportFileMetadata,
} from '@/lib/support-files';

export const dynamic = 'force-dynamic';
// Never let the platform try to statically optimise / cache this.
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Chunked upload endpoint for support videos & files.
//
// The browser sends a file in 4MB pieces (multipart/form-data). Each piece is
// parked in `support_upload_chunks`; when the final piece arrives the whole file
// is assembled into GridFS in order. This keeps every individual request small
// enough for the hosting platform's body-size cap while still supporting files
// up to 250MB.
//
// Auth: a user may only upload to their own ticket (gaming_id cookie); admins
// may upload to any ticket.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
    // Per-IP cap on upload chunks (4 MB each): about 6 maximum-size files per 10 minutes.
    const ip = getClientIp(req.headers);
    const verdict = rateLimit(`support-chunk:${ip}`, { limit: 400, windowMs: 10 * 60 * 1000 });
    if (!verdict.allowed) {
        return NextResponse.json({ success: false, message: 'Too many uploads. Please wait a few minutes.' }, { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSec) } });
    }
    try {
        const form = await req.formData();

        const ticketId = String(form.get('ticketId') || '');
        const uploadId = String(form.get('uploadId') || '');
        const index = Number(form.get('index'));
        const totalChunks = Number(form.get('totalChunks'));
        const totalSize = Number(form.get('totalSize'));
        const filename = String(form.get('filename') || 'file');
        const contentType = String(form.get('contentType') || 'application/octet-stream');
        const chunk = form.get('chunk');

        // --- Basic validation ---
        if (
            !ObjectId.isValid(ticketId) ||
            !uploadId ||
            !/^[a-zA-Z0-9_-]{6,64}$/.test(uploadId) ||
            !Number.isInteger(index) ||
            index < 0 ||
            !Number.isInteger(totalChunks) ||
            totalChunks < 1 ||
            totalChunks > 200 ||
            index >= totalChunks ||
            !Number.isFinite(totalSize) ||
            totalSize <= 0 ||
            !(chunk instanceof Blob)
        ) {
            return NextResponse.json({ success: false, message: 'Bad request.' }, { status: 400 });
        }

        const db = await connectToDatabase();

        // --- Authorise: ticket owner or admin ---
        const isAdmin = await isAdminAuthenticated();
        const gamingIdCookie = cookies().get('gaming_id')?.value;

        const ticket = await db
            .collection<SupportTicket>('support_tickets')
            .findOne({ _id: new ObjectId(ticketId) }, { projection: { gamingId: 1 } });
        if (!ticket) {
            return NextResponse.json({ success: false, message: 'Report not found.' }, { status: 404 });
        }

        let uploadedBy: 'user' | 'admin';
        let ownerGamingId: string;
        if (isAdmin) {
            uploadedBy = 'admin';
            ownerGamingId = ticket.gamingId;
        } else if (gamingIdCookie && gamingIdCookie === ticket.gamingId) {
            uploadedBy = 'user';
            ownerGamingId = ticket.gamingId;
            // A user may be blocked from support entirely.
            const blocked = await db.collection('support_blocks').findOne({ gamingId: ownerGamingId });
            if (blocked) {
                return NextResponse.json({ success: false, message: 'You are blocked from this feature.' }, { status: 403 });
            }
        } else {
            return NextResponse.json({ success: false, message: 'Unauthorized.' }, { status: 403 });
        }

        // --- Enforce the size limit server-side (defence in depth) ---
        // Admins are not limited; users are capped at their granted tier.
        if (uploadedBy === 'user') {
            const limit = await getUploadLimitBytes(db, ownerGamingId);
            if (totalSize > limit) {
                return NextResponse.json(
                    { success: false, code: 'LIMIT_EXCEEDED', message: 'File exceeds your upload limit.' },
                    { status: 413 }
                );
            }
        } else if (totalSize > MAX_UPLOAD_LIMIT_BYTES) {
            return NextResponse.json(
                { success: false, message: 'File exceeds the maximum size.' },
                { status: 413 }
            );
        }

        // --- Store this chunk ---
        const buffer = Buffer.from(await chunk.arrayBuffer());
        await saveUploadChunk(db, {
            uploadId,
            index,
            gamingId: ownerGamingId,
            ticketId,
            data: buffer,
        });

        // --- Not the last chunk: acknowledge and wait for more ---
        if (index < totalChunks - 1) {
            return NextResponse.json({ success: true, done: false });
        }

        // --- Final chunk: assemble into GridFS ---
        const metadata: SupportFileMetadata = {
            ticketId,
            gamingId: ownerGamingId,
            uploadedBy,
            kind: classifyKind(contentType),
            contentType,
        };
        const { fileId, size } = await assembleUpload(db, {
            uploadId,
            totalChunks,
            filename: filename.slice(0, 200),
            metadata,
        });

        // Opportunistic cleanup of any abandoned partial uploads.
        void sweepStaleUploadChunks(db);

        return NextResponse.json({ success: true, done: true, fileId, size });
    } catch (error) {
        console.error('Support upload failed:', error);
        return NextResponse.json({ success: false, message: 'Upload failed.' }, { status: 500 });
    }
}
