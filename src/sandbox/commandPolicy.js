/**
 * Hardened command policy.
 *
 * - Allowed list now covers Vite, Next.js, install variants, and lint/test/build.
 * - Denied list blocks anything destructive, privileged, or that exposes secrets.
 * - Commands are also length-limited to prevent shell-injection chains.
 */

const allowed = [
  // installs
  /^npm install$/,
  /^npm ci$/,
  /^npm install --no-audit --no-fund$/,
  /^npm install --omit=dev$/,
  /^npm install --legacy-peer-deps$/,
  /^pnpm install$/,
  /^yarn install$/,

  // build / lint / test
  /^npm run build$/,
  /^npm run lint$/,
  /^npm test$/,
  /^npm run test$/,
  /^npm run typecheck$/,
  /^npx tsc --noEmit$/,

  // dev servers (smoke tests)
  /^npx vite --host 0\.0\.0\.0 --port \d+$/,
  /^npm run dev -- --host 0\.0\.0\.0 --port \d+$/,
  /^npm run preview -- --host 0\.0\.0\.0 --port \d+$/,
  /^npx next start -p \d+$/,
  /^npm run start -- -p \d+$/
];

const denied = [
  /rm\s+-rf/i,
  /sudo/i,
  /chmod\s+777/i,
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
  /\benv\b/i,
  /printenv/i,
  /\.env\b/i,
  /OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|GITHUB_TOKEN|VERCEL_TOKEN|ANTHROPIC_API_KEY|XAI_API_KEY|GOOGLE_GEMINI_API_KEY/i,
  /[;&]{1,2}\s*\S/, // chained commands
  /\|\s*\S/, // pipes (except inside our allowed regex which doesn't have any)
  /`/, // backticks (command substitution)
  /\$\(/ // $(...) substitution
];

const MAX_LEN = 200;

export function assertCommandAllowed(command) {
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_LEN) {
    throw new Error(`Command rejected (length): ${command}`);
  }
  if (denied.some(p => p.test(command))) {
    throw new Error(`Command blocked (denylist): ${command}`);
  }
  if (!allowed.some(p => p.test(command))) {
    throw new Error(`Command blocked (not allow-listed): ${command}`);
  }
}

export function listAllowedPatterns() {
  return allowed.map(r => r.source);
}
