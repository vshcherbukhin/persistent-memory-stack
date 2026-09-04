/**
 * Edge-safe cookie name constants. Kept in their OWN module (no node: imports, no
 * 'server-only') so the Edge middleware can import the names without dragging in
 * session.ts → local-session.ts → node:crypto (which the Edge runtime can't bundle).
 */
export const SESSION_COOKIE = 'pm_admin_token'
