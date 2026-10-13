# ThemeBot Cloud on a Hostinger VPS: runbook

This folder holds everything needed to run ThemeBot Cloud (accounts, seats, passes, the build recipe
and QA scoring) on one small Linux server. Nothing here runs by itself. Every step below is one you
start yourself.

```
customer's ThemeBot app ──HTTPS──▶ Caddy (ports 80/443, automatic certificate)
                                     │
                                     ▼ 127.0.0.1:8800 (not reachable from outside)
                                   ThemeBot Cloud (Node 24, user "themebot")
                                     │
                                     ▼
                                   /var/lib/themebot-cloud/cloud.sqlite  ──nightly──▶ /var/backups/themebot-cloud
```

| File | What it is |
|---|---|
| `setup-server.sh` | First-time server setup. Run once on the server; it is safe to run again later. |
| `deploy.sh` | Run on your PC. Builds, tests, uploads and switches to a new version, and rolls back on failure. Also does `--rollback`, `--status`, `--list` and `--logs`. |
| `cloud.env.example` | Every setting, with comments. Becomes `/etc/themebot-cloud/cloud.env` on the server. |
| `gen-secrets.mjs` | Makes the signing key, pepper and admin token. Also prints the public key and rotates the admin token. |
| `themebot-cloud.service` | The systemd service, locked down. It listens on 127.0.0.1:8800 only. |
| `Caddyfile` | The HTTPS front door: certificates, body size limits, security headers and the access log. |
| `backup.sh`, `themebot-cloud-backup.service/.timer` | Nightly database backup kept for 14 days, plus `list` and `restore`. |

On the server, files end up here:

| Path | Contents | Who can read it |
|---|---|---|
| `/opt/themebot-cloud/releases/<time>-<commit>/` | One folder per version: `cloud.mjs`, `recipe/`, `release.json` | everyone (read-only) |
| `/opt/themebot-cloud/current` | Points at the release that is running | |
| `/etc/themebot-cloud/cloud.env` | Settings and secrets | root only |
| `/var/lib/themebot-cloud/` | The database | themebot only |
| `/var/backups/themebot-cloud/` | Database backups | themebot only |
| `/var/log/caddy/themebot-cloud-access.log` | Access log (no tokens or headers) | caddy |

---

## 1. What to buy or prepare (once)

1. **A Hostinger KVM VPS** with the **Ubuntu 24.04** template. KVM 1 is enough to start with. In
   hPanel, note the server's **IP address** and set a **root password**.
2. **A domain or subdomain** for the Cloud, for example `cloud.yourdomain.com`. A subdomain of a
   domain you already own is fine. This address is built into every installer, so pick one you will
   keep.
3. **A Resend account** (resend.com), which sends the 6-digit sign-in codes:
   - Domains → **Add Domain**, for example `mail.yourdomain.com`. Add the DNS records Resend shows you
     and wait until the domain says **Verified**.
   - API Keys → **Create API Key** with "Sending access". Copy the key (`re_…`).
   - Choose the sender, for example `ThemeBot <login@mail.yourdomain.com>`. Its domain must be the
     verified one.
4. **Lemon Squeezy** (payments), which can wait until you sell:
   - Settings → Webhooks → **+**. URL: `https://cloud.yourdomain.com/v1/webhooks/lemonsqueezy`.
     Make up a **signing secret**; to generate one, run
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
     Events: `order_created`, `order_refunded` and every `subscription_*` event.
   - Write down your **store id**, the **product id** of ThemeBot and the **variant id** of each
     plan, plus how many computers (seats) each plan allows. Only these grant a ThemeBot account
     (`LEMONSQUEEZY_VARIANT_SEATS` / `LEMONSQUEEZY_PRODUCT_IDS`); anything else your store sells is
     ignored. With neither set, the live Cloud grants nothing. Test-mode purchases are ignored on
     the live Cloud unless `LEMONSQUEEZY_ALLOW_TEST_MODE=1`.
5. **On your PC**:
   - Git for Windows, which gives you **Git Bash**. Run every `./deploy/...` command in Git Bash from
     the repository folder.
   - **Node.js 24**.
   - This repository on branch `desktop-electron`, with `npm ci` done.
6. **A password manager entry** called "ThemeBot Cloud". It will hold the settings file from step 3e.

