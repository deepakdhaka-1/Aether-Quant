# Supabase Auth email templates

In the Supabase dashboard, open **Authentication → Email Templates**. For each template below, paste the matching `.html` file into the template body and set its subject as listed.

| Supabase template | Subject | File |
| --- | --- | --- |
| Confirm signup | Confirm your Aether Quant account | `confirm-signup.html` |
| Magic link | Your Aether Quant sign-in link | `magic-link.html` |
| Reset password | Reset your Aether Quant password | `reset-password.html` |

The signup confirmation and magic link templates include both the clickable `{{ .ConfirmationURL }}` and `{{ .Token }}`. The app accepts either the confirmation link or signup code, and either the sign-in link or email code. The password reset template uses `{{ .ConfirmationURL }}` for the app's callback flow. Keep the production `/auth/callback` URL in **Authentication → URL Configuration → Redirect URLs**.
