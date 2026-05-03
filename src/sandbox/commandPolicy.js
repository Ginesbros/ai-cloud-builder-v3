const allowed = [
  /^npm install$/,
  /^npm ci$/,
  /^npm run build$/,
  /^npm test$/,
  /^npm run test$/,
  /^npm run lint$/,
  /^npx vite --host 0\.0\.0\.0 --port \d+$/,
  /^npm run dev -- --host 0\.0\.0\.0 --port \d+$/
];

const denied = [
  /rm\s+-rf/,
  /sudo/,
  /chmod\s+777/,
  /curl\s+.*\|\s*sh/,
  /wget\s+.*\|\s*sh/,
  /\.env/,
  /printenv/,
  /OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|GITHUB_TOKEN|VERCEL_TOKEN/
];

export function assertCommandAllowed(command) {
  if (denied.some(p => p.test(command)) || !allowed.some(p => p.test(command))) {
    throw new Error(`Command blocked: ${command}`);
  }
}
