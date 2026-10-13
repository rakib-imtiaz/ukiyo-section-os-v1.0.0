# ThemeBot — project log (plain-language notes for future me)

Newest entries at the top. No passwords or keys in this file — those live in the password manager.

---

## 2026-10-14 — Decision: GitHub repo stays PUBLIC

- Chosen knowingly: the build recipe (old one on `master`, new one in `cloud/recipe/`) is readable
  by anyone on GitHub. Accounts, seats, the tamper lock and payments still stop unpaid use of the
  app; the recipe itself is not protected while the repo is public.
- Revisit once ThemeBot has real customers: either make the repo private, or keep the code public
  and move `cloud/recipe/` out of GitHub (~10 minutes of work).

---

## 2026-10-14 — ThemeBot Engine built (SaaS milestone 1, not yet tried for real)

- **What it is:** our own AI agent on the **Claude API** (folder `engine/`). It can replace Claude
  Code as the build engine, so SaaS customers won't need a Claude account (we pay the API, sell
  credits — allowed by Anthropic's rules, unlike running Claude Code on our account).
- Same tools as Claude Code (read/write/edit files, search, run commands, fetch allowed web pages,
  helper sub-agents, to-do list), so the existing recipe works unchanged. Not yet: Chrome checks
  (use the "playwright" QA option instead).
- **Cost meter + hard budget cap per build** (default $25; ledger in `.factory/engine-ledger/`).
  When the cap is reached the build stops as "blocked" with the amount spent.
- **Off by default.** Claude Code stays the normal engine. Turn on with the setting
  `buildEngine: 'themebot'` or env `THEMEBOT_BUILD_ENGINE=themebot`.
- Tested only with a fake AI (no money spent): 350 tests pass.
- Prices used: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 4.5 $1/$5 per million tokens
  (input/output). A newer, much cheaper Haiku may exist — check before the paid run.
- **Paid proof run needs:** Anthropic Console API key (with a spend limit), a throwaway Shopify
  dev store + a React site already built before (to compare), budget e.g. $10, and a go-ahead.

---

## 2026-10-14 (later) — VPS server set up for ThemeBot Cloud ("deploy" given)

- Address (temporary): **https://srv2059747.hstgr.cloud** — the server's own Hostinger name. Will
  switch to a real domain later (then installers must be rebuilt — fine, no customers yet).
