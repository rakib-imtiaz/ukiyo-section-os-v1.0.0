# ThemeBot — Product & UI Brief

Everything the app does, every screen, every option, every state. No layout decisions: where things go is the designer's call. This file describes **what exists and what each piece needs**.

---

## 1. What ThemeBot is

ThemeBot turns a website into a real Shopify store.

The user gives it a website (a link, the project files, or both) and a store name. ThemeBot creates the Shopify store, connects to it, rebuilds the website as a native Shopify theme, then compares the new store to the original website and fixes the differences, round after round, until they match. The result lands on the store as a **draft theme** the owner reviews before publishing.

It runs on the user's own computer. It works inside the user's own Chrome through the Claude for Chrome extension, so Shopify sees a normal, signed-in person.

### Who uses it

- **Primary: non-technical store owners and their clients.** They should never see words like API, token, scope, workspace, prefix, QA, iteration, converge, clone, CLI.
- **Secondary: the operator (the agency running it).** Needs the technical detail, but behind an "advanced" or "developer" switch.

### The promise, in the user's words

"I give it my website and a name. It builds my Shopify store. I sign in once. I check it before it goes live."

---

## 2. Plain-language glossary

Use the right-hand words in the UI. The left-hand words are internal.

| Internal term | Say this in the UI |
|---|---|
| Clone job | Build |
| Clone project | Project / store build |
| React site / source | Your website |
| Target store / shop | Your Shopify store |
| Custom app, Client ID, Client Secret | Connection, connection keys |
| Scopes | Permissions |
| Dev theme | Draft theme |
| Publish / autoswap | Go live |
| QA | Checking |
| QA iteration / fix round | Round |
| Score / convergence threshold | Match / "good enough" level |
| Converged | Done, matches your website |
| Exhausted | Needs a look |
| Blocked | Paused, needs you |
| Workspace | Project folder |
| Storefront password | Store password (visitors need it to see a new store) |

---

## 3. Core objects (the data the UI shows)

### 3.1 Build (a job)

| Field | Example | Notes |
|---|---|---|
| Name | Eco Eli | User-chosen |
| Website | https://bkglxvhadenag.kimi.page | The site being copied |
| Store | rzf7de-at.myshopify.com | Shopify address |
| Store display name | My Store / Eco Eli | Cosmetic, may differ from address |
| Status | see 3.2 | Drives colour and the main action |
| Status detail | "Paused: no activity for 20 minutes" | One human sentence |
| Current round / max rounds | 2 of 5 | |
| Latest match | 87% | Percentage |
| Match target | 92% | "Good enough" level |
| Match history | 61% → 78% → 87% | Per round, for a small trend |
| Checking method | Quiet / In my Chrome | |
| Go live when done | On / Off | Off by default |
| Draft theme name | Eco Eli Clone (dev) | |
| Started, finished, elapsed | 21:01, —, 34 min | |
| Pages found | 17 pages (/Home, /About, …) | From the website files |

### 3.2 Build statuses

| Internal | Label | Tone | What the user can do |
|---|---|---|---|
| draft | Draft | Neutral | Continue setting up, discard |
| queued | Waiting to start | Neutral | Cancel |
| scaffolding | Preparing | In progress | Watch, cancel |
| cloning | Building | In progress | Watch, pause, cancel |
| qa_running | Checking | In progress | Watch, pause, cancel |
| fixing | Fixing differences | In progress | Watch, pause, cancel |
| converged | Done | Success | View store, review draft, get report |
| exhausted | Needs a look | Warning | View what still differs, retry, accept as is |
| blocked | Paused, needs you | Warning | Read why, retry |
| paused | Paused by you | Neutral | Resume, cancel |
| aborted | Stopped | Error | Retry, delete |
| failed | Failed | Error | Read why, retry, delete |
| canceled | Cancelled | Neutral | Delete, start again |

### 3.3 Setup run (the "Do it for me" autopilot)

Seven fixed steps. Each step has a state (**waiting, working, done, failed**) and one detail sentence.

1. Check that your Chrome is ready (Claude extension, signed in to Shopify)
2. Create your Shopify store (no card needed)
3. Set up the connection between ThemeBot and your store
4. Save the connection keys to your project
5. Test that ThemeBot can edit the store
6. Get your website ready to compare against
7. Start building your Shopify theme

