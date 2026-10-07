import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RtcVideoStreams, videoPayload, audioPayload } from "../video-stream.js";
import { buildPortalHeader } from "../portal-packet.js";
import type { RtcSession } from "../session.js";
import type { RtcSessionOptions } from "../session.js";

const nal = Buffer.from([0, 0, 0, 1, 0x40, 1, 2, 3]);
function frame() {
  const media = Buffer.alloc(22);
  media.writeUInt32LE(nal.length);
  return Buffer.concat([buildPortalHeader(1300, media.length + nal.length, 0, 0), media, nal]);
}
class Session extends EventEmitter {
  isConnected = false;
  sent: Buffer[] = [];
  sendHeartbeat = vi.fn(() => true);
  async connect() {
    this.isConnected = true;
    this.emit("connected");
  }
  sendCommand(packet: Buffer) {
    this.sent.push(packet);
    return true;
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
}
function fixture(signalingMode?: "call" | "scall", startMode?: "prelude" | "direct") {
  vi.useFakeTimers();
  const sessions: Session[] = [];
  const options: RtcSessionOptions[] = [];
  const router = new RtcVideoStreams({
    signalingMode,
    startMode,
    identity: () => ({ authToken: "synthetic", userId: "synthetic", gtoken: "synthetic" }),
    shard: () => "eu-pr",
    createSession: (opts) => {
      options.push(opts);
      const s = new Session();
      sessions.push(s);
      return s as unknown as RtcSession;
    },
  });
  return { router, sessions, options };
}
afterEach(() => vi.useRealTimers());

describe("NVR RTC video", () => {
  it("direct start skips the prelude, preserves lens/audio and starts only once", async () => {
    const { router, sessions } = fixture("call", "direct");
    const pending = router.open("T8000P0000000000", "synthetic", 3, { sensor: 0, onAudio() {} });
    await vi.advanceTimersByTimeAsync(1);
    const session = sessions[0]!;
    expect(session.sent).toHaveLength(1);
    expect(JSON.parse(session.sent[0]!.subarray(16).toString())).toMatchObject({
      cmd: 1003,
      payload: { audio_chn: 3, chn_list: [{ chn: 3, sensor: 0 }] },
    });
    session.emit("connected");
    expect(session.sent).toHaveLength(1);
    session.emit("commandData", frame());
    (await pending).destroy();
    await vi.advanceTimersByTimeAsync(251);
    expect(session.isConnected).toBe(false);
  });
  it("propagates native signaling to the media session", async () => {
    const { router, sessions, options } = fixture("call");
    const pending = router.open("T8000P0000000000", "synthetic", 3);
    await vi.advanceTimersByTimeAsync(151);
    expect(options[0]?.signalingMode).toBe("call");
    sessions[0]!.emit("commandData", frame(), 4);
    await pending;
    router.close();
    await vi.advanceTimersByTimeAsync(251);
  });
  it("selects the fixed lens and separates audio from Annex-B video", async () => {
    const { router, sessions } = fixture();
    const onAudio = vi.fn();
    const pending = router.open("T8000P0000000000", "synthetic", 3, { sensor: 0, onAudio });
    await vi.advanceTimersByTimeAsync(151);
    const session = sessions[0]!;
    expect(JSON.parse(session.sent[1]!.subarray(16).toString()).payload).toMatchObject({
      audio_chn: 3,
      chn_list: [{ index: 0, chn: 3, sensor: 0 }],
    });
    const samples = Buffer.from([0xff, 0xf1, 1, 2, 3]);
    const h = Buffer.alloc(16);
    h.writeUInt32LE(samples.length);
    const audio = Buffer.concat([buildPortalHeader(1301, 16 + samples.length, 0, 0), h, samples]);
    expect(audioPayload(audio)).toEqual({ codec: "aac-lc", data: samples, timestampMs: 0 });
    expect(videoPayload(audio)).toBeUndefined();
    session.emit("commandData", audio, 4);
    expect(onAudio).toHaveBeenCalledWith({ codec: "aac-lc", data: samples, timestampMs: 0 });
    expect(audioPayload(audio.subarray(0, -1))).toBeUndefined();
    audio[21] = 99;
    expect(audioPayload(audio)).toBeUndefined();
    session.emit("commandData", frame(), 4);
    const stream = await pending;
    expect(stream.read()).toEqual(nal);
    router.close();
    await vi.advanceTimersByTimeAsync(251);
  });
  it("rejects invalid sensors before opening a session", async () => {
    const { router, sessions } = fixture();
    await expect(router.open("T8000P0000000000", "synthetic", 0, { sensor: 2 })).rejects.toThrow("sensor");
    expect(sessions).toHaveLength(0);
  });
  it("extracts video and refuses truncated, mis-sized, non-video and non-Annex-B frames", () => {
    expect(videoPayload(frame())).toEqual(nal);
    expect(videoPayload(frame().subarray(0, 39))).toBeUndefined();
    const bad = frame();
    bad.writeUInt32LE(999, 16);
    expect(videoPayload(bad)).toBeUndefined();
    const control = frame();
    control.writeUInt16LE(1351, 4);
    expect(videoPayload(control)).toBeUndefined();
    const invalidNal = frame();
    invalidNal[38] = 1;
    expect(videoPayload(invalidNal)).toBeUndefined();
  });
  it("requests the selected camera, waits for video, sends heartbeat and stops on destruction", async () => {
    const { router, sessions } = fixture();
    const pending = router.open("T8000P0000000000", "synthetic-admin", 3);
    await vi.advanceTimersByTimeAsync(151);
    const session = sessions[0]!;
    const start = session.sent[1]!;
    expect(start[14]).toBe(1);
    expect(JSON.parse(start.subarray(16).toString())).toMatchObject({
      cmd: 1003,
      payload: { chn_list: [{ index: 0, chn: 3, sensor: 1 }] },
    });
    session.emit("commandData", frame(), 4);
    const stream = await pending;
    expect(stream.read()).toEqual(nal);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.sendHeartbeat).toHaveBeenCalledOnce();
    stream.destroy();
    await vi.advanceTimersByTimeAsync(251);
    expect(JSON.parse(session.sent.at(-1)!.subarray(16).toString()).cmd).toBe(1004);
    expect(session.isConnected).toBe(false);
  });
  it("rejects a correlated negative start ACK without waiting for the media deadline", async () => {
    const { router, sessions } = fixture();
    const pending = expect(router.open("T8000P0000000000", "synthetic", 0)).rejects.toThrow("start rejected (err 7)");
    await vi.advanceTimersByTimeAsync(151);
    const body = Buffer.alloc(4);
    body.writeInt32LE(7);
    const session = sessions[0]!;
    session.emit("commandData", Buffer.concat([buildPortalHeader(1350, 4, 255, 2, 1), body]), 1);
    await pending;
    await vi.advanceTimersByTimeAsync(251);
    expect(session.isConnected).toBe(false);
    expect(session.listenerCount("commandData")).toBe(0);
    expect(session.listenerCount("error")).toBe(0);
  });
  it("ignores unrelated ACKs and keeps another camera alive when a pull closes", async () => {
    const { router, sessions } = fixture();
    const a = router.open("T8000P0000000000", "synthetic", 0);
    const b = router.open("T8000P0000000000", "synthetic", 1);
    await vi.advanceTimersByTimeAsync(151);
    const body = Buffer.alloc(4);
    body.writeInt32LE(7);
    sessions[0]!.emit("commandData", Buffer.concat([buildPortalHeader(1350, 4, 255, 1, 1), body]), 1);
    sessions[0]!.emit("commandData", frame(), 4);
    sessions[1]!.emit("commandData", frame(), 4);
    (await a).destroy();
    await vi.advanceTimersByTimeAsync(251);
    expect(sessions[1]!.isConnected).toBe(true);
    const remaining = await b;
    expect(remaining.destroyed).toBe(false);
    router.close();
    await vi.advanceTimersByTimeAsync(251);
  });
  it("times out instead of reporting an open command channel as working video", async () => {
    const { router, sessions } = fixture();
    const pending = expect(router.open("T8000P0000000000", "synthetic", 0)).rejects.toThrow("no first frame");
    await vi.advanceTimersByTimeAsync(25_251);
    await pending;
    expect(sessions[0]!.isConnected).toBe(false);
  });
  it("aborts an opening stream and releases the session", async () => {
    const { router, sessions } = fixture();
    const abort = new AbortController();
    const pending = expect(router.open("T8000P0000000000", "synthetic", 0, { signal: abort.signal })).rejects.toThrow(
      "aborted",
    );
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await pending;
    expect(sessions[0]!.isConnected).toBe(false);
  });
  it("keeps simultaneous camera data isolated and closes all pulls on shutdown", async () => {
    const { router, sessions } = fixture();
    const a = router.open("T8000P0000000000", "synthetic", 0);
    const b = router.open("T8000P0000000000", "synthetic", 1);
    await vi.advanceTimersByTimeAsync(151);
    sessions[0]!.emit("commandData", frame(), 4);
    const sa = await a;
    expect(sa.read()).toEqual(nal);
    let secondReady = false;
    void b.then(() => {
      secondReady = true;
    });
    await Promise.resolve();
    expect(secondReady).toBe(false);
    sessions[1]!.emit("commandData", frame(), 4);
    await b;
    router.close();
    await vi.advanceTimersByTimeAsync(251);
    expect(sessions.every((s) => !s.isConnected)).toBe(true);
  });
  it("ends an established stream when video stalls", async () => {
    const { router, sessions } = fixture();
    const pending = router.open("T8000P0000000000", "synthetic", 0);
    await vi.advanceTimersByTimeAsync(151);
    sessions[0]!.emit("commandData", frame(), 4);
    const stream = await pending;
    await vi.advanceTimersByTimeAsync(15_251);
    expect(stream.errored?.message).toContain("no video");
    expect(sessions[0]!.isConnected).toBe(false);
  });
});

describe("RTC source timestamps", () => {
  it("preserves timestamped frame metadata in object mode", async () => {
    const { router, sessions } = fixture();
    const pending = router.open("T8000P0000000000", "synthetic", 0, { objectMode: true });
    await vi.advanceTimersByTimeAsync(151);
    const packet = frame();
    packet[20] = 1;
    packet[21] = 1;
    packet.writeUInt16LE(3840, 26);
    packet.writeUInt16LE(2160, 28);
    packet.writeBigUInt64LE(1728000000123n, 30);
    sessions[0]!.emit("commandData", packet);
    const stream = await pending;
    expect(stream.read()).toEqual({
      data: nal,
      keyframe: true,
      codec: "h265",
      width: 3840,
      height: 2160,
      timestampMs: 1728000000123,
    });
    stream.destroy();
    await vi.advanceTimersByTimeAsync(251);
  });
});
