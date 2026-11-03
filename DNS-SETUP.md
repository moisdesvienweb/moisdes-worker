# Domain / DNS setup — read this if the site ever breaks or needs moving

Personal reminder, written down so it survives even if nobody touches
this for years. If chatzarvien.org (or any future domain on this
project) stops resolving, shows the wrong site, or a fresh deploy "isn't
showing up," check these two places first.

## 1. Cloudflare — Workers custom domains

This Worker (`moisdes-worker`) must have the custom domain attached
**twice**: once with `www` and once without.

- Cloudflare dashboard → Workers & Pages → **moisdes-worker** → Settings
  → Domains & Routes → Add:
  - `chatzarvien.org`
  - `www.chatzarvien.org`

Both need to point at this Worker. If only one is attached, the other
variant of the URL will 404, fail to resolve, or serve something stale
instead of this site.

## 2. Squarespace — DNS (CNAME)

The domain's DNS is managed through Squarespace (that's where it's
registered/pointed from), not Cloudflare's own DNS. There's a **CNAME
record whose value needs to be correct** — it was wrong/needed fixing as
of the last time this was checked (2026-11-03). Squarespace's domain
settings → DNS → find the CNAME record for this domain and make sure its
value actually points at the right target for Cloudflare.

**When you're actually troubleshooting this**: get the exact CNAME
target Cloudflare currently expects from the Workers custom-domain
screen in step 1 above (it shows the correct value to use once the
domain is added there) — don't guess it from this note, Cloudflare's
expected value can change.

## Quick mental checklist

- [ ] Cloudflare: Worker has both `chatzarvien.org` and
      `www.chatzarvien.org` as custom domains.
- [ ] Squarespace: CNAME record value matches what Cloudflare's custom
      domain screen currently says it should be.
