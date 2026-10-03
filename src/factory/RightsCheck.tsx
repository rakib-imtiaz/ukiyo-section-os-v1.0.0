// "I'm allowed to copy this site" — required before a build starts. The server refuses customer
// builds without it and keeps a record of who confirmed it and when.
import { ShieldCheck } from 'lucide-react';

export function RightsCheck({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border bg-card/60 px-3.5 py-3 text-[13.5px] leading-snug">
      <input type="checkbox" className="mt-0.5 size-4 accent-[hsl(var(--primary))]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="flex items-center gap-1.5 font-semibold"><ShieldCheck className="size-4 text-primary" /> I own this website, or I have the owner's permission</span>
        <span className="mt-0.5 block text-muted-foreground">ThemeBot copies the site's design and content into a Shopify theme. Only build sites you have the rights to.</span>
      </span>
    </label>
  );
}
