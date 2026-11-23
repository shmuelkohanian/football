# Supabase setup

1. Create a Supabase project and copy its project URL and publishable key into `.env.local`.
2. Apply migrations `001_initial_schema.sql`, `002_signup_window_0900.sql`, `003_manager_membership_management.sql`, `004_manager_member_actions.sql`, `005_manual_signup_control.sql`, `006_temporary_signup_limit.sql`, and `007_add_absence_action.sql` in order in the Supabase SQL editor. Migrations 003–005 add manager controls for membership and signup. Migration 006 temporarily limits registration and selection to two players for testing; restore `public.signup_settings.max_signups` to 15 afterward. Migration 007 adds the absence action for the latest closed signup.
3. Create the first account through the app, then promote it from a trusted SQL Editor session:

   ```sql
   update public.profiles
   set status = 'approved', role = 'manager', approved_at = now()
   where id = (select id from auth.users where email = 'manager@example.com');
   ```

4. Set `SUPABASE_URL` and the project's secret API key as Cloudflare Worker variables/secrets. The secret key must never be placed in browser variables or committed to Git. The Worker sends it only as an `apikey` header.
5. Deploy the Worker. Its hourly trigger asks the database to finalize during Monday 09:00–09:59 in `Asia/Jerusalem`, unless a manager has manually left signup open; the database function is idempotent.

The app uses these schema functions for account registration, weekly signup, manager approvals, and attendance. Before inviting players, configure the Supabase Auth email settings and the Cloudflare Worker secrets, then deploy the app.
