

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { rewardAdCoins, getUserData, startAdSession } from '@/app/actions';
import { getRandomAd } from '../admin/(protected)/custom-ads/actions';
import { useToast } from '@/hooks/use-toast';
import { Loader2, X, Volume2, VolumeX, SkipForward } from 'lucide-react';
import type { CustomAd, User } from '@/lib/definitions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import GamingIdModal from '@/components/gaming-id-modal';


export default function WatchAdPage() {
  const [ad, setAd] = useState<CustomAd | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false);
  
  const [timeElapsed, setTimeElapsed] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isRewardGranted, setIsRewardGranted] = useState(false);
  const [showCta, setShowCta] = useState(false);
  
  const [shouldGrantReward, setShouldGrantReward] = useState(false);
  const [adToken, setAdToken] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const router = useRouter();
  const { toast } = useToast();
  const hasGrantedReward = useRef(false);

  useEffect(() => {
    async function fetchData() {
      const [adData, userData] = await Promise.all([getRandomAd(), getUserData()]);
      
      if (!userData) {
        setIsRegisterModalOpen(true);
        setIsLoading(false);
        return;
      }
      setUser(userData);

      if (adData) {
        setAd(adData);
        // Server-issued single-use token; the reward can only be claimed after the
        // server-side reward time has passed.
        const session = await startAdSession(String(adData._id));
        if (session.success) setAdToken(session.token);
      }
      setIsLoading(false);
    }
    fetchData();
  }, []);

  useEffect(() => {
      if (videoRef.current && ad) {
          videoRef.current.play().catch(error => {
              console.warn("Autoplay with sound failed. Muting video.", error);
              setIsMuted(true);
              if(videoRef.current) {
                videoRef.current.muted = true;
                videoRef.current.play();
              }
          });
      }
  }, [ad]);

  useEffect(() => {
    if (!ad || isLoading) return;
    
    // Timer for UI updates and reward granting
    const rewardTime = ad.rewardTime || ad.totalDuration;
    const interval = setInterval(() => {
      setTimeElapsed(prev => {
        const newTime = prev + 1;
        if (newTime >= 3) {
          setShowCta(true);
        }
        if (newTime >= rewardTime && !hasGrantedReward.current) {
          hasGrantedReward.current = true;
          setShouldGrantReward(true);
        }
        return newTime;
      });
    }, 1000);

    // Reliable timer for redirecting
    const redirectTimer = setTimeout(() => {
      setIsClosing(true);
    }, ad.totalDuration * 1000);

    return () => {
      clearInterval(interval);
      clearTimeout(redirectTimer);
    };
  }, [ad, isLoading]);
  
  useEffect(() => {
    if (!shouldGrantReward) return;
    setIsRewardGranted(true);
    if (!adToken) return; // no server session (e.g. not logged in): nothing to claim
    let cancelled = false;
    const claim = async (attempt: number) => {
      const result = await rewardAdCoins(adToken);
      if (cancelled) return;
      if (result.success) {
        toast({ title: 'Success!', description: result.message || "You've earned 5 coins!" });
      } else if (result.retryAfterMs && attempt < 3) {
        // Server clock says the reward time has not quite passed yet; try again shortly.
        setTimeout(() => claim(attempt + 1), result.retryAfterMs);
      }
    };
    claim(0);
    return () => {
      cancelled = true;
    };
  }, [shouldGrantReward, adToken, toast]);

  useEffect(() => {
    if (isClosing) {
        router.push('/');
    }
  }, [isClosing, router]);

  const handleCtaClick = useCallback(() => {
    if (ad) {
      window.open(ad.ctaLink, '_blank');
    }
  }, [ad]);
  
  const handleSkip = () => {
    router.push('/');
  }

  const renderContent = () => {
    if (isLoading || isClosing) {
      return (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-16 h-16 text-white animate-spin" />
        </div>
      );
    }
    
    if (!ad) {
        return (
             <div className="flex flex-col items-center justify-center h-full text-center text-white">
                <h1 className="text-2xl font-bold">No Active Ad</h1>
                <p className="text-lg mt-2">There is no ad available to watch right now. Please check back later.</p>
                <Button onClick={() => router.push('/')} className="mt-6">Go Back Home</Button>
            </div>
        )
    }

    const buttonShapeClass = {
        pill: 'rounded-full',
        rounded: 'rounded-lg',
        square: 'rounded-none'
    };

    const colorClasses = {
      primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
      destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      outline: 'bg-transparent border-2 border-white text-white hover:bg-white/10',
      blue: 'bg-blue-600 text-white hover:bg-blue-700',
      green: 'bg-green-600 text-white hover:bg-green-700',
      yellow: 'bg-yellow-500 text-black hover:bg-yellow-600',
      black: 'bg-black text-white hover:bg-gray-800',
      grey: 'bg-gray-500 text-white hover:bg-gray-600',
    }

    const showSkipButton = isRewardGranted && ad.rewardTime && ad.rewardTime < ad.totalDuration;

    return (
      <div className="relative w-full h-full">
        <div 
          className="absolute top-0 left-0 right-0 p-4 z-10 flex items-center gap-4 bg-gradient-to-b from-black/50 to-transparent"
        >
          <div className="w-full bg-white/20 rounded-full h-1 overflow-hidden">
            <div
              className="bg-white h-1 rounded-full animate-[progress-smooth_var(--duration)_linear_forwards]"
              style={{ '--duration': `${ad.totalDuration}s` } as React.CSSProperties}
            ></div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => setIsMuted(!isMuted)} variant="ghost" size="icon" className="text-white">
              {isMuted ? <VolumeX /> : <Volume2 />}
            </Button>
            {showSkipButton && (
                <Button onClick={handleSkip} variant="secondary" className="bg-white/80 hover:bg-white text-black backdrop-blur-sm rounded-full">
                    <SkipForward className="mr-2"/>
                    Skip Ad
                </Button>
            )}
          </div>
        </div>
        
        <div 
          className="w-full h-full cursor-pointer"
          onClick={handleCtaClick}
        >
            <video
              ref={videoRef}
              src={ad.videoUrl}
              autoPlay
              playsInline
              muted={isMuted}
              className="w-full h-full object-cover"
            />
        </div>
        
        {!ad.hideCtaButton && (
             <div className="fixed bottom-20 w-full flex justify-center">
              <div className={cn("transition-all duration-700", showCta ? 'animate-slide-in-up' : 'opacity-0')}>
                <Button 
                    onClick={handleCtaClick}
                    size="lg"
                    className={cn(
                      "text-lg h-12 px-8 font-bold relative overflow-hidden animate-glowing-ray", 
                      buttonShapeClass[ad.ctaShape], 
                      colorClasses[ad.ctaColor]
                    )}
                >
                {ad.ctaText}
                </Button>
              </div>
            </div>
        )}
      </div>
    );
  };

  return (
     <>
        <GamingIdModal isOpen={isRegisterModalOpen} onOpenChange={setIsRegisterModalOpen} />
         <div className="fixed inset-0 flex flex-col items-center justify-center bg-black w-full h-full">
           {renderContent()}
        </div>
     </>
  );
}
