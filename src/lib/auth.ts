/**
 * Resolve the current user's id for an API request.
 *
 * Clerk integration arrives in Step 6. Until then this reads an `x-user-id`
 * header (handy for Postman and tests) and falls back to a fixed dev user so
 * the monitor routes are exercisable end-to-end. Step 6 will replace the body
 * of this function with Clerk's `auth()` and return `null` when unauthenticated.
 */
const DEV_USER_ID = "dev-user";

export function getUserId(request: Request): string {
  return request.headers.get("x-user-id")?.trim() || DEV_USER_ID;
}
