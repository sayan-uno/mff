
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { logoutAdmin } from '@/app/actions';
import { Home, ListChecks, ListX, Users, LogOut, Banknote, Tag, ArchiveRestore, Coins, ShieldBan, Box, EyeOff, Bell, CalendarPlus, MessageCircle, SlidersHorizontal, FileCode, PersonStanding, BadgeCheck, History, Clapperboard, BellRing, GalleryHorizontal, Timer, MessageSquareText, ShieldX, Fingerprint, Ban, Download, Activity, CreditCard, Headset, ReceiptText, TrendingUp, ShieldAlert, FolderOpen, ShieldCheck, Wifi, ChartColumn } from 'lucide-react';
import { cn } from '@/lib/utils';
import Image from 'next/image';

const navItems = [
  { href: '/admin', label: 'Pending Orders', icon: Home },
  { href: '/admin/master', label: 'Master', icon: ShieldAlert },
  { href: '/admin/promoted-ids', label: 'Promoted IDs', icon: BadgeCheck },
  { href: '/admin/visualize-id', label: 'Visualize ID', icon: PersonStanding },
  { href: '/admin/active-users', label: 'Active Users', icon: Activity },
  { href: '/admin/online', label: 'Online Now', icon: Wifi },
  { href: '/admin/ad-analytics', label: 'Ad Analytics', icon: ChartColumn },
  { href: '/admin/users', label: 'User Management', icon: ShieldBan },
  { href: '/admin/notifications', label: 'Send Notification', icon: Bell },
  { href: '/admin/html-notifier', label: 'HTML Notifier', icon: FileCode },
  { href: '/admin/support', label: 'Support Inbox', icon: Headset },
  { href: '/admin/refunds', label: 'Accepted Refunds', icon: ReceiptText },
  { href: '/admin/payment-sessions', label: 'Payment Sessions', icon: Timer },
  { href: '/admin/earning-history', label: 'Earning History', icon: TrendingUp },
  { href: '/admin/upi-management', label: 'UPI Management', icon: CreditCard },
  { href: '/admin/sms-logs', label: 'SMS Logs', icon: MessageSquareText },
  { href: '/admin/ai-logs', label: 'AI Logs', icon: MessageCircle },
  { href: '/admin/users-notification', label: 'Users Notification', icon: BellRing },
  { href: '/admin/price-management', label: 'Price Management', icon: Tag },
  { href: '/admin/ip-logger', label: 'User Security Logs', icon: Fingerprint },
  { href: '/admin/success', label: 'Successful Orders', icon: ListChecks },
  { href: '/admin/failed', label: 'Failed Orders', icon: ListX },
  { href: '/admin/all-orders', label: 'All Orders', icon: Box },
  { href: '/admin/accounts', label: 'Registered Accounts', icon: Users },
  { href: '/admin/banned-users', label: 'Banned Users', icon: ShieldX },
  { href: '/admin/hidden-users', label: 'Hidden Users', icon: EyeOff },
  { href: '/admin/user-product-controls', label: 'User-Product Control', icon: SlidersHorizontal },
  { href: '/admin/disabled-redeem-users', label: 'Disabled Redeem Users', icon: FileCode },
  { href: '/admin/login-history', label: 'Login History', icon: History },
  { href: '/admin/block-management', label: 'Block Management', icon: Ban },
  { href: '/admin/withdrawals', label: 'Withdrawals', icon: Banknote },
  { href: '/admin/vanished-products', label: 'Vanished Products', icon: ArchiveRestore },
  { href: '/admin/coin-management', label: 'Coin Management', icon: Coins },
  { href: '/admin/events', label: 'Manage Events', icon: CalendarPlus },
  { href: '/admin/custom-ads', label: 'Custom Ad Management', icon: Clapperboard },
  { href: '/admin/slider-management', label: 'Slider Management', icon: GalleryHorizontal },
  { href: '/admin/object-manager', label: 'Object Manager', icon: FolderOpen },
  { href: '/admin/security', label: 'Admin Security', icon: ShieldCheck },
  { href: '/admin/downloads', label: 'Download Section', icon: Download },
];

export default function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    await logoutAdmin();
    router.push('/admin/login');
  };

  return (
    <aside className="hidden md:flex flex-col w-64 border-r bg-background">
      <div className="flex items-center justify-center h-16 border-b">
        <Link href="/admin" className="flex items-center gap-2 font-semibold">
          <Image src="/img/garena.png" alt="Garena Logo" width={24} height={24} />
          <span>Garena Admin</span>
        </Link>
      </div>
      <nav className="flex-1 p-4 space-y-2">
        {navItems.map((item) => (
          <Button
            key={item.href}
            asChild
            variant={pathname === item.href ? 'secondary' : 'ghost'}
            className="w-full justify-start"
          >
            <Link href={item.href}>
              <item.icon className="mr-2 h-4 w-4" />
              {item.label}
            </Link>
          </Button>
        ))}
      </nav>
      <div className="p-4 mt-auto border-t">
        <Button variant="outline" className="w-full justify-start" onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          Logout
        </Button>
      </div>
    </aside>
  );
}
