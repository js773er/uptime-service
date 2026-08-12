import { describe, expect, it } from "vitest";
import {
  ANALYSIS_THROTTLE_MS,
  contentVerdictSchema,
  extractText,
  hashContent,
  shouldAnalyze,
} from "./content-analysis";

const now = new Date("2026-08-13T12:00:00.000Z");
const agesAgo = new Date(now.getTime() - ANALYSIS_THROTTLE_MS - 1).toISOString();
const justNow = new Date(now.getTime() - 1000).toISOString();

const base = {
  contentCheckEnabled: true,
  httpIsUp: true,
  currentHash: "hash-b",
  previousHash: "hash-a",
  lastAnalyzedAt: agesAgo,
  now,
};

describe("shouldAnalyze", () => {
  it("analyses the first time a monitor is seen", () => {
    expect(
      shouldAnalyze({
        ...base,
        previousHash: undefined,
        lastAnalyzedAt: undefined,
      }),
    ).toBe(true);
  });

  it("analyses when the page content changed and the throttle has elapsed", () => {
    expect(shouldAnalyze(base)).toBe(true);
  });

  it("skips when the content is unchanged — the steady state costs nothing", () => {
    expect(shouldAnalyze({ ...base, currentHash: "hash-a" })).toBe(false);
  });

  it("skips a changed page while the throttle is still active", () => {
    expect(shouldAnalyze({ ...base, lastAnalyzedAt: justNow })).toBe(false);
  });

  it("skips when the feature is switched off", () => {
    expect(shouldAnalyze({ ...base, contentCheckEnabled: false })).toBe(false);
  });

  it("skips when HTTP already says down — no point analysing an error page", () => {
    expect(shouldAnalyze({ ...base, httpIsUp: false })).toBe(false);
  });
});

describe("hashContent", () => {
  it("is stable across whitespace-only differences", () => {
    expect(hashContent("  hello world  ")).toBe(hashContent("hello world"));
  });

  it("changes when the content changes", () => {
    expect(hashContent("checkout available")).not.toBe(
      hashContent("checkout unavailable"),
    );
  });
});

describe("extractText", () => {
  it("strips markup, scripts and styles", () => {
    const html =
      "<html><head><style>body{color:red}</style></head>" +
      "<body><script>alert(1)</script><h1>Welcome</h1><p>All good</p></body></html>";
    expect(extractText(html)).toBe("Welcome All good");
  });

  it("collapses whitespace and entities", () => {
    expect(extractText("<p>a&nbsp;&nbsp;b\n\n  c</p>")).toBe("a b c");
  });

  it("returns empty for markup with no text", () => {
    expect(extractText("<div><span></span></div>")).toBe("");
  });
});

describe("contentVerdictSchema", () => {
  it("accepts a well-formed verdict", () => {
    const result = contentVerdictSchema.safeParse({
      healthy: false,
      reason: "Page shows 'We'll be back soon' instead of the storefront.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed model reply", () => {
    expect(contentVerdictSchema.safeParse({ healthy: "yes" }).success).toBe(
      false,
    );
    expect(
      contentVerdictSchema.safeParse({ healthy: true, reason: "" }).success,
    ).toBe(false);
  });
});
