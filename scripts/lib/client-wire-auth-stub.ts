/* Test-only stand-in for src/lib/auth in the client wire-contract bundle:
 * supplies a bearer token so the PRODUCTION request logic runs. Nothing else
 * is replaced — the code under test is the real one. */
export async function getAccessToken(): Promise<string | null> { return 'test-token'; }
