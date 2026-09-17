





















'use server';

import { customerFAQChatbot, type CustomerFAQChatbotInput } from '@/ai/flows/customer-faq-chatbot';
import { connectToDatabase } from '@/lib/mongodb';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { isSafeHttpUrl, MEDIA_URL_ERROR } from '@/lib/media-urls';
import { type User, type Order, type Product, type Withdrawal, type LegacyUser, type Notification, type Event, type AiLog, type UserProductControl, type VisualIdPromotionLog, type CustomAd, PreSeededLoginHistory } from '@/lib/definitions';
import { randomBytes, createHmac } from 'crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { unstable_noStore as noStore } from 'next/cache';
import { alertRedeemCodeOrder } from '@/lib/admin-alerts';
import { ObjectId } from 'mongodb';
import { sendPushNotification, sendMulticastPushNotification } from '@/lib/push-notifications';
import { promoteVisualId } from '@/lib/visual-id-promoter';
import { setSmartVisualId } from '@/lib/auto-visual-id';
import { handlePreRegistrationPromotion } from '@/lib/pre-registration-promoter';
import { buildPurchaseSuccessHtml } from '@/lib/purchase-success-notifier';
import { ADMIN_CHALLENGE_COOKIE, ADMIN_SESSION_COOKIE, verifyAdminSessionToken } from '@/lib/admin-auth/session';
import { getSessionVersion } from '@/lib/admin-auth/store';
import { rateLimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import { AD_REWARD_COINS, claimAdReward, startAdRewardSession } from '@/lib/ad-rewards';
import { GIFT_RULES, clearGiftFailures, getGiftLock, recordGiftPasswordFailure } from '@/lib/coin-guard';


/**
 * Key for the account (username/password) session cookie. There is deliberately
 * no fallback: a deployment without a strong SESSION_SECRET must fail loudly
 * instead of silently signing sessions with a value anyone can read in the repo.
 */
function sessionKey(): Uint8Array {
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters.');
  }
  return new TextEncoder().encode(secret);
}

const USER_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};


export async function askQuestion(
  input: Omit<CustomerFAQChatbotInput, 'gamingId' | 'visualGamingId'>
): Promise<{ success: boolean; answer?: string; error?: string }> {
  // Gentle limits: no human hits these; they protect the AI bill from scripts.
  const askerId = (await cookies()).get('gaming_id')?.value ?? 'guest';
  const askerHeaders = await headers();
  const askerIp = getClientIp(askerHeaders);
  if (!rateLimit(`chat:user:${askerId}`, { limit: 20, windowMs: 60 * 1000 }).allowed || !rateLimit(`chat:ip:${askerIp}`, { limit: 40, windowMs: 60 * 1000 }).allowed) {
    return { success: false, error: 'Too many questions in a short time. Please wait a minute and try again.' };
  }
  try {
    const user = await getUserData();
    const gamingId = user?.gamingId || 'Guest';

    const fullInput: CustomerFAQChatbotInput = {
      ...input,
      gamingId: user?.gamingId,
      visualGamingId: user?.visualGamingId,
    };

    const result = await customerFAQChatbot(fullInput);

    // Log the conversation to the database
    const db = await connectToDatabase();
    const newLog: Omit<AiLog, '_id'> = {
        gamingId,
        question: input.question,
        answer: result.answer,
        createdAt: new Date(),
        ip: askerIp,
        mediaDataUri: input.mediaDataUri,
    };
    await db.collection<AiLog>('ai_logs').insertOne(newLog as AiLog);
    revalidatePath('/admin/ai-logs');

    return { success: true, answer: result.answer };
  } catch (error) {
    console.error('Error in askQuestion action:', error);
    return { success: false, error: 'Sorry, I am unable to answer at the moment. Please try again later.' };
  }
}

type FormState = {
  success: boolean;
  message: string;
};

// --- Authentication Actions ---

const accountSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters long'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
});


async function createSession(username: string) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const session = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(sessionKey());

  cookies().set('session', session, { ...USER_COOKIE_OPTIONS, expires });
}

export async function getSession() {
  const sessionCookie = cookies().get('session')?.value;
  if (!sessionCookie) return null;

  try {
    const { payload } = await jwtVerify(sessionCookie, sessionKey(), {
      algorithms: ['HS256'],
    });
    return payload as { username: string; iat: number; exp: number };
  } catch (error) {
    return null;
  }
}

export async function logout() {
  cookies().set('session', '', { ...USER_COOKIE_OPTIONS, expires: new Date(0) });
  redirect('/account');
}

export async function createAccount(prevState: FormState, formData: FormData): Promise<FormState> {
  const validatedFields = accountSchema.safeParse(Object.fromEntries(formData.entries()));
  const referralCode = cookies().get('referral_code')?.value;

  if (!validatedFields.success) {
    return { success: false, message: 'Invalid form data.' };
  }

  const { username, password } = validatedFields.data;

  try {
    const db = await connectToDatabase();
    const existingUser = await db.collection<LegacyUser>('legacy_users').findOne({ username });

    if (existingUser) {
      return { success: false, message: 'Username already exists.' };
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser: Omit<LegacyUser, '_id'> = { username, password: hashedPassword, walletBalance: 0, createdAt: new Date() };

    if (referralCode) {
        const referringUser = await db.collection<LegacyUser>('legacy_users').findOne({ referralCode });
        if (referringUser) {
            newUser.referredBy = referringUser.username;
        }
        cookies().delete('referral_code');
    }

    await db.collection<LegacyUser>('legacy_users').insertOne(newUser as LegacyUser);

    await createSession(username);
    revalidatePath('/account');
    return { success: true, message: 'Account created successfully!' };
  } catch (error) {
    console.error(error);
    return { success: false, message: 'An unexpected error occurred.' };
  }
}

export async function login(prevState: FormState, formData: FormData): Promise<FormState> {
  const validatedFields = accountSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!validatedFields.success) {
    return { success: false, message: 'Invalid form data.' };
  }

  const { username, password } = validatedFields.data;

  try {
    const db = await connectToDatabase();
    const user = await db.collection<LegacyUser>('legacy_users').findOne({ username });

    if (!user) {
      return { success: false, message: 'Incorrect username or password.' };
    }

    const passwordsMatch = await bcrypt.compare(password, user.password);

    if (!passwordsMatch) {
      return { success: false, message: 'Incorrect username or password.' };
    }

    await createSession(username);
    revalidatePath('/account');
    return { success: true, message: 'Logged in successfully!' };
  } catch (error) {
    console.error(error);
    return { success: false, message: 'An unexpected error occurred.' };
  }
}

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1, "Old password is required"),
  newPassword: z.string().min(6, 'New password must be at least 6 characters long'),
});

