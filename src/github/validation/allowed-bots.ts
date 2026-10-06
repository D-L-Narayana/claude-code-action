/**
 * Shared matching for the `allowed_bots` input.
 *
 * Both the human-actor check (actor.ts) and the write-permission check
 * (permissions.ts) consult the same allow-list. Keeping a single
 * implementation guarantees the two checks cannot drift apart and end up
 * accepting different sets of actors.
 */

/**
 * Normalize a GitHub login for comparison: trim, lowercase, and drop one
 * trailing "[bot]" suffix.
 *
 * GitHub logins are case-insensitive, and App actors appear with the "[bot]"
 * suffix in REST payloads and the UI but without it in GraphQL, so both the
 * configured entry and the actor have to be reduced to the same form before
 * they can be compared.
 */
export function normalizeLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

/**
 * Check if a bot actor is in the allowed bots list.
 *
 * "*" allows every actor; an empty list allows none; otherwise the
 * comma-separated entries are compared with the actor after normalizeLogin
 * on both sides, so "dependabot", "Dependabot[bot]" and "dependabot[bot]"
 * all denote the same entry.
 */
export function isAllowedBot(actor: string, allowedBots: string): boolean {
  const trimmed = allowedBots.trim();
  if (trimmed === "*") return true;
  if (!trimmed) return false;

  const allowedList = trimmed
    .split(",")
    .map(normalizeLogin)
    .filter((bot) => bot.length > 0);

  return allowedList.includes(normalizeLogin(actor));
}