## 2. DNS: point the domain at the server

At the company that runs DNS for your domain (Hostinger: hPanel → Domains → DNS / Nameservers):

| Type | Name | Points to | TTL |
|---|---|---|---|
| `A` | `cloud` (the part before your domain) | the VPS IPv4 address | 300 (or the default) |

- Do **not** add an `AAAA` (IPv6) record unless you know the server's IPv6 address is right. A wrong
  one stops the certificate from being issued.
- Check it from Git Bash with `nslookup cloud.yourdomain.com`. The answer must be the VPS IP. This
  can take a few minutes, and sometimes up to an hour.

## 3. First-time server setup (once)

**a. Use an SSH key instead of the root password.** In Git Bash on your PC:

```bash
ssh-keygen -t ed25519            # press Enter at every question (or set a passphrase)
cat ~/.ssh/id_ed25519.pub | ssh root@YOUR_SERVER_IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys"
ssh root@YOUR_SERVER_IP          # should now log in without the password; type "exit" to leave
```

Instead of the `cat …` line, you can paste the contents of `~/.ssh/id_ed25519.pub` into hPanel →
VPS → Settings → SSH keys.

**b. Check Hostinger's firewall.** If hPanel → VPS → Security → Firewall has rules enabled, allow
TCP 22, 80 and 443 there. The server sets up its own firewall as well.

**c. Copy this folder to the server.** In Git Bash, from the repository folder:

```bash
scp -r deploy root@YOUR_SERVER_IP:/root/themebot-deploy
```

**d. Run the setup on the server.** It takes about 3–5 minutes:

```bash
ssh root@YOUR_SERVER_IP
cd /root/themebot-deploy
CLOUD_DOMAIN=cloud.yourdomain.com ACME_EMAIL=you@yourdomain.com bash setup-server.sh
```

The script installs updates, Node.js 24, Caddy, SQLite and the firewall (it leaves only SSH, 80 and
443 open). It also turns on daily automatic security updates, creates the `themebot` user and the
folders, installs the services, and **generates the three secrets** (signing key, pepper and admin
token) into `/etc/themebot-cloud/cloud.env`. At the end it prints what is still missing and the
**public key**.

**e. Fill in the rest of the settings** while still on the server:

```bash
nano /etc/themebot-cloud/cloud.env
```

Fill in `RESEND_API_KEY=` and `MAIL_FROM="ThemeBot <login@mail.yourdomain.com>"` (keep the quotes).
If you already have them, also fill in the `LEMONSQUEEZY_…` lines. To save in nano, press **Ctrl+O**,
then **Enter**, then **Ctrl+X**.

**f. Save a copy of the settings file in your password manager.** This step matters:

```bash
cat /etc/themebot-cloud/cloud.env
```

Copy the whole output into the password manager entry. If the server is ever lost, this file and a
database backup are everything you need to rebuild it (see part 7). Without this file, every
installed app is locked out.

**g. Deploy the app for the first time.** Back on your PC, in Git Bash, from the repository folder:

```bash
HOST=YOUR_SERVER_IP ./deploy/deploy.sh
```

**h. Check it from your PC:**

```bash
curl https://cloud.yourdomain.com/v1/health        # {"ok":true,"name":"ThemeBot Cloud",...}
curl https://cloud.yourdomain.com/v1/public-key    # {"algorithm":"Ed25519","publicKey":"..."}
```

If HTTPS does not answer yet, the certificate is usually still waiting for DNS (part 2). Caddy
retries by itself. To watch it, run `ssh root@YOUR_SERVER_IP journalctl -u caddy -n 50`.

**i. Create your first account.** You can wait for a Lemon Squeezy purchase, or create one with the
admin API (the token is `ADMIN_TOKEN` from the settings file):

```bash
A="Authorization: Bearer YOUR_ADMIN_TOKEN"; C=https://cloud.yourdomain.com
curl -H "$A" -H 'Content-Type: application/json' -d '{"email":"you@yourdomain.com","plan":"studio","seats":3,"expiresAt":null}' $C/v1/admin/accounts
```

More admin calls are listed in `docs/DESKTOP.md` under "Admin calls". Use the same commands with
`C=https://cloud.yourdomain.com`.

## 4. Build installers that use the production Cloud