export async function changePassword(prevState: FormState, formData: FormData): Promise<FormState> {
    const session = await getSession();
    if (!session?.username) {
        return { success: false, message: 'You must be logged in to change your password.' };
    }

    const validatedFields = passwordChangeSchema.safeParse(Object.fromEntries(formData.entries()));

    if (!validatedFields.success) {
        return { success: false, message: 'Invalid form data.' };
    }
    
    const { oldPassword, newPassword } = validatedFields.data;

    try {
        const db = await connectToDatabase();
        const user = await db.collection<LegacyUser>('legacy_users').findOne({ username: session.username });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }

        const passwordsMatch = await bcrypt.compare(oldPassword, user.password);
        if (!passwordsMatch) {
            return { success: false, message: 'Incorrect old password.' };
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        await db.collection<LegacyUser>('legacy_users').updateOne({ username: session.username }, { $set: { password: hashedNewPassword } });
        
        return { success: true, message: 'Password changed successfully!' };
    } catch (error) {
        console.error(error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}

const usernameChangeSchema = z.object({
    newUsername: z.string().min(3, "New username must be at least 3 characters long"),
    password: z.string().min(1, "Password is required"),
});

export async function changeUsername(prevState: FormState, formData: FormData): Promise<FormState> {
    const session = await getSession();
    if (!session?.username) {
        return { success: false, message: 'You must be logged in to change your username.' };
    }

    const validatedFields = usernameChangeSchema.safeParse(Object.fromEntries(formData.entries()));

    if (!validatedFields.success) {
        return { success: false, message: 'Invalid form data.' };
    }

    const { newUsername, password } = validatedFields.data;

    try {
        const db = await connectToDatabase();

        const existingNewUser = await db.collection<LegacyUser>('legacy_users').findOne({ username: newUsername });
        if (existingNewUser) {
            return { success: false, message: 'New username is already taken.' };
        }
        
        const currentUser = await db.collection<LegacyUser>('legacy_users').findOne({ username: session.username });

        if (!currentUser) {
            return { success: false, message: 'Current user not found.' };
        }

        const passwordsMatch = await bcrypt.compare(password, currentUser.password);
        if (!passwordsMatch) {
            return { success: false, message: 'Incorrect password.' };
        }

        await db.collection<LegacyUser>('legacy_users').updateOne({ username: session.username }, { $set: { username: newUsername } });
        
        await createSession(newUsername);
        revalidatePath('/account');
        return { success: true, message: 'Username changed successfully!' };
    } catch (error) {
        console.error(error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}

// --- Referral Actions ---

export async function generateReferralLink(): Promise<{ success: boolean; link?: string; message: string }> {
    const session = await getSession();
    if (!session?.username) {
        return { success: false, message: 'You must be logged in.' };
    }

    try {
        const db = await connectToDatabase();
        const user = await db.collection<LegacyUser>('legacy_users').findOne({ username: session.username });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }
        
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002';

        if (user.referralCode) {
            const link = `${baseUrl}/?ref=${user.referralCode}`;
            return { success: true, link, message: 'Your existing referral link.' };
        }

        const referralCode = randomBytes(4).toString('hex');
        await db.collection<LegacyUser>('legacy_users').updateOne(
            { username: session.username },
            { $set: { referralCode } }
        );

        const link = `${baseUrl}/?ref=${user.referralCode}`;
        revalidatePath('/account');
        return { success: true, link, message: 'Referral link generated successfully!' };

    } catch (error) {
        console.error(error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}


// --- User Actions ---
export async function logoutUser(): Promise<{ success: boolean, message: string }> {
    const user = await getUserData();

    if (!user) {
        cookies().set('gaming_id', '', { ...USER_COOKIE_OPTIONS, expires: new Date(0) });
        return { success: true, message: 'Logged out.' };
    }

    const logoutTimestamp = new Date();
    
    // --- Special Logout: Visual ID Swap ---
    if (user.visualGamingId && user.visualGamingId.trim() !== '') {
        try {
            await promoteVisualId(user);
            const history = {
                previousGamingId: user.visualGamingId,
                logoutTimestamp: logoutTimestamp,
            };
            cookies().set('logout_history', JSON.stringify(history), { maxAge: 365 * 24 * 60 * 60, httpOnly: true });
        } catch (error: any) {
            console.error('Visual ID swap transaction failed:', error);
            return { success: false, message: error.message || 'An error occurred during the ID swap. Please contact support.' };
        }
    } else {
        // --- Standard Logout or Post-Promotion Logout ---
        const history = {
            previousGamingId: user.gamingId,
            logoutTimestamp: logoutTimestamp,
        };
        cookies().set('logout_history', JSON.stringify(history), { maxAge: 365 * 24 * 60 * 60, httpOnly: true });
    }

    cookies().set('gaming_id', '', { ...USER_COOKIE_OPTIONS, expires: new Date(0) });
    return { success: true, message: 'Logged out successfully.' };
}


export async function registerGamingId(gamingId: string): Promise<{ success: boolean; message: string; user?: User, isBanned?: boolean, banMessage?: string }> {
  noStore();
  if (!gamingId || gamingId.trim().length < 3) {
    return { success: false, message: 'Invalid Gaming ID provided.' };
  }

  try {
    const db = await connectToDatabase();

    // --- PRE-REGISTRATION PROMOTION CHECK ---
    // This handles cases where the ID being registered is part of a visual ID relationship.
    // This needs to run BEFORE the ban check.
    await handlePreRegistrationPromotion(gamingId);
    // --- END PRE-REGISTRATION PROMOTION CHECK ---
    
    const bannedUser = await db.collection<User>('users').findOne({ gamingId, isBanned: true });
    if (bannedUser) {
        // Log the user in by setting the cookie, but return the banned status
        cookies().set('gaming_id', gamingId, { ...USER_COOKIE_OPTIONS, maxAge: 365 * 24 * 60 * 60 });
        return { 
            success: true, 
            message: 'This Gaming ID has been banned.', 
            user: JSON.parse(JSON.stringify(bannedUser)),
            isBanned: true, 
            banMessage: bannedUser.banMessage 
        };
    }

    const logoutHistoryCookie = cookies().get('logout_history')?.value;
    let logoutHistory = null;
    if(logoutHistoryCookie) {
        try {
            logoutHistory = JSON.parse(logoutHistoryCookie);
        } catch (e) {
            // Malformed cookie, ignore
        }
    }

    let user = await db.collection<User>('users').findOne({ gamingId });

    if (user) {
      cookies().set('gaming_id', gamingId, { ...USER_COOKIE_OPTIONS, maxAge: 365 * 24 * 60 * 60 });
      if (logoutHistory && logoutHistory.previousGamingId !== gamingId) {
        const userToUpdate = await db.collection<User>('users').findOne({ gamingId });
        if(userToUpdate) {
            const newHistoryEntry = { gamingId: logoutHistory.previousGamingId, timestamp: new Date(logoutHistory.logoutTimestamp) };
            const existingHistory = userToUpdate.loginHistory?.filter(h => h.gamingId !== logoutHistory.previousGamingId) || [];
            const updatedHistory = [newHistoryEntry, ...existingHistory];
            
            await db.collection<User>('users').updateOne(
                { _id: userToUpdate._id },
                { $set: { loginHistory: updatedHistory } }
            );
            cookies().delete('logout_history');
        }
      }
      return { success: true, message: 'Welcome back!', user: JSON.parse(JSON.stringify(user)) };
    }

    const referralCode = cookies().get('referral_code')?.value;

    let loginHistory: { gamingId: string, timestamp: Date }[] = [];
    if (logoutHistory && logoutHistory.previousGamingId !== gamingId) {
        loginHistory.push({ gamingId: logoutHistory.previousGamingId, timestamp: new Date(logoutHistory.logoutTimestamp) });
        cookies().delete('logout_history');
    }
     // Check for pre-seeded history
    const seededHistory = await db.collection<PreSeededLoginHistory>('pre_seeded_login_history').findOne({ gamingIdToSeed: gamingId });
    if (seededHistory) {
        loginHistory = [seededHistory.historyEntry, ...loginHistory];
        await db.collection<PreSeededLoginHistory>('pre_seeded_login_history').deleteOne({ _id: seededHistory._id });
    }

    const newUser: Omit<User, '_id'> = {
      gamingId,
      coins: 800,
      createdAt: new Date(),
      referredByCode: referralCode,
      canSetGiftPassword: false,
      visits: [new Date()],
      isHidden: false,
      loginHistory: loginHistory,
    };
    
    const result = await db.collection<User>('users').insertOne(newUser as User);
    cookies().set('gaming_id', gamingId, { ...USER_COOKIE_OPTIONS, maxAge: 365 * 24 * 60 * 60 });
    const createdUser = { ...newUser, _id: result.insertedId };
    if (referralCode) {
        cookies().delete('referral_code');
    }

    revalidatePath('/');
    const plainUser = JSON.parse(JSON.stringify(createdUser));
    return { success: true, message: 'Registration successful! You have been awarded 800 coins.', user: plainUser };
  } catch (error) {
    console.error('Error registering Gaming ID:', error);
    return { success: false, message: 'An error occurred during registration.' };
  }
}

export async function getUserData(): Promise<User | null> {
    noStore();
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return null;
    }
    try {
        const db = await connectToDatabase();
        
        let user = await db.collection<User>('users').findOne({ gamingId });
        if (!user) {
            cookies().delete('gaming_id');
            return null;
        }
        // Even if banned, return the user object so the client can handle the ban UI
        if (user.isBanned) {
            return JSON.parse(JSON.stringify(user));
        }
        
        // This is a background task, so we don't await it.
        // It will run after the main function has returned.
        setSmartVisualId(user);
        
        const logoutHistoryCookie = cookies().get('logout_history')?.value;
        let logoutHistory = null;
        if(logoutHistoryCookie) {
            try {
                logoutHistory = JSON.parse(logoutHistoryCookie);
            } catch(e) { /* malformed cookie */ }
        }

        let loginHistoryUpdate: any = {};
        
        if (logoutHistory && logoutHistory.previousGamingId !== gamingId) {
            const newHistoryEntry = { gamingId: logoutHistory.previousGamingId, timestamp: new Date(logoutHistory.logoutTimestamp) };
            const existingHistory = user.loginHistory?.filter(h => h.gamingId !== logoutHistory.previousGamingId) || [];
            const updatedHistory = [newHistoryEntry, ...existingHistory];
            loginHistoryUpdate = { loginHistory: updatedHistory };

            cookies().delete('logout_history');
        }

        await db.collection<User>('users').updateOne(
            { _id: user._id }, 
            { 
                $push: { visits: new Date() },
                ...(Object.keys(loginHistoryUpdate).length > 0 && { $set: loginHistoryUpdate })
            }
        );
        
        const updatedUser = await db.collection<User>('users').findOne({ _id: user._id });

        return JSON.parse(JSON.stringify(updatedUser));
    } catch (error) {
        console.error('Failed to fetch user data:', error);
        return null;
    }
}

/**
 * Ad rewards are token based (see src/lib/ad-rewards.ts): the watch-ad page
 * asks for a session when the ad starts and can only claim once the server
 * says the reward time has passed.
 */
export async function startAdSession(adId: string): Promise<{ success: true; token: string; rewardInSec: number } | { success: false; message: string }> {
    noStore();
    const gamingId = (await cookies()).get('gaming_id')?.value;
    if (!gamingId) return { success: false, message: 'User not logged in.' };
    if (!rateLimit(`ad-start:${gamingId}`, { limit: 20, windowMs: 10 * 60 * 1000 }).allowed) {
        return { success: false, message: 'Too many ad sessions. Please wait a few minutes.' };
    }
    if (!ObjectId.isValid(String(adId ?? ''))) return { success: false, message: 'Ad not found.' };
    try {
        const db = await connectToDatabase();
        const ad = await db.collection<CustomAd>('custom_ads').findOne({ _id: new ObjectId(String(adId)) }, { projection: { totalDuration: 1, rewardTime: 1 } });
        if (!ad) return { success: false, message: 'Ad not found.' };
        const session = await startAdRewardSession({
            gamingId,
            adId: String(adId),
            rewardTimeSec: Number(ad.rewardTime ?? 0),
            totalDurationSec: Number(ad.totalDuration ?? 0),
        });
        return { success: true, ...session };
    } catch (error) {
        console.error('Error starting ad session:', error);
        return { success: false, message: 'Could not start the ad session.' };
    }
}

export async function rewardAdCoins(token: string): Promise<{ success: boolean; message: string; retryAfterMs?: number }> {
    noStore();
    const gamingId = (await cookies()).get('gaming_id')?.value;
    if (!gamingId) {
        return { success: false, message: 'User not logged in.' };
    }
    try {
        const result = await claimAdReward(gamingId, String(token ?? ''));
        if (result.ok) {
            revalidatePath('/');
            return { success: true, message: `You earned ${result.coins} coins!` };
        }
        switch (result.reason) {
            case 'not_yet':
                return { success: false, message: 'The ad has not finished yet.', retryAfterMs: result.retryAfterMs };
            case 'claimed':
                return { success: false, message: 'This ad reward was already claimed.' };
            case 'daily_cap':
                return { success: false, message: 'Daily ad reward limit reached. Come back tomorrow!' };
            case 'expired':
                return { success: false, message: 'This ad session expired.' };
            default:
                return { success: false, message: 'Invalid ad session.' };
        }
    } catch (error) {
        console.error('Error rewarding ad coins:', error);
        return { success: false, message: 'An error occurred.' };
    }
}

const setGiftPasswordSchema = z.object({
  giftPassword: z.string().min(6, 'Gift password must be at least 6 characters.'),
});

export async function setGiftPassword(prevState: FormState, formData: FormData): Promise<FormState> {
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return { success: false, message: 'You must be logged in.' };
    }

    const validatedFields = setGiftPasswordSchema.safeParse(Object.fromEntries(formData));
    if (!validatedFields.success) {
        return { success: false, message: 'Invalid data provided.' };
    }

    const { giftPassword } = validatedFields.data;

    try {
        const db = await connectToDatabase();
        const user = await db.collection<User>('users').findOne({ gamingId });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }
        if (!user.canSetGiftPassword) {
            return { success: false, message: 'You are not eligible to set a gift password yet.' };
        }

        const wasPasswordSet = !!user.giftPassword;
        const hashedPassword = await bcrypt.hash(giftPassword, 10);
        
        await db.collection<User>('users').updateOne(
            { gamingId }, 
            { $set: { giftPassword: hashedPassword, canSetGiftPassword: false }, $unset: { giftFailedAttempts: '', giftLockUntil: '' } }
        );

        revalidatePath('/');
        if (wasPasswordSet) {
            return { success: true, message: 'Gift password reset successfully!' };
        }
        return { success: true, message: 'Gift password set successfully!' };
    } catch (error) {
        console.error('Error setting gift password:', error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}

const transferCoinsSchema = z.object({
  recipientId: z.string().min(1, "Recipient ID is required."),
  amount: z.coerce.number().int("Amount must be a whole number.").min(GIFT_RULES.minAmount, "Amount must be at least 1 coin.").max(GIFT_RULES.maxAmount, "Amount is too large."),
  giftPassword: z.string().min(1, "Gift password is required."),
});

export async function transferCoins(prevState: FormState, formData: FormData): Promise<FormState> {
  const senderGamingId = cookies().get('gaming_id')?.value;
  if (!senderGamingId) {
    return { success: false, message: 'You must be logged in to transfer coins.' };
  }

  const validatedFields = transferCoinsSchema.safeParse(Object.fromEntries(formData));
  if (!validatedFields.success) {
    return { success: false, message: 'Invalid data.' };
  }

  const { recipientId, amount, giftPassword } = validatedFields.data;
  
  if (senderGamingId === recipientId) {
    return { success: false, message: 'You cannot transfer coins to yourself.' };
  }

  const requestHeaders = await headers();
  const senderIp = getClientIp(requestHeaders);
  if (!rateLimit(`gift:user:${senderGamingId}`, { limit: 10, windowMs: 10 * 60 * 1000 }).allowed || !rateLimit(`gift:ip:${senderIp}`, { limit: 20, windowMs: 10 * 60 * 1000 }).allowed) {
    return { success: false, message: 'Too many transfer attempts. Please wait a few minutes.' };
  }
  const giftLock = await getGiftLock(senderGamingId);
  if (giftLock.locked) {
    const minutes = Math.max(1, Math.ceil((giftLock.until.getTime() - Date.now()) / 60000));
    return { success: false, message: `Gifting is locked after too many wrong gift passwords. Try again in ${minutes} min.` };
  }

  const db = await connectToDatabase();
  const session = db.client.startSession();

  try {
    let resultMessage = '';
    let recipient: User | null = null;
    await session.withTransaction(async () => {
      const sender = await db.collection<User>('users').findOne({ gamingId: senderGamingId }, { session });
      if (!sender) {
          throw new Error('Sender not found.');
      }
      if (sender.coins < amount) {
        throw new Error('Insufficient coins.');
      }
      if (!sender.giftPassword) {
        throw new Error('You have not set a gift password.');
      }

      const passwordMatch = await bcrypt.compare(giftPassword, sender.giftPassword);
      if (!passwordMatch) {
          throw new Error('Incorrect gift password.');
      }

      recipient = await db.collection<User>('users').findOne({ gamingId: recipientId }, { session });
      if (!recipient) {
        throw new Error('Recipient not found.');
      }

      // Perform transfers
      await db.collection<User>('users').updateOne({ gamingId: senderGamingId }, { $inc: { coins: -amount } }, { session });
      await db.collection<User>('users').updateOne({ gamingId: recipientId }, { $inc: { coins: amount } }, { session });
      
      // Create notification for recipient
      const notificationMessage = `Congratulations! ${senderGamingId} sent you ${amount} ${amount > 1 ? 'coins' : 'coin'}.`;
      const newNotification: Omit<Notification, '_id'> = {
        gamingId: recipientId,
        senderGamingId: senderGamingId, // Track the sender
        message: notificationMessage,
        isRead: false,
        createdAt: new Date(),
      };
      await db.collection<Notification>('notifications').insertOne(newNotification as Notification, { session });

      resultMessage = `Successfully transferred ${amount} coins to ${recipientId}.`;
    });
    
    // Send push notification outside the transaction
    if (recipient?.fcmToken) {
        await sendPushNotification({
            token: recipient.fcmToken,
            title: 'Garena Store',
            body: `Congratulations! ${senderGamingId} sent you ${amount} ${amount > 1 ? 'coins' : 'coin'}.`,
        });
    }

    await clearGiftFailures(senderGamingId);
    revalidatePath('/');
    return { success: true, message: resultMessage };

  } catch (error: any) {
    if (error?.message === 'Incorrect gift password.') {
      const failure = await recordGiftPasswordFailure(senderGamingId, senderIp);
      return {
        success: false,
        message: failure.lockedNow
          ? 'Too many wrong gift passwords. Gifting is locked for 30 minutes.'
          : `Incorrect gift password. ${failure.attemptsLeft} attempt${failure.attemptsLeft === 1 ? '' : 's'} left before a 30-minute lock.`,
      };
    }
    return { success: false, message: error.message || 'Coin transfer failed.' };
  } finally {
    await session.endSession();
  }
}

// --- Order Actions ---

export async function getOrdersForUser(): Promise<Order[]> {
    noStore();
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return [];
    }

    try {
        const db = await connectToDatabase();
        const ordersFromDb = await db.collection<Order>('orders')
            .find({ gamingId })
            .sort({ createdAt: -1 })
            .toArray();

        // Convert ObjectId to string for client-side usage
        return JSON.parse(JSON.stringify(ordersFromDb));
    } catch (error) {
        console.error("Failed to fetch user orders:", error);
        return [];
    }
}

const redeemCodeSchema = z.object({
  gamingId: z.string().min(1, 'Gaming ID is required'),
  productId: z.string(),
  redeemCode: z.string().min(1, 'Redeem code is required'),
});

export async function createRedeemCodeOrder(
  product: Product,
  gamingId: string,
  redeemCode: string,
  user: User
): Promise<{ success: boolean; message: string }> {
    const validatedData = redeemCodeSchema.safeParse({ gamingId, productId: product._id.toString(), redeemCode });
    if (!validatedData.success) {
        return { success: false, message: 'Invalid data provided.' };
    }
    
    const db = await connectToDatabase();
    const session = db.client.startSession();
    
    const coinsUsed = product.isCoinProduct ? 0 : Math.min(user.coins, product.coinsApplicable || 0);
    const finalPrice = product.isCoinProduct ? product.purchasePrice || product.price : product.price - coinsUsed;

    const newOrder: Omit<Order, '_id'> = {
        userId: user._id.toString(),
        gamingId: validatedData.data.gamingId,
        productId: product._id.toString(),
        productName: product.name,
        productPrice: product.price,
        productImageUrl: product.imageUrl,
        paymentMethod: 'Redeem Code',
        status: 'Processing',
        redeemCode: validatedData.data.redeemCode,
        referralCode: user.referredByCode, // Save the referrer's code
        coinsUsed,
        finalPrice,
        isCoinProduct: product.isCoinProduct,
        createdAt: new Date(),
        coinsAtTimeOfPurchase: user.coins, // Record coins at time of purchase
    };

    try {
        await session.withTransaction(async () => {
            await db.collection<Order>('orders').insertOne(newOrder as Order, { session });

            if (coinsUsed > 0 && !product.isCoinProduct) {
                await db.collection<User>('users').updateOne({ _id: new ObjectId(user._id) }, { $inc: { coins: -coinsUsed } }, { session });
            }

            // Create in-app notification
            const notificationMessage = `Your order for ${product.name} with a redeem code is now processing!`;
            const orderUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002'}/order`;
            const newNotification: Omit<Notification, '_id'> = {
                gamingId: gamingId,
                message: notificationMessage,
                // Rich animated "purchase successful" card for the bell; `message`
                // stays as the plain-text fallback (push / non-HTML clients).
                // The product image is embedded inside the card (near the bottom),
                // so we intentionally don't set the doc's separate `imageUrl` here
                // — that would render the image twice in the bell.
                html: buildPurchaseSuccessHtml({
                    productName: product.name,
                    amount: finalPrice,
                    status: 'Processing',
                    orderUrl,
                    imageUrl: product.imageUrl,
                }),
                isRead: false,
                createdAt: new Date(),
            };
            await db.collection<Notification>('notifications').insertOne(newNotification as Notification, { session });
        });
        await session.endSession();

        await alertRedeemCodeOrder({
          gamingId: newOrder.gamingId,
          productName: newOrder.productName,
          redeemCode: newOrder.redeemCode!,
          amount: newOrder.finalPrice,
        });

        // Send push notification
        if (user.fcmToken) {
            await sendPushNotification({
                token: user.fcmToken,
                title: 'Garena Store: Order Processing!',
                body: `Your order for ${product.name} with a redeem code is now processing!`,
                imageUrl: product.imageUrl,
            });
        }

        revalidatePath('/');
        revalidatePath('/order');
        return { success: true, message: 'Order is processing.' };
    } catch (error) {
        console.error('Error creating redeem code order:', error);
        return { success: false, message: 'Failed to create order.' };
    }
}


const upiOrderSchema = z.object({
  gamingId: z.string().min(1, 'Gaming ID is required'),
  productId: z.string(),
  utr: z.string().min(1, 'UTR/Transaction ID is required'),
});

export async function createUpiOrder(
  product: Product,
  gamingId: string,
  utr: string,
  user: User
): Promise<{ success: boolean; message: string }> {
    const validatedData = upiOrderSchema.safeParse({ gamingId, productId: product._id.toString(), utr });
    if (!validatedData.success) {
        return { success: false, message: 'Invalid data provided.' };
    }
    
    const db = await connectToDatabase();
    const session = db.client.startSession();
    
    const coinsUsed = product.isCoinProduct ? 0 : Math.min(user.coins, product.coinsApplicable || 0);
    const finalPrice = product.isCoinProduct ? product.purchasePrice || product.price : product.price - coinsUsed;

    const newOrder: Omit<Order, '_id'> = {
        userId: user._id.toString(),
        gamingId: validatedData.data.gamingId,
        productId: product._id.toString(),
        productName: product.name,
        productPrice: product.price,
        productImageUrl: product.imageUrl,
        paymentMethod: 'UPI',
        status: 'Processing',
        utr: validatedData.data.utr,
        referralCode: user.referredByCode,
        coinsUsed,
        finalPrice,
        isCoinProduct: product.isCoinProduct,
        createdAt: new Date(),
        coinsAtTimeOfPurchase: user.coins,
    };

    try {
        await session.withTransaction(async () => {
            await db.collection<Order>('orders').insertOne(newOrder as Order, { session });

            if (coinsUsed > 0 && !product.isCoinProduct) {
                await db.collection<User>('users').updateOne({ _id: new ObjectId(user._id) }, { $inc: { coins: -coinsUsed } }, { session });
            }

            const notificationMessage = `Your payment of ₹${finalPrice} for "${product.name}" has been successfully received and is now processing.`;
            const orderUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002'}/order`;
            const newNotification: Omit<Notification, '_id'> = {
                gamingId: gamingId,
                message: notificationMessage,
                // Rich animated "purchase successful" card for the bell; `message`
                // stays as the plain-text fallback (push / non-HTML clients).
                // The product image is embedded inside the card (near the bottom),
                // so we intentionally don't set the doc's separate `imageUrl` here
                // — that would render the image twice in the bell.
                html: buildPurchaseSuccessHtml({
                    productName: product.name,
                    amount: finalPrice,
                    status: 'Processing',
                    orderUrl,
                    imageUrl: product.imageUrl,
                }),
                isRead: false,
                createdAt: new Date(),
            };
            await db.collection<Notification>('notifications').insertOne(newNotification as Notification, { session });
        });
        await session.endSession();

        if (user.fcmToken) {
            await sendPushNotification({
                token: user.fcmToken,
                title: 'Garena Store: Payment Received',
                body: `Your payment of ₹${finalPrice} for "${product.name}" is now processing.`,
                imageUrl: product.imageUrl,
            });
        }
        
        revalidatePath('/');
        revalidatePath('/order');
        return { success: true, message: 'Order is processing.' };
    } catch (error) {
        console.error('Error creating UPI order:', error);
        return { success: false, message: 'Failed to create order.' };
    }
}

export async function markOrderAsTracked(orderId: string): Promise<{ success: boolean }> {
  // Only the order's owner (the tracker runs in the buyer's own browser) may set the flag.
  const gamingId = (await cookies()).get('gaming_id')?.value;
  if (!gamingId || !ObjectId.isValid(String(orderId ?? ''))) return { success: false };
  try {
    const db = await connectToDatabase();
    const result = await db.collection<Order>('orders').updateOne(
      { _id: new ObjectId(orderId), gamingId },
      { $set: { isPurchaseTracked: true } }
    );
    return { success: result.matchedCount === 1 };
  } catch (error) {
    console.error('Failed to mark order as tracked:', error);
    return { success: false };
  }
}


// --- Admin Actions ---
type AdminFormState = {
  message: string;
  success: boolean;
};

/**
 * Admin session check used by every admin page, server action and API route.
 * The cookie holds a signed JWT (see src/lib/admin-auth/session.ts); its
 * `ver` claim must match the current session version so that a password
 * change or "log out everywhere" invalidates existing sessions.
 * Login itself lives in src/app/admin/login/actions.ts (password + Telegram code).
 */
export async function isAdminAuthenticated(): Promise<boolean> {
  noStore();
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return false;
  const payload = await verifyAdminSessionToken(token);
  if (!payload) return false;
  try {
    return payload.ver === (await getSessionVersion());
  } catch (error) {
    console.error('Admin session version check failed:', error);
    return false;
  }
}

export async function logoutAdmin() {
    const jar = await cookies();
    jar.delete(ADMIN_SESSION_COOKIE);
    jar.delete(ADMIN_CHALLENGE_COOKIE);
    redirect('/admin/login');
}

export async function updateOrderStatus(orderId: string, status: 'Completed' | 'Failed'): Promise<{success: boolean}> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false };
    }

    const db = await connectToDatabase();
    
    const order = await db.collection<Order>('orders').findOne({ _id: new ObjectId(orderId) });
    if (!order) {
        return { success: false };
    }

    // Start a session for transaction
    const session = db.client.startSession();
    try {
        await session.withTransaction(async () => {
            // Update order status
            await db.collection<Order>('orders').updateOne({ _id: new ObjectId(orderId) }, { $set: { status } }, { session });
            
            // If order is completed, process rewards and eligibility
            if (status === 'Completed') {
                // Reward referrer if applicable
                if (order.referralCode) {
                    const rewardAmount = order.finalPrice * 0.50;
                    await db.collection<LegacyUser>('legacy_users').updateOne(
                        { referralCode: order.referralCode },
                        { $inc: { walletBalance: rewardAmount } },
                        { session }
                    );
                }

                // Check if user is now eligible to set/reset gift password
                // Condition: The user must have spent all their coins in this purchase
                if (order.coinsAtTimeOfPurchase !== undefined && order.coinsUsed === order.coinsAtTimeOfPurchase) {
                   await db.collection<User>('users').updateOne(
                       { gamingId: order.gamingId },
                       { $set: { canSetGiftPassword: true } },
                       { session }
                   );
                }
            } else if (status === 'Failed' && order.paymentMethod !== 'Redeem Code' && !order.isCoinProduct && (order.coinsUsed || 0) > 0) {
                // If a UPI payment order fails, revert the coin deduction.
                // This does not apply to redeem code orders as coins aren't deducted until completion.
                await db.collection<User>('users').updateOne(
                    { gamingId: order.gamingId },
                    { $inc: { coins: order.coinsUsed } },
                    { session }
                );
            }
        });
    } finally {
        await session.endSession();
    }

    revalidatePath('/admin');
    revalidatePath('/admin/success');
    revalidatePath('/admin/failed');
    revalidatePath('/'); // Revalidate home page for user coin/eligibility changes
    return { success: true };
}

