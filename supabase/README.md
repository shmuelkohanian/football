# Supabase setup

1. Create a Supabase project and copy its project URL and publishable key into `.env.local`.
2. Apply migrations `001_initial_schema.sql` through `013_match_player_stats_and_leaderboards.sql` in order in the Supabase SQL editor. Migrations 008–013 remove the temporary registration limit, set the roster size to 15, rank every registrant, add four attendance statuses, calculate weighted priority over the previous eight weeks, save goals and assists, and provide monthly leaderboards.
3. Create the first account through the app, then promote it from a trusted SQL Editor session:

   ```sql
   update public.profiles
   set status = 'approved', role = 'manager', approved_at = now()
   where id = (select id from auth.users where email = 'manager@example.com');
   ```

4. Set `SUPABASE_URL` and the project's secret API key as Cloudflare Worker variables/secrets. The secret key must never be placed in browser variables or committed to Git. The Worker sends it only as an `apikey` header.
5. Deploy the Worker. Its hourly trigger asks the database to finalize during Monday 09:00–09:59 in `Asia/Jerusalem`, unless a manager has manually left signup open; the database function is idempotent.

The app uses these schema functions for account registration, unlimited weekly signup, manager approvals, roster selection, and attendance. The live list shows the current ranking as it changes; when signup closes, the first 15 are selected and all remaining registrants appear in priority order. Selected players remain pending until a manager records attendance. Before inviting players, configure the Supabase Auth email settings and the Cloudflare Worker secrets, then deploy the app.
