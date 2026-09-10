/**
 * Runs before `npm start` (via the `prestart` hook).
 *
 * src/environments/environment.local.ts is gitignored, so a fresh clone has
 * nothing for the development build's fileReplacements to swap in. Angular then
 * fails with:
 *
 *   An unhandled exception occurred: The .../environment.local.ts path in file
 *   replacements does not exist.
 *
 * which says nothing about what to do. This creates the file from the committed
 * template and explains what to fill in, so the first run of a clone is a
 * checklist rather than a stack trace.
 */

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'environments');
const localFile = path.join(dir, 'environment.local.ts');

const PLACEHOLDER_URL = 'YOUR_SUPABASE_URL_HERE';
const PLACEHOLDER_KEY = 'YOUR_SUPABASE_ANON_KEY_HERE';

const template = (url, key) => `// =============================================================
// LOCAL DEVELOPMENT ENVIRONMENT
//
// Gitignored — this file never leaves your machine.
// Values come from the Supabase dashboard: Settings -> API
// Use the ANON key. Never the service_role key: this file is
// compiled into the browser bundle.
// =============================================================

export const environment = {
  production: false,
  supabaseUrl: '${url}',
  supabaseAnonKey: '${key}',
};
`;

const instructions = () => {
  console.error('');
  console.error('  Supabase credentials are not set up yet.');
  console.error('');
  console.error('  Open this file and replace the two placeholder values:');
  console.error(`    ${path.relative(process.cwd(), localFile)}`);
  console.error('');
  console.error('  Get them from your Supabase project:');
  console.error('    Dashboard -> Settings -> API');
  console.error('      Project URL  ->  supabaseUrl');
  console.error('      anon  public ->  supabaseAnonKey   (NOT service_role)');
  console.error('');
  console.error('  Then run `npm start` again.');
  console.error('');
};

fs.mkdirSync(dir, { recursive: true });

// A CI job or another developer can supply these instead of editing the file.
if (!fs.existsSync(localFile) && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  fs.writeFileSync(localFile, template(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_ANON_KEY.trim()));
  console.log('Generated environment.local.ts from SUPABASE_URL / SUPABASE_ANON_KEY.');
  process.exit(0);
}

if (!fs.existsSync(localFile)) {
  fs.writeFileSync(localFile, template(PLACEHOLDER_URL, PLACEHOLDER_KEY));
  console.error('');
  console.error('  Created src/environments/environment.local.ts for you.');
  instructions();
  process.exit(1);
}

const contents = fs.readFileSync(localFile, 'utf8');
const url = contents.match(/supabaseUrl:\s*'([^']*)'/)?.[1] ?? '';
const key = contents.match(/supabaseAnonKey:\s*'([^']*)'/)?.[1] ?? '';

const problems = [];
if (!url || url === PLACEHOLDER_URL) problems.push('supabaseUrl is still a placeholder');
if (!key || key === PLACEHOLDER_KEY) problems.push('supabaseAnonKey is still a placeholder');

// Catch the service_role key being pasted here — it would be handed to every
// visitor in the JavaScript bundle, with RLS bypassed.
if (key && key !== PLACEHOLDER_KEY) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString('utf8'));
    if (payload.role && payload.role !== 'anon') {
      problems.push(`supabaseAnonKey carries role "${payload.role}" — use the anon key, never service_role`);
    }
  } catch {
    // Not a decodable JWT; the placeholder check above already covers the common case.
  }
}

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`  ${problem}`);
  instructions();
  process.exit(1);
}

console.log('Supabase credentials found. Starting dev server...');