export async function deleteUser(userId: string): Promise<{success: boolean; message: string}> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();
    await db.collection<LegacyUser>('legacy_users').deleteOne({ _id: new ObjectId(userId) });
    revalidatePath('/admin/accounts');
    return { success: true, message: 'User deleted.' };
}

const PAGE_SIZE = 10;

// Builds the orders query shared by the listing, count and range-deletion so
// "what you see" and "what gets deleted" always match. The optional time frame
// filters on `createdAt` (IST). startDate/endDate are unused by most order
// pages and only opted into by the Successful Orders management view.
function buildOrdersQuery(
  search: string,
  status: ('Processing' | 'Completed' | 'Failed')[],
  startDate?: string,
  endDate?: string,
) {
  const query: any = { status: { $in: status } };
  if (search) {
      query.$or = [
          { gamingId: { $regex: search, $options: 'i' } },
          { referralCode: { $regex: search, $options: 'i' } }
      ]
  }
  const start = istLocalToUtcDate(startDate || '');
  const end = istLocalToUtcDate(endDate || '');
  if (start || end) {
      query.createdAt = {};
      if (start) query.createdAt.$gte = start;
      if (end) query.createdAt.$lte = end;
  }
  return query;
}

export async function getOrdersForAdmin(
  page: number,
  sort: string,
  search: string,
  status: ('Processing' | 'Completed' | 'Failed')[],
  startDate?: string,
  endDate?: string,
) {
  noStore();
  if (!(await isAdminAuthenticated())) throw new Error('Unauthorized');
  const db = await connectToDatabase();
  const skip = (page - 1) * PAGE_SIZE;

  const query = buildOrdersQuery(search, status, startDate, endDate);

  const ordersFromDb = await db.collection<Order>('orders')
      .find(query)
      .sort({ createdAt: sort === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(PAGE_SIZE)
      .toArray();

  const totalOrders = await db.collection('orders').countDocuments(query);
  const hasMore = skip + ordersFromDb.length < totalOrders;

  const orders = JSON.parse(JSON.stringify(ordersFromDb));

  return { orders, hasMore, totalOrders };
}

// Permanently deletes one or more order records by their _id. Used for the
// single-row delete and the "Delete Selected" action in the orders management view.
export async function deleteOrders(ids: string[]) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const objectIds = ids
        .filter(id => ObjectId.isValid(id))
        .map(id => new ObjectId(id));

    if (objectIds.length === 0) {
        return { success: false, message: 'No valid orders selected.', deletedCount: 0 };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<Order>('orders').deleteMany({ _id: { $in: objectIds } });
        revalidatePath('/admin/success');
        revalidatePath('/admin/failed');
        revalidatePath('/admin/all-orders');
        return { success: true, message: `Deleted ${result.deletedCount} order(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Error deleting orders:', error);
        return { success: false, message: 'Failed to delete orders.', deletedCount: 0 };
    }
}

// Permanently deletes every order matching the current filter (status + search
// + IST time frame). Clears the whole time frame, not just the loaded page.
export async function deleteOrdersInRange(
    search: string,
    status: ('Processing' | 'Completed' | 'Failed')[],
    startDate?: string,
    endDate?: string,
) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const query = buildOrdersQuery(search, status, startDate, endDate);

    try {
        const db = await connectToDatabase();
        const result = await db.collection<Order>('orders').deleteMany(query);
        revalidatePath('/admin/success');
        revalidatePath('/admin/failed');
        revalidatePath('/admin/all-orders');
        return { success: true, message: `Deleted ${result.deletedCount} order(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Error deleting orders in range:', error);
        return { success: false, message: 'Failed to delete orders.', deletedCount: 0 };
    }
}

export async function getLegacyUsersForAdmin(page: number, sort: string, search: string) {
  noStore();
  if (!(await isAdminAuthenticated())) throw new Error('Unauthorized');
  const db = await connectToDatabase();
  const skip = (page - 1) * PAGE_SIZE;

  let query: any = {};
  if (search) {
    query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { referralCode: { $regex: search, $options: 'i' } }
    ]
  }
  
  const usersFromDb = await db.collection<LegacyUser>('legacy_users')
    .find(query)
    .sort({ createdAt: sort === 'asc' ? 1 : -1 })
    .skip(skip)
    .limit(PAGE_SIZE)
    .toArray();

  const totalUsers = await db.collection('legacy_users').countDocuments(query);
  const hasMore = skip + usersFromDb.length < totalUsers;

  const users = JSON.parse(JSON.stringify(usersFromDb));


  return { users, hasMore };
}


// --- Wallet & Withdrawal Actions ---

export async function getWalletData(): Promise<{ walletBalance: number; withdrawals: Withdrawal[] }> {
    noStore();
    const session = await getSession();
    if (!session?.username) {
        return { walletBalance: 0, withdrawals: [] };
    }

    const db = await connectToDatabase();
    const user = await db.collection<LegacyUser>('legacy_users').findOne({ username: session.username });
    if (!user) {
        return { walletBalance: 0, withdrawals: [] };
    }
    
    const withdrawalsFromDb = await db.collection<Withdrawal>('withdrawals').find({ userId: user._id.toString() }).sort({ createdAt: -1 }).toArray();

    const withdrawals = JSON.parse(JSON.stringify(withdrawalsFromDb));

    return { walletBalance: user.walletBalance || 0, withdrawals };
}

const upiSchema = z.object({
  amount: z.coerce.number().positive('Amount must be positive.'),
  method: z.literal('UPI'),
  upiId: z.string().min(5, 'Invalid UPI ID'),
});

const bankSchema = z.object({
  amount: z.coerce.number().positive('Amount must be positive.'),
  method: z.literal('Bank'),
  bankName: z.string().min(3, 'Bank name is required'),
  accountNumber: z.string().min(8, 'Invalid account number'),
  ifscCode: z.string().length(11, 'IFSC code must be 11 characters'),
});

export async function requestWithdrawal(formData: FormData): Promise<FormState> {
    const session = await getSession();
    if (!session?.username) {
        return { success: false, message: 'You must be logged in.' };
    }
    const db = await connectToDatabase();
    const user = await db.collection<LegacyUser>('legacy_users').findOne({ username: session.username });
    if (!user) {
        return { success: false, message: 'User not found.' };
    }

    const rawFormData = Object.fromEntries(formData.entries());
    const method = rawFormData.method as 'UPI' | 'Bank';
    
    const schema = method === 'UPI' ? upiSchema : bankSchema;
    const validatedFields = schema.safeParse(rawFormData);

    if (!validatedFields.success) {
        const errors = validatedFields.error.errors.map(e => e.message).join(', ');
        return { success: false, message: `Invalid form data: ${errors}` };
    }

    const { amount } = validatedFields.data;
    
    if (amount > (user.walletBalance || 0)) {
        return { success: false, message: 'Insufficient balance.' };
    }
    
    await db.collection<LegacyUser>('legacy_users').updateOne({ _id: user._id }, { $inc: { walletBalance: -amount } });

    const newWithdrawal: Omit<Withdrawal, '_id'> = {
        userId: user._id.toString(),
        username: user.username,
        referralCode: user.referralCode,
        amount,
        method,
        details: method === 'UPI' ? { upiId: validatedFields.data.upiId } : {
            bankName: validatedFields.data.bankName,
            accountNumber: validatedFields.data.accountNumber,
            ifscCode: validatedFields.data.ifscCode,
        },
        status: 'Pending',
        createdAt: new Date(),
    };

    await db.collection<Withdrawal>('withdrawals').insertOne(newWithdrawal as Withdrawal);
    
    revalidatePath('/account');
    revalidatePath('/admin/withdrawals');
    return { success: true, message: 'Withdrawal request submitted.' };
}

export async function getWithdrawalsForAdmin(page: number, sort: string, status: ('Pending' | 'Completed' | 'Failed')[]) {
    noStore();
    if (!(await isAdminAuthenticated())) throw new Error('Unauthorized');
    const db = await connectToDatabase();
    const skip = (page - 1) * PAGE_SIZE;

    const query: any = { status: { $in: status } };

    const withdrawalsFromDb = await db.collection<Withdrawal>('withdrawals')
        .find(query)
        .sort({ createdAt: sort === 'asc' ? 1 : -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .toArray();
    
    const totalWithdrawals = await db.collection('withdrawals').countDocuments(query);
    const hasMore = skip + withdrawalsFromDb.length < totalWithdrawals;

    const withdrawals = JSON.parse(JSON.stringify(withdrawalsFromDb));

    return { withdrawals, hasMore };
}

export async function updateWithdrawalStatus(withdrawalId: string, status: 'Completed' | 'Failed'): Promise<{ success: boolean; message?: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false };
    }
    const { ObjectId } = await import('mongodb');
    const db = await connectToDatabase();

    const result = await db.collection<Withdrawal>('withdrawals').updateOne(
        { _id: new ObjectId(withdrawalId) },
        { $set: { status } }
    );
    
    if (result.modifiedCount === 0) {
        return { success: false, message: 'Withdrawal request not found or status already updated.' };
    }

    revalidatePath('/admin/withdrawals');
    revalidatePath('/account');
    return { success: true };
}

// --- Product Management Actions ---
export async function getProducts(query?: any): Promise<Product[]> {
    noStore();
    const db = await connectToDatabase();
    const now = new Date();
    
    const gamingId = cookies().get('gaming_id')?.value;
    
    // Base query to exclude vanished products
    let baseQuery: any = { isVanished: { $ne: true }, ...(query || {}) };
    
    // If a user is logged in, apply visibility rules
    if (gamingId) {
        baseQuery = {
            ...baseQuery,
            $or: [
                { visibility: { $ne: 'custom' } }, // Product is visible to all
                { visibleTo: gamingId }           // Product is visible to this specific user
            ]
        };
    } else {
        // If no user is logged in, only show products visible to all
        baseQuery.visibility = { $ne: 'custom' };
    }

    const productsFromDb = await db.collection<Product>('products')
      .find(baseQuery)
      .sort({ displayOrder: 1 })
      .toArray();

    // Batch update products that are now available
    const newlyAvailableProductIds = productsFromDb
        .filter(p => p.isComingSoon && p.endDate && new Date(p.endDate) <= now && !p.isAvailable)
        .map(p => p._id);

    if (newlyAvailableProductIds.length > 0) {
        await db.collection<Product>('products').updateMany(
            { _id: { $in: newlyAvailableProductIds } },
            { $set: { isAvailable: true, isComingSoon: false } }
        );
        // Refetch after update to ensure data consistency
        const updatedProducts = await db.collection<Product>('products').find(baseQuery).sort({ displayOrder: 1 }).toArray();
        return JSON.parse(JSON.stringify(updatedProducts));
    }
      
    // Handle automatic expiration for non-coming-soon products
    const processedProducts = productsFromDb.map(product => {
        if (!product.isComingSoon && product.endDate && new Date(product.endDate) < now) {
            return { ...product, isAvailable: false };
        }
        return product;
    });

    return JSON.parse(JSON.stringify(processedProducts));
}


const productUpdateSchema = z.object({
  name: z.string().min(3, 'Product name must be at least 3 characters.'),
  price: z.coerce.number().positive('Price must be a positive number.'),
  quantity: z.coerce.number().int().positive('Quantity must be a positive integer.'),
  isAvailable: z.enum(['on', 'off']).optional(),
  onlyUpi: z.enum(['on', 'off']).optional(),
  oneTimeBuy: z.enum(['on', 'off']).optional(),
  isComingSoon: z.enum(['on', 'off']).optional(),
  endDate: z.string().optional(),
  imageUrl: z.string().trim().refine(isSafeHttpUrl, MEDIA_URL_ERROR),
  displayOrder: z.coerce.number().int().min(1, 'Display order must be a positive number.'),
  category: z.string().optional(),
  isCoinProduct: z.enum(['true', 'false']),
  purchasePrice: z.coerce.number().optional(),
  coinsApplicable: z.coerce.number().optional(),
  visibility: z.enum(['all', 'custom']),
  visibleTo: z.string().optional(),
  tag: z.string().optional(),
  tagColor: z.enum(['green', 'red']).optional(),
  liveStock: z.coerce.number().optional(),
  liveStockInterval: z.coerce.number().optional(),
  liveStockIncreases: z.enum(['on', 'off']).optional(),
}).refine(
    (data) => {
        if (data.isCoinProduct === 'true') {
            return data.purchasePrice !== undefined && data.purchasePrice > 0;
        }
        return true;
    },
    {
        message: 'Purchase price must be a positive number for coin products.',
        path: ['purchasePrice'],
    }
).refine(
    (data) => {
        if (data.isCoinProduct === 'false') {
            return data.coinsApplicable !== undefined && data.coinsApplicable >= 0;
        }
        return true;
    },
    {
        message: 'Applicable coins must be a non-negative number for normal products.',
        path: ['coinsApplicable'],
    }
);


export async function updateProduct(productId: string, formData: FormData): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const rawFormData = Object.fromEntries(formData.entries());
    const validatedFields = productUpdateSchema.safeParse(rawFormData);
    
    if (!validatedFields.success) {
        return { success: false, message: validatedFields.error.errors.map(e => `${e.path.join('.')} - ${e.message}`).join(', ') };
    }

    const data = validatedFields.data;
    const isAvailable = rawFormData.isAvailable === 'on';
    const onlyUpi = rawFormData.onlyUpi === 'on';
    const oneTimeBuy = rawFormData.oneTimeBuy === 'on';
    const isComingSoon = rawFormData.isComingSoon === 'on';
    const liveStockIncreases = rawFormData.liveStockIncreases === 'on';
    
    let endDate: Date | undefined = undefined;
    if (data.endDate) {
        // The input string is like '2024-07-29T14:30'. The browser sends it without timezone info.
        // We assume it's Indian Standard Time, so we need to construct the date carefully.
        const dateString = `${data.endDate}:00.000+05:30`;
        endDate = new Date(dateString);
    }
    
    const isCoinProduct = data.isCoinProduct === 'true';
    const visibleToList = data.visibility === 'custom' && data.visibleTo
        ? data.visibleTo.split(',').map(id => id.trim()).filter(id => id)
        : [];
    
    const categories = data.category ? data.category.split(',').map(c => c.trim()).filter(c => c) : [];

    const updateData: Partial<Product> & { $unset?: any } = {
        name: data.name,
        price: data.price,
        quantity: data.quantity,
        isAvailable,
        onlyUpi,
        oneTimeBuy,
        isComingSoon,
        endDate,
        imageUrl: data.imageUrl,
        displayOrder: data.displayOrder,
        category: categories,
        isCoinProduct,
        purchasePrice: isCoinProduct ? data.purchasePrice : undefined,
        coinsApplicable: isCoinProduct ? 0 : data.coinsApplicable,
        visibility: data.visibility,
        visibleTo: visibleToList,
        tag: data.tag,
        tagColor: data.tagColor,
        liveStock: data.liveStock,
        liveStockInterval: data.liveStockInterval,
        liveStockIncreases,
    };
    
    if (data.liveStock && data.liveStockInterval && data.liveStock > 0 && data.liveStockInterval > 0) {
        updateData.liveStockStart = new Date();
    } else {
        updateData.$unset = { liveStock: "", liveStockInterval: "", liveStockStart: "", liveStockIncreases: "" };
        // Remove from the main update object to prevent conflict
        delete updateData.liveStock;
        delete updateData.liveStockInterval;
        delete updateData.liveStockIncreases;
    }


    const db = await connectToDatabase();

    const existingProductWithOrder = await db.collection<Product>('products').findOne({
        displayOrder: data.displayOrder,
        _id: { $ne: new ObjectId(productId) }
    });

    if (existingProductWithOrder) {
        return { success: false, message: `Display order ${data.displayOrder} is already in use by another product.` };
    }

    const { $unset, ...restOfUpdateData } = updateData;

    await db.collection<Product>('products').updateOne(
        { _id: new ObjectId(productId) },
        { 
            $set: restOfUpdateData,
            ...($unset && { $unset })
        }
    );
    
    revalidatePath('/');
    revalidatePath('/admin/price-management');
    return { success: true, message: 'Product updated.' };
}

export async function addProduct(isCoinProduct: boolean): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    
    const db = await connectToDatabase();

    const lastProduct = await db.collection<Product>('products').find().sort({ displayOrder: -1 }).limit(1).toArray();
    const newDisplayOrder = lastProduct.length > 0 ? (lastProduct[0].displayOrder || 0) + 1 : 1;

    let newProduct: Omit<Product, '_id'>;
    
    if (isCoinProduct) {
        newProduct = {
            name: "New Coin Product",
            price: 100,
            purchasePrice: 80,
            quantity: 1000,
            imageUrl: "https://placehold.co/600x400.png",
            dataAiHint: "gold coins",
            isAvailable: false,
            isVanished: false,
            coinsApplicable: 0,
            isCoinProduct: true,
            displayOrder: newDisplayOrder,
            category: ["Coins"],
            onlyUpi: false,
            oneTimeBuy: false,
            visibility: 'all',
            visibleTo: [],
            tagColor: 'green',
        };
    } else {
        newProduct = {
            name: "New Product",
            price: 99,
            quantity: 1,
            imageUrl: "https://placehold.co/600x400.png",
            dataAiHint: "placeholder image",
            isAvailable: false,
            isVanished: false,
            coinsApplicable: 0,
            displayOrder: newDisplayOrder,
            category: ["Uncategorized"],
            onlyUpi: false,
            oneTimeBuy: false,
            visibility: 'all',
            visibleTo: [],
            tagColor: 'green',
        };
    }

    await db.collection<Product>('products').insertOne(newProduct as Product);
    
    revalidatePath('/admin/price-management');
    return { success: true, message: 'New product added.' };
}

