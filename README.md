# The Old Mill

The website, tenant portal and landlord admin for The Old Mill, Mill Lane, Kineton.

- **Website**: spaces, photos, site plan, prices, and requests or waitlist sign-ups from visitors.
- **Tenant portal**: each tenant signs in to see their space, invoices, Wi-Fi details and messages.
- **Landlord admin**: spaces and availability, enquiries, tenants and portal invitations, invoices, messages, waitlist alerts, Wi-Fi and property details.

To put it online, follow **[DEPLOY.md](DEPLOY.md)**.

## How it's built
- `server.js`: Express server. It provides sign-in (bcrypt passwords and sessions stored in Postgres) and the JSON API. Prices of let spaces and bank details are removed before anything is sent to the public.
- `src/store.js`: storage. It uses Postgres when `DATABASE_URL` is set, otherwise a local JSON file for testing.
- `src/seed.json`: the property details and spaces loaded the first time the app starts on an empty database.
- `public/`: the front end (`index.html`, `app.css`, `app.js`) and images.

## Accounts
- **Landlord:** created at start-up from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- **Tenants:** the landlord creates a one-time invitation link for each tenant (valid 14 days), and the tenant chooses their own password. Ending a tenancy blocks that tenant's sign-in.

## Not included yet
- Emails aren't sent automatically. Waitlist alerts and invitation links are copied and sent by WhatsApp or email.
- Direct Debit isn't collected automatically. GoCardless can be added.
- Photos are added as files in `public/img`. There's no upload button yet.

## Search engines (SEO)
- Public pages are rendered on the server (`src/ssr.js` runs `public/app.js` in a sandbox), so search engines see full content without JavaScript.
- Addresses: `/`, `/rooms`, `/workshops`, `/storage`, `/spaces/<name>`. Old `#unit-…` links redirect.
- `robots.txt` and `sitemap.xml` are generated live from the database. `/tenant`, `/landlord`, `/invite` and `/api` are noindexed.
- Category intro copy lives in `CATS` in `public/app.js` (draft, edit freely).
- New photos: add a `.jpg` to `public/img`. WebP versions are optional; until they exist, the original JPEG is served.
