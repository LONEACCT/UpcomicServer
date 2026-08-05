# UPCOMIC

A self-hosted adult comic platform with a horizontal top-nav layout, hero
carousel, Trending Now / Latest Updates sections, genre browsing, ratings,
bookmarks, and a single-tier VIP membership with the same manual
Telegram-payment + code system as your other SINCOMIC sites.

This is a **standalone project** — separate from SINCOMIC #1 and #2. Nothing
here touches or depends on those.

---

## 1. What's in it

**Public site**
- Homepage: hero carousel (Featured comics), Trending Now row, Latest
  Updates row, Latest/Popular/Trending sort tabs, genre filter, search,
  a full comic grid, and a VIP promo band
- Comic detail page: cover, rating, genre tags, description, Status
  (Ongoing/Completed), Chapters, Views, Read Latest / Read From Start,
  Bookmark (for logged-in users) and Share (copies the link), and a
  chapter list with play icons, NEW badges, and an ascending/descending
  sort toggle
- Chapter reader with prev/next chapter navigation
- VIP page: benefits list, a single ₦5,000/month price panel, a 4-step
  "how to get access" guide, and a Telegram help box
- Mobile: hamburger slide-out menu in the header, plus a fixed bottom tab
  bar (Home / Comics / Updates / VIP / Profile)

**Admin dashboard** (`/admin`, password-protected)
- Comics: cover (auto-converted to JPG on upload), title, description, rating,
  status, genres (free-text, auto-creates new ones), Featured/Trending flags
- Chapters: add via manual multi-image select **or** a single ZIP (auto-extracted
  and naturally sorted), **Bulk ZIP upload** (several ZIPs at once, one chapter
  per ZIP, chapter number parsed from the filename), edit-in-place (rename/
  renumber/toggle VIP/reschedule without re-uploading pages), and scheduled
  publishing (hidden from readers, and no notification sent, until the
  scheduled time)
- New-chapter notifications: auto-posts to a Telegram channel and sends Web
  Push to readers who bookmarked that comic; both fire immediately on publish
  or automatically when a scheduled chapter's time arrives (checked every
  minute). Email is wired on the backend too, but there's no UI yet for a
  reader to add an email address, so it stays dormant until that's built.
- Reported Comments: readers can report a comment from the chapter page; this
  queue lets you Dismiss (clears the report, keeps the comment) or Delete it
- Genres: manage the full list, see how many comics use each
- VIP Codes: generate single-use codes, track status/redemption
- Users: see accounts and VIP status

**Comments** — logged-in readers can comment on a chapter and report other
comments; reports feed the admin moderation queue above.

**VIP system** — identical mechanics to your other SINCOMIC sites: you
generate a single-use code after payment, the buyer redeems it for exactly
30 days of access, a used code can never be reused. The only difference
here is the price is shown directly on the page (₦5,000/month) instead of
"message to negotiate."

---

## 2. Running it on your own computer first (strongly recommended)

You'll need [Node.js](https://nodejs.org) installed (version 18 or newer).

```bash
cd upcomic
npm install
cp .env.example .env
```

Open `.env` and fill in:

```
PORT=3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=pick-a-strong-password
SESSION_SECRET=paste-a-long-random-string-here
SITE_NAME=UPCOMIC
SITE_MOTTO=Uncensored Stories. Every Chapter.
VIP_PRICE=5,000
VIP_PRICE_PERIOD=month
TELEGRAM_CHANNEL=@upcomic
TELEGRAM_ADMIN=@upcomicadmin
```

Generate a good `SESSION_SECRET` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

New-chapter notifications (Telegram, Web Push, email) are optional — each
channel just stays silent if its variables are left blank. See the extra
vars documented in `.env.example` (`TELEGRAM_BOT_TOKEN`, `VAPID_PUBLIC_KEY`
/`VAPID_PRIVATE_KEY` — generate with `npx web-push generate-vapid-keys` —
and `SMTP_USER`/`SMTP_PASS`).

Then start the site:
```bash
npm start
```

Visit `http://localhost:3000` for the public site, and
`http://localhost:3000/admin` for the dashboard.

---

## 3. Deploying on Hostinger

Same approach as your other SINCOMIC sites:

1. Get a Hostinger VPS (Ubuntu), install Node.js.
2. Upload this `upcomic` folder, run `npm install`, create `.env`.
3. Run it with a process manager so it survives reboots:
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name upcomic
   pm2 save
   pm2 startup
   ```
4. Point a domain/subdomain at the VPS and put Nginx in front of it for
   HTTPS. Ask me if you want this running alongside your other sites on
   one server — happy to write the Nginx config for that.

---

## 4. Using it day to day

**Post a new comic:** Admin → Comics → New Comic → cover, title,
description, rating, status (Ongoing/Completed), genres (type them
comma-separated — new ones are created automatically), tick Featured for
the homepage carousel or Trending to boost it in that sort tab.

**Post a chapter:** Admin → Comics → Manage chapters → New Chapter →
upload pages in order, tick "premium" if it should be VIP-only.

**Manage genres:** Admin → Genres shows the full list with how many comics
use each — you can add or delete from there too, though typing them
directly on the comic form is the normal way.

**Sell VIP access:** Someone pays and sends proof via your admin Telegram
(`@upcomicadmin`), you generate a code in Admin → VIP Codes, send it to
them, they redeem it at `/redeem` for 30 days of access.

---

## 5. A few things worth knowing

- **Views counting is simple** — it increments once per page load of a
  comic's detail page, including when someone toggles the chapter sort
  order. It's not deduplicated per visitor. Good enough to show relative
  popularity, not a precise analytics number.
- **Bookmarks** require an account — a logged-out visitor sees a Bookmark
  link that sends them to log in first.
- **Back up `data/upcomic.db` regularly** — one file holds everything:
  comics, genres, users, codes, bookmarks.
- **Keep `.env` private** — it holds your admin password in plain text.
- **This wasn't run in a live server during building** — I built this in a
  sandboxed environment with no internet access, so I couldn't `npm
  install` or click through it myself. I syntax-checked every file and
  traced the logic by hand, and rendered the actual CSS/HTML in a headless
  browser to verify the visual design, but please do a full click-through
  on your own machine before relying on it for real payments: post a
  comic with genres/rating, mark it Featured and Trending, check the
  homepage carousel and Trending row, post a chapter and mark it premium,
  bookmark a comic, generate and redeem a test code, confirm the used
  code is rejected the second time.
