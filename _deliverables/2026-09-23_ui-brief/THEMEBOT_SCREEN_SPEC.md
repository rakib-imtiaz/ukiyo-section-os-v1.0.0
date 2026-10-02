# ThemeBot — Strict Screen Spec (for UI generation)

READ THIS FIRST — RULES FOR THE GENERATOR

1. Design ONLY the screens listed in section B. Exactly these, no others.
2. Each screen lists what it CONTAINS and what it must NOT contain. Put nothing on a screen that is not in its CONTAINS list.
3. Use the exact wording given in quotes. Do not invent headings, taglines, stats, or labels.
4. Every number shown must be one of the data fields in section C. Do not invent counters or metrics.
5. Section A lists things that DO NOT EXIST in this product. Never draw them.
6. This is a desktop app that runs on the user's own computer. Design desktop first (1440 wide). A narrow-window version is optional; do not design a phone app with a bottom tab bar.
7. Layout, placement, and visual style are yours. Content, wording, steps, and options are fixed by this file.

---

## A. DOES NOT EXIST — never draw these

- No marketing / landing page, no hero slogans, no "Trusted by" logos, no testimonials, no lifestyle photos
- No user accounts: no profile, name, email, avatar menu, sign in to ThemeBot, sign out, password
- No email or SMS notifications, no notification preferences
- No help center, no search, no articles, no "Contact support", no chat widget
- No "Appearance" settings tab (the only appearance control is a light/dark switch icon)
- No billing, pricing, plans, invoices
- No "Go live" button after a build. Going live is ONLY a switch chosen before the build starts ("Publish live when it passes")
- No "View report" / "Download report" button (reports are not built yet)
- No store thumbnails or product photos in lists
- No counters called "Pages found / Matched / In progress / Need attention" on a build
- No team members, sharing, comments, or collaborators
- No phone bottom navigation bar
- No step called "All set", "Store details", or "Options" in the new-build wizard
- Do NOT label "Check in my Chrome" as recommended. The recommended checking method is "Quiet automatic check"

---

## B. SCREEN LIST (exactly 14)

| # | Screen |
|---|---|
| 1 | Home |
| 2 | Choose how to start |
| 3 | Do it for me · Step 1 of 3 · About your store |
| 4 | Do it for me · Step 2 of 3 · Is this your website? |
| 5 | Do it for me · Step 3 of 3 · Ready to go |
| 6 | Do it for me · Setting up (live progress) |
| 7 | I already have a store · Step 1 of 3 · Your website and store |
| 8 | I already have a store · Step 2 of 3 · Connect ThemeBot to your store |
| 9 | I already have a store · Step 3 of 3 · Review and start |
| 10 | Build detail |
| 11 | All builds |
| 12 | Projects |
| 13 | Connections |
| 14 | Settings |

App navigation has exactly four items: **Home, Builds, Projects, Connections**. Plus a light/dark switch icon. Settings is reached from a gear icon or from Connections. Nothing else in the navigation.

Global element on every screen: a small system status indicator ("All systems normal" in green, or "Could not reach ThemeBot" in red with "Retry now").

---

## C. DATA (the only numbers and values that may appear)

**Build**
- Name — "Eco Eli"
- Website — "https://bkglxvhadenag.kimi.page"
- Store address — "rzf7de-at.myshopify.com"
- Status — one of the 13 in section D
- Status sentence — e.g. "Paused: no activity for 20 minutes"
- Round — "Round 2 of 5"
- Match now — "87%"
- Match target — "92%"
- Match history — "61% → 78% → 87%"
- Per-round match split — "Layout 90%", "Text 84%", "Clickable things 81%"
- Issues found — a number and a list (types in section E)
- Checking method — "Quiet automatic check" or "Check in my Chrome with Claude"
- Publish live when it passes — On / Off
- Draft theme — "Eco Eli Clone (dev)"
- Started — "Started 34 minutes ago"

**Builds overview counters (the only counters allowed, screen 11 only):** Building · Waiting · Done · Needs you

**Project:** name "jacqueline_new", description one sentence, "107 sections built", state "Partial" or "Complete", 19 projects total.

**Saved store:** "Eco Eli · rzf7de-at.myshopify.com · Connected 22 Sep 2026".

**Website preview:** picture of the home page, address, "Built with Vite + React", "17 pages found (/Home, /About, /Blog, …)", elapsed "12s".

---

## D. BUILD STATUSES (exact labels and tones)

| Label | Tone | Main action |
|---|---|---|
| Draft | Grey | "Continue" |
| Waiting to start | Grey | "Cancel" |
| Preparing | Blue, animated | "Cancel" |
| Building | Blue, animated | "Pause" |
| Checking | Blue, animated | "Pause" |
| Fixing differences | Blue, animated | "Pause" |
| Done | Green | "Open store" |
| Needs a look | Amber | "See what differs" |
| Paused, needs you | Amber | "Retry" |
| Paused by you | Grey | "Resume" |
| Stopped | Red | "Retry" |
| Failed | Red | "Retry" |
| Cancelled | Grey | "Delete" |

