# Deploy Runbook — Attachment Reader (Forge/Rovo app)

How to ship this app to a new Atlassian instance, including production. Steps
are Forge CLI commands run from the repo root.

## 0. Prerequisites

- Forge CLI installed and reasonably current: `forge --version` (this repo
  was last run against 13.4.0; update anytime with
  `npm install -g @forge/cli@latest`).
- Logged in as an account that is a **contributor** on the target app
  registration: `forge whoami`. If you get permission errors in step 2, you're
  logged into the wrong account — `forge logout` then `forge login` as the
  right one, or have an existing contributor add you (Developer Console →
  the app → Contributors).
- Admin access on the destination Atlassian site, OR a site admin there
  who can approve an install link (see step 4b).

## 1. Confirm you're pointed at the right app

`manifest.yml` pins one specific registered app via `app.id`:

```yaml
app:
  id: ari:cloud:ecosystem::app/<uuid>
```

Every `forge` command in this repo operates on whatever app that UUID
resolves to — **not** on "the app in this git repo" in the abstract. Two
different Atlassian orgs can each have their own separate app registration
built from this same code, each with its own UUID, environments, and
installations.

Before deploying to a new instance, check the Developer Console
(`Console → <org> → Attachment Reader → App details → App ID`) for the org
that owns that instance, and make sure it matches `manifest.yml`. If it
doesn't, update it:

```bash
# edit manifest.yml: app.id: ari:cloud:ecosystem::app/<correct-uuid>
forge environments list   # should succeed and list dev/staging/production
forge install list        # should succeed and list existing installs
```

If either of those two commands errors with an authorization/permissions
message, you're either on the wrong app ID or the wrong logged-in account —
resolve that before doing anything else. Don't deploy or install against an
app you can't first list installations for.

> This app ID pin is deliberately committed to `manifest.yml`. If you're
> setting this repo up against a brand-new org for the first time (no app
> registered there yet), see step 6 instead of following this section.

## 2. Pre-flight checks

```bash
forge lint            # static checks on manifest + function code
npm install            # make sure node_modules matches package-lock.json
```

Fix anything `forge lint` flags before proceeding — it's cheap to catch here
versus in a failed deploy.

## 3. Deploy the code to an environment

Forge apps have three environments — `development`, `staging`,
`production` — each with its own deployed code version, independent of which
sites have the app installed. Promote through them in order; don't deploy
straight to `production` on a change you haven't run anywhere yet.

```bash
forge deploy -e development
# → smoke test against whatever site already has `development` installed

forge deploy -e staging
# → smoke test against whatever site already has `staging` installed

forge deploy -e production
```

Useful flags:
- `--non-interactive` for CI/scripted runs (skips confirmation prompts).
- `-t <tag>` deploys a specific previously-built tag (see `forge build`) —
  used for rollback, see step 5.
- `forge deploy list --json` shows deployment history per environment.

