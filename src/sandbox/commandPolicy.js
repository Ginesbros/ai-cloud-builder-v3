/**
 * Hardened command policy.
 *
 * Allow-list now covers:
 *   - Node tooling (npm/pnpm/yarn, vite, next, lint/test/typecheck)
 *   - Python tooling (python -m venv, pip install, pytest, python script.py --help)
 *   - Static-file servers for smoke tests (npx serve, python -m http.server)
 *   - Bash --help inspections (script.sh --help)
 *
 * Denylist blocks:
 *   - Destructive ops (rm -rf, sudo, chmod 777)
 *   - Secret reads (printenv, env, .env, known API key names)
 *   - Shell chaining/substitution (;, &&, |, $(, backticks)
 */

const allowed = [
  // Node installs
  /^npm install$/,
  /^npm ci$/,
  /^npm install --no-audit --no-fund$/,
  /^npm install --omit=dev$/,
  /^npm install --legacy-peer-deps$/,
  /^pnpm install$/,
  /^yarn install$/,
  /^yarn$/,

  // Node build/lint/test
  /^npm run build$/,
  /^npm run lint$/,
  /^npm test$/,
  /^npm run test$/,
  /^npm run typecheck$/,
  /^npx tsc --noEmit$/,

  // Node dev/preview servers (smoke tests)
  /^npx vite --host 0\.0\.0\.0 --port \d+$/,
  /^npm run dev -- --host 0\.0\.0\.0 --port \d+$/,
  /^npm run preview -- --host 0\.0\.0\.0 --port \d+$/,
  /^npx next start -p \d+$/,
  /^npm run start -- -p \d+$/,
  /^node [\w./-]+\.(?:js|mjs|cjs)( --help)?$/,

  // Static file servers (for static_site smoke tests)
  /^npx serve -l \d+ \.$/,
  /^python -m http\.server \d+$/,
  /^python3 -m http\.server \d+$/,

  // Python tooling
  /^python -m venv \.venv$/,
  /^python3 -m venv \.venv$/,
  /^\.venv\/bin\/pip install -r requirements\.txt$/,
  /^\.venv\/bin\/pip install [a-zA-Z0-9_\-.,= ]+$/,
  /^\.venv\/bin\/python [\w./-]+\.py( --help)?$/,
  /^\.venv\/bin\/pytest$/,

  // Bash inspections
  /^bash [\w./-]+\.sh --help$/
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
  /OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|GITHUB_TOKEN|VERCEL_TOKEN|ANTHROPIC_API_KEY|XAI_API_KEY|GOOGLE_GEMINI_API_KEY|MANUS_API_KEY|HIGGSFIELD_API_KEY|PERPLEXITY_API_KEY/i,
  /[;&]{1,2}\s*\S/,
  /\|\s*\S/,
  /`/,
  /\$\(/
];

const MAX_LEN = 240;

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
