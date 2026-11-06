# Personal site, run from a Google Sheet

A one-page professional site (hero, highlights, about, services, content feed, resume, contact), generated from a Google Sheet. The site owner only edits the sheet. Nothing else to maintain.

```
Google Sheet ──(Apps Script web app, JSON)──▶ GitHub Actions: node build.mjs ──▶ GitHub Pages (custom domain)
     │                                                ▲
     └── "Website" menu / 15-min trigger ─────────────┘  (workflow_dispatch)
YouTube channel RSS ─────────────────────────────────▶ new videos added automatically
```

- **No dependencies.** Node 20+ only.
- **Fails safe:** if the sheet can't be read, or `name` is empty, the build exits 1 and the live site stays as it was.
- **Images** (Drive photo, link previews) are downloaded into the site rather than hotlinked.
- **Link previews:** for non-YouTube links with a blank title or image, the build reads the page's preview tags. LinkedIn and Instagram often block this, so the sheet's Title/Note are the fallback.

## Local preview

```bash
node build.mjs --sample                  # uses sample-data.json, no network
python3 -m http.server 8080 -d dist      # open http://localhost:8080
```

## One-time setup

### 1. Google Sheet
1. Create a new Google Sheet in a **personal Gmail account** (hers is best; share it with yours as editor). Avoid Workspace/university accounts: admins often block "Anyone" web apps and "Anyone with the link" Drive sharing, which this setup needs.
2. Open **Extensions → Apps Script**, replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs), and save.
3. Reload the sheet. Run **Website → Set up tabs (first time only)** and approve the permission prompt ("Google hasn't verified this app" → Advanced → Go to … → Allow — it's your own script). Do steps 1–4 yourself; she only edits tabs afterwards.
4. Fill in the **Profile** tab. Any photo or resume PDF in Drive must be shared as *Anyone with the link → Viewer*.

### 2. Publish the sheet as JSON
1. In Apps Script, go to **Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
2. Deploy, then copy the URL (it ends in `/exec`).

> Anyone with this URL can read every tab not starting with `_`. Keep only public website content in this sheet.

After any change to `Code.gs`, go to **Manage deployments → Edit → Version: New version**. This keeps the same URL.

### 3. GitHub repo and Pages
1. Push this folder to a **public** repo. Pages on private repos needs a paid plan.
2. Go to **Settings → Pages → Source** and choose **GitHub Actions**.
3. Go to **Settings → Secrets and variables → Actions** and add a secret named `SHEET_JSON_URL` containing the `/exec` URL.
4. Go to **Actions → Deploy site → Run workflow**. Check that the build succeeds.

### 4. Let the sheet trigger builds
1. Create a fine-grained token at **GitHub → Settings → Developer settings → Fine-grained tokens**:
   - Repository access: **only this repo**
   - Permissions: **Actions: Read and write**
   - Nothing else.
   - Set a reminder before it expires.
2. In Apps Script, go to **Project Settings → Script properties** and add:
   - `GITHUB_REPO` = `owner/repo`
   - `GITHUB_TOKEN` = the token

   Never paste the token into `Code.gs`.
3. In the sheet, run **Website → Turn on automatic publishing**.

How builds get triggered:
- Edits go live about 15–30 minutes after she stops editing.
- **Website → Publish now** updates immediately.
- Every 6 hours a refresh runs anyway, so new YouTube videos appear even without sheet edits.

The GitHub cron is only a backup. GitHub pauses scheduled workflows in repos with no activity for 60 days, which is why the Apps Script trigger is the primary one.

### 5. Custom domain
1. Go to **Settings → Pages → Custom domain**, enter the domain, and save.
2. Once DNS resolves, tick **Enforce HTTPS**.
3. At the domain registrar, add:

| Type | Host | Value |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153, 2606:50c0:8001::153, 2606:50c0:8002::153, 2606:50c0:8003::153 |
| CNAME | www | `<github-username>.github.io` |

Set `site_url` in the Profile tab to `https://<domain>`. It's used for SEO and link previews.

## Sheet schema

This is the contract for her and for any automation (e.g. a Claude flow that appends posts). Header names matter, not column order, and they're case-insensitive. Don't rename tabs or headers. Tabs starting with `_` are ignored.

**Profile**: two columns, `Field` and `Value`. A third Notes column is ignored.

| Field | Purpose |
|---|---|
| `name` | Required. |
| `headline`, `intro`, `about` | `about`: a blank line starts a new paragraph. |
| `photo`, `resume_pdf` | Drive links, shared as *Anyone with the link*. |
| `location`, `email` | |
| `cta_label`, `cta_link` | Main button. |
| `linkedin_url`, `youtube_url`, `instagram_url`, `x_url`, `facebook_url` | |
| `youtube_channel_id` | Optional. Normally found automatically from `youtube_url`. |
| `contact_heading`, `contact_text` | |
| `about_heading`, `services_heading`, `content_heading`, `resume_heading` | Optional section titles. |
| `accent_color` | Hex. |
| `site_url`, `meta_description` | |

**Content**: one row per post. Only `Link` is required.

| Column | Notes |
|---|---|
| Link | URL of the post or video. Platform is detected from the URL. |
| Title | Optional. Taken from the page preview if blank. |
| Date | `yyyy-mm-dd`. Sorts newest first. `dd/mm/yyyy` also accepted. |
| Note | Optional short description. |
| Featured | `TRUE` or `yes` pins it to the top. |
| Hide | `TRUE` or `yes` removes it from the site. This also works for auto-imported YouTube videos. |
| Image | Optional image URL or Drive link, overriding the preview. |
| Platform | Optional override: `YouTube`, `LinkedIn`, `Instagram`, `X`, `Facebook`, `Medium`, `Substack`, `Podcast`, `Article`. |

**Highlights**: `Value`, `Label`. Shown as the stats strip, e.g. `20+` / `Years of experience`.

**Services**: `Title`, `Description`.

**Resume**: `Section`, `Title`, `Organization`, `Dates`, `Details`.
- `Section` groups the rows, e.g. Experience / Education / Recognition.
- In `Details`, lines starting with `-` become bullets.

### Automating updates

To add content, append a row to **Content** (below the last row that has a Link) with at least `Link`. That's all it needs.

It goes live on the next auto-publish check. To publish immediately, call the same dispatch the sheet uses:

```bash
curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/actions/workflows/deploy.yml/dispatches \
  -d '{"ref":"main","inputs":{"reason":"automation"}}'
```

## Files

| Path | What |
|---|---|
| `build.mjs` | Fetches the sheet and YouTube feed, then renders `dist/index.html`. |
| `src/styles.css`, `src/site.js` | Design and the platform filter. Both are inlined into the page. |
| `apps-script/Code.gs` | JSON endpoint, Website menu, auto-publish trigger, tab setup. |
| `.github/workflows/deploy.yml` | Build and deploy to GitHub Pages. |
| `sample-data.json` | Fixture for `--sample`. Same shape as the web app output. |