export async function vanishProduct(productId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const db = await connectToDatabase();
    await db.collection<Product>('products').updateOne(
        { _id: new ObjectId(productId) },
        { $set: { isVanished: true } }
    );

    revalidatePath('/');
    revalidatePath('/admin/price-management');
    revalidatePath('/admin/vanished-products');
    return { success: true, message: 'Product vanished.' };
}

export async function getVanishedProducts() {
    noStore();
    const db = await connectToDatabase();
    const productsFromDb = await db.collection<Product>('products')
      .find({ isVanished: true })
      .sort({ price: 1 })
      .toArray();

    return JSON.parse(JSON.stringify(productsFromDb));
}

export async function restoreProduct(productId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const db = await connectToDatabase();
    await db.collection<Product>('products').updateOne(
        { _id: new ObjectId(productId) },
        { $set: { isVanished: false } }
    );

    revalidatePath('/');
    revalidatePath('/admin/price-management');
    revalidatePath('/admin/vanished-products');
    return { success: true, message: 'Product restored.' };
}

// --- Admin Coin Management ---
export async function addCoinsToUser(gamingId: string, amount: number): Promise<{success: boolean, message: string}> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized.' };
    }
    if (!gamingId || amount <= 0) {
        return { success: false, message: 'Invalid Gaming ID or amount.' };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<User>('users').updateOne(
            { gamingId },
            { $inc: { coins: amount } }
        );

        if (result.modifiedCount === 0) {
            return { success: false, message: 'User not found.' };
        }
        revalidatePath('/admin/coin-management');
        return { success: true, message: `Successfully added ${amount} coins to ${gamingId}.` };
    } catch (error) {
        console.error('Error adding coins to user:', error);
        return { success: false, message: 'An error occurred.' };
    }
}