Run-level states: **Running, Waiting for you (sign-in / Chrome setup), Done, Failed, Stopped.**
While running there is also a **live activity line** (latest thing the bot is doing, e.g. "Payment screen, skipping it, no card entered").
When a run fails after the store exists, it remembers the store and offers **"Continue from where it stopped"** instead of starting over.

### 3.4 Saved store

| Field | Example |
|---|---|
| Label | Eco Eli |
| Store address | rzf7de-at.myshopify.com |
| Has store password saved | Yes / No |
| Connected since | 22 Sep 2026 |

Actions: use for a new build, test connection, remove keys everywhere.

### 3.5 Project (library entry)

| Field | Example |
|---|---|
| Name | jacqueline_new |
| Description | "A premium multi-page styling & hat-design business site with 107 Liquid sections…" |
| Sections built | 107 |
| State | partial / cloned |
| Linked build | optional |

Currently 19 projects exist.

### 3.6 Website preview

| Field | Example |
|---|---|
| Source | Uploaded files / link |
| Framework detected | Vite + React, Next.js, … |
| Pages found | 17 |
| Phase | Getting ready, Installing (first time, can take minutes), Starting, Taking a picture, Ready, Failed |
| Picture | Screenshot of the home page |
| Address shown | http://localhost:55127 or the link |
| Elapsed | 12s |
| Recent log lines | 3 short lines while working |

---

## 4. Screens and what each one must offer

### 4.1 Home

Purpose: answer "what is happening with my stores, and what do I do next?"

Must show:
- Every build with its status, match %, and its one main action
- Anything that needs the user (blocked, needs a look, waiting for sign-in) above everything else
- One way to start a new build
- First-time empty state explaining the three steps, with a start action
- Quiet system health (all systems normal / something is wrong)

Must not show: fake demo logs, marketing feature tiles, developer tools.

### 4.2 Start a new build: choose a path

Two options, clearly different:

| Option | For whom | Promise |
|---|---|---|
| **Do it for me** (recommended) | No Shopify store yet, or not sure | ThemeBot creates the store, connects it, builds the theme. Sign in once. No card. You confirm the website first. |
| **I already have a store** | Store and connection keys already exist | Paste the address and keys, fine-tune, build. Includes a guide to get the keys. |

A way to switch paths at any time.

### 4.3 "Do it for me", step 1: About your store

Inputs:
- **Store name** (required, 2+ characters). Help: "This becomes the name of your Shopify store and of this project."
- **Link to your website** (optional). Validates as a web address.
- **Your website's files** (optional if a link is given): drag-and-drop or choose a .zip, with upload progress and "unpacking" state. Alternative: "The project is already a folder on this computer" with a path field and a "Use folder" action.

At least one of link or files is required.

After files are received, show a confirmation: project name, what it is built with, number of pages and the first few page names, plus "Change". Warn if the project cannot be run.

Errors needed: name missing, address not valid, neither link nor files, not a .zip, folder not found, no project inside the zip.

Actions: Next, Cancel (asks before throwing work away), switch path.

### 4.4 "Do it for me", step 2: Is this your website?

ThemeBot runs the uploaded project (or opens the link) and takes a picture of the home page.

States: getting ready, installing (first time, may take minutes, show elapsed and a few log lines), starting, taking picture, ready (show picture and address), failed (show reason).

Actions: **Yes, that's my website** (only when ready), **No, wrong one** (returns to step 1 with everything kept), **Try again** and **Skip this check** (only when failed), Back.

### 4.5 "Do it for me", step 3: Ready to go

Must show:
- **Chrome readiness** (the one-time setup, see 4.9). Either "Your Chrome is set up (since date)" with "Redo the setup", or the setup checklist.
- **How should ThemeBot check its work?** Two choices:
  - Quiet automatic check (recommended): hidden browser, nothing to install. Extra option: "Show me the window while it checks (slower)".
  - Check in my Chrome with Claude: uses the same Chrome setup.
- **What ThemeBot will do**: a plain numbered list personalised with the store name and website.
- A reassurance line: ThemeBot never enters payment details; if Shopify insists on a card, it stops and says so.
- A warning if the user skipped the website check.

