'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, MessageCircle, ShieldCheck } from 'lucide-react';
import {
  cancelAdminLogin,
  loginWithAdminBackupCode,
  resendAdminLoginCode,
  startAdminLogin,
  verifyAdminLoginCode,
  type LoginStepResult,
} from '../actions';

type Step = 'password' | 'code' | 'backup' | 'codes';

const RESEND_COOLDOWN_SEC = 30;

export default function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number>(0);
  const [sendsLeft, setSendsLeft] = useState(0);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pending, startTransition] = useTransition();
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Ticks once a second while a code is pending, for the countdown texts.
  useEffect(() => {
    if (step !== 'code') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);

  useEffect(() => {
    if (step === 'code') codeInputRef.current?.focus();
  }, [step]);

  const goToLogin = useCallback(() => {
    router.replace('/admin');
    router.refresh();
  }, [router]);

  const handleResult = useCallback(
    (result: LoginStepResult) => {
      if (result.status === 'code_sent') {
        setStep('code');
        setCode('');
        setError(null);
        setExpiresAt(Date.now() + result.expiresInSec * 1000);
        setResendAt(Date.now() + RESEND_COOLDOWN_SEC * 1000);
        setSendsLeft(result.sendsLeft);
        return;
      }
      if (result.status === 'ok') {
        if (result.backupCodes && result.backupCodes.length > 0) {
          setBackupCodes(result.backupCodes);
          setStep('codes');
          setError(null);
        } else {
          goToLogin();
        }
        return;
      }
      setError(result.message);
      if (result.restart) {
        setStep('password');
        setPassword('');
        setCode('');
        setBackupCode('');
        setExpiresAt(null);
      }
    },
    [goToLogin]
  );

  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || pending) return;
    setError(null);
    startTransition(async () => handleResult(await startAdminLogin({ password })));
  };

  const submitCode = useCallback(
    (value: string) => {
      if (pending) return;
      setError(null);
      startTransition(async () => handleResult(await verifyAdminLoginCode({ code: value })));
    },
    [handleResult, pending]
  );

  const onCodeChange = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6) submitCode(digits);
  };

  const resend = () => {
    if (pending || now < resendAt) return;
    setError(null);
    startTransition(async () => handleResult(await resendAdminLoginCode()));
  };

  const submitBackup = (event: React.FormEvent) => {
    event.preventDefault();
    if (!backupCode.trim() || pending) return;
    setError(null);
    startTransition(async () => handleResult(await loginWithAdminBackupCode({ code: backupCode })));
  };

  const startOver = () => {
    setError(null);
    setStep('password');
    setPassword('');
    setCode('');
    setBackupCode('');
    setExpiresAt(null);
    startTransition(async () => {
      await cancelAdminLogin();
    });
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed. Write the codes down manually.');
    }
  };

  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));

  const errorBox = error && (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error}</span>
    </div>
  );

  if (step === 'password') {
    return (
      <form onSubmit={submitPassword} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="admin-password">Password</Label>
          <Input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
          />
        </div>
        {errorBox}
        <Button type="submit" className="w-full" disabled={pending || !password}>
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking…
            </>
          ) : (
            'Continue'
          )}
        </Button>
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <MessageCircle className="h-3.5 w-3.5" /> A one-time code is sent to your Telegram after the password.
        </p>
      </form>
    );
  }

  if (step === 'code') {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-muted p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <MessageCircle className="h-4 w-4" /> Code sent to your Telegram
          </p>
          <p className="mt-1 text-muted-foreground">
            {secondsLeft > 0 ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'The code has expired.'}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="admin-code">6-digit code</Label>
          <Input
            ref={codeInputRef}
            id="admin-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="••••••"
            className="text-center text-2xl tracking-[0.5em]"
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && code.length === 6 && submitCode(code)}
            disabled={pending}
          />
        </div>
        {errorBox}
        <Button type="button" className="w-full" onClick={() => submitCode(code)} disabled={pending || code.length !== 6}>
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying…
            </>
          ) : (
            'Verify and sign in'
          )}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <button type="button" className="text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50" onClick={resend} disabled={pending || resendIn > 0 || sendsLeft <= 0}>
            {sendsLeft <= 0 ? 'No resends left' : resendIn > 0 ? `Resend code in ${resendIn}s` : `Resend code (${sendsLeft} left)`}
          </button>
          <button type="button" className="text-muted-foreground hover:underline" onClick={() => { setError(null); setStep('backup'); }} disabled={pending}>
            Use a backup code
          </button>
        </div>
        <button type="button" className="w-full text-center text-xs text-muted-foreground hover:underline" onClick={startOver} disabled={pending}>
          Start over
        </button>
      </div>
    );
  }

  if (step === 'backup') {
    return (
      <form onSubmit={submitBackup} className="space-y-4">
        <div className="rounded-md bg-muted p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <KeyRound className="h-4 w-4" /> Backup code
          </p>
          <p className="mt-1 text-muted-foreground">Each backup code works once. Using one sends an alert to your Telegram.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="admin-backup">Backup code</Label>
          <Input
            id="admin-backup"
            autoFocus
            autoComplete="off"
            placeholder="XXXX-XXXX-XXXX"
            className="font-mono uppercase"
            value={backupCode}
            onChange={(event) => setBackupCode(event.target.value)}
            disabled={pending}
          />
        </div>
        {errorBox}
        <Button type="submit" className="w-full" disabled={pending || !backupCode.trim()}>
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying…
            </>
          ) : (
            'Sign in with backup code'
          )}
        </Button>
        <button type="button" className="w-full text-center text-sm text-muted-foreground hover:underline" onClick={() => { setError(null); setStep('code'); }} disabled={pending}>
          Back to Telegram code
        </button>
      </form>
    );
  }

  // step === 'codes': first login created the security record; show the backup codes once.
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="h-4 w-4" /> Save your backup codes now
        </p>
        <p className="mt-1 text-muted-foreground">
          They are shown only this once. Each works one time, if Telegram is ever unavailable. Keep them in a password manager or on paper, never in the project.
        </p>
      </div>
      <ul className="grid gap-2 rounded-md bg-muted p-3 font-mono text-sm sm:grid-cols-2">
        {backupCodes.map((item) => (
          <li key={item} className="rounded bg-background px-2 py-1 text-center tracking-wider">
            {item}
          </li>
        ))}
      </ul>
      {errorBox}
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={copyCodes}>
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />} {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button type="button" className="flex-1" onClick={goToLogin}>
          I have saved them, continue
        </Button>
      </div>
      <p className="text-center text-xs text-muted-foreground">You can generate a new set any time in Admin → Admin Security.</p>
    </div>
  );
}