---

## E. ISSUE TYPES (exact labels, used on screen 10)

Missing page (red) · Missing section (red) · Text differs (amber) · Extra section (grey) · Missing interaction (red) · Goes to the wrong place (amber) · Button does nothing (amber) · Extra interaction (grey) · Not fully checked (grey) · Products not set up (amber)

---

## F. SCREENS

### 1. Home

CONTAINS
- Title: "Your stores"
- If any build needs the user: an attention card per build with the store name, the status "Paused, needs you" or "Needs a look", the status sentence, and its main action button. This comes before everything else.
- A list of builds (max 5), each: name, store address, status pill, match %, round, main action
- One primary button: "Build a new store"
- Link: "See all builds"
- Empty state (no builds yet): title "Build your first store", text "Give ThemeBot a website and a name. It creates the Shopify store, connects it, and rebuilds your website as a Shopify theme.", three short steps "Tell us about your store", "Confirm your website", "Press Start", and the button "Build a new store"

MUST NOT CONTAIN: marketing copy, fake logs, feature tiles, developer tools, a URL input, "Upload project files" button.

### 2. Choose how to start

CONTAINS
- Title: "Build a Shopify theme from your website"
- Subtitle: "Pick how you want to start. Both ways end with the same result."
- Choice card A — badge "Recommended" — title "Do it for me" — text "You give a store name and your website. ThemeBot creates the Shopify store, connects it, tests it, and builds the theme." — ticks: "No Shopify store yet? No problem.", "No card, no technical steps.", "You confirm it is the right website before anything starts." — action "Start here"
- Choice card B — title "I already have a store" — text "You made the Shopify store and its connection yourself. Paste the store address and the keys, then start." — ticks: "Works with any existing store.", "Fine-tune how the build runs.", "Includes a guide to get the keys." — action "Use my own store"

### 3. Do it for me · Step 1 of 3 · About your store

CONTAINS
- Step indicator with exactly three steps: "About your store" · "Is this your website?" · "Ready to go"
- Field "What should the store be called?" (required) — help "This becomes the name of your Shopify store and of this project."
- Field "Link to your website (optional)" — help "If the website is already online, paste its address."
- File drop area "Your website's files" — text "Drop your project .zip here, or click to choose it" — sub-text "The zip of your website's source code."
- Link under it: "The project is already a folder on this computer" → swaps the drop area for a path field with the button "Use folder"
- After a file is received: confirmation card "Project received: my-app" · "Built with Vite + React · 17 pages found (/Home, /About, /Blog …)" · button "Change"
- Upload in progress state: "Uploading… 64%" then "Unpacking and reading your project…"
- Errors (inline): "Give your store a name." · "That does not look like a web address — it should start with https://" · "Add a website link or upload your project files (or both)." · "Please choose a .zip file." · "Folder not found."
- Buttons: "Cancel" · "Next"
- Small link: "I already have a store — use the other way"

### 4. Do it for me · Step 2 of 3 · Is this your website?

CONTAINS
- Title "Is this your website?"
- Text "ThemeBot is running your project and taking a picture of its home page, so you can make sure it is the right one."
- A large picture area with these states:
  - Working: spinner, "Installing what your project needs (first time only — this can take a few minutes)…", "3m 12s so far", three small grey log lines
  - Ready: the home-page picture, and under it the address
  - Failed: red icon, "We could not show your website.", one reason sentence
- Buttons when ready: "Yes, that's my website" (primary) · "No, wrong one"
- Extra buttons when failed: "Try again" · "Skip this check"
- Buttons: "Back"

### 5. Do it for me · Step 3 of 3 · Ready to go

CONTAINS
- Title "Ready to go" — text "ThemeBot works inside your own Chrome. Confirm the one-time setup, then press Start."
- Block "Your Chrome, ready for the bot":
  - If already done: green note "Your Chrome is set up (since 22 Sep 2026). Claude uses the sign-ins Chrome already remembers." + "Redo the setup"
  - If not done: checklist of five rows:
    1. "Google Chrome is installed" (auto tick)
    2. "The Claude for Chrome extension is installed" (auto tick, or link "Get it from the Chrome Web Store")
    3. "I am signed in to Chrome" (checkbox)
    4. "I am signed in to Claude in the extension" (checkbox)
    5. "I am signed in to Shopify in Chrome" (checkbox)
    Buttons: "Open Chrome to sign in" · "Check again" · "Save — setup done" (disabled until all five)
