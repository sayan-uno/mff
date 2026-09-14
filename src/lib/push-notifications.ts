import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
function initializeFirebaseAdmin() {
  if (!admin.apps.length) {
    try {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY;
      if (!privateKey) {
          throw new Error('FIREBASE_PRIVATE_KEY is not set');
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      console.log('Firebase Admin SDK initialized successfully for push notifications.');
    } catch (error: any) {
      console.error('Error initializing Firebase Admin SDK for push notifications:', error.message);
    }
  }
  return admin.messaging();
}

interface PushNotificationPayload {
    token: string;
    title: string;
    body: string;
    imageUrl?: string;
    link?: string; // Optional click-through URL; defaults to the site base URL
}

interface MulticastPushNotificationPayload {
    tokens: string[];
    title: string;
    body: string;
    imageUrl?: string;
}

// Helper to build the message payload, sending only 'data'
const buildDataPayload = (payload: { title: string; body: string; imageUrl?: string; link?: string; }) => {
    return {
        data: {
            title: payload.title,
            body: payload.body,
            ...(payload.imageUrl && { image: payload.imageUrl }),
            // Add the link here so the service worker can use it. Callers may pass a
            // specific link (e.g. the /support page); otherwise fall back to the base URL.
            link: payload.link || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002'
        }
    };
};


export async function sendPushNotification(payload: PushNotificationPayload) {
    const messaging = initializeFirebaseAdmin();
    if (!payload.token) return;

    try {
        await messaging.send({
            token: payload.token,
            ...buildDataPayload(payload)
        });
    } catch (error) {
        console.error(`Failed to send push notification to token ${payload.token}:`, error);
        // Don't fail the whole action if push notification fails for one token
    }
}

export async function sendMulticastPushNotification(payload: MulticastPushNotificationPayload) {
    if (payload.tokens.length === 0) {
        return;
    }
    const messaging = initializeFirebaseAdmin();
    try {
        await messaging.sendEachForMulticast({
            tokens: payload.tokens,
            ...buildDataPayload(payload)
        });
    } catch (error) {
        console.error('Error sending multicast push notifications:', error);
    }
}
