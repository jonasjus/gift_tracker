# Gift Tracker

Track the people you buy gifts for, their wishlists, occasions and budgets, and get gift suggestions from Gemini that can be bought in shops in each person's country. Accounts and data live in Supabase, so family and friends can share lists.

```
gift_tracker/
├── web/                         static site (no build step)
│   ├── index.html
│   ├── app.js                   UI + Supabase calls
│   ├── styles.css
│   └── config.js                your Supabase URL and anon key go here
├── supabase/
│   ├── config.toml
│   ├── migrations/…_init.sql    tables, row-level security, group functions
│   └── functions/suggest-gifts/ Edge Function that calls the Gemini API
└── gift_tracker.html            the original single-user claude.ai version
```

## How sharing works

- Everything you add is private to your account.
- Create a **group** (e.g. "Family") and give others its 8-character invite code. They join from the Groups panel.
- In a person's details, set **Shared with** to a group. Everyone in the group can then see and edit that person's wishlist and gifts. When someone marks a gift bought, the others see "bought by …", so nobody buys the same thing twice.
- If the person you're buying for is also in the group, choose them under **Hide gifts from**. They still see and can add to their own wishlist, but never the gifts planned for them.
- Occasions can be private or shared with a group. Opening an occasion shows its gift list across everyone.
- Only the person who added someone can change who they're shared with or remove them. If a group is deleted, its people and occasions become private again for whoever added them.

## Setup

1. **Create a Supabase project** at <https://supabase.com/dashboard>.

2. **Install the Supabase CLI** and link this folder to the project:
   ```sh
   brew install supabase/tap/supabase
   cd gift_tracker
   supabase login
   supabase link --project-ref <your-project-ref>
   ```

3. **Create the database tables and security rules:**
   ```sh
   supabase db push
   ```

4. **Deploy the suggestion function.** It needs a Gemini API key from <https://aistudio.google.com/apikey>:
   ```sh
   supabase secrets set GEMINI_API_KEY=...
   supabase functions deploy suggest-gifts
   ```

5. **Point the site at your project.** In the dashboard, open Project Settings → API. Copy the project URL and the `anon` public key into `web/config.js`. The anon key is meant to be public, because row-level security protects the data.

6. **Set the auth URLs.** Under Authentication → URL Configuration, set the Site URL to wherever you host the site (use `http://localhost:5173` while testing). The confirmation email links back to that address. For quick testing you can turn off "Confirm email" under Authentication → Providers → Email.

7. **Run it locally:**
   ```sh
   python3 -m http.server 5173 -d web
   ```
   Then open <http://localhost:5173>.

## Hosting

`web/` is a plain static folder. Any static host works: Netlify (drag the folder onto app.netlify.com/drop), Vercel, Cloudflare Pages or GitHub Pages. After deploying, add the live URL to the Site URL / Redirect URLs from step 6.

## Gift suggestions

`supabase/functions/suggest-gifts` reads the person's notes, wishlist, existing gifts and budget using the signed-in user's own token, so it can only see what that user can see. It then asks Gemini for 6 ideas sold by real stores in the recipient's country, returned as JSON that matches a fixed schema.

- The model defaults to `gemini-flash-latest`, Google's alias for its current Flash model. To use a different one, set a secret and redeploy: `supabase secrets set GEMINI_MODEL=<model-name>`.
- Usage is billed to the Google account that owns the API key. Gemini API keys come with a free tier.
- If Gemini's safety filters block a request, the app asks you to reword it.
- Suggestions are not saved until you click "Add to gifts".

## Notes

- Budgets are shown in each viewer's own currency setting. If members of a group use different currencies, agree on one.
- Changes from other group members appear live (Supabase Realtime). Reloads wait until you stop typing.
- Data from the old claude.ai version isn't migrated automatically. It was stored in claude.ai, not Supabase.
