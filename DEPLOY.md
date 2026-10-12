# Putting The Old Mill online

This guide takes the website from this folder to a live web address, using **GitHub** (stores the code) and **Railway** (runs the website and its database). Allow about 30–45 minutes the first time. You don't need to type any code.

**What it costs:** GitHub is free. Railway's Hobby plan is $5 a month, which includes enough usage for a site this size.

---

## Part 1: Put the code on GitHub

### 1. Create a GitHub account
1. Go to **github.com** and select **Sign up**.
2. Follow the steps and verify your email address.

### 2. Install GitHub Desktop
1. Go to **desktop.github.com** and download GitHub Desktop for Mac.
2. Open it and sign in with your GitHub account.
3. If it asks for your name and email for commits, enter them.

### 3. Add this folder and publish it
1. In GitHub Desktop, choose **File → Add Local Repository…**
2. Select the **website** folder inside *The Old Mill App* (the one that contains `server.js`), then **Add Repository**.
3. Select **Publish repository** at the top.
4. Name it `the-old-mill`. **Leave "Keep this code private" ticked.**
5. Select **Publish Repository**.

Your code is now on GitHub. Only you can see it.

---

## Part 2: Run it on Railway

### 4. Create a Railway account
1. Go to **railway.com** and select **Login → Login with GitHub**.
2. Allow Railway to access your GitHub account when asked.
3. Choose the **Hobby** plan and add a payment card. The free trial won't keep the site running permanently.

### 5. Create the project from GitHub
1. In Railway, select **New Project → Deploy from GitHub repo**.
2. If Railway asks, select **Configure GitHub App** and give it access to the `the-old-mill` repository.
3. Choose **the-old-mill**. Railway starts building. The first deploy **will fail or warn**, because the database and settings aren't added yet. That's expected.

### 6. Add the database
1. In the project, select **+ Create** (or **New**) → **Database → Add PostgreSQL**.
2. Wait until the Postgres box shows as active.

### 7. Add the settings (variables)
1. Select the **the-old-mill** box (your website service, not Postgres).
2. Open the **Variables** tab and select **+ New Variable** for each of these:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` | the email you'll sign in with as landlord |
| `ADMIN_PASSWORD` | a strong password, **at least 10 characters** |

Type the `DATABASE_URL` value exactly as shown, curly brackets included. Railway replaces it with your database's real address.

3. Select **Deploy** (or **Apply changes**) when Railway offers it.

### 8. Give it a web address
1. Still in the website service, open **Settings → Networking**.
2. Select **Generate Domain**. You'll get an address like `the-old-mill-production.up.railway.app`.
3. Open it. You should see The Old Mill homepage with all the spaces.

### 9. Check it started properly
1. Open the **Deployments** tab, then the latest deployment's **View logs**.
2. You should see:
   - `Seeded 14 spaces and the property details.`
   - `Created the landlord account for you@…`
   - `The Old Mill is running on port …`

If the log shows a database connection error, check the `DATABASE_URL` variable from step 7.

---

## Part 3: First sign-in

### 10. Sign in as the landlord
1. Go to your web address and scroll to the bottom. Select **Landlord sign in** (or add `/#landlord` to the address).
2. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
3. Go to **Wi-Fi & details** and check:
   - your address and contact details
   - which payment methods you offer
   - the **bank details** for bank transfer invoices
   - your Wi-Fi networks and passwords

### 11. Add tenants and invite them
1. Open **Tenants → Add tenant**. Use the tenant's real email address.
2. In the tenant's row, select **Invite** in the **Portal** column.
3. Select **Copy message with link** and send it by WhatsApp or email.
4. The tenant opens the link, chooses a password and sees their own portal. The link works once and lasts 14 days.
5. If a tenant forgets their password, select **Reset link** and send them the new link.

---

## Optional: use your own domain (e.g. theoldmill.co.uk)
1. In Railway: website service → **Settings → Networking → Custom Domain**. Enter your domain.
2. Railway shows a **CNAME** record. Add it where you bought the domain (GoDaddy, 123-reg, Namecheap and so on), in the DNS settings.
3. It can take up to a few hours to start working. Railway adds the secure padlock (HTTPS) automatically.
4. Add a variable `PUBLIC_URL` with your full address, e.g. `https://theoldmill.co.uk`, so invitation links use it.

## Making changes later
- **Prices, statuses, text, tenants, invoices, Wi-Fi:** change them in the Landlord view. No code needed.
- **Code changes:** when the files in the `website` folder change, open GitHub Desktop. Type a short summary bottom-left, select **Commit to main**, then **Push origin**. Railway redeploys automatically in a minute or two.
- **New photos:** put the image (ideally under 500 KB) in `website/public/img/`, commit and push as above. Then in **Landlord → Spaces → Edit**, add a photo line like `Interior | img/your-photo.jpg`.

## If you forget the landlord password
1. In Railway, set `ADMIN_PASSWORD` to a new password and add a variable `ADMIN_RESET_PASSWORD` = `true`.
2. Let it redeploy, sign in with the new password, then **delete** `ADMIN_RESET_PASSWORD`.

## Backups
Your data is in the Railway Postgres database. To keep a copy, open the Postgres service in Railway and use its **Backups** tab where your plan offers it. You can also ask for an export to be added to the app.

## Running it on this Mac (optional)
You need Node.js 20 or newer from **nodejs.org**. Then in Terminal, inside the `website` folder:

```bash
npm install
```

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=a-long-test-password npm start
```

Open http://localhost:3000. Without a `DATABASE_URL` it saves to `website/data/dev-db.json`, which is never uploaded.

## Connect your email (Landlord → Email)
1. In Railway, open your website service → **Variables** → **+ New Variable**, and add:
   - `MAIL_USER` = `pete@theoldmillkineton.co.uk`
   - `MAIL_PASSWORD` = that mailbox's password
2. Railway redeploys automatically. Open **Landlord → Email** to see your inbox.
3. Waitlist alerts get a **Send email** button, invitations get **Email it to them**, and you're emailed whenever someone sends a request.

For a provider other than IONOS, also set `MAIL_IMAP_HOST` and `MAIL_SMTP_HOST`.
