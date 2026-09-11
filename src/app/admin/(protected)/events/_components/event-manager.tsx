'use client';

import { useState, useTransition, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, PlusCircle, Trash2, Image as ImageIcon } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { addEvent, deleteEvent } from '@/app/actions';
import type { Event } from '@/lib/definitions';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SmartImage from '@/components/smart-image';
import { isVideoUrl } from '@/lib/media-urls';

interface EventManagerProps {
  initialEvents: Event[];
}

const EventMedia = ({ src }: { src: string }) => {
    const isVideo = isVideoUrl(src);
    if (isVideo) {
        return (
            <video
                src={src}
                autoPlay
                loop
                muted
                playsInline
                className="absolute inset-0 w-full h-full object-cover"
            />
        );
    }
    return <SmartImage src={src} alt="Event Image" fill className="object-cover" />;
}

export default function EventManager({ initialEvents }: EventManagerProps) {
  const [events, setEvents] = useState(initialEvents);
  const [isPending, startTransition] = useTransition();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const imageUrlRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleAddEvent = async () => {
    const imageUrl = imageUrlRef.current?.value;
    if (!imageUrl) {
      toast({ variant: 'destructive', title: 'Error', description: 'Image URL is required.' });
      return;
    }
    
    startTransition(async () => {
      const result = await addEvent(imageUrl);
      if (result.success && result.event) {
        toast({ title: 'Success', description: 'Event added successfully.' });
        setEvents(prev => [...prev, result.event!]);
        setIsAddDialogOpen(false);
      } else {
        toast({ variant: 'destructive', title: 'Error', description: result.message });
      }
    });
  };

  const handleDeleteEvent = (eventId: string) => {
    startTransition(async () => {
      const result = await deleteEvent(eventId);
      if (result.success) {
        toast({ title: 'Success', description: 'Event deleted successfully.' });
        setEvents(prev => prev.filter(event => event._id.toString() !== eventId));
      } else {
        toast({ variant: 'destructive', title: 'Error', description: result.message });
      }
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row justify-between items-start">
        <div>
          <CardTitle>Manage Events</CardTitle>
          <CardDescription>Add or remove promotional event images that show on site load.</CardDescription>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button disabled={isPending}>
              <PlusCircle className="mr-2 h-4 w-4" />
              Add Event
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a New Event</DialogTitle>
              <DialogDescription>
                Enter the URL for the event image you want to display to users.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-2">
              <Label htmlFor="imageUrl">Image URL</Label>
              <Input id="imageUrl" ref={imageUrlRef} placeholder="https://example.com/image.png" />
            </div>
            <DialogFooter>
              <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
              <Button onClick={handleAddEvent} disabled={isPending}>
                {isPending && <Loader2 className="animate-spin mr-2" />}
                Add Event
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-4">
        {events.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">No active events.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {events.map((event) => (
              <Card key={event._id.toString()} className="overflow-hidden group">
                <CardContent className="p-0">
                  <div className="relative aspect-video">
                    <EventMedia src={event.imageUrl} />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                       <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="destructive" disabled={isPending}>
                              <Trash2 className="mr-2" /> Delete
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                              <AlertDialogHeader>
                                  <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                      This will permanently delete the event image. This action cannot be undone.
                                  </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => handleDeleteEvent(event._id.toString())}>
                                      Yes, Delete
                                  </AlertDialogAction>
                              </AlertDialogFooter>
                          </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
