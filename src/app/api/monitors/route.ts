import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import {
  createMonitor,
  getMonitorsByUser,
  MonitorLimitError,
} from "@/lib/monitors";
import { createMonitorSchema } from "@/lib/schemas";

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

  // Default downtime alerts to the account's email unless one was provided.
  const user = await currentUser();
  const alertEmail =
    parsed.data.alertEmail ?? user?.primaryEmailAddress?.emailAddress;

  try {
    const monitor = await createMonitor({
      userId,
      name: parsed.data.name,
      url: parsed.data.url,
      alertEmail,
    });
    return NextResponse.json({ monitor }, { status: 201 });
  } catch (err) {
    // The cap is enforced atomically in the data layer (counter condition),
    // so concurrent creates can't slip past a read-then-write window.
    if (err instanceof MonitorLimitError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
}
