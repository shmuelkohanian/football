# Weekly Football Signup

A responsive, Hebrew-language web app for managing signup for a weekly football game.

## Stack

- React, TypeScript, and Vite for the website.
- Supabase Auth and PostgreSQL for accounts, manager approvals, signups, and attendance history.
- Cloudflare Workers for hosting and scheduled weekly selection.

## Run locally

1. Copy `.env.example` to `.env.local` and add the Supabase project URL and publishable key.
2. Run `npm install`.
3. Run `npm run dev`.

Apply `supabase/migrations/001_initial_schema.sql` to the Supabase project before using live data.

The first manager account must be promoted through the trusted Supabase SQL editor. Never expose the Supabase service role key in browser code.

## Deployment

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Cloudflare Worker secrets, then run `npm run deploy`. The scheduled Worker calls the finalization function hourly; the database only selects players on Monday between 08:00 and 09:00 in `Asia/Jerusalem`.

The initial interface includes the signup, account request, login, manager approval, and attendance flows. Configure Supabase before inviting players.
