/**
 * PII / secret scrubber for components saved to the global library.
 *
 * Two responsibilities:
 *  1. Refuse to save anything that looks like a secret (API key, AWS key, JWT,
 *     RSA private key, .env file).
 *  2. Replace common PII (phone numbers, emails, full street addresses, named
 *     business signatures) with placeholders so a saved "HVAC quote form"
 *     doesn't carry "Thor Industries · 555-0123" into the next user's build.
 *
 * Returns: { ok, scrubbed: files[], reasons: [] }
 *   ok=false means the component should NOT be saved at all (hard block).
 */

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,                   // OpenAI
  /sk_(test|live)_[A-Za-z0-9]{16,}/g,         // Stripe
  /AIza[0-9A-Za-z_\-]{35}/g,                  // Google
  /AKIA[0-9A-Z]{16}/g,                        // AWS access key
  /xox[abp]-[A-Za-z0-9-]{10,}/g,              // Slack
  /ghp_[A-Za-z0-9]{36}/g,                     // GitHub PAT (classic)
  /github_pat_[A-Za-z0-9_]{60,}/g,            // GitHub PAT (fine-grained)
  /eyJ[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g       // RSA / SSH private keys
];

const ENV_FILE_PATHS = [/^\.env(\..+)?$/i, /\/\.env(\..+)?$/i];

// PII patterns (replace, not block).
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const STREET = /\b\d{1,6}\s+[A-Z][a-z]+\s+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl)\.?\b/g;

// Heuristic for "the user's specific business name" — looks for the
// pattern "<Capitalized> Industries" or "<Capitalized> LLC" / "Inc." / "Corp."
// and replaces with a generic placeholder. Conservative so we don't over-strip.
const BUSINESS_NAME = /\b([A-Z][a-zA-Z]+ )(Industries|Enterprises|LLC|Inc\.?|Corp\.?|Co\.|Holdings|Group)\b/g;

const PLACEHOLDERS = {
  email: "contact@example.com",
  phone: "555-555-0100",
  street: "123 Example Street",
  business: "Example Company"
};

export function scrubFiles(files) {
  const reasons = [];
  const scrubbed = [];

  for (const file of files || []) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") continue;

    // Hard block: env files.
    if (ENV_FILE_PATHS.some(p => p.test(file.path))) {
      reasons.push(`Refused: env file (${file.path})`);
      return { ok: false, scrubbed: [], reasons };
    }

    let content = file.content;

    // Hard block: secrets.
    for (const pat of SECRET_PATTERNS) {
      if (pat.test(content)) {
        // Reset regex state since global flags persist.
        pat.lastIndex = 0;
        reasons.push(`Refused: secret detected in ${file.path}`);
        return { ok: false, scrubbed: [], reasons };
      }
      pat.lastIndex = 0;
    }

    // Soft scrub: PII replacements.
    const emailHits = content.match(EMAIL)?.length || 0;
    const phoneHits = content.match(PHONE)?.length || 0;
    const streetHits = content.match(STREET)?.length || 0;
    const bizHits = content.match(BUSINESS_NAME)?.length || 0;

    content = content
      .replace(EMAIL, PLACEHOLDERS.email)
      .replace(PHONE, PLACEHOLDERS.phone)
      .replace(STREET, PLACEHOLDERS.street)
      .replace(BUSINESS_NAME, `${PLACEHOLDERS.business} $2`);

    if (emailHits || phoneHits || streetHits || bizHits) {
      reasons.push(
        `Scrubbed ${file.path}: ${emailHits} email(s), ${phoneHits} phone(s), ${streetHits} address(es), ${bizHits} business name(s)`
      );
    }

    scrubbed.push({ ...file, content });
  }

  return { ok: true, scrubbed, reasons };
}