An installer is tied to one Cloud. The build pins the Cloud's **address** and its **public key**,
and neither value is secret.

**On your PC (Git Bash).** Run this on each operating system you build for:

```bash
export THEMEBOT_CLOUD_URL=https://cloud.yourdomain.com
export THEMEBOT_CLOUD_PUBKEY=$(curl -s $THEMEBOT_CLOUD_URL/v1/public-key | node -pe "JSON.parse(require('fs').readFileSync(0)).publicKey")
echo $THEMEBOT_CLOUD_PUBKEY      # 44 characters ending in "="
npm run desktop:pack             # installers land in release/
```

The same in PowerShell:

```powershell
$env:THEMEBOT_CLOUD_URL = 'https://cloud.yourdomain.com'
$env:THEMEBOT_CLOUD_PUBKEY = (Invoke-RestMethod "$env:THEMEBOT_CLOUD_URL/v1/public-key").publicKey
npm run desktop:pack
```

You can also print the public key without the server running. On the server, run
`node /usr/local/lib/themebot-cloud/gen-secrets.mjs --pubkey /etc/themebot-cloud/cloud.env`.

**On GitHub Actions** (`.github/workflows/desktop.yml`), go to Settings → Secrets and variables →
Actions → **Variables** and add `THEMEBOT_CLOUD_URL` and `THEMEBOT_CLOUD_PUBKEY`. Every run then
builds Cloud installers for Windows, macOS and Linux as downloadable artifacts. The workflow never
publishes anything.

Building an installer does not release it. Sending installers to customers or uploading an update
feed is a separate decision, covered in docs/DESKTOP.md under "Releasing an update".

**Tip:** keep those two `export` lines set when you run `deploy.sh`. It then also checks HTTPS from
your PC, and it warns you if the server's key no longer matches the one your installers carry.

## 5. Deploy a new version

From the repository folder in Git Bash:

```bash
HOST=YOUR_SERVER_IP ./deploy/deploy.sh
```

The script:

1. builds the Cloud (`npm run cloud:build`), producing `build/cloud/` at about 1.4 MB;
2. smoke-tests the build on your PC: production mode, throwaway secrets, 127.0.0.1 only, and no email
   is sent;
3. uploads it as a new release folder named `<date>-<time>-<commit>`;
4. backs up the database, which is labelled `pre-deploy-<release>`;
5. switches `current` to the new release and restarts the service;
6. checks `/v1/health` on the server for up to about 40 seconds.

If the new version is not healthy, the script prints the last log lines, **switches back to the
previous release by itself** and stops with an error. The server keeps the last 5 releases (change
this with `KEEP_RELEASES=8`).

Options: `SSH_USER=` (default `root`), `SSH_PORT=` (default 22), `SSH_KEY=~/.ssh/other_key`, and
`SKIP_BUILD=1` to upload `build/cloud` as it is.

Changes to `setup-server.sh`, the service file or the Caddyfile are **not** copied by `deploy.sh`.
After changing one of them, copy the folder again (step 3c) and re-run `setup-server.sh` (step 3d).
Re-running is safe. Your settings file is never overwritten, and any config file it replaces is kept
as `<file>.bak-<time>`.

## 6. Roll back

```bash
HOST=YOUR_SERVER_IP ./deploy/deploy.sh --list                  # releases on the server, * = current
HOST=YOUR_SERVER_IP ./deploy/deploy.sh --rollback              # back to the previous one
HOST=YOUR_SERVER_IP ./deploy/deploy.sh --rollback 20261004-153012-1a2b3c4d5e6f   # a specific one
```

A rollback changes the code only, not the database. Database changes only ever add things, so an
older version normally runs fine on a newer database. If a bad version damaged data, restore the
`pre-deploy-<release>` backup that was taken just before it (part 7).

## 7. Backups and restore

**Automatic.** Every night at about 03:17 server time (UTC on Hostinger), the server takes a
consistent copy of the live database. It checks the copy (`integrity_check`), compresses it, and
stores it in `/var/backups/themebot-cloud/`. Copies are kept for 14 days. Every deploy also takes
one first.

On the server:

```bash
themebot-cloud-backup list                         # newest first
sudo themebot-cloud-backup backup manual           # take one now
systemctl list-timers themebot-cloud-backup        # when the next one runs
journalctl -u themebot-cloud-backup -n 20          # how the last ones went
```

