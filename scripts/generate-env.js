const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../src/environments');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Generate environment.prod.ts from Vercel's Environment Variables
const prodEnvFile = path.join(dir, 'environment.prod.ts');
const prodEnvContent = `
export const environment = {
  production: true,
  supabaseUrl: '${process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL_HERE'}',
  supabaseAnonKey: '${process.env.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY_HERE'}'
};
`;

fs.writeFileSync(prodEnvFile, prodEnvContent.trim());
console.log('✅ Generated environment.prod.ts successfully.');