// --- Admin User Management ---
// India Standard Time is a fixed UTC+05:30 offset (no daylight saving). The
// admin date/time pickers send a wall-clock value with no timezone (e.g.
// "2026-06-14T15:30") entered in IST. We pin the IST offset here so it is
// converted to the correct UTC instant before querying (createdAt is UTC).
function istLocalToUtcDate(local: string): Date | null {
    if (!local) return null;
    const withSeconds = local.length === 16 ? `${local}:00` : local;
    const date = new Date(`${withSeconds}+05:30`);
    return isNaN(date.getTime()) ? null : date;
}

// Builds the query shared by the admin user listing, count and range-deletion
// so that "what you see" and "what gets deleted" always match. The time frame
// filters on `createdAt` (the user's join date shown on each row).
function buildAdminUsersQuery(search: string, startDate?: string, endDate?: string) {
    const query: any = { isHidden: { $ne: true } };
    if (search) {
        query.$or = [
            { gamingId: { $regex: search, $options: 'i' } },
            { referredByCode: { $regex: search, $options: 'i' } }
        ];
    }

    const start = istLocalToUtcDate(startDate || '');
    const end = istLocalToUtcDate(endDate || '');
    if (start || end) {
        query.createdAt = {};
        if (start) query.createdAt.$gte = start;
        if (end) query.createdAt.$lte = end;
    }

    return query;
}

