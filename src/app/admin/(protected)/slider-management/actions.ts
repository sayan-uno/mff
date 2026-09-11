
'use server';

import { isAdminAuthenticated } from '@/app/actions';
import { SliderImage } from '@/lib/definitions';
import { connectToDatabase } from '@/lib/mongodb';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSafeHttpUrl, MEDIA_URL_ERROR } from '@/lib/media-urls';
import { unstable_noStore as noStore } from 'next/cache';
import { ObjectId } from 'mongodb';


export async function getSliderImages(): Promise<SliderImage[]> {
    noStore();
    try {
        const db = await connectToDatabase();
        const images = await db.collection<SliderImage>('slider_images').find().sort({ displayOrder: 1 }).toArray();
        return JSON.parse(JSON.stringify(images));
    } catch (error) {
        console.error('Error fetching slider images:', error);
        return [];
    }
}


const imageSchema = z.object({
    imageUrl: z.string().trim().refine(isSafeHttpUrl, MEDIA_URL_ERROR),
    displayOrder: z.coerce.number().int().min(1, { message: "Display order must be 1 or greater." }),
});

export async function addSliderImage(formData: FormData): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const validated = imageSchema.safeParse(Object.fromEntries(formData));

    if (!validated.success) {
        return { success: false, message: validated.error.errors.map(e => e.message).join(', ') };
    }
    
    const { imageUrl, displayOrder } = validated.data;

    try {
        const db = await connectToDatabase();

        const newImage: Omit<SliderImage, '_id'> = {
            imageUrl,
            displayOrder,
            createdAt: new Date(),
        };

        await db.collection<SliderImage>('slider_images').insertOne(newImage as SliderImage);

        revalidatePath('/admin/slider-management');
        revalidatePath('/'); // Revalidate homepage to show new slider

        return { success: true, message: 'Slider image added successfully.' };
    } catch (error) {
        console.error('Error adding slider image:', error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}

export async function updateSliderImage(imageId: string, formData: FormData): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const validated = imageSchema.safeParse(Object.fromEntries(formData));

    if (!validated.success) {
        return { success: false, message: validated.error.errors.map(e => e.message).join(', ') };
    }
    
    const { imageUrl, displayOrder } = validated.data;

    try {
        const db = await connectToDatabase();
        
        await db.collection<SliderImage>('slider_images').updateOne(
            { _id: new ObjectId(imageId) },
            { $set: { imageUrl, displayOrder } }
        );

        revalidatePath('/admin/slider-management');
        revalidatePath('/');

        return { success: true, message: 'Slider image updated successfully.' };
    } catch (error) {
        console.error('Error updating slider image:', error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}


export async function deleteSliderImage(imageId: string): Promise<{ success: boolean, message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<SliderImage>('slider_images').deleteOne({ _id: new ObjectId(imageId) });

        if (result.deletedCount === 0) {
            return { success: false, message: 'Image not found.' };
        }

        revalidatePath('/admin/slider-management');
        revalidatePath('/');

        return { success: true, message: 'Slider image deleted successfully.' };
    } catch (error) {
        console.error('Error deleting slider image:', error);
        return { success: false, message: 'An unexpected error occurred.' };
    }
}
