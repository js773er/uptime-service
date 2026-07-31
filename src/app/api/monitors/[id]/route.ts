import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { getRecentChecks } from "@/lib/checks";
import {
  deleteMonitor,
  getMonitorById,
  setMonitorActive,
} from "@/lib/monitors";
import { updateMonitorSchema } from "@/lib/schemas";

type RouteContext = { params: Promise<{ id: string }> };

/** GET /api/monitors/[id] — a single monitor plus its recent checks. */
export async function GET(request: Request, { params }: RouteContext) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const monitor = await getMonitorById(userId, id);
  if (!monitor) {
    return NextResponse.json({ error: "monitor not found" }, { status: 404 });
  }

  const checks = await getRecentChecks(id);
  return NextResponse.json({ monitor, checks });
}

/** PATCH /api/monitors/[id] — pause/resume a monitor. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = updateMonitorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const monitor = await setMonitorActive(userId, id, parsed.data.active);
  if (!monitor) {
    return NextResponse.json({ error: "monitor not found" }, { status: 404 });
  }

  return NextResponse.json({ monitor });
}

/** DELETE /api/monitors/[id] — remove a monitor. */
export async function DELETE(request: Request, { params }: RouteContext) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const monitor = await getMonitorById(userId, id);
  if (!monitor) {
    return NextResponse.json({ error: "monitor not found" }, { status: 404 });
  }

  await deleteMonitor(userId, id);
  return new NextResponse(null, { status: 204 });
}
