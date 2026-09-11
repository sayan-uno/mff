
'use client';

import { Dialog, DialogContent, DialogClose, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Event } from '@/lib/definitions';
import SmartImage from '@/components/smart-image';
import { isVideoUrl } from '@/lib/media-urls';
import { X } from 'lucide-react';

interface EventModalProps {
  event: Event;
  onClose: () => void;
}

const EventMedia = ({ src }: { src: string }) => {
    const isVideo = isVideoUrl(src);
    if (isVideo) {
        return (
            <video
                src={src}
                autoPlay
                loop
                playsInline
                className="rounded-lg w-full h-full object-contain"
            />
        );
    }
    return <SmartImage src={src} alt="Event" fill className="object-contain rounded-lg" />;
}

export default function EventModal({ event, onClose }: EventModalProps) {
  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent hideCloseButton={true} className="p-0 bg-transparent border-none shadow-none max-w-xl w-full">
        <DialogHeader>
          <DialogTitle className="sr-only">Event Promotion</DialogTitle>
        </DialogHeader>
        <div className="relative aspect-[600/400] w-full">
        <DialogClose asChild>
             <button
              type="button"
              className="absolute top-2 right-2 z-10 rounded-full p-1 bg-black/50 text-white transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            </DialogClose>
            <EventMedia src={event.imageUrl} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
