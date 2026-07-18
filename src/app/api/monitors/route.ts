import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { createMonitor, getMonitorsByUser } from "@/lib/monitors";
import { createMonitorSchema } from "@/lib/schemas";

/** Free-tier cap: a user may own at most this many monitors. */
const MAX_MONITORS_PER_USER = 5;

/** GET /api/monitors — list the current user's monitors. */
export async function GET() {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const monitors = await getMonitorsByUser(userId);
  return NextResponse.json({ monitors });
}

/** POST /api/monitors — create a monitor (max 5 per user). */
export async function POST(request: Request) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = createMonitorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const existing = await getMonitorsByUser(userId);
  if (existing.length >= MAX_MONITORS_PER_USER) {
    return NextResponse.json(
      { error: `monitor limit reached (max ${MAX_MONITORS_PER_USER})` },
      { status: 403 },
    );
  }

  // Default downtime alerts to the account's email unless one was provided.
  const user = await currentUser();
  const alertEmail =
    parsed.data.alertEmail ?? user?.primaryEmailAddress?.emailAddress;

  const monitor = await createMonitor({
    userId,
    name: parsed.data.name,
    url: parsed.data.url,
    alertEmail,
  });

  return NextResponse.json({ monitor }, { status: 201 });
}
