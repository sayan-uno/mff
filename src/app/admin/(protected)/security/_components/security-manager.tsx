'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import type { SecurityOverview } from '@/lib/admin-auth/store';
import { Bell, Check, Copy, KeyRound, Loader2, LogOut, MessageCircle, ShieldCheck, XCircle } from 'lucide-react';
import { changeAdminPassword, logoutAllAdminSessions, regenerateAdminBackupCodes, sendTelegramTestAlert } from '../actions';

interface AttemptRow {
  ip: string;
  userAgent: string;
  kind: 'password' | 'code' | 'backup';
  success: boolean;
  at: string;
}

interface Props {
  overview: SecurityOverview;
  telegramConfigured: boolean;
  telegramChatHint: string;
  sessionHours: number;
  attempts: AttemptRow[];
}

export default function SecurityManager({ overview, telegramConfigured, telegramChatHint, sessionHours, attempts }: Props) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [regenPassword, setRegenPassword] = useState('');
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ variant: 'destructive', title: 'Passwords do not match' });
      return;
    }
    startTransition(async () => {
      const res = await changeAdminPassword({ currentPassword, newPassword });
      toast({ variant: res.success ? 'default' : 'destructive', title: res.success ? 'Password changed' : 'Not changed', description: res.message });
      if (res.success) {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        router.refresh();
      }
    });
  };

  const regenerate = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const res = await regenerateAdminBackupCodes({ currentPassword: regenPassword });
      if (res.success) {
        setNewCodes(res.codes);
        setRegenPassword('');
        router.refresh();
      } else {
        toast({ variant: 'destructive', title: 'Not regenerated', description: res.message });
      }
    });
  };

  const logoutEverywhere = () => {
    startTransition(async () => {
      const res = await logoutAllAdminSessions();
      toast({ variant: res.success ? 'default' : 'destructive', title: res.success ? 'Logged out everywhere' : 'Failed', description: res.message });
      if (res.success) {
        router.replace('/admin/login');
        router.refresh();
      }
    });
  };

  const testTelegram = () => {
    startTransition(async () => {
      const res = await sendTelegramTestAlert();
      toast({ variant: res.success ? 'default' : 'destructive', title: res.success ? 'Telegram works' : 'Telegram problem', description: res.message });
    });
  };

  const copyCodes = async () => {
    if (!newCodes) return;
    try {
      await navigator.clipboard.writeText(newCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ variant: 'destructive', title: 'Copy failed', description: 'Write the codes down manually.' });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck className="h-6 w-6" /> Admin Security
        </h1>
        <p className="text-sm text-muted-foreground">Password, Telegram login codes, backup codes and sessions for the admin panel.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Bell className="h-5 w-5" /> Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Telegram alerts">
              {telegramConfigured ? <Badge className="bg-green-600 hover:bg-green-700">Connected (chat {telegramChatHint})</Badge> : <Badge variant="destructive">Not configured</Badge>}
            </Row>
            <Row label="Password">
              {overview.initialized ? `Last changed ${formatDate(overview.passwordUpdatedAt)}` : 'Using the env password until the first Telegram login completes'}
            </Row>
            <Row label="Backup codes">
              {overview.initialized ? `${overview.backupCodesUnused} of ${overview.backupCodesTotal} unused · generated ${formatDate(overview.backupCodesUpdatedAt)}` : 'Created at first login'}
            </Row>
            <Row label="Sessions">Valid {sessionHours} hours after login · version {overview.sessionVersion}</Row>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={testTelegram} disabled={pending}>
              <MessageCircle className="mr-2 h-4 w-4" /> Send test alert
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" disabled={pending}>
                  <LogOut className="mr-2 h-4 w-4" /> Log out everywhere
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Log out everywhere?</AlertDialogTitle>
                  <AlertDialogDescription>Every admin session, including this one, becomes invalid immediately. You will need to log in again with your password and a Telegram code.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={logoutEverywhere}>Log out everywhere</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <KeyRound className="h-5 w-5" /> Change password
            </CardTitle>
            <CardDescription>At least 12 characters. Other devices are logged out; this one stays signed in. A Telegram alert is required for the change to go through.</CardDescription>
          </CardHeader>
          <form onSubmit={submitPassword}>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="current-password">Current password</Label>
                <Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required disabled={pending} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-password">New password</Label>
                <Input id="new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required disabled={pending} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input id="confirm-password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required disabled={pending} />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={pending || !overview.initialized}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Change password
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="h-5 w-5" /> Backup codes
            </CardTitle>
            <CardDescription>Five one-time codes for logging in if Telegram is unavailable. Regenerating replaces all existing codes.</CardDescription>
          </CardHeader>
          <form onSubmit={regenerate}>
            <CardContent className="space-y-1">
              <Label htmlFor="regen-password">Current password</Label>
              <Input id="regen-password" type="password" autoComplete="current-password" value={regenPassword} onChange={(e) => setRegenPassword(e.target.value)} required disabled={pending} />
            </CardContent>
            <CardFooter>
              <Button type="submit" variant="outline" disabled={pending || !overview.initialized}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Generate new backup codes
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Recent login activity</CardTitle>
            <CardDescription>Last 24 hours. Password, Telegram code and backup code attempts, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attempts recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Step</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>IP</TableHead>
                      <TableHead>Browser</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {attempts.map((a, i) => (
                      <TableRow key={`${a.at}-${i}`}>
                        <TableCell className="whitespace-nowrap">
                          <ClientDate iso={a.at} />
                        </TableCell>
                        <TableCell className="capitalize">{a.kind}</TableCell>
                        <TableCell>
                          {a.success ? (
                            <span className="flex items-center gap-1 text-green-600">
                              <Check className="h-4 w-4" /> OK
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-destructive">
                              <XCircle className="h-4 w-4" /> Failed
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{a.ip}</TableCell>
                        <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground" title={a.userAgent}>
                          {a.userAgent}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={newCodes !== null} onOpenChange={(open) => !open && setNewCodes(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your new backup codes</DialogTitle>
            <DialogDescription>Shown only once. Each works one time. The previous codes are now invalid.</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-2 rounded-md bg-muted p-3 font-mono text-sm sm:grid-cols-2">
            {(newCodes ?? []).map((code) => (
              <li key={code} className="rounded bg-background px-2 py-1 text-center tracking-wider">
                {code}
              </li>
            ))}
          </ul>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={copyCodes}>
              {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />} {copied ? 'Copied' : 'Copy all'}
            </Button>
            <Button type="button" onClick={() => setNewCodes(null)}>
              I have saved them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function ClientDate({ iso }: { iso: string }) {
  const [text, setText] = useState('');
  useEffect(() => setText(formatDate(iso)), [iso]);
  return <>{text}</>;
}
