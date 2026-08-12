import type { SQSEvent, SQSRecord } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentAlert } from "./queue";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));
vi.mock("./ai/correlate", async (importOriginal) => ({
  // Keep MIN_ALERTS_TO_CORRELATE real; stub only the model call.
  ...(await importOriginal<typeof import("./ai/correlate")>()),
  correlateAlerts: vi.fn(),
}));

import { correlateAlerts } from "./ai/correlate";
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
  // Default: no correlation available, so each incident emails individually.
  vi.mocked(correlateAlerts).mockReset().mockResolvedValue(null);
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

describe("alert correlation", () => {
  const second: IncidentAlert = {
    ...alert,
    incidentId: "inc-2",
    monitorId: "m2",
    monitorName: "API",
    url: "https://api.example.com",
  };

  it("sends one combined email when several incidents share a recipient", async () => {
    vi.mocked(correlateAlerts).mockResolvedValue({
      subject: "2 services down — both on example.com",
      summary: "Both failures are on the same domain returning 503.",
    });

    const result = await handler(
      sqsEvent(JSON.stringify(alert), JSON.stringify(second)),
    );

    expect(correlateAlerts).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledOnce();
    const sent = sendMock.mock.calls[0][0];
    expect(sent.subject).toBe("[DOWN] 2 services down — both on example.com");
    // The body carries the model's summary plus the raw facts.
    expect(sent.text).toContain("same domain returning 503");
    expect(sent.text).toContain("My site");
    expect(sent.text).toContain("API");
    expect(result.batchItemFailures).toEqual([]);
  });

  it("falls back to one email each when correlation is unavailable", async () => {
    vi.mocked(correlateAlerts).mockResolvedValue(null);

    const result = await handler(
      sqsEvent(JSON.stringify(alert), JSON.stringify(second)),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(result.batchItemFailures).toEqual([]);
  });

  it("does not correlate a single incident", async () => {
    await handler(sqsEvent(JSON.stringify(alert)));

    expect(correlateAlerts).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it("never mixes recipients into one email", async () => {
    const otherTenant: IncidentAlert = {
      ...second,
      alertEmail: "someone-else@example.com",
    };

    await handler(
      sqsEvent(JSON.stringify(alert), JSON.stringify(otherTenant)),
    );

    // Two separate recipients — each below the correlation threshold.
    expect(correlateAlerts).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(2);
    const recipients = sendMock.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual(["owner@example.com", "someone-else@example.com"]);
  });

  it("retries every incident in the group when the combined send fails", async () => {
    vi.mocked(correlateAlerts).mockResolvedValue({
      subject: "2 services down",
      summary: "Shared cause.",
    });
    sendMock.mockResolvedValue({ data: null, error: { message: "rate limited" } });

    const result = await handler(
      sqsEvent(JSON.stringify(alert), JSON.stringify(second)),
    );

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "msg-0" },
      { itemIdentifier: "msg-1" },
    ]);
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
