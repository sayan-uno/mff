
'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { registerGamingId } from '@/app/actions';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import WelcomeAnimation from './welcome-animation';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import BannedNotice from './banned-notice';
import { trackGoogleAdsSignup } from '@/lib/google-ads';

// Declare fbq for TypeScript
declare global {
  interface Window {
    fbq: (...args: any[]) => void;
  }
}

interface GamingIdModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}


export default function GamingIdModal({ isOpen, onOpenChange }: GamingIdModalProps) {
  const [gamingId, setGamingId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [bannedInfo, setBannedInfo] = useState<{ message: string, id: string } | null>(null);
  const [registrationSuccess, setRegistrationSuccess] = useState<{coins?: number} | null>(null);
  const [isShifted, setIsShifted] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const isMobile = useIsMobile();


  const handleRegister = async () => {
    if (gamingId.length < 8 || gamingId.length > 11) {
      toast({
        variant: 'destructive',
        title: 'Invalid Gaming ID',
        description: 'Your Gaming ID must be between 8 and 11 digits.',
      });
      return;
    }
    setIsLoading(true);
    const result = await registerGamingId(gamingId);
    
    if (result.success && result.user?.isBanned) {
      // Handle the case where the user is banned but successfully "logged in"
      setBannedInfo({ 
        message: result.user.banMessage || 'Your account has been suspended.', 
        id: result.user.visualGamingId || result.user.gamingId 
      });
      onOpenChange(false); // Close this modal to show the ban notice
    } else if (result.success && result.user) {
      // Handle successful registration/login
      toast({
        title: 'Success',
        description: result.message,
      });
      onOpenChange(false);
      // Check if it's a new registration by looking at the welcome message
      if (result.message.includes('800 coins')) {
        setRegistrationSuccess({ coins: 800 });
        // Fire Meta Pixel event for new registration
        if (typeof window.fbq === 'function') {
          window.fbq('track', 'CompleteRegistration');
        }
        // Also report the new registration to Google Ads (no-op if the tag is unavailable).
        trackGoogleAdsSignup();
      } else {
        // For returning users, show animation without coins
        setRegistrationSuccess({});
      }
    } else {
      // Handle other errors
      toast({
        variant: 'destructive',
        title: 'Error',
        description: result.message,
      });
    }
    setIsLoading(false);
  };
  
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.target;
    // Only allow digits by replacing any non-digit character with an empty string
    const digitsOnly = value.replace(/\D/g, '');
    setGamingId(digitsOnly);
    if (isMobile) {
      setIsShifted(digitsOnly.length > 0);
    }
  };
  
  const handleOpenChangeWithReset = (open: boolean) => {
    if (!open) {
        setGamingId('');
        setIsShifted(false);
    }
    onOpenChange(open);
  }

  if (registrationSuccess) {
    return <WelcomeAnimation coins={registrationSuccess.coins} />;
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleOpenChangeWithReset}>
        <DialogContent
          className={cn(
            'sm:max-w-md transition-all duration-300 ease-in-out',
            isMobile && isShifted && 'top-[41%]'
          )}
          onOpenAutoFocus={(e) => {
            if (isMobile) {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader>
          <DialogTitle className="text-2xl font-headline">Welcome to Garena Store</DialogTitle>
          <DialogDescription>
              Please enter your Free Fire Gaming ID to get started and receive your welcome bonus!
          </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
          <div className="space-y-2">
              <Label htmlFor="gaming-id-register">Gaming ID</Label>
              <Input
                id="gaming-id-register"
                placeholder="Your in-game user ID"
                value={gamingId}
                onChange={handleInputChange}
                disabled={isLoading}
                type="tel"
                pattern="[0-9]*"
                minLength={8}
                maxLength={11}
                className={cn(
                  isMobile && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                )}
              />
          </div>
          <Button onClick={handleRegister} className="w-full" disabled={isLoading}>
              {isLoading ? <Loader2 className="animate-spin" /> : 'Continue & get 800 coins'}
          </Button>
          </div>
        </DialogContent>
      </Dialog>
      
      <BannedNotice 
        isOpen={!!bannedInfo}
        onOpenChange={(open) => !open && setBannedInfo(null)}
        gamingId={bannedInfo?.id || ''}
        banMessage={bannedInfo?.message || ''}
      />
    </>
  );
}
