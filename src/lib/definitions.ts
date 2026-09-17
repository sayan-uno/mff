

import { type ObjectId } from 'mongodb';

// Represents a user account created via username/password on the /account page.
// This is the account that has a wallet and can generate referral codes.
// This is stored in the 'legacy_users' collection.
export interface LegacyUser {
  _id: ObjectId;
  username: string;
  password:  string;
  referralCode?: string;
  referredBy?: string;
  walletBalance?: number;
  createdAt: Date;
}

// Represents a gaming profile, created when a user first enters their Gaming ID.
// This is used for making purchases and tracking coins. It is NOT a full user account.
// This is stored in the 'users' collection.
export interface User {
    _id: ObjectId;
    gamingId: string;
    visualGamingId?: string; // A display-only gaming ID
    visualIdSetAt?: Date; // Timestamp for when the visual ID was set
    coins: number;
    referredByCode?: string; // This will store the referral code of the referrer
    createdAt: Date;
    giftPassword?: string; // Hashed password for securing coin transfers
    canSetGiftPassword?: boolean; // Flag to check if user can set/reset gift password
    giftFailedAttempts?: number; // Wrong gift-password count (reset on success / lock)
    giftLockUntil?: Date; // Gifting locked until this time after too many wrong passwords
    isBanned?: boolean;
    banMessage?: string; // A message to show the user when they are banned
    bannedAt?: Date; // Timestamp for when the user was banned
    visits?: Date[];
    isHidden?: boolean; // Flag to hide user from admin list
    fcmToken?: string; // Firebase Cloud Messaging token
    isRedeemDisabled?: boolean; // If true, user cannot use redeem codes
    redeemDisabledAt?: Date; // Timestamp for when the redeem code was disabled
    loginHistory?: { gamingId: string; timestamp: Date }[];
    ipHistory?: { ip: string; timestamp: Date }[];
    fingerprintHistory?: { fingerprint: string; timestamp: Date }[];
}


export interface Product {
    _id: ObjectId; // From MongoDB
    name: string;
    price: number;
    purchasePrice?: number; // Special price for coin products
    quantity: number;
    imageUrl: string;
    dataAiHint?: string;
    isAvailable: boolean;
    isVanished: boolean;
    coinsApplicable?: number;
    isCoinProduct?: boolean;
    endDate?: Date;
    isComingSoon?: boolean;
    displayOrder?: number;
    category?: string[];
    onlyUpi?: boolean;
    oneTimeBuy?: boolean;
    visibility?: 'all' | 'custom';
    visibleTo?: string[];
    tag?: string; 
    tagColor?: 'green' | 'red';
    liveStock?: number;
    liveStockInterval?: number;
    liveStockStart?: Date;
    liveStockIncreases?: boolean;
}

export interface Order {
    _id: ObjectId;
    userId: string; // The unique ID of the Gaming ID profile document from 'users'
    gamingId: string;
    productId: string;
    productName: string;
    productPrice: number;
    productImageUrl: string;
    paymentMethod: 'UPI' | 'Redeem Code' | 'UPI-Auto';
    status: 'Processing' | 'Completed' | 'Failed';
    utr?: string;
    redeemCode?: string;
    transactionId?: string; // Unique ID for the purchase attempt from the client
    referralCode?: string; // This will store the referral code of the referrer
    coinsUsed: number;
    finalPrice: number;
    isCoinProduct?: boolean;
    createdAt: Date;
    coinsAtTimeOfPurchase?: number; // Record user's coin balance at the time of purchase
    isPurchaseTracked?: boolean; // Flag to check if the purchase event has been sent to Meta Pixel
    payCode?: string; // Pay code of the UPI payment session this order came from (see src/lib/pay-code.ts)
}

export interface Withdrawal {
  _id: ObjectId;
  userId: string;
  username: string;
  referralCode?: string;
  amount: number;
  method: 'Bank' | 'UPI';
  details: {
    bankName?: string;
    accountNumber?: string;
    ifscCode?: string;
    upiId?: string;
  };
  status: 'Pending' | 'Completed' | 'Failed';
  createdAt: Date;
}