Actions: **Start** (disabled until Chrome setup is confirmed), Back, Cancel.

### 4.6 "Do it for me": live progress

Must show:
- Headline that matches the state ("Setting everything up", "One thing first: your Chrome needs to be ready", "All set, your theme is being built", "Setup stopped", "Something needs your attention")
- The seven steps with state and detail
- Live activity line under the working step
- A notice that a Chrome window will open and should be left alone; if Shopify asks for a sign-in, log in there and it continues by itself

Actions by state:
- Running: **Stop the setup**
- Waiting for you: **Open Shopify in Chrome**, **I've signed in, continue**, Stop
- Failed: **Continue from where it stopped** (if the store exists) or **Try again**, **Back to the form**
- Done: **Go to my build**

System notifications (outside the app) when a sign-in is needed and when keys are collected.

### 4.7 "I already have a store", step 1: Your website and store

Inputs:
- Project name (required). Shows the project folder name it will create.
- Link to the website to copy (required)
- Your Shopify store (required). Accepts the admin URL, the myshopify address, or just the handle; shows "Building in xxx.myshopify.com" once understood.
- Store password (optional). Remembered per store if saved before.
- Website source folder or .zip (optional)

### 4.8 "I already have a store", step 2: Connect ThemeBot to your store

Ways to get the keys (user picks one):
- **Manual paste**: paste both keys in one box, in any order
- **Bookmarklet**: drag a button to the bookmarks bar, click it on the app's settings page, paste back
- **Scripted bot**: opens the user's Chrome profile and clicks through; needs Chrome closed; profile picker if several
- **AI bot**: Claude drives the user's Chrome, creates the app, fetches the keys
- **Partner API**: headless, needs a partner token (experimental)

Supporting content:
- **8-step setup guide** with checkboxes that remember progress, a "copy all 31 permissions" action, links to Shopify pages, and one step flagged as critical
- **2-minute video** of the whole setup
- **Stores you connected before**: pick one, no pasting

Fields: Client ID, Client Secret (with show/hide). Validation: ID must be 32 letters/numbers, secret must start with shpss_.

Actions: **Test connection**, **Test with a tiny edit** (writes and removes a harmless file on the live theme).

Test result shows: connected store name, each permission as granted / missing / optional, edit test passed or not, and a plain explanation for optional ones.

After a successful test: **Remember this store** toggle.

Key management: **Change key**, **Remove keys everywhere** (confirmation required, destructive).

Live bot panel while a bot works: elapsed seconds, streaming activity lines (thoughts, actions, system), Stop, and a success moment ("Keys collected!") that leads to the filled fields.

### 4.9 One-time Chrome setup (shared)

Five items:
1. Google Chrome installed (auto-detected)
2. Claude for Chrome extension installed (auto-detected, link to install)
3. I am signed in to Chrome (user confirms)
4. I am signed in to Claude in the extension (user confirms)
5. I am signed in to Shopify in Chrome (user confirms)

Actions: **Open Chrome to sign in**, **Check again**, **Save, setup done** (disabled until all five), later **Redo the setup** / **Keep the old setup**.
Saved once, remembered forever.

### 4.10 "I already have a store", step 3: Review and start

Must show a plain summary: what gets copied into which store, how checking works, whether the live store is touched.

Options:
- **Check and fix automatically** on/off (recommended on)
- **How should ThemeBot check its work?** (same two choices as 4.5)
- **Publish live when it passes** on/off (off by default; turning on needs a confirmation that explains customers see it immediately)
- One-time download notice if the checking browser is not installed, with **Install now**

Advanced (for developers, hidden by default):
- Section prefix (2 to 3 letters)
- Draft theme name (follows the project name until edited)
- What to check: layout and clickable things / layout only / clickable things only
- Maximum fix rounds (1 to 10, default 5)
- Good enough when the match reaches (50% to 100%, default 92%)

Actions: **Start building**, Back, Cancel.

### 4.11 Build detail

Must offer:
- Status, detail sentence, elapsed time
- Match % now, target, and the history across rounds
- Per-round breakdown: layout match, text match, clickable-things match
- **Issues found**, each with a type badge and page:
  - Missing page, Missing section, Text differs, Extra section, Missing interaction, Goes to the wrong place, Button does nothing, Extra interaction, Not fully checked, Products not set up
