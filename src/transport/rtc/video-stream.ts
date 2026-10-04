import { Readable } from "node:stream";
import type { RtcCommandRouterDeps } from "./command-router.js";
import { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalHeader, PORTAL_HEADER_LENGTH } from "./portal-packet.js";

/** The NVR live frame carries a 22-byte media header before its Annex-B access unit. */
export function videoPayload(frame: Buffer): Buffer | undefined {
  const header = parsePortalHeader(frame);
  if (!header || ![1300, 1301, 1303].includes(header.commandId)) return;
  if (header.paramLength !== frame.length - PORTAL_HEADER_LENGTH || header.paramLength < 26) return;
  const length = frame.readUInt32LE(PORTAL_HEADER_LENGTH);
  const data = frame.subarray(PORTAL_HEADER_LENGTH + 22);
  if (length !== data.length) return;
  if (data[0] !== 0 || data[1] !== 0 || (data[2] !== 1 && !(data[2] === 0 && data[3] === 1))) return;
  return data;
}

/** NVR live requests use the station envelope and an explicit camera list; byte 14 holds streamId. */
export function videoCommand(adminUserId: string, channel: number, cmd: number, segment: number): Buffer {
  const payload =
    cmd === 1103
      ? { channel_info: { array_size: 1, channel_array: [channel] } }
      : cmd === 1003
        ? {
            ClientOS: "WEB",
            entrytype: 1,
            camera_type: 0,
            streamtype: 2,
            key: "",
            msg_id: "",
            audio_chn: -1,
            stitch_mode: 1,
            chn_list: [{ index: 0, chn: channel, sensor: 1 }],
          }
        : {};
  return buildPortalPacket({
    commandId: 1350,
    channel: 255,
    segment,
    isResponse: cmd === 1003 ? 1 : 0,
    payload: { account_id: adminUserId, cmd, payload },
  });
}

/** Owns dedicated, bounded video pulls; closing a pull never tears down the command router. */
export class RtcVideoStreams {
  private readonly active = new Set<Readable>();
  constructor(private readonly deps: RtcCommandRouterDeps) {}

  close(): void {
    for (const stream of this.active) stream.destroy();
  }

  /** Resolves only after actual Annex-B video, and releases the session on abort, stall or slow output. */
  async open(
    stationSn: string,
    adminUserId: string,
    channel: number,
    opts?: { signal?: AbortSignal; objectMode?: boolean },
  ): Promise<Readable> {
    if (opts?.objectMode) throw new Error("RTC video currently supports raw Annex-B output only");
    opts?.signal?.throwIfAborted();
    const identity = this.deps.identity();
    if (!identity) throw new Error("rtc video: login() first");
    const session = (this.deps.createSession ?? ((o) => new RtcSession(o)))({
      ...identity,
      stationSn,
      adminUserId,
      shard: this.deps.shard(),
      country: this.deps.country ?? "US",
      logger: this.deps.logger,
    });
    return new Promise<Readable>((resolve, reject) => {
      let delivered = false;
      let stopped = false;
      let started = false;
      let frames = 0;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout>;
      const stream = new Readable({
        read() {},
        destroy(error, done) {
          cleanup(error ?? undefined);
          done(error);
        },
      });
      const fail = (error: Error) => stream.destroy(error);
      const onClose = () => fail(new Error("rtc video: session closed"));
      const onAbort = () => fail(new Error("rtc video: aborted"));
      const cleanup = (error?: Error) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(deadline);
        clearTimeout(startTimer);
        clearInterval(heartbeat);
        opts?.signal?.removeEventListener("abort", onAbort);
        session.off("connected", onConnected);
        session.off("commandData", onData);
        session.off("close", onClose);
        this.active.delete(stream);
        if (!delivered) reject(error ?? new Error("rtc video: stopped before first frame"));
        if (started && session.isConnected) {
          session.sendCommand(videoCommand(adminUserId, channel, 1004, 3));
          setTimeout(() => session.close(), 250).unref();
        } else session.close();
      };
      const onData = (frame: Buffer) => {
        if (stopped) return;
        const data = videoPayload(frame);
        if (!data) return;
        clearTimeout(deadline);
        deadline = setTimeout(() => fail(new Error("rtc video: no video for 15 seconds")), 15_000);
        if (stream.readableLength + data.length > 8 * 1024 * 1024) {
          fail(new Error("rtc video: consumer too slow (8 MiB buffer limit)"));
          return;
        }
        stream.push(data);
        frames++;
        if (!delivered) {
          delivered = true;
          this.deps.logger?.info(`[rtc:video] first frame, camera channel ${channel}, ${data.length} bytes`);
          resolve(stream);
        } else if (frames % 300 === 0) this.deps.logger?.debug(`[rtc:video] channel ${channel}: ${frames} frames`);
      };
      const onConnected = () => {
        if (stopped || startTimer) return;
        this.deps.logger?.info(`[rtc:video] connected; requesting camera channel ${channel}`);
        if (!session.sendCommand(videoCommand(adminUserId, channel, 1103, 1)))
          return fail(new Error("rtc video: parameter request refused"));
        startTimer = setTimeout(() => {
          if (stopped) return;
          started = true;
          if (!session.sendCommand(videoCommand(adminUserId, channel, 1003, 2)))
            return fail(new Error("rtc video: start refused"));
          heartbeat = setInterval(() => {
            if (!session.sendHeartbeat()) fail(new Error("rtc video: heartbeat refused"));
          }, 10_000);
        }, 150);
      };
      stream.on("error", () => {});
      this.active.add(stream);
      deadline = setTimeout(() => fail(new Error("rtc video: no first frame within 25 seconds")), 25_000);
      session.on("connected", onConnected);
      session.on("commandData", onData);
      session.on("error", fail);
      session.on("close", onClose);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          if (!stopped) return session.connect();
        })
        .catch(fail);
    });
  }
}