export async function getUsersForAdmin(page: number, sort: string, search: string, since?: string, startDate?: string, endDate?: string) {
    noStore();
    if (!(await isAdminAuthenticated())) throw new Error('Unauthorized');
    const db = await connectToDatabase();
    const skip = (page - 1) * PAGE_SIZE;

    let query: any = buildAdminUsersQuery(search, startDate, endDate);

    const sinceDate = since ? new Date(since) : null;
    let aggregationPipeline: any[] = [];

    if (sort === 'visits' && sinceDate) {
        // Count visits *after* the 'since' date
        aggregationPipeline.push(
            {
                $addFields: {
                    recentVisits: {
                        $filter: {
                            input: "$visits",
                            as: "visit",
                            cond: { $gte: [ "$$visit", sinceDate ] }
                        }
                    }
                }
            },
            {
                $addFields: {
                    visitsCount: { $size: { $ifNull: [ "$recentVisits", [] ] } }
                }
            }
        );
    } else {
         aggregationPipeline.push({
            $addFields: { visitsCount: { $size: { $ifNull: [ "$visits", [] ] } } }
        });
    }

    aggregationPipeline.push({ $match: query });

    let sortOption: any = { createdAt: -1 }; // Default sort
    if (sort === 'asc') {
        sortOption = { createdAt: 1 };
    } else if (sort === 'visits') {
        sortOption = { 'visitsCount': -1, 'createdAt': -1 };
    }
    aggregationPipeline.push({ $sort: sortOption });
    
    aggregationPipeline.push({ $skip: skip });
    aggregationPipeline.push({ $limit: PAGE_SIZE });

    const usersFromDb = await db.collection<User>('users').aggregate(aggregationPipeline).toArray();
    const totalUsers = await db.collection('users').countDocuments(query);
    const hasMore = skip + usersFromDb.length < totalUsers;
    
    const users = JSON.parse(JSON.stringify(usersFromDb));

    return { users, hasMore, totalUsers };
}