- Block "How should ThemeBot check its work?" — two choice cards:
  - "Quiet automatic check" — badge "Recommended" — "Runs in the background. Nothing to install."
  - "Check in my Chrome with Claude" — "Claude opens the pages in your Chrome and checks them like a person would."
  - Under the first, a checkbox "Show me the window while it checks (slower)"
- Block "What ThemeBot will do" (numbered, exact):
  1. "Open Chrome and create a Shopify store called Eco Eli — skipping every payment step, no card needed."
  2. "Set up the connection so ThemeBot can edit that store, and save the keys."
  3. "Do a tiny test edit to make sure the connection works."
  4. "Compare its work against https://bkglxvhadenag.kimi.page."
  5. "Build the Shopify theme, check it against your website, and fix differences until they match."
- Line: "ThemeBot never enters payment details. If Shopify insists on a card, the setup stops and tells you."
- Buttons: "Cancel" · "Back" · "Start — do it for me" (disabled until Chrome setup is done)

MUST NOT CONTAIN: a "Go live" switch, a match-target selector, profile info.

### 6. Do it for me · Setting up

CONTAINS
- Title "Setting up "Eco Eli""
- Headline by state: "ThemeBot is setting everything up…" / "One thing first: your Chrome needs to be ready" / "Something needs your attention" / "Setup stopped" / "All set — your theme is being built"
- Note (while running): "A Chrome window opens on this computer and the bot works in it — hands off. If Shopify asks you to sign in, log in there and it carries on by itself."
- EXACTLY seven steps, each with state (waiting · working · done · failed) and a one-line detail:
  1. "Check that your Chrome is ready"
  2. "Create your Shopify store (no card needed)" — done detail example: "Store: rzf7de-at.myshopify.com"
  3. "Set up the connection between ThemeBot and your store"
  4. "Save the connection keys to your project"
  5. "Test that ThemeBot can edit the store"
  6. "Get your website ready to compare against"
  7. "Start building your Shopify theme"
- Under the working step: a live activity line, e.g. "› Payment screen — skipping it, no card entered"
- Buttons by state:
  - Running: "Stop the setup"
  - Needs you: "Open Shopify in Chrome" · "I've signed in — continue" · "Stop the setup"
  - Failed after the store exists: red detail "The bot timed out. The store rzf7de-at.myshopify.com exists — press Continue to pick up from the connection step." + "Continue from where it stopped" · "Back to the form"
  - Failed before the store exists: "Try again" · "Back to the form"
  - Done: "Go to my build"

MUST NOT CONTAIN: an eighth step, "All set" step, confetti illustration of a store.

### 7. I already have a store · Step 1 of 3 · Your website and store

CONTAINS
- Step indicator: "Your website" · "Store connection" · "Review & start"
- Fields: "Name this project" (shows "Project folder: eco_eli") · "Link to the website to copy" · "Your Shopify store" (shows green "Building in eco-eli.myshopify.com" when understood) · "Store password (optional)" · "Website source folder (optional)"
- Buttons: "Cancel" · "Next"
- Side: a small video card "Store & app setup — watch along · 2 minutes"

### 8. I already have a store · Step 2 of 3 · Connect ThemeBot to your store

CONTAINS
- Title "Connect ThemeBot to your store" — text "ThemeBot needs the two keys from the app you created for this store in Shopify's Dev Dashboard."
- Method picker with five options: "Manual paste" · "Bookmarklet" · "Scripted bot" · "AI bot" · "Partner API"
- Selected method panel (one at a time), e.g. Manual paste: a paste box "Client ID and Secret" + "Fill the fields"
- Expandable guide "No store or app yet? Full setup in about 5 minutes" with 8 checkable steps, one "Copy all 31 permissions" button, and a "Watch the 2-minute video" row
- Dropdown "Stores you connected before" (if any)
- Fields: "Client ID" · "Client Secret" (show/hide eye)
- Buttons: "Test connection" · "Test with a tiny edit"
- Result card: success "Connected to "Eco Eli" — ThemeBot is allowed to edit themes" + permission chips (green granted, amber optional missing, red required missing) + "Edit test: Write + delete verified". Failure: red "Could not connect. Check that the app is installed and the keys match its settings page."
- After success: toggle "Remember this store"
- When keys are saved: note "Keys are already saved for this store" + "Change key" + "Remove keys everywhere" (red)
- Bot running panel: dark live feed with elapsed seconds and streaming lines + "Stop the bot"
- Success moment: "Keys collected!" + "Show me the keys"
- Buttons: "Back" · "Next"

### 9. I already have a store · Step 3 of 3 · Review and start

