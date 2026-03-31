import { expect, test } from "playwright/test";

test.describe("GEPA optimize e2e (Workers AI)", () => {
  test.setTimeout(120_000);

  test("improves over the bad seed instructions with real model calls", async ({
    request,
    baseURL
  }) => {
    const response = await request.get(`${baseURL}/optimize`, {
      timeout: 120_000
    });

    expect(response.ok()).toBe(true);

    const result = (await response.json()) as {
      seedScore: number | null;
      bestScore: number | null;
      candidateCount: number;
      winningInstructions: string | null;
      activatedArtifactId: string | null;
      activeInstructions: string | null;
      fixtures: number;
    };

    expect(result.fixtures).toBeGreaterThanOrEqual(3);
    expect(result.candidateCount).toBeGreaterThan(1);
    expect(result.seedScore).not.toBeNull();
    expect(result.bestScore).not.toBeNull();
    expect((result.bestScore ?? 0) >= (result.seedScore ?? 0)).toBe(true);
    expect(result.winningInstructions).toBeTruthy();
    expect(result.winningInstructions).not.toContain('always put "0"');
    expect(result.activatedArtifactId).toBeTruthy();
    expect(result.activeInstructions).toBe(result.winningInstructions);
  });
});