// Permanently deletes one or more user documents by their _id.
// Used for the single-row delete and the "Delete Selected" action.
export async function deleteAdminUsers(ids: string[]) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const objectIds = ids
        .filter(id => ObjectId.isValid(id))
        .map(id => new ObjectId(id));

    if (objectIds.length === 0) {
        return { success: false, message: 'No valid users selected.', deletedCount: 0 };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<User>('users').deleteMany({ _id: { $in: objectIds } });
        revalidatePath('/admin/users');
        return { success: true, message: `Deleted ${result.deletedCount} user(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error("Error deleting admin users:", error);
        return { success: false, message: 'Failed to delete users.', deletedCount: 0 };
    }
}

// Permanently deletes every user matching the current filter (search + IST
// time frame on createdAt). Clears the whole time frame, not just the page.
export async function deleteAdminUsersInRange(search: string, startDate?: string, endDate?: string) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const query = buildAdminUsersQuery(search, startDate, endDate);

    try {
        const db = await connectToDatabase();
        const result = await db.collection<User>('users').deleteMany(query);
        revalidatePath('/admin/users');
        return { success: true, message: `Deleted ${result.deletedCount} user(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error("Error deleting admin users in range:", error);
        return { success: false, message: 'Failed to delete users.', deletedCount: 0 };
    }
}

export async function banUser(userId: string, banMessage: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    const db = await connectToDatabase();
    
    const result = await db.collection<User>('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { isBanned: true, banMessage: banMessage, bannedAt: new Date() } }
    );
    
    if (result.modifiedCount === 0) {
        return { success: false, message: 'User not found or already banned.' };
    }

    revalidatePath('/admin/users');
    revalidatePath('/admin/banned-users');
    return { success: true, message: 'User has been banned.' };
}

export async function unbanUser(userId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    const db = await connectToDatabase();
    
    const result = await db.collection<User>('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { isBanned: false }, $unset: { banMessage: "", bannedAt: "" } }
    );
    
    if (result.modifiedCount === 0) {
        return { success: false, message: 'User not found or not banned.' };
    }

    revalidatePath('/admin/users');
    revalidatePath('/admin/banned-users');
    return { success: true, message: 'User has been unbanned.' };
}

export async function hideUser(userId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    const db = await connectToDatabase();
    
    const result = await db.collection<User>('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { isHidden: true } }
    );
    
    if (result.modifiedCount === 0) {
        return { success: false, message: 'User not found.' };
    }

    revalidatePath('/admin/users');
    revalidatePath('/admin/hidden-users');
    return { success: true, message: 'User has been hidden.' };
}

export async function unhideUser(userId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    const db = await connectToDatabase();
    
    const result = await db.collection<User>('users').updateOne(
        { _id: new ObjectId(userId) },
        { $set: { isHidden: false } }
    );
    
    if (result.modifiedCount === 0) {
        return { success: false, message: 'User not found.' };
    }

    revalidatePath('/admin/users');
    revalidatePath('/admin/hidden-users');
    return { success: true, message: 'User has been unhidden.' };
}

export async function getHiddenUsersForAdmin() {
    noStore();
    if (!(await isAdminAuthenticated())) throw new Error('Unauthorized');
    const db = await connectToDatabase();
    
    const usersFromDb = await db.collection<User>('users')
      .find({ isHidden: true })
      .sort({ createdAt: -1 })
      .toArray();

    return JSON.parse(JSON.stringify(usersFromDb));
}

// --- Notification Actions ---

const notificationSchema = z.object({
    gamingId: z.string().min(1, 'Gaming ID is required.'),
    message: z.string().min(1, 'Message is required.'),
    imageUrl: z.string().trim().refine(isSafeHttpUrl, MEDIA_URL_ERROR).optional().or(z.literal('')),
    isPopup: z.enum(['on', 'off']).optional(),
});

export async function sendNotification(formData: FormData): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const rawFormData = Object.fromEntries(formData.entries());
    const validatedFields = notificationSchema.safeParse(rawFormData);

    if (!validatedFields.success) {
        return { success: false, message: 'Invalid data.' };
    }

    const { gamingId, message, imageUrl } = validatedFields.data;
    const isPopup = rawFormData.isPopup === 'on';

    const db = await connectToDatabase();
    const user = await db.collection<User>('users').findOne({ gamingId });

    if (!user) {
        return { success: false, message: 'User with that Gaming ID does not exist.' };
    }

    const newNotification: Omit<Notification, '_id'> = {
        gamingId,
        message,
        imageUrl: imageUrl || undefined,
        isRead: false,
        createdAt: new Date(),
        isPopup: isPopup,
    };

    await db.collection<Notification>('notifications').insertOne(newNotification as Notification);

    // Send push notification if user has a token
    if (user.fcmToken) {
       await sendPushNotification({
            token: user.fcmToken,
            title: 'Garena Store',
            body: message,
            imageUrl: imageUrl || undefined,
        });
    }


    revalidatePath('/'); // Revalidate to show notification icon in header
    return { success: true, message: 'Notification sent successfully!' };
}

const sendToAllSchema = z.object({
  message: z.string().min(1, 'Message is required.'),
  imageUrl: z.string().trim().refine(isSafeHttpUrl, MEDIA_URL_ERROR).optional().or(z.literal('')),
  isPopup: z.enum(['on', 'off']).optional(),
});

export async function sendNotificationToAll(formData: FormData): Promise<{ success: boolean; message: string; broadcastId?: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    
    const rawFormData = Object.fromEntries(formData.entries());
    const validatedFields = sendToAllSchema.safeParse(rawFormData);
    if (!validatedFields.success) {
        return { success: false, message: 'Invalid data.' };
    }
    const { message, imageUrl } = validatedFields.data;
    const isPopup = rawFormData.isPopup === 'on';

    const db = await connectToDatabase();
    // Find all users who are not banned or hidden
    const allUsers = await db.collection<User>('users').find({ isBanned: { $ne: true }, isHidden: { $ne: true } }).project({ gamingId: 1, fcmToken: 1 }).toArray();

    if (allUsers.length === 0) {
        return { success: false, message: 'No active users found to send notifications to.' };
    }

    // Step 1: Create a single broadcast notification document
    const tokens = allUsers
        .filter(u => !!u.fcmToken)
        .map(u => ({ token: u.fcmToken as string, gamingId: u.gamingId }));

    const broadcastDoc = {
        message,
        imageUrl: imageUrl || undefined,
        isPopup,
        createdAt: new Date(),
        totalUsers: allUsers.length,
        pushTotal: tokens.length,
        pushSent: 0,
        pushFailed: 0,
        status: 'sending' as const,
    };
    const broadcastResult = await db.collection('broadcast_notifications').insertOne(broadcastDoc);
    const broadcastId = broadcastResult.insertedId.toString();

    // Step 2: Insert individual notification documents tagged with broadcastId
    const notifications: Omit<Notification, '_id'>[] = allUsers.map(user => ({
        gamingId: user.gamingId,
        message,
        imageUrl: imageUrl || undefined,
        isRead: false,
        createdAt: new Date(),
        isPopup: isPopup,
        broadcastId: broadcastId,
    }));

    await db.collection<Notification>('notifications').insertMany(notifications as Notification[], { ordered: false });

    // Step 3: Send batched push notifications (fire-and-forget, progress tracked via DB)
    if (tokens.length > 0) {
        // Import dynamically to keep this file's existing imports unchanged
        const { sendBatchedPushNotifications } = await import('@/lib/broadcast-push-notifications');
        // Fire and forget — don't await. Progress is tracked in the DB via SSE.
        sendBatchedPushNotifications(
            tokens,
            'Garena Store',
            message,
            broadcastId,
            imageUrl || undefined
        ).catch(err => console.error('[Broadcast] Background push sending failed:', err));
    } else {
        // No tokens to send, mark as completed immediately
        await db.collection('broadcast_notifications').updateOne(
            { _id: broadcastResult.insertedId },
            { $set: { status: 'completed' } }
        );
    }

    revalidatePath('/');
    return { success: true, message: `Notification sent to ${allUsers.length} users. Push notifications are being delivered in batches.`, broadcastId };
}

export async function getNotificationsForUser(): Promise<Notification[]> {
    noStore();
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return [];
    }
    
    const db = await connectToDatabase();
    const notifications = await db.collection<Notification>('notifications')
        .find({ gamingId })
        .sort({ createdAt: -1 })
        .toArray();
    
    return JSON.parse(JSON.stringify(notifications));
}

export async function getGiftHistoryForUser(): Promise<Notification[]> {
    noStore();
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return [];
    }
    
    const db = await connectToDatabase();
    // Fetch notifications where the current user was the sender
    const notifications = await db.collection<Notification>('notifications')
        .find({ senderGamingId: gamingId })
        .sort({ createdAt: -1 })
        .toArray();
    
    return JSON.parse(JSON.stringify(notifications));
}


export async function markNotificationAsRead(notificationId: string): Promise<{ success: boolean }> {
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return { success: false };
    }

    const db = await connectToDatabase();
    await db.collection<Notification>('notifications').updateOne(
        { _id: new ObjectId(notificationId), gamingId },
        { $set: { isRead: true } }
    );
    
    revalidatePath('/'); // Revalidate to update unread count
    return { success: true };
}


export async function markNotificationsAsRead(): Promise<{ success: boolean }> {
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return { success: false };
    }

    const db = await connectToDatabase();
    await db.collection<Notification>('notifications').updateMany(
        { gamingId, isRead: false },
        { $set: { isRead: true } }
    );
    
    revalidatePath('/'); // Revalidate to update unread count
    return { success: true };
}

// --- Event Management Actions ---

export async function getEvents(): Promise<Event[]> {
    noStore();
    const db = await connectToDatabase();
    const eventsFromDb = await db.collection<Event>('events')
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    return JSON.parse(JSON.stringify(eventsFromDb));
}

export async function addEvent(imageUrl: string): Promise<{ success: boolean; message: string; event?: Event }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    
    if (!imageUrl) {
        return { success: false, message: 'Image URL is required' };
    }
    if (!isSafeHttpUrl(imageUrl)) {
        return { success: false, message: MEDIA_URL_ERROR };
    }

    const db = await connectToDatabase();
    
    const newEvent: Omit<Event, '_id'> = {
        imageUrl: imageUrl.trim(),
        createdAt: new Date(),
    };

    const result = await db.collection<Event>('events').insertOne(newEvent as Event);
    
    revalidatePath('/admin/events');
    revalidatePath('/');
    
    const createdEvent = { ...newEvent, _id: result.insertedId };

    return { success: true, message: 'New event added.', event: JSON.parse(JSON.stringify(createdEvent)) };
}

export async function deleteEvent(eventId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const db = await connectToDatabase();
    await db.collection<Event>('events').deleteOne({ _id: new ObjectId(eventId) });

    revalidatePath('/admin/events');
    revalidatePath('/');

    return { success: true, message: 'Event deleted.' };
}

// --- Push Notification Actions ---
export async function saveFcmToken(token: string): Promise<{ success: boolean }> {
  const gamingId = cookies().get('gaming_id')?.value;
  if (!gamingId) {
    return { success: false };
  }

  try {
    const db = await connectToDatabase();
    await db.collection<User>('users').updateOne(
      { gamingId },
      { $set: { fcmToken: token } }
    );
    return { success: true };
  } catch (error) {
    console.error('Failed to save FCM token:', error);
    return { success: false };
  }
}

// --- AI Log Actions ---

export async function getChatHistory(): Promise<AiLog[]> {
    noStore();
    const gamingId = cookies().get('gaming_id')?.value;
    if (!gamingId) {
        return [];
    }

    try {
        const db = await connectToDatabase();
        const logs = await db.collection<AiLog>('ai_logs')
            .find({ gamingId })
            .sort({ createdAt: 1 }) // sort ascending to get chronological order
            .toArray();
        return JSON.parse(JSON.stringify(logs));
    } catch (error) {
        console.error("Failed to fetch user's chat history:", error);
        return [];
    }
}