export interface Notification {
    _id: ObjectId;
    gamingId: string; // The recipient's gaming ID
    senderGamingId?: string; // The sender's gaming ID, for gift history
    message: string;
    // Optional rich, self-contained HTML body (server-generated, trusted) rendered
    // in the notification bell instead of the plain `message`. `message` is kept as
    // a plain-text fallback for push notifications and clients that don't render HTML.
    html?: string;
    imageUrl?: string;
    isRead: boolean;
    createdAt: Date;
    isPopup?: boolean;
    broadcastId?: string; // Links to a BroadcastNotification if this was part of a broadcast
    pushDelivered?: boolean; // True if Firebase push notification was successfully sent
    // Tagging for support-reply notifications so they can be precisely removed
    // from the bell once the user has actually seen the reply (keeps the bell
    // history from piling up). Absent on all other notification kinds.
    type?: string;            // e.g. 'support_reply'
    supportTicketId?: string; // The report this reply notification belongs to
}

export interface BroadcastNotification {
    _id: ObjectId;
    message: string;
    imageUrl?: string;
    isPopup?: boolean;
    createdAt: Date;
    totalUsers: number;        // How many users were targeted
    pushTotal: number;         // How many users had FCM tokens (actual push targets)
    pushSent: number;          // How many push notifications succeeded
    pushFailed: number;        // How many push notifications failed
    status: 'sending' | 'completed' | 'failed';
    removedTokenGamingIds?: string[]; // Gaming IDs of users whose FCM tokens were invalid and removed
}

export interface Event {
    _id: ObjectId;
    imageUrl: string;
    createdAt: Date;
}

export interface AiLog {
    _id: ObjectId;
    gamingId: string;
    ip?: string; // Requester IP (mainly to identify guests)
    question: string;
    answer: string;
    createdAt: Date;
    mediaDataUri?: string;
}

export interface UserProductControl {
    _id: ObjectId;
    gamingId: string;
    productId: string;
    productName: string;
    type: 'block' | 'allowPurchase' | 'hideProduct' | 'limitPurchase';
    blockReason?: string; // For 'block' type
    allowanceCount?: number; // For 'allowPurchase' type
    limitCount?: number; // For 'limitPurchase' type
    createdAt: Date;
}

export interface VisualIdPromotionLog {
    _id: ObjectId;
    oldGamingId: string;
    newGamingId: string;
    promotionDate: Date;
}

// Represents a pre-seeded history entry for a user that hasn't been created yet.
// This is used for promoted IDs.
export interface PreSeededLoginHistory {
  _id: ObjectId;
  gamingIdToSeed: string;
  historyEntry: {
    gamingId: string;
    timestamp: Date;
  };
}

export interface CustomAd {
  _id: ObjectId;
  videoUrl: string;
  ctaText: string;
  ctaLink: string;
  ctaShape: 'pill' | 'rounded' | 'square';
  ctaColor: 'primary' | 'destructive' | 'outline' | 'blue' | 'yellow' | 'green' | 'black' | 'grey';
  totalDuration: number; // in seconds
  rewardTime?: number; // in seconds, must be <= totalDuration
  hideCtaButton?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SliderImage {
  _id: ObjectId;
  imageUrl: string;
  displayOrder: number;
  createdAt: Date;
}

export interface PaymentLock {
    _id: ObjectId;
    gamingId: string;
    productId: string;
    productName: string;
    amount: number;
    status: 'active' | 'expired' | 'completed';
    createdAt: Date;
    expiresAt: Date;
    payCode?: string; // Short unique reference put at the front of the UPI note (see src/lib/pay-code.ts)
    upiNote?: string; // The exact note text sent in the QR link: "<payCode> <short product name>"
}

export interface SmsWebhookLog {
    _id: ObjectId;
    sender?: string;
    body: string;
    receivedAt: Date;
    status: 'unprocessed' | 'verified' | 'ignored_no_match' | 'ignored_not_payment' | 'ignored_duplicate';
    matchedPaymentLockId?: ObjectId;
    parsedAmount?: number;
    matchedGamingId?: string;
}

export interface BlockedIdentifier {
  _id: ObjectId;
  type: 'ip' | 'fingerprint' | 'id';
  value: string;
  reason: string;
  createdAt: Date;
}
