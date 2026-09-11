
'use server';

import { isAdminAuthenticated } from '@/app/actions';
import { CustomAd } from '@/lib/definitions';
import { connectToDatabase } from '@/lib/mongodb';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSafeHttpUrl, MEDIA_URL_ERROR } from '@/lib/media-urls';
import { unstable_noStore as noStore } from 'next/cache';
import { ObjectId } from 'mongodb';
import { getLockedAd, setAdLock } from '@/lib/ad-locker';

const adSchema = z.object({
    adId: z.string().optional(),
    videoUrl: z.string().trim().refine(isSafeHttpUrl, MEDIA_URL_ERROR),
    ctaText: z.string().min(1, 'Button text is required.'),
    ctaLink: z.string().url('Must be a valid URL.'),
    ctaShape: z.enum(['pill', 'rounded', 'square']),
    ctaColor: z.enum(['primary', 'destructive', 'outline', 'blue', 'yellow', 'green', 'black', 'grey']),
    totalDuration: z.coerce.number().int().min(5, 'Total duration must be at least 5 seconds.'),
    rewardTime: z.coerce.number().int().min(1, 'Reward time must be at least 1 second.').optional().or(z.literal('')),
    hideCtaButton: z.enum(['on', 'off']).optional(),
}).refine(data => {
    if (data.rewardTime) {
        return data.rewardTime <= data.totalDuration;
    }
    return true;
}, {
    message: 'Reward time cannot be greater than the total duration.',
    path: ['rewardTime'],
});

export async function getRandomAd(): Promise<CustomAd | null> {
    noStore();
    
    // Check for a locked ad first.
    const lockedAd = await getLockedAd();
    if (lockedAd) {
        return lockedAd;
    }

    try {
        const db = await connectToDatabase();
        const ads = await db.collection<CustomAd>('custom_ads').aggregate([{ $sample: { size: 1 } }]).toArray();

        if (ads.length === 0) return null;
        
        const randomAd = JSON.parse(JSON.stringify(ads[0]));
        
        // Lock the newly fetched ad for the user.
        await setAdLock(randomAd);
        
        return randomAd;

    } catch (error) {
        console.error('Error fetching random ad:', error);
        return null;
    }
}


export async function getAds(): Promise<CustomAd[]> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return [];

    try {
        const db = await connectToDatabase();
        const ads = await db.collection<CustomAd>('custom_ads').find().sort({ createdAt: -1 }).toArray();
        return JSON.parse(JSON.stringify(ads));
    } catch (error) {
        console.error('Error fetching ads:', error);
        return [];
    }
}

export async function saveAd(prevState: { success: boolean, message: string }, formData: FormData): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const rawData = Object.fromEntries(formData.entries());
    const validated = adSchema.safeParse(rawData);

    if (!validated.success) {
        const errors = validated.error.errors.map(e => e.message).join(', ');
        return { success: false, message: `Invalid data: ${errors}` };
    }

    const { adId, videoUrl, ctaText, ctaLink, ctaShape, ctaColor, totalDuration, rewardTime } = validated.data;
    const hideCtaButton = rawData.hideCtaButton === 'on';

    try {
        const db = await connectToDatabase();
        const now = new Date();

        const adData: Omit<CustomAd, '_id' | 'createdAt'> = {
            videoUrl,
            ctaText,
            ctaLink,
            ctaShape,
            ctaColor,
            totalDuration,
            rewardTime: rewardTime || undefined,
            hideCtaButton,
            updatedAt: now,
        };

        if (adId) {
            // Update existing ad
            await db.collection<CustomAd>('custom_ads').updateOne(
                { _id: new ObjectId(adId) },
                { $set: adData }
            );
        } else {
            // Create new ad
            const newAd = { ...adData, createdAt: now };
            await db.collection<CustomAd>('custom_ads').insertOne(newAd as CustomAd);
        }
        

        revalidatePath('/admin/custom-ads');
        revalidatePath('/watch-ad');

        return { success: true, message: `Ad ${adId ? 'updated' : 'saved'} successfully.` };

    } catch (error) {
        console.error('Error saving ad:', error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}

export async function deleteAd(adId: string): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<CustomAd>('custom_ads').deleteOne({ _id: new ObjectId(adId) });
        if (result.deletedCount === 0) {
            return { success: false, message: 'Ad not found.' };
        }
        revalidatePath('/admin/custom-ads');
        return { success: true, message: 'Ad deleted successfully.' };
    } catch (error) {
        console.error('Error deleting ad:', error);
        return { success: false, message: 'An error occurred.' };
    }
}