// Builds the query shared by the AI log listing, count and range-deletion so
// that "what you see" and "what gets deleted" always match. The time frame
// filters on `createdAt` (IST), reusing the IST→UTC helper above.
function buildAiLogsQuery(search: string, startDate?: string, endDate?: string) {
    const query: any = {};
    if (search) {
        query.gamingId = { $regex: search, $options: 'i' };
    }
    const start = istLocalToUtcDate(startDate || '');
    const end = istLocalToUtcDate(endDate || '');
    if (start || end) {
        query.createdAt = {};
        if (start) query.createdAt.$gte = start;
        if (end) query.createdAt.$lte = end;
    }
    return query;
}

export async function getAiLogs(page: number, search: string, sort: string, startDate?: string, endDate?: string) {
    noStore();
    if (!(await isAdminAuthenticated())) throw new Error('Unauthorized');
    const db = await connectToDatabase();
    const skip = (page - 1) * PAGE_SIZE;

    const query = buildAiLogsQuery(search, startDate, endDate);

    const logsFromDb = await db.collection<AiLog>('ai_logs')
        .find(query)
        .sort({ createdAt: sort === 'asc' ? 1 : -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .toArray();

    const totalLogs = await db.collection('ai_logs').countDocuments(query);
    const hasMore = skip + logsFromDb.length < totalLogs;

    const logs = JSON.parse(JSON.stringify(logsFromDb));

    return { logs, hasMore, totalLogs };
}

export async function deleteAiLog(logId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }
    
    try {
        const db = await connectToDatabase();
        const result = await db.collection<AiLog>('ai_logs').deleteOne({ _id: new ObjectId(logId) });
        
        if (result.deletedCount === 0) {
            return { success: false, message: 'Log not found.' };
        }

        revalidatePath('/admin/ai-logs');
        return { success: true, message: 'Log deleted successfully.' };
    } catch (error) {
        console.error('Error deleting AI log:', error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}

// Permanently deletes one or more AI logs by their _id. Used for the
// single-row delete and the "Delete Selected" action.
export async function deleteAiLogs(ids: string[]) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const objectIds = ids
        .filter(id => ObjectId.isValid(id))
        .map(id => new ObjectId(id));

    if (objectIds.length === 0) {
        return { success: false, message: 'No valid logs selected.', deletedCount: 0 };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<AiLog>('ai_logs').deleteMany({ _id: { $in: objectIds } });
        revalidatePath('/admin/ai-logs');
        return { success: true, message: `Deleted ${result.deletedCount} log(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Error deleting AI logs:', error);
        return { success: false, message: 'Failed to delete logs.', deletedCount: 0 };
    }
}

// Permanently deletes every AI log matching the current filter (search + IST
// time frame). Clears the whole time frame, not just the loaded page.
export async function deleteAiLogsInRange(search: string, startDate?: string, endDate?: string) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const query = buildAiLogsQuery(search, startDate, endDate);

    try {
        const db = await connectToDatabase();
        const result = await db.collection<AiLog>('ai_logs').deleteMany(query);
        revalidatePath('/admin/ai-logs');
        return { success: true, message: `Deleted ${result.deletedCount} log(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Error deleting AI logs in range:', error);
        return { success: false, message: 'Failed to delete logs.', deletedCount: 0 };
    }
}

// --- User-Product Control Actions ---
const RULES_PAGE_SIZE = 5;

export async function findUserAndProductsForControl(gamingId: string): Promise<{ success: boolean, message?: string, user?: User, products?: Product[] }> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: "Unauthorized" };

    try {
        const db = await connectToDatabase();
        const user = await db.collection<User>('users').findOne({ gamingId });
        if (!user) {
            return { success: false, message: "User not found." };
        }
        const products = await getProducts({ isVanished: { $ne: true } });
        return { success: true, user: JSON.parse(JSON.stringify(user)), products: JSON.parse(JSON.stringify(products)) };
    } catch (error) {
        console.error("Error finding user/products for control:", error);
        return { success: false, message: "An error occurred." };
    }
}

export async function setUserRedeemDisabled(gamingId: string, disabled: boolean): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: "Unauthorized" };

    try {
        const db = await connectToDatabase();
        const update = disabled 
            ? { $set: { isRedeemDisabled: true, redeemDisabledAt: new Date() } }
            : { $set: { isRedeemDisabled: false }, $unset: { redeemDisabledAt: "" } };
        
        const result = await db.collection<User>('users').updateOne({ gamingId }, update);


        if (result.modifiedCount === 0 && result.matchedCount === 0) {
            return { success: false, message: 'User not found.' };
        }

        revalidatePath('/'); // To update user data on client
        revalidatePath('/admin/user-product-controls');
        revalidatePath('/admin/disabled-redeem-users');
        return { success: true, message: `Redeem code payments ${disabled ? 'disabled' : 'enabled'} for ${gamingId}.` };
    } catch (error) {
        console.error("Error setting redeem code disabled status:", error);
        return { success: false, message: 'An error occurred.' };
    }
}

const controlRuleSchema = z.object({
    gamingId: z.string(),
    productId: z.string(),
    type: z.enum(['block', 'allowPurchase', 'hideProduct', 'limitPurchase']),
    reason: z.string().optional(),
    allowance: z.coerce.number().optional(),
    limit: z.coerce.number().optional()
});

export async function setControlRule(formData: FormData): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: "Unauthorized" };

    const rawData = Object.fromEntries(formData);
    const validated = controlRuleSchema.safeParse(rawData);

    if (!validated.success) {
        return { success: false, message: "Invalid data provided." };
    }

    const { gamingId, productId, type, reason, allowance, limit } = validated.data;
    
    try {
        const db = await connectToDatabase();
        const product = await db.collection<Product>('products').findOne({ _id: new ObjectId(productId) });
        if (!product) {
            return { success: false, message: 'Product not found.' };
        }

        let newRule: Omit<UserProductControl, '_id'> = {
            gamingId,
            productId,
            productName: product.name,
            type,
            createdAt: new Date()
        };

        if (type === 'block') {
            if (!reason) return { success: false, message: 'A reason is required to block a purchase.' };
            newRule.blockReason = reason;
        } else if (type === 'allowPurchase') {
            if (!allowance || allowance <= 0) return { success: false, message: 'A positive allowance count is required.' };
            newRule.allowanceCount = allowance;
        } else if (type === 'limitPurchase') {
            if (!limit || limit <= 0) return { success: false, message: 'A positive limit count is required.' };
            newRule.limitCount = limit;
        }

        await db.collection<UserProductControl>('user_product_controls').replaceOne(
            { gamingId, productId },
            newRule as UserProductControl,
            { upsert: true }
        );

        revalidatePath('/');
        revalidatePath('/admin/user-product-controls');
        return { success: true, message: 'Rule set successfully.' };

    } catch (error) {
        console.error("Error setting control rule:", error);
        return { success: false, message: 'An error occurred.' };
    }
}

export async function getActiveControlRules(page: number, search: string) {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { rules: [], hasMore: false, totalRules: 0 };
    
    const db = await connectToDatabase();
    const skip = (page - 1) * RULES_PAGE_SIZE;

    let query: any = {};
    if (search) {
        query.gamingId = { $regex: search, $options: 'i' };
    }

    try {
        const rulesFromDb = await db.collection<UserProductControl>('user_product_controls')
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(RULES_PAGE_SIZE)
            .toArray();

        const totalRules = await db.collection('user_product_controls').countDocuments(query);
        const hasMore = skip + rulesFromDb.length < totalRules;
        const rules = JSON.parse(JSON.stringify(rulesFromDb));

        return { rules, hasMore, totalRules };
    } catch (error) {
        console.error("Error fetching control rules:", error);
        return { rules: [], hasMore: false, totalRules: 0 };
    }
}

export async function deleteControlRule(ruleId: string): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized' };
    
    try {
        const db = await connectToDatabase();
        const result = await db.collection<UserProductControl>('user_product_controls').deleteOne({ _id: new ObjectId(ruleId) });
        if (result.deletedCount === 0) {
            return { success: false, message: 'Rule not found.' };
        }
        revalidatePath('/admin/user-product-controls');
        return { success: true, message: 'Rule removed successfully.' };
    } catch (error) {
        console.error("Error deleting control rule:", error);
        return { success: false, message: 'An error occurred.' };
    }
}

export async function getUserProductControls(gamingId: string): Promise<UserProductControl[]> {
    noStore();
    if (!gamingId) return [];

    try {
        const db = await connectToDatabase();
        const controls = await db.collection<UserProductControl>('user_product_controls').find({ gamingId }).toArray();
        return JSON.parse(JSON.stringify(controls));
    } catch (error) {
        console.error("Failed to fetch user product controls:", error);
        return [];
    }
}

const DISABLED_REDEEM_PAGE_SIZE = 5;

export async function getDisabledRedeemUsers(search: string, page: number) {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { users: [], hasMore: false, totalUsers: 0 };

    let query: any = { isRedeemDisabled: true };
    if (search) {
        query.gamingId = { $regex: search, $options: 'i' };
    }

    try {
        const db = await connectToDatabase();
        const skip = (page - 1) * DISABLED_REDEEM_PAGE_SIZE;

        const usersFromDb = await db.collection<User>('users')
            .find(query)
            .sort({ redeemDisabledAt: -1 })
            .skip(skip)
            .limit(DISABLED_REDEEM_PAGE_SIZE)
            .toArray();
            
        const totalUsers = await db.collection('users').countDocuments(query);
        const hasMore = skip + usersFromDb.length < totalUsers;
        
        const users = JSON.parse(JSON.stringify(usersFromDb));

        return { users, hasMore, totalUsers };
    } catch (error) {
        console.error("Error fetching disabled redeem users:", error);
        return { users: [], hasMore: false, totalUsers: 0 };
    }
}

export async function getLoginHistory(): Promise<{ gamingId: string; timestamp: Date }[]> {
  noStore();
  const user = await getUserData();
  if (!user || !user.loginHistory) {
    return [];
  }
  // Sort history by timestamp descending (most recent first)
  const sortedHistory = user.loginHistory.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return sortedHistory;
}
