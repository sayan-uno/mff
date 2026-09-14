
import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { isAdminAuthenticated } from '@/app/actions';
import { AiLog } from '@/lib/definitions';

// Helper to create a small delay, can help prevent event loop blocking on huge datasets.
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function GET(req: NextRequest) {
  const isAdmin = await isAdminAuthenticated();
  if (!isAdmin) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const db = await connectToDatabase();
    // Get a cursor, which does not load all documents into memory at once.
    // The .sort() has been removed to prevent the database memory limit error.
    // The logs will be streamed in their natural (oldest first) order.
    const cursor = db.collection<AiLog>('ai_logs').find({});

    // Create a ReadableStream to send data chunk by chunk.
    const stream = new ReadableStream({
      async start(controller) {
        // Start the JSON array.
        controller.enqueue('[\n');
        let isFirst = true;

        // Iterate over the cursor, which fetches documents in batches.
        for await (const doc of cursor) {
          if (!isFirst) {
            controller.enqueue(',\n');
          }
          
          // Ensure we have a plain object for JSON.stringify.
          const plainDoc = {
              _id: doc._id.toString(),
              gamingId: doc.gamingId,
              ip: doc.ip ?? '',
              question: doc.question,
              answer: doc.answer,
              createdAt: doc.createdAt,
              mediaDataUri: doc.mediaDataUri,
          };
          
          // Enqueue the stringified document chunk.
          controller.enqueue(JSON.stringify(plainDoc, null, 2));
          isFirst = false;
          
          // Small sleep to ensure the event loop is not blocked on extremely large collections.
          await sleep(1);
        }

        // Close the JSON array and the stream.
        controller.enqueue('\n]');
        controller.close();
      },
      cancel() {
        cursor.close();
      }
    });

    const date = new Date().toISOString().split('T')[0];
    // Set headers to instruct the browser to download the file.
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ai_logs_${date}.json"`,
    });

    return new NextResponse(stream, { headers });

  } catch (error) {
    console.error('Streaming download failed:', error);
    return new NextResponse(JSON.stringify({ success: false, message: 'An internal server error occurred.' }), { status: 500 });
  }
}
