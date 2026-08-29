/**
 * Writes src/environments/environment.prod.ts from the deployment's environment
 * variables. Runs automatically via the `prebuild` npm script.
 *
 * Required on Vercel (Project Settings -> Environment Variables):
 *   SUPABASE_URL       https://<project-ref>.supabase.co
 *   SUPABASE_ANON_KEY  the anon/publishable key — never the service role key
 *
 * This deliberately fails the build when either is missing. It used to fall back
 * to placeholder strings, which produced a green build that shipped an app
 * pointing at "YOUR_SUPABASE_URL_HERE" and only broke once a user opened it.
 * A cached service worker then made that broken shell stick around.
 */

const fs = require('fs');
const path = require('path');

const url = (process.env.SUPABASE_URL || '').trim();
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

const problems = [];

if (!url) {
  problems.push('SUPABASE_URL is not set.');
} else if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
  problems.push(`SUPABASE_URL does not look like a Supabase URL: "${url}"`);
}

if (!anonKey) {
  problems.push('SUPABASE_ANON_KEY is not set.');
} else if (!/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(anonKey)) {
  problems.push('SUPABASE_ANON_KEY does not look like a JWT — check it was pasted in full.');
}

// Guard against the service role key being pasted in by mistake. It would be
// bundled into client-side JavaScript and handed to every visitor, granting
// full read/write access to the database with RLS bypassed.
if (anonKey) {
  try {
    const payload = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64').toString('utf8'));
    if (payload.role && payload.role !== 'anon') {
      problems.push(
        `SUPABASE_ANON_KEY carries role "${payload.role}", not "anon". ` +
        'Never ship a service role key to the browser.'
      );
    }
  } catch {
    // Not decodable — the JWT shape check above already covers it.
  }
}

if (problems.length > 0) {
  console.error('\n✖ Cannot generate environment.prod.ts:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nSet these in the Vercel project settings and redeploy.\n');
  process.exit(1);
}

const dir = path.join(__dirname, '../src/environments');
fs.mkdirSync(dir, { recursive: true });

const contents = `export const environment = {
  production: true,
  supabaseUrl: '${url.replace(/\/$/, '')}',
  supabaseAnonKey: '${anonKey}'
};
`;

fs.writeFileSync(path.join(dir, 'environment.prod.ts'), contents);
console.log('✅ Generated environment.prod.ts');
