// Supabase config for the dashboard page. Kept as a classic (non-module) script so the
// page works when opened as a packaged chrome-extension page, where the MV3 CSP blocks
// remote module imports. Mirror of src/lib/config.js — update both when rotating.
//
// SECURITY: the anon key is PUBLIC by design, but do not commit a live project key to
// a public repo. Mirror src/lib/config.js when configuring locally.
window.SUPABASE_CONFIG = {
  url: 'https://your-project-ref.supabase.co',
  anonKey: 'YOUR_SUPABASE_ANON_KEY',
};
