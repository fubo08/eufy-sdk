import { describe, expect, it } from "vitest";
import { MediaTiming } from "../media-timing.js";

describe("media timing diagnostics", () => {
  it("distinguishes delayed arrival from old source frames without exposing absolute times", () => {
    const timing = new MediaTiming();
    const origin = 1728000000000;
    timing.observe(origin, 100);
    timing.observe(origin + 1000, 1100);
    timing.observe(origin + 200, 1101);
    timing.observe(origin + 200, 1102);
    timing.observe(origin + 2000, 4100);
    expect(JSON.parse(timing.summary())).toEqual({
      samples: 5,
      backwards: 2,
      repeated: 1,
      maxBackMs: 800,
      maxArrivalGapMs: 2998,
      maxSourceGapMs: 1800,
      sourceElapsedMs: 2000,
      arrivalElapsedMs: 4000,
      lagGrowthMs: 2000,
    });
    expect(timing.summary()).not.toContain(String(origin));
  });
});
