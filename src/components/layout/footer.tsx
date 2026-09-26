import Link from 'next/link';
import Image from 'next/image';

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-muted/40 border-t">
      <div className="container mx-auto px-6 py-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="flex flex-col">
            <Link href="/" className="flex items-center gap-2 mb-4">
              <Image src="/img/garena.png" alt="Garena Logo" width={32} height={23} className="w-8 h-auto" />
              <span className="font-bold font-headline text-lg">Garena</span>
            </Link>
            <p className="text-muted-foreground text-sm max-w-sm">
              Your official, secure, and trusted source for discounted Free Fire items. Based in Singapore, we serve players globally.
            </p>
          </div>
          <div>
            <h3 className="font-headline font-semibold mb-4">Quick Links</h3>
            <ul className="space-y-2 text-sm">
              <li><Link href="/about" className="text-muted-foreground hover:text-primary transition-colors">About Us</Link></li>
              <li><Link href="/contact" className="text-muted-foreground hover:text-primary transition-colors">Contact</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="font-headline font-semibold mb-4">Legal</h3>
            <ul className="space-y-2 text-sm">
              <li><Link href="/terms" className="text-muted-foreground hover:text-primary transition-colors">Terms & Conditions</Link></li>
              <li><Link href="/privacy" className="text-muted-foreground hover:text-primary transition-colors">Privacy Policy</Link></li>
              <li><Link href="/refund" className="text-muted-foreground hover:text-primary transition-colors">Refund Policy</Link></li>
              <li><Link href="/delivery-policy" className="text-muted-foreground hover:text-primary transition-colors">Delivery Policy</Link></li>
            </ul>
          </div>
        </div>
        <div className="mt-8 border-t pt-6 text-center text-sm text-muted-foreground">
          <p>&copy; {year} Garena. All rights reserved. This is an official website of Garena, Headquartered in Singapore.</p>
        </div>
      </div>
    </footer>
  );
}
