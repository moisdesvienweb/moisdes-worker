# Google Calendar setup — "Calendar" admin tab

The admin's **Upload → Calendar** tab creates real events on your Google
Calendar (not just on the site). To do that, the Worker needs its own
Google credentials — something only you can create, since it requires
access to your Google account. This is a one-time setup.

There are two separate things to set up. Do them in this order.

## Part 1 — A service account that can write events (required)

This is what lets the Worker create events on your behalf, with no login
popup and nothing that expires.

1. **Open Google Cloud Console** → https://console.cloud.google.com
   - If you don't already have a project, create one (top-left project
     picker → "New Project"). Any name is fine, e.g. "Moisdes Vien".

2. **Enable the Calendar API**
   - Go to "APIs & Services" → "Library".
   - Search for **Google Calendar API** → click it → **Enable**.

3. **Create a service account**
   - Go to "APIs & Services" → "Credentials".
   - Click **Create Credentials** → **Service account**.
   - Give it any name (e.g. "moisdes-calendar-writer") → **Create and continue** → skip the optional role/access steps → **Done**.

4. **Generate a JSON key for it**
   - On the Credentials page, click the service account you just created.
   - Go to the **Keys** tab → **Add Key** → **Create new key** → choose **JSON** → **Create**.
   - A `.json` file downloads to your computer. This file is a secret —
     don't post it anywhere public.
   - Open it in any text editor. It looks like:
     ```json
     {
       "type": "service_account",
       "project_id": "...",
       "private_key_id": "...",
       "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
       "client_email": "moisdes-calendar-writer@your-project.iam.gserviceaccount.com",
       ...
     }
     ```
   - Copy the **`client_email`** value — you'll need it in the next step.

5. **Share your calendar with the service account**
   - Open **Google Calendar** (calendar.google.com) in your browser.
   - Find the calendar you want events created on → hover it in the left
     sidebar → ⋮ → **Settings and sharing**.
   - Under "Share with specific people or groups" → **Add people and groups**.
   - Paste in the `client_email` from step 4.
   - Set its permission to **"Make changes to events"**.
   - Click **Send**.

6. **Set the Worker secret**
   - In the Cloudflare dashboard: Workers & Pages → **moisdes-worker** →
     Settings → Variables and Secrets → **Add**.
   - Name: `GCAL_SERVICE_ACCOUNT_JSON`
   - Value: paste the **entire contents** of the downloaded `.json` file,
     exactly as-is (it's one JSON object — don't reformat it).
   - Type: **Secret** (encrypted).
   - Save, then redeploy (or it'll pick it up on the next deploy either way).
   - You should already have a secret named `GCAL_CALENDAR_ID` from the
     existing read-only calendar feed — the new "Calendar" tab writes to
     that same calendar ID. If you ever want events to go to a different
     calendar, update that secret (and re-share that calendar with the
     service account in step 5).

That's it for Part 1 — once that secret is set, the Calendar tab in
Admin → Upload will create real events on your Google Calendar.

## Part 2 — Google Maps address suggestions for the Location field (optional)

Without this, the Location field on the Calendar tab is still a normal
text box — you can type any address or venue name by hand. This step
adds the address-suggestions dropdown as you type.

1. **Enable billing on the Google Cloud project** (Billing → link a
   billing account). Every Google Maps Platform API requires this even
   though there's a monthly free usage tier — without it, the key will
   fail with a billing error no matter what else is set up correctly.
2. In the same project, go to "APIs & Services" → "Library" → search
   **Places API (New)** → **Enable**.
   - Note: this is a different product from the plain "Places API" (no
     "(New)") — make sure you enable the one with "(New)" in the name.
     The admin's address field calls this one directly over HTTPS; it
     doesn't load any Google Maps JavaScript on the page at all.
3. Go to "APIs & Services" → "Credentials" → **Create Credentials** →
   **API key**.
4. Click the new key to restrict it (recommended, not required):
   - Under "Application restrictions" choose **Websites** and add
     `chatzarvien.org/*`.
   - Under "API restrictions" choose **Restrict key** and select
     **Places API (New)**.
   - Save.
5. Copy the key (starts with `AIza...`).
6. In the site admin: **Settings → Google Maps API key** → paste it in →
   **Save**.

No code change or redeploy needed for this part — it's read from your
site settings, not a Worker secret, because it's a public (but
referrer-restricted) key meant to be used client-side.
