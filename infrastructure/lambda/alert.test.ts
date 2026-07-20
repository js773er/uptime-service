import type { SQSEvent, SQSRecord } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentAlert } from "./queue";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { formatAlertEmail, handler } from "./alert";

const alert: IncidentAlert = {
  incidentId: "inc-1",
  monitorId: "m1",
  monitorName: "My site",
  url: "https://example.com",
  startedAt: "2026-07-18T00:00:00.000Z",
  statusCode: 503,
  alertEmail: "owner@example.com",
};

function sqsEvent(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, i) => ({ messageId: `msg-${i}`, body }) as SQSRecord,
    ),
  };
}

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
  process.env.RESEND_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.ALERT_FALLBACK_EMAIL;
  delete process.env.ALERT_FROM_EMAIL;
});

describe("handler", () => {
  it("sends an email per valid message and reports no failures", async () => {
    const result = await handler(sqsEvent(JSON.stringify(alert)));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@example.com" }),
    );
    expect(result.batchItemFailures).toEqual([]);
  });

  it("falls back to ALERT_FALLBACK_EMAIL when the monitor has no alertEmail", async () => {
    process.env.ALERT_FALLBACK_EMAIL = "fallback@example.com";
    const noEmail: IncidentAlert = { ...alert };
    delete noEmail.alertEmail;

    await handler(sqsEvent(JSON.stringify(noEmail)));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "fallback@example.com" }),
    );
  });

  it("marks a message failed when the send fails, leaving others untouched", async () => {
    sendMock
      .mockResolvedValueOnce({ data: null, error: { message: "rate limited" } })
      .mockResolvedValueOnce({ data: { id: "email-2" }, error: null });

    const result = await handler(
      sqsEvent(JSON.stringify(alert), JSON.stringify(alert)),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("falls back to the default sender when ALERT_FROM_EMAIL is empty", async () => {
    // CDK injects unset deploy-time vars as "" — the fallback must engage.
    process.env.ALERT_FROM_EMAIL = "";

    await handler(sqsEvent(JSON.stringify(alert)));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Uptime <onboarding@resend.dev>" }),
    );
  });

  it("marks malformed messages failed so they reach the DLQ", async () => {
    const result = await handler(sqsEvent("not json"));

    expect(sendMock).not.toHaveBeenCalled();
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });
});

describe("formatAlertEmail", () => {
  it("uses the status code as the reason when present", () => {
    const { subject } = formatAlertEmail(alert);
    expect(subject).toBe("[DOWN] My site (HTTP 503)");
  });

  it("falls back to the error string when there was no response", () => {
    const { subject } = formatAlertEmail({
      ...alert,
      statusCode: null,
      error: "request timed out",
    });
    expect(subject).toBe("[DOWN] My site (request timed out)");
  });
});
