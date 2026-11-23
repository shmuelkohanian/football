# Supabase setup

1. Create a Supabase project and copy its project URL and publishable key into `.env.local`.
2. Apply migrations `001_initial_schema.sql`, `002_signup_window_0900.sql`, and `003_manager_membership_management.sql` in order in the Supabase SQL editor. Migration 003 adds the manager action for removing an approved member's access.
3. Create the first account through the app, then promote it from a trusted SQL Editor session:

   ```sql
   update public.profiles
   set status = 'approved', role = 'manager', approved_at = now()
   where id = (select id from auth.users where email = 'manager@example.com');
   ```

4. Set `SUPABASE_URL` and the project's secret API key as Cloudflare Worker variables/secrets. The secret key must never be placed in browser variables or committed to Git. The Worker sends it only as an `apikey` header.
5. Deploy the Worker. Its hourly trigger asks the database to finalize only during Monday 09:00–09:59 in `Asia/Jerusalem`; the database function is idempotent.

The app uses these schema functions for account registration, weekly signup, manager approvals, and attendance. Before inviting players, configure the Supabase Auth email settings and the Cloudflare Worker secrets, then deploy the app.