- **Side-by-side pictures** of the original and the new store, per page, desktop and mobile, per round
- Reports and logs (plain summary first, raw logs for developers)
- Actions: Pause, Resume, Retry, Cancel, Delete (optionally delete the project folder too), open store, open draft theme, open project folder / terminal (developer only)

### 4.12 Builds dashboard (Factory)

- Counters: Building, Waiting, Done, Needs you
- Resume card for an unfinished draft ("You left off on step 2 of 3") with Resume and Discard
- List of builds with status, match, trend, elapsed, and a per-build menu
- Queue control: **Pause queue / Resume queue**, and how many are running now
- Empty state for first build

### 4.13 Projects

- List of every project with name, short description, sections built, state, and **Open**
- Count of projects in the current workspace
- Workspace switcher (which folder ThemeBot is working in)

### 4.14 Connections

- Shopify store connection state (connected store, API version, storage type, billing state), disconnect
- Explanation that each build uses its own encrypted keys, with a way into the builder
- **Developer mode** switch: shows Terminal and Browser tools

### 4.15 Settings (operator)

| Group | Options |
|---|---|
| Models | Model for building and fixing: Opus (most reliable, default) / Sonnet (faster) / Haiku (fastest, least careful). Model for the setup bot: same three, Opus strongly recommended |
| Running | Builds at the same time (1 to 5, default 2). Delay between launches (seconds, default 90). Pause the queue when usage limit is hit (on) |
| Timeouts | Stop if silent for (default 20 min). Maximum build time (default 240 min). Maximum fix round time (default 60 min). Maximum check time (default 30 min). Values set by the environment are locked |
| Checking defaults | Default rounds (5). Default good-enough level (92%). Weights for layout / text / clickable things. Stop early when a round makes no progress (on), progress threshold |
| Housekeeping | Keep the last N rounds on disk (3) |
| Safety | Hide secrets in logs (on). Extra permissions for build sessions (advanced text list) |
| Health checks | Claude found (path, Check). Checking browser installed (Re-check, Install). Run the checking self-test (takes up to 5 minutes, shows score) |
| Danger zone | Stop all running builds. Clear the queue. Reset settings to defaults. Each needs a confirmation |

### 4.16 Developer tools (only with developer mode on)

- **Terminal**: a real shell in the project folder, multiple tabs, Clear, Reconnect, disconnected state
- **Browser**: ThemeBot's own browser with tabs, address bar, zoom, split view, console, network, checking panel, start/stop, "Claude is driving this page" indicator

### 4.17 First launch (onboarding)

- Connect the Claude app on this computer
- Choose the folder where projects are kept
- Both localhost-only

---

## 5. Cross-cutting states every screen needs

- **Loading** (skeletons, not spinners, for lists)
- **Empty** (first time, with one clear action)
- **Server unreachable** ("Could not reach ThemeBot", retries automatically, **Retry now**)
- **Error** in plain words, with what to do next
- **Long-running** (elapsed time, what is happening now, safe to leave the page)
- **Needs you** (visually louder than everything else)
- **Success moment** (store created, keys collected, build done)
- **Confirmation dialogs** for anything destructive or live: discard draft, remove keys, publish live, stop all, delete build
- **Toasts** for quick results: Setup saved, Build started, Keys removed, Queue paused
- **System notifications** (outside the browser) for sign-in needed, keys collected, build done / needs a look

---

## 6. Component inventory

No positions, just what is needed.

**Navigation**
- App navigation with Home, Projects, Connections, Builder; Terminal and Browser only in developer mode
- Collapsible navigation
- Account chip (workspace name, Claude connection, switch workspace, log out)
- Light / dark switch
- Tabs (Dashboard / New build / Settings)

**Status & feedback**
- Status pill for the 13 build statuses
- Step list item with four states (waiting, working, done, failed) and a detail line
- Stepper for 3-step wizards, with completed / current / locked
- Match ring or gauge (percentage)
- Progress bar (determinate, and an "active" variant)
- Small trend line for match history
- Counter tile (number + label + optional alert tone)
- Issue badge (10 issue types, each with a tone)
- Permission chip (granted / missing / optional)
- Live dot (something is running)
- Live activity feed (streaming lines, three kinds: thought, action, system; elapsed timer)
- Toasts, confirmation dialog, full-screen success moment
- System health block (platform version, storage, uptime, last sync)

