import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, KeyRound } from 'lucide-react';

const VARIABLES: { name: string; help: string }[] = [
  { name: 'R2_ACCOUNT_ID', help: 'Cloudflare account ID (shown on the R2 overview page and in the S3 endpoint).' },
  { name: 'R2_ACCESS_KEY_ID', help: 'From the R2 API token you create for this bucket.' },
  { name: 'R2_SECRET_ACCESS_KEY', help: 'The secret shown once when the token is created.' },
  { name: 'R2_BUCKET', help: 'Bucket name, e.g. garena-images.' },
  { name: 'R2_PUBLIC_BASE_URL', help: 'Custom domain connected to the bucket, e.g. https://cdn.tofo.in' },
];

interface Props {
  missing: string[];
  error?: string;
}

export default function SetupNotice({ missing, error }: Props) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Object Manager needs a one-time setup
          </CardTitle>
          <CardDescription>
            This section manages the images in your Cloudflare R2 bucket. It needs an R2 API token stored on the server (never in the browser).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {missing.length > 0 && (
            <div>
              <p className="font-medium">Missing environment variables</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {missing.map((name) => (
                  <li key={name}>
                    <code className="rounded bg-muted px-1 py-0.5">{name}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            <p className="font-medium">1. Create the API token</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Cloudflare dashboard → R2 Object Storage → Manage R2 API Tokens → Create API token.</li>
              <li>Permission: <span className="text-foreground">Object Read &amp; Write</span>. Specify bucket: only your images bucket. TTL: Forever.</li>
              <li>Copy the Access Key ID and the Secret Access Key. The secret is shown only once.</li>
            </ol>
          </div>

          <div className="space-y-2">
            <p className="font-medium">2. Add these lines to <code className="rounded bg-muted px-1 py-0.5">.env</code> and restart the dev server</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              {VARIABLES.map((v) => `${v.name}=${v.name === 'R2_PUBLIC_BASE_URL' ? 'https://cdn.tofo.in' : ''}`).join('\n')}
            </pre>
            <ul className="space-y-1 text-muted-foreground">
              {VARIABLES.map((v) => (
                <li key={v.name}>
                  <code className="text-foreground">{v.name}</code>: {v.help}
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-2">
            <p className="font-medium">3. Production</p>
            <p className="text-muted-foreground">
              Set the same five variables in your hosting provider. On Firebase App Hosting store the two key values as secrets and reference them from
              <code className="mx-1 rounded bg-muted px-1 py-0.5">apphosting.yaml</code>; the other three can be plain env values.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