**Copy one to your PC** (Git Bash):

```bash
scp root@YOUR_SERVER_IP:/var/backups/themebot-cloud/cloud-20261004T031700Z-nightly.sqlite.gz .
```

**Restore.** The script checks the backup, takes a safety copy of the current database, stops the
Cloud, puts the backup in place and starts the Cloud again:

```bash
sudo themebot-cloud-backup restore /var/backups/themebot-cloud/cloud-20261004T031700Z-nightly.sqlite.gz
```

The replaced database is kept in `/var/lib/themebot-cloud/replaced-<time>/`. Delete it once you are
happy with the restore. Everything since the backup is lost, including sign-ins, new accounts and
webhook events. Lemon Squeezy events can be re-sent from its dashboard.

**Offsite copy (recommended once you have customers).** Backups on the server do not survive losing
the server. `backup.sh` has commented instructions for copying each backup to Backblaze B2, S3 or
Google Drive with rclone (use an encrypted remote). Hostinger's own VPS backups and snapshots in
hPanel are a useful extra layer.

**What a backup does not contain** is `/etc/themebot-cloud/cloud.env`. That file lives in your
password manager (step 3f). The database cannot be used without the same `CLOUD_PEPPER`.

**Moving to a new server (disaster recovery):**

1. Set up the new server with parts 3a–3d.
2. **Replace** the freshly generated `/etc/themebot-cloud/cloud.env` with the copy from your password
   manager (`nano`, paste, save). The new server made new secrets that installed apps do not know.
3. Copy your newest backup to the server with
   `scp cloud-….sqlite.gz root@NEW_IP:/root/`. Then run `HOST=NEW_IP ./deploy/deploy.sh`, followed by
   `sudo themebot-cloud-backup restore /root/cloud-….sqlite.gz`.
4. Point the DNS `A` record at the new IP (part 2). Installed apps reconnect by themselves.

## 8. Rotate ADMIN_TOKEN

Do this if the admin token might have been seen by anyone. It is safe to do at any time, and
customers are not affected:

```bash
ssh root@YOUR_SERVER_IP
node /usr/local/lib/themebot-cloud/gen-secrets.mjs --rotate-admin-token /etc/themebot-cloud/cloud.env
systemctl restart themebot-cloud
```

Put the new token (printed by the first command) in your password manager.

## 9. CLOUD_SIGNING_KEY and CLOUD_PEPPER: never change them casually

- **`CLOUD_SIGNING_KEY`** signs every pass. Its public half is **built into every installer**
  (`THEMEBOT_CLOUD_PUBKEY`). If you change it, **every installed app stops working** until the
  customer installs a new build made with the new public key, and the Cloud cannot accept the old
  key and the new key at the same time. Only rotate it if it has leaked, and plan it like a release:
  1. Make a new key with `node gen-secrets.mjs`.
  2. Build new installers with the new public key.
  3. Get them to customers.
  4. Swap the key in `cloud.env` and restart.

  `deploy.sh` warns you if the live key ever stops matching your `THEMEBOT_CLOUD_PUBKEY`.
- **`CLOUD_PEPPER`** is mixed into every stored token and hash and into the prompt watermarks.
  Changing it **signs every customer out** and breaks leak tracing for prompts already sent. Never
  rotate it.
- Both live only in `cloud.env` and your password manager. They are never in git, a release or a
  backup.

## 10. Check health and logs

From your PC:

```bash
HOST=YOUR_SERVER_IP ./deploy/deploy.sh --status   # release, service state, health, key, disk, backups, last log lines
HOST=YOUR_SERVER_IP ./deploy/deploy.sh --logs     # live log (Ctrl+C to stop)
curl https://cloud.yourdomain.com/v1/health
```

On the server:

```bash
systemctl status themebot-cloud                    # running? since when?
journalctl -u themebot-cloud -n 100                # app log (one JSON line per event)
journalctl -u themebot-cloud --since "1 hour ago" | grep '"level":"error"'
journalctl -u caddy -n 50                          # certificates, proxy errors
tail -f /var/log/caddy/themebot-cloud-access.log   # every request (no tokens or headers)
df -h /                                            # disk space
cat /opt/themebot-cloud/current/release.json       # which version, recipe and commit is live
```

