// Supabase connection config — single source of truth for the extension side
// (service worker / sync.js). The dashboard page has its own classic-script copy at
// dashboard/config.js (it can't ES-import under the MV3 page CSP); keep the two in
// sync when rotating the project.
//
// SECURITY: the anon key is a PUBLIC client key, but do not commit a live project
// key to a public repo. Copy your Supabase URL and anon public key here locally, then
// mirror the same values in dashboard/config.js. Real access control belongs in RLS.
export const SUPABASE_URL = 'https://your-project-ref.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
