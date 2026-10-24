// Import this FIRST in a test whose code imports src/config/supabase.js (directly or through accessScope /
// services/accounts.js). It gives the client a harmless URL and key so the import does not exit; nothing is
// ever sent there, the tests pass their own fake database.
process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