A successful deploy here means the app **built and packaged**; it does not
by itself prove every code path works at runtime in Forge's sandbox (see
[Known risks](#known-risks-for-this-app) below) — that still needs a real
functional test after install.

## 4. Get the app installed on the target site

### 4a. You have admin on the target site

```bash
# First-time install:
forge install -e production -s <site>.atlassian.net -p Jira --confirm-scopes

# Upgrading an existing install to the code you just deployed:
forge install --upgrade -e production -s <site>.atlassian.net -p Jira
```

`-p` is the Atlassian product the app targets — this app is Jira-only
(`Jira`). `--confirm-scopes` skips the interactive scope-approval prompt;
drop it if you want to review scopes (`read:jira-work`) before confirming.

### 4b. You don't have admin on the target site

You'll see:

```
Error: Insufficient permissions to install app
```

Generate an install link and send it to a site admin instead:
`https://developer.atlassian.com/console/myapps/<app-id>/distribution`
→ "Generate a link to install this app" → share the link. They approve it
from their own logged-in browser session; no CLI access needed on their end.

## 5. Verify, then roll back if needed

After install, before calling it done:

1. Open a real (or test) Jira issue on that site with attachments covering
   each supported type — PDF, DOCX, XLSX, TXT/CSV/JSON/Markdown, and at
   least one PNG or JPEG with visible text — and exercise the Rovo agent
   or MCP action against it.
2. Check `forge logs -e production -s <site>` (or `-g` to group by
   invocation) for errors, especially from `readAttachment()`.
3. If something's broken and you need to revert:
   ```bash
   forge deploy list --json           # find the last known-good build tag
   forge deploy -e production -t <tag>
   ```
   This redeploys old code to the environment; it does not touch data.

## 6. First-time setup on a brand-new org (no app registered yet)

If the target org has never had this app registered at all (not just "not
installed" — no App ID exists for it in that org's Developer Console):

```bash
forge login                 # as an account in the target org
forge create                # registers a new app, generates a fresh app.id
# forge create will prompt for a name and write a new manifest.yml —
# reconcile the generated manifest.yml with this repo's (module/action/
# permission config) rather than accepting its scaffold wholesale, then
# restore this repo's src/ and package.json.
```

Then continue from step 3 as normal on the newly-created app.

## Known risks for this app

- **Image OCR (`tesseract.js`) — real bundling failure, now fixed a
  different way; needs a fresh deploy to confirm.** An earlier "confirmed
  working" note here was wrong: the success it was based on (a chat message
  reporting a PASS on a Checkmarx screenshot) was most likely Rovo chat's
  own native image-viewing, not this action — the first time the action was
  actually exercised (via Jira Automation, same screenshot), it failed
  immediately, twice, in two different ways:
  1. tesseract.js's Node build computes its `workerPath` via
     `path.join(__dirname, ...)` *inside its own bundled module* — Forge's
     bundler doesn't preserve a real filesystem `__dirname` there, so
     `worker_threads.Worker()` got a bare relative string and rejected it.
  2. Passing our own explicit `workerPath`, computed via *our* module's
     `import.meta.url`, hit the exact same failure — confirming Forge's
     bundler doesn't preserve a reliable self-location for **any** module,
     not just nested dependencies. The WASM core loader has the identical
     `__dirname`-relative pattern for its `.wasm` file, so it was next in
     line to break the same way.

  Fix: stopped computing paths to existing files entirely. `src/ocr-assets.js`
  (generated by `gen_ocr_assets.mjs`, which esbuild-bundles
  `src/ocr-worker-entry.cjs` — a custom worker entry point — together with
  tesseract.js's worker-script logic and one fixed WASM core variant)
  embeds the worker bundle, the matching `.wasm` binary, and the English
  trained data as base64 constants — literal source, so guaranteed part of
  the static import graph Forge's bundler follows correctly. At call time
  `index.js` decodes all three and writes them to `os.tmpdir()` (a real,
  writable, hardcoded-safe path in any Lambda-style sandbox — no computed
  `__dirname` involved) before spawning the worker from there. Validated
  locally end-to-end (PNG and JPEG) against the exact runtime pattern Forge
  will use. **Not yet confirmed against a real Forge deploy** — this needs a
  `forge deploy` and a re-test against a real image attachment before it can
  be trusted. If it still fails, check `forge logs` for the new error shape;
  it will look different from both errors above since neither failure mode
  it fixed can recur.
- After any tesseract.js/tesseract.js-core version bump, re-run
  `node gen_ocr_assets.mjs` to regenerate `src/ocr-assets.js` — it embeds a
  specific pinned build of the worker bundle and WASM core, not a live
  reference to the installed packages.
- **Images are capped at 3MB** (vs. 5MB for other types) and OCR runs inside
  Forge's ~25s function timeout — a dense/large image can still time out.
- **`.xls` (legacy binary Excel) isn't supported**, only `.xlsx` — `exceljs`
  doesn't read the old format.
- The app only requests `read:jira-work` — it cannot write back to issues.
  No scope changes needed for this deploy.