CONTAINS
- Summary block "What will happen": "ThemeBot copies https://… into a new draft theme on eco-eli.myshopify.com." · "It compares both sites and fixes differences, up to 5 rounds, until they match at least 92%." · "Your live store is not changed — the result stays a draft until you publish it."
- Switch "Check and fix automatically" (on)
- "How should ThemeBot check its work?" — same two cards as screen 5, "Quiet automatic check" recommended
- Switch "Publish live when it passes" (off) — turning on opens a confirm dialog "Publish the new theme live automatically?" with "Yes, publish automatically" (red) / "Cancel"
- Collapsed section "Advanced settings — for developers": "Section prefix" · "Draft theme name" · "What to check" (Layout + clickable things / Layout only / Clickable things only) · "Maximum fix rounds" slider 1–10 · "Good enough when the match reaches" slider 50–100%
- Buttons: "Cancel" · "Back" · "Start building"

### 10. Build detail

CONTAINS
- Header: build name, status pill, status sentence, "Started 34 minutes ago", store address
- Match block: "87%" large, "Target 92%", progress bar, "Round 2 of 5", history "61% → 78% → 87%"
- Per-round split: "Layout 90%" · "Text 84%" · "Clickable things 81%"
- Tabs: "Overview" · "Differences" · "Pictures" · "Activity"
  - Differences: list of issues, each with a type badge (section E), the page ("/about"), and one sentence
  - Pictures: side-by-side "Your website" vs "Shopify store", desktop/mobile toggle, round selector
  - Activity: plain timeline of rounds (Built · Checked · Fixed) with times
- Settings summary: checking method, publish live on/off, draft theme name
- Actions by status (section D) plus: "Open store" · "Open draft theme in Shopify" · "Delete build" (confirm; option "Also delete the project folder")

MUST NOT CONTAIN: "Pages found / Matched / In progress / Need attention" counters, "Go live" button, "View report" button.

### 11. All builds

CONTAINS
- Counters: "Building" · "Waiting" · "Done" · "Needs you"
- Resume card when a wizard was left unfinished: "Draft in progress — Eco Eli · You left off on step 2 of 3" + "Resume where I left off" + "Discard draft"
- List of builds (card or row): name, store address, status pill, match %, small trend, elapsed, menu (Open · Pause/Resume · Retry · Cancel · Delete)
- Top actions: "Build a new store" · "Pause queue" / "Resume queue" · "2 running"
- Empty state: "No builds yet" + "Build a new store"

### 12. Projects

CONTAINS
- Title "Projects" — subtitle "19 projects in shopify_works"
- Folder switcher showing the current folder name + "Switch folder"
- Project cards: name, one-line description, "107 sections built", state "Partial"/"Complete", button "Open"

### 13. Connections

CONTAINS
- Card "Saved stores": list of saved stores (label, address, connected date) each with "Test connection" and "Remove keys"
- Card "Your Chrome": same state as screen 5's Chrome block (set up since… / Redo the setup)
- Card "Claude on this computer": "Connected" + "Switch account"
- Card "Developer mode": switch "Show developer tools" — text "Adds Terminal and Browser to the navigation. Only for people maintaining ThemeBot."

### 14. Settings

CONTAINS exactly these groups:
- "Models" — "Building and fixing": Opus (most reliable) / Sonnet / Haiku · "Setup bot": Opus (recommended) / Sonnet / Haiku
- "Running" — "Builds at the same time" 1–5 · "Delay between starts" seconds · switch "Pause the queue when the usage limit is hit"
- "Time limits" — "Stop if silent for" · "Longest build" · "Longest fix round" · "Longest check" (locked values show a lock)
- "Checking defaults" — "Rounds" · "Good enough at" · "Weights: layout / text / clickable things" · switch "Stop early when a round makes no progress"
- "Health checks" — "Claude app: Found" + "Check" · "Checking browser: Installed" + "Re-check" · "Checking self-test" + "Run self-test (up to 5 minutes)"
- "Safety" — switch "Hide secrets in logs" · text box "Extra permissions (advanced)"
- "Danger zone" (red) — "Stop all running builds" · "Clear the queue" · "Reset settings to defaults"

MUST NOT CONTAIN: profile, email, notifications, appearance, sign out.

---

## G. SHARED STATES (show at least one example of each somewhere)

- Server unreachable banner: "Could not reach ThemeBot. Retrying… (attempt 3)" + "Retry now"
- Confirm dialog (destructive): title, one sentence of consequence, red confirm, "Cancel"
- Toast: "Setup saved" · "Build started" · "Keys removed everywhere" · "Queue paused"
- Loading skeletons for lists

## H. DESIGN LANGUAGE

- Calm, competent, reassuring. A quiet tool that speaks up only when it needs you.
- Plain words, short sentences, "your store" / "your website".
- One accent colour for primary actions and "working"; green = done; amber = needs you / needs a look; red = failed / destructive; grey = waiting.
- Light default, dark mode supported.
- Monospace only for addresses, folder paths, and the live activity feed.
- Motion: gentle pulse on working states, small tick animation when a step completes.