**Inputs**
- Text field with label, help text, error, success message
- Password field with show/hide
- Paste box (multi-line)
- File drop zone with drag state, progress, unpacking state
- Folder path field with a "use" action
- Toggle switch
- Checkbox (setup items)
- Radio cards (two big choices with title, description, badge)
- Select dropdown
- Slider with value readout (rounds, percentage)
- Segmented choice (model picker)

**Cards**
- Path choice card (title, promise, three ticks, badge, call to action)
- Build card (name, status, detail, match, trend, elapsed, menu)
- Project card (name, description, sections count, state, open)
- Resume-draft card
- Saved-store card
- Setup checklist (numbered items with checkboxes, copy block, links, critical flag)
- Chrome setup card (auto-detected rows + confirm rows + actions + "set up since" state)
- Website preview card (picture, address, states, log lines)
- Project received card (name, framework, pages, change)
- Test result card (connected / failed, permissions, edit test)
- Collection method picker (five options)
- Video card and video modal
- Side-by-side comparison viewer (original vs new, desktop/mobile, per round)
- Settings group card
- Danger zone card

**Buttons**
- Primary (Start, Next, Yes that's my website)
- Secondary / outline (Test connection, Check again, Open Chrome)
- Ghost / text (Cancel, Back, Change, Redo)
- Destructive (Remove keys everywhere, Stop all, Discard)
- Icon buttons (theme switch, collapse, close, menu)
- Link-style actions (switch path, open in Shopify)
- Disabled with a reason on hover

---

## 7. Design language

**Personality:** calm, competent, reassuring. A tool that does hard work quietly and only speaks up when it needs you. Not a hacker cockpit, not a marketing site.

**Voice:**
- Plain words, short sentences, second person ("your store", "your website")
- Say what happens next, never what the system is
- Errors: what went wrong + what to do, no apology, no codes
- Reassure about money and safety explicitly ("no card needed", "your live store is not touched")
- Never show internal terms from the glossary's left column

**Colour roles (semantic, not specific hex):**
- One accent for primary actions and "working" states
- Success (done, granted, passed)
- Warning (needs a look, paused, needs you, optional)
- Error (failed, missing, destructive)
- Neutral greys for waiting / drafts
- Must work in light and dark

**Type needs:**
- A display face for page titles and big numbers (match %)
- A readable body face
- A monospace face only for addresses, file paths, and developer logs

**Motion:**
- Progress and "working" states should feel alive (subtle pulse, streaming lines)
- Step completion deserves a small satisfying moment
- Big success moments (store created, keys collected, build done)
- Respect reduced-motion settings

**Density:** low for client-facing screens (one decision at a time), higher only in developer mode and advanced panels.

**Current identity (can be kept or replaced):** ThemeBot wordmark, "Autonomous builder" tagline, blue accent, rounded cards, light default with dark mode.

---

## 8. Hard facts the UI must respect

- The store is created with **no card**. Shopify's payment screen is skipped. If Shopify ever requires a card, the run stops.
- The connection app installs fine on a store **without a paid plan**.
- Shopify gives new stores a **random address** (e.g. rzf7de-at.myshopify.com) and may name it "My Store". ThemeBot tries to rename it; the address never changes.
- Setup takes roughly **15 to 30 minutes**; a build takes much longer (up to 4 hours); both run in the background.
- Everything happens on **this computer**. Keys are stored encrypted locally and never shown again after saving.
- The result is always a **draft theme** unless "Publish live" was deliberately switched on.
- The app needs **several GB of free memory** during a build; low memory stalls builds.

---

## 9. Not built yet (design for them now)

- **Setup history**: every setup attempt kept after restarts, with its steps, outcome, and full activity log, and a way to continue a stopped one
- **Result report**: when a build finishes, a one-page summary with before/after pictures the owner can send to their client
- **Memory warning**: tell the user before starting when the computer is short on memory
