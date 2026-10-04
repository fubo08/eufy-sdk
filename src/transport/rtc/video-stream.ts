import { Readable } from "node:stream";
import { MediaTiming } from "./media-timing.js";
import type { LiveAudioFrame, LiveVideoFrame } from "../../core/contracts.js";
import type { RtcCommandRouterDeps } from "./command-router.js";
import { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalHeader, PORTAL_HEADER_LENGTH } from "./portal-packet.js";

/** The NVR live frame carries a 22-byte media header before its Annex-B access unit. */
export function videoPayload(frame: Buffer): Buffer | undefined {
  const header = parsePortalHeader(frame);
  if (!header || header.commandId !== 1300) return;
  if (header.paramLength !== frame.length - PORTAL_HEADER_LENGTH || header.paramLength < 26) return;
  const length = frame.readUInt32LE(PORTAL_HEADER_LENGTH);
  const data = frame.subarray(PORTAL_HEADER_LENGTH + 22);
  if (length !== data.length) return;
  if (data[0] !== 0 || data[1] !== 0 || (data[2] !== 1 && !(data[2] === 0 && data[3] === 1))) return;
  return data;
}

/** Audio is command 1301, followed by the 16-byte audio header and encoded samples. */
export function audioPayload(frame: Buffer): LiveAudioFrame | undefined {
  const header = parsePortalHeader(frame);
  if (!header || header.commandId !== 1301 || header.paramLength !== frame.length - 16 || header.paramLength <= 16)
    return;
  const size = frame.readUInt32LE(16);
  if (size !== frame.length - 32) return;
  const codecs = { 0: "aac-lc", 2: "g711a", 7: "aac-eld" } as const;
  const codec = codecs[frame[21]! as keyof typeof codecs];
  return codec ? { codec, data: frame.subarray(32), timestampMs: Number(frame.readBigUInt64LE(24)) } : undefined;
}

/** The portal's 22-byte video header retains source timing and frame geometry. */
export function videoFrame(frame: Buffer): LiveVideoFrame | undefined {
  const data = videoPayload(frame);
  if (!data) return;
  return {
    data,
    keyframe: frame[20] === 1,
    codec: frame[21] === 1 ? "h265" : "h264",
    width: frame.readUInt16LE(26),
    height: frame.readUInt16LE(28),
    timestampMs: Number(frame.readBigUInt64LE(30)),
  };
}

/** NVR live requests use the station envelope and an explicit camera list; byte 14 holds streamId. */
export function videoCommand(
  adminUserId: string,
  channel: number,
  cmd: number,
  segment: number,
  sensor = 1,
  audio = false,
): Buffer {
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
            audio_chn: audio ? channel : -1,
            stitch_mode: 1,
            chn_list: [{ index: 0, chn: channel, sensor }],
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
    opts?: { signal?: AbortSignal; objectMode?: boolean; sensor?: number; onAudio?: (frame: LiveAudioFrame) => void },
  ): Promise<Readable> {
    const sensor = opts?.sensor ?? 1;
    if (sensor !== 0 && sensor !== 1) throw new Error("RTC video sensor must be 0 or 1");
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
      keepPeerOnSignalingLoss: true,
    });
    return new Promise<Readable>((resolve, reject) => {
      let delivered = false;
      let stopped = false;
      let started = false;
      let frames = 0;
      let audioFrames = 0;
      const videoTiming = new MediaTiming();
      const audioTiming = new MediaTiming();
      let warnedAudio = false;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout>;
      const stream = new Readable({
        objectMode: opts?.objectMode ?? false,
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
        if (opts?.onAudio && parsePortalHeader(frame)?.commandId === 1301) {
          const audio = audioPayload(frame);
          if (audio) {
            audioTiming.observe(audio.timestampMs!, performance.now());
            if (++audioFrames === 1)
              this.deps.logger?.info(`[rtc:audio] first frame, codec=${audio.codec}, ${audio.data.length} bytes`);
            try {
              opts.onAudio(audio);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          } else if (!warnedAudio) {
            warnedAudio = true;
            this.deps.logger?.warn(
              `[rtc:audio] unsupported frame; total=${frame.length}, codecByte=${frame[21] ?? -1}`,
            );
          }
          return;
        }
        const data = videoPayload(frame);
        if (!data) return;
        videoTiming.observe(Number(frame.readBigUInt64LE(30)), performance.now());
        clearTimeout(deadline);
        deadline = setTimeout(() => fail(new Error("rtc video: no video for 15 seconds")), 15_000);
        if (opts?.objectMode ? stream.readableLength >= 120 : stream.readableLength + data.length > 8 * 1024 * 1024) {
          fail(new Error("rtc video: consumer too slow (8 MiB buffer limit)"));
          return;
        }
        stream.push(opts?.objectMode ? videoFrame(frame) : data);
        frames++;
        if (!delivered) {
          delivered = true;
          this.deps.logger?.info(
            `[rtc:video] first frame, camera channel ${channel}, sensor ${sensor}, ${data.length} bytes`,
          );
          resolve(stream);
        } else if (frames % 300 === 0) {
          this.deps.logger?.debug(`[rtc:video] channel ${channel}, sensor ${sensor}: ${frames} frames`);
          this.deps.logger?.info(
            `[rtc:timing] sensor ${sensor} video=${videoTiming.summary()} audio=${audioTiming.summary()}`,
          );
        }
      };
      const onConnected = () => {
        if (stopped || startTimer) return;
        this.deps.logger?.info(
          `[rtc:video] connected; requesting camera channel ${channel}, sensor ${sensor}, audio=${!!opts?.onAudio}`,
        );
        if (!session.sendCommand(videoCommand(adminUserId, channel, 1103, 1)))
          return fail(new Error("rtc video: parameter request refused"));
        startTimer = setTimeout(() => {
          if (stopped) return;
          started = true;
          if (!session.sendCommand(videoCommand(adminUserId, channel, 1003, 2, sensor, !!opts?.onAudio)))
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