## 11. Maintenance (about once a month)

Ubuntu security updates install themselves every day. Node.js and Caddy updates are installed by
hand:

```bash
ssh root@YOUR_SERVER_IP
apt update && apt upgrade -y
systemctl restart themebot-cloud                   # picks up a new Node.js, if one came in
ls /var/run/reboot-required 2>/dev/null && reboot  # only if an update asks for it (about 1 minute offline)
```

While the Cloud is briefly offline, running builds keep going on customers' computers. Sign-ins and
new builds simply wait and retry. To let the server reboot itself after kernel updates, set
`Automatic-Reboot "true"` in `/etc/apt/apt.conf.d/52themebot-unattended-upgrades`.

**Optional extra lock on the admin API.** In `/etc/caddy/Caddyfile`, uncomment the `@admin_outside`
block, put in your own IP address, then run `systemctl reload caddy`. Keep the same change in this
folder's `Caddyfile`, or the next `setup-server.sh` run will undo it.

## 12. When something goes wrong

| Symptom | What to do |
|---|---|
| `deploy.sh` says "fill in … in /etc/themebot-cloud/cloud.env" | Step 3e. The Cloud refuses to start without the signing key, pepper, Resend key and sender. |
| HTTPS does not work, but `--status` says healthy | DNS is not pointing at the server yet, or ports 80/443 are closed in Hostinger's firewall (step 3b). Check with `journalctl -u caddy -n 50`. |
| Sign-in emails do not arrive | Check `journalctl -u themebot-cloud \| grep "mail send failed"`. Usually the Resend domain is not verified or `MAIL_FROM` uses another domain. |
| Purchases do not create accounts | `LEMONSQUEEZY_WEBHOOK_SECRET` must match the webhook's signing secret exactly. Lemon Squeezy shows each delivery and its answer: `not a ThemeBot product` or `no ThemeBot product allowlist` means the variant/product ids are missing from `LEMONSQUEEZY_VARIANT_SEATS` / `LEMONSQUEEZY_PRODUCT_IDS`; `test mode` means a test purchase on the live Cloud. Fix the setting, restart, then resend the delivery from Lemon Squeezy. |
| A purchase did not change an existing account | Another purchase under an email that already has access is held, not applied. See `billingConflicts` with `GET /v1/admin/billing-conflicts`, then adopt or dismiss it (docs/DESKTOP.md, "Admin calls"). |
| Customers see "update required" | `MIN_APP_VERSION`, or the admin setting `minAppVersion`, is newer than their app. |
| The service will not start and the log says "Operation not permitted" | A locked-down system call blocked something. In `/etc/systemd/system/themebot-cloud.service`, put `#` in front of the `SystemCallFilter=` lines, then run `systemctl daemon-reload && systemctl restart themebot-cloud`, and tell your developer. |
| `$'\r': command not found` | The scripts were saved with Windows line endings. On the server, run `sed -i 's/\r$//' /root/themebot-deploy/*.sh` and try again. |
| `deploy.sh` asks for a sudo password | Deploy as `root` (the default), or give that user passwordless sudo. |
| "another deploy or rollback is running" | Wait for the other one to finish. The lock frees itself when it ends. |

## How the pieces were checked

None of this has been run on a server. The following was checked locally on Windows:

- `npm run cloud:build -- --smoke` builds the bundle and runs it on 127.0.0.1 in production mode with
  throwaway secrets. `/v1/health` and `/v1/public-key` answer, and the public key matches the
  throwaway key. The Cloud refuses to start without each required setting and without its recipe.
- The bundled recipe is checked file by file against `cloud/recipe` on every build.
- `gen-secrets.mjs --fill` writes a settings file whose key the bundle reads, and the key served
  matches `--pubkey`.
- `backup.sh` backs up, checks, lists and prunes using the node:sqlite fallback.
- The `Caddyfile` passes `caddy validate`, `caddy adapt` and `caddy fmt` (Caddy 2.11.7). The body
  limits and headers were tested through a local Caddy.
- The shell scripts pass `bash -n` and `shellcheck`.
- The systemd units have not been verified with `systemd-analyze verify`, which is not available on
  Windows. After setup, run `systemd-analyze verify /etc/systemd/system/themebot-cloud*.service` on
  the server.
