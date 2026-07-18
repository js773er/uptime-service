import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { createMonitor, getMonitorsByUser } from "@/lib/monitors";
import { createMonitorSchema } from "@/lib/schemas";

/** Free-tier cap: a user may own at most this many monitors. */
const MAX_MONITORS_PER_USER = 5;

/** GET /api/monitors — list the current user's monitors. */
export async function GET(request: Request) {
  const userId = getUserId(request);
  const monitors = await getMonitorsByUser(userId);
  return NextResponse.json({ monitors });
}

/** POST /api/monitors — create a monitor (max 5 per user). */
export async function POST(request: Request) {
  const userId = getUserId(request);

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

  const monitor = await createMonitor({
    userId,
    name: parsed.data.name,
    url: parsed.data.url,
    alertEmail: parsed.data.alertEmail,
  });

  return NextResponse.json({ monitor }, { status: 201 });
}
