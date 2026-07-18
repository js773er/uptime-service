import { auth } from "@clerk/nextjs/server";

/**
 * The signed-in user's id, or null when the request is unauthenticated.
 * Route handlers translate null into a 401; the proxy middleware already
 * blocks most unauthenticated traffic before it gets this far.
 */
export async function getUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}
