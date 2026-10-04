/** Bounded, relative-only diagnostics. Observes source timing without changing media order. */
export class MediaTiming {
  private firstSource?: number;
  private firstArrival?: number;
  private previousSource?: number;
  private previousArrival?: number;
  private highSource?: number;
  private samples = 0;
  private backwards = 0;
  private repeated = 0;
  private maxBackMs = 0;
  private maxArrivalGapMs = 0;
  private maxSourceGapMs = 0;

  observe(sourceMs: number, arrivalMs: number): void {
    if (!Number.isSafeInteger(sourceMs)) return;
    this.samples++;
    this.firstSource ??= sourceMs;
    this.firstArrival ??= arrivalMs;
    if (this.previousSource !== undefined) {
      if (sourceMs < this.highSource!) {
        this.backwards++;
        this.maxBackMs = Math.max(this.maxBackMs, this.highSource! - sourceMs);
      }
      if (sourceMs === this.previousSource) this.repeated++;
      this.maxSourceGapMs = Math.max(this.maxSourceGapMs, sourceMs - this.previousSource);
      this.maxArrivalGapMs = Math.max(this.maxArrivalGapMs, arrivalMs - this.previousArrival!);
    }
    this.highSource = Math.max(this.highSource ?? sourceMs, sourceMs);
    this.previousSource = sourceMs;
    this.previousArrival = arrivalMs;
  }

  summary(): string {
    const sourceElapsedMs = (this.highSource ?? 0) - (this.firstSource ?? 0);
    const arrivalElapsedMs = (this.previousArrival ?? 0) - (this.firstArrival ?? 0);
    return JSON.stringify({
      samples: this.samples,
      backwards: this.backwards,
      repeated: this.repeated,
      maxBackMs: this.maxBackMs,
      maxArrivalGapMs: Math.round(this.maxArrivalGapMs),
      maxSourceGapMs: this.maxSourceGapMs,
      sourceElapsedMs,
      arrivalElapsedMs: Math.round(arrivalElapsedMs),
      lagGrowthMs: Math.round(arrivalElapsedMs - sourceElapsedMs),
    });
  }
}