- Certificate email: sales.automateiq@gmail.com (Let's Encrypt; Caddy renews automatically).
- Installed by `deploy/setup-server.sh`: updates, Node.js 24.21, Caddy 2.11.7 (HTTPS — real
  Let's Encrypt certificate, valid to Jan 2027, auto-renews), firewall ON (only 22, 80, 443 open),
  daily automatic security updates, user `themebot`, nightly database backup timer.
- Secrets generated **on the server** into `/etc/themebot-cloud/cloud.env` (signing key, pepper,
  admin token). **TODO: copy that file into the password manager** — without it every installed
  app is locked out if the server is lost.
- Public key for building installers (NOT secret):
  `THEMEBOT_CLOUD_URL=https://srv2059747.hstgr.cloud`
  `THEMEBOT_CLOUD_PUBKEY=xgmP/0ZFuAQIZy9jICzy95t0oDMFUwWxhMsDYQ6OM1E=`
- The Cloud app itself is **not running yet** (the address answers 502 for now). It starts with
  `HOST=179.197.243.215 SSH_KEY=~/.ssh/themebot_vps_ed25519 ./deploy/deploy.sh` once
  `RESEND_API_KEY` + `MAIL_FROM` are in cloud.env (login codes are emailed through Resend).
- **Resend needs a real domain** to send to customers (the sending address must be on a domain you
  verify in Resend). Without it, Resend can only email your own address — OK for testing only.
  → Claim the free Hostinger domain.
- Lemon Squeezy webhook secret still empty: purchases won't create accounts until it's set.
- Fixed a bug in setup-server.sh (it silently stopped at the firewall step, exit 141).
- Harmless warning in the setup output: "points at 127.0.1.1" — that's the server looking up its
  own name locally; from the internet the name points at the right IP.

---

## 2026-10-14 — VPS bought, repo safety, auto-build switched to manual

### Where the code lives
- GitHub repo: https://github.com/rakib-imtiaz/ukiyo-section-os-v1.0.0
  - `master` = the main ThemeBot app (folder `SHOPIFY_APP/ukiyo-section-os-v1.0.0`).
  - `desktop-electron` = the desktop app + ThemeBot Cloud (folder `SHOPIFY_APP/themebot-desktop`).
- **The repo was PUBLIC** (anyone could read the build recipe). Decision: make it **private**
  (GitHub → repo → Settings → bottom "Danger Zone" → Change visibility → Make private).
  A scan found no passwords or API keys in it — only the code was exposed.
- The anti-piracy work (Cloud, sign-in, security, deploy kit — 148 files) was **staged but not yet
  committed**. To save it to GitHub, paste into Claude Code:
  ```
  ! cd /c/patrick_workspace/SHOPIFY_APP/themebot-desktop && git commit -m "Add ThemeBot Cloud anti-piracy: accounts, server-side recipe and QA, watermarks, deploy kit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin desktop-electron
  ```

### GitHub Actions (the "installer robot")
- GitHub Actions = GitHub's free robot that runs jobs on its own computers. Ours builds the
  ThemeBot installers for Windows, Mac (Apple Silicon + Intel) and Linux — needed because a Mac
  installer can only be built on a Mac.
- On a **private** repo the free plan gives ~2,000 robot-minutes a month, and Mac minutes count
  10×. One full installer build can use ~300+ minutes.
- So it now runs **only when started by hand** (file `.github/workflows/desktop.yml`).
- **To make new installers:** GitHub → repo → **Actions** tab → **Desktop installers** →
  **Run workflow** → branch `desktop-electron` → wait ~15–20 min → download from the bottom of
  that run's page.
- If the minutes run out, it simply stops until next month — nothing breaks, no charge.

### Hostinger VPS (for ThemeBot Cloud)
- Bought: **KVM 2** (2 CPU, 8 GB RAM, 100 GB disk), **monthly billing** — $13.99 first month,
  then $24.49/month. (Yearly would be ~$10–17/month; can switch later in hPanel.)
- Name: `srv2059747.hstgr.cloud` · IP: `179.197.243.215` · IPv6: `2a02:4780:5e:3f65::1`
- System: **Ubuntu 24.04 LTS**, plain OS (no control panel, no Docker manager, no Monarx).
- Root password: set during setup — **keep it in the password manager**.
- If the PC dies: the server keeps running. Get back in via hPanel → VPS → browser terminal
  (root password), or add a new SSH key in hPanel.
- Other things on the same Hostinger account: Unlimited Web Hosting (runs the ECO WordPress staging
  site; can also host the ThemeBot marketing website), "AI automation apps", Reach 500 (email
  marketing), and **2 unclaimed free domains** (claim one for the SaaS).

### SSH key (password-free login to the VPS)
- Created on this PC: `C:\Users\USER\.ssh\themebot_vps_ed25519` (private — never share) and
  `themebot_vps_ed25519.pub` (public — this part goes on the server).
- **Added to the server** (2026-10-14). Login: `ssh -i ~/.ssh/themebot_vps_ed25519 root@179.197.243.215`
- Server check 2026-10-14: Ubuntu 24.04.5, 7.8 GB RAM, 95 GB free, clean (nothing installed),
  18 updates waiting, firewall off (the deploy script turns it on).
- **Decision: keep it simple** — root password login stays on (no key-only lockdown, no fail2ban).
  Just use a long, strong root password.

### Docker — decision
- **Not** on this Cloud server (simple service is better; Docker can bypass the firewall).
- **Yes** later on the SaaS build-worker servers (each customer build in its own sealed box).

### Monthly cost plan
| Stage | What | ≈ per month |
|---|---|---|
| Now | 1 × KVM 2 for ThemeBot Cloud | $14 first month, then $24.49 (≈ $10–17 if switched to yearly) |
| SaaS proof build | + Claude API usage | one-off $50–100 (capped in the Anthropic Console) |
| SaaS launch | KVM 2 + 1 × KVM 8 build worker | ≈ $38 yearly-billed (≈ $71 after year 1) |
| Growth | + 1 × KVM 8 per ~4 builds running at once | + $28–54 each |
Also: domain free year 1 then ~$10–20/yr; Lemon Squeezy takes ~5% + 50¢ per sale; Resend free tier
for sign-in emails; later code signing (~$10/mo Windows, $99/yr Apple).

### Next steps (in order)
1. Make the GitHub repo private.
2. Run the commit command above (saves all the anti-piracy work).
3. Wait for the VPS to show **Running** → let Claude add the SSH key and do a read-only check.
4. Claim the free domain.
5. For going live ("deploy"): Resend API key + sending address, Lemon Squeezy webhook secret +
   ThemeBot plan/variant IDs (without them nobody gets access).
6. SaaS (Lovable/Bolt-style): Anthropic Console API key with a spend limit, a Shopify
   **development** store, pick a React project already built before (to compare), budget cap.

---

## 2026-10-03 → 10-13 — Anti-piracy system built (all local, tested, not deployed)

- **ThemeBot Cloud** (`cloud/`): email sign-in with 6-digit codes, seats per plan, signed 15-minute
  passes, copied sign-ins get signed out, Lemon Squeezy payments (only ThemeBot plans, refunds cut
  access, test payments ignored on live).
- **Recipe stays on the server**: sent one step at a time; nothing left on the customer's PC.
- **QA scoring on the server**: the PC only takes screenshots/measurements.
- **Watermarks**: hidden per-account marks — a leaked recipe can be traced to the account.
- **App lock-down**: tampered app refuses to start.
- **Security review**: no high-confidence vulnerabilities found (2026-10-13).
- **Deploy kit** for the VPS: `deploy/README.md` (step-by-step guide).
- Tests: 281 passing.

## Important rules (don't forget)
- Nothing goes live (VPS deploy, publishing installers, Shopify live themes) without saying **"deploy"**.
- Running Claude Code on our server with **our** Claude account for customers is **not allowed** by
  Anthropic's rules. The SaaS must use our own engine on the **Claude API** (sell credits).
  Desktop/agency version = customers use their own Claude.
