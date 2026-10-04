import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";
import type { MediaProvider } from "../../core/contracts.js";
import type { RtcVideoStreams } from "../../transport/rtc/video-stream.js";

const hub = "T8000P0000000000";
const cam = "T8000P0000000001";
function fixture(model = "T8N00", channel: unknown = 3) {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    storedSnapshotCache: false,
  });
  const internal = client as unknown as {
    registry: { devices: EufyDevice[] };
    rtcVideo: RtcVideoStreams;
    p2p: { mediaProviderFor(sn: string): MediaProvider };
    mediaProviderFor(sn: string): MediaProvider;
  };
  internal.registry.devices = [
    { sn: hub, model, raw: { member: { admin_user_id: "synthetic-admin" } } },
    { sn: cam, model: "T8E00", stationSn: hub, raw: { device_channel: channel } },
  ] as EufyDevice[];
  const p2p = vi.fn(async () => Readable.from([]));
  vi.spyOn(internal.p2p, "mediaProviderFor").mockReturnValue({ openReadable: p2p } as unknown as MediaProvider);
  const rtc = vi.spyOn(internal.rtcVideo, "open").mockResolvedValue(Readable.from([]));
  return { internal, rtc, p2p };
}
describe("RTC video routing", () => {
  it("opens the attached NVR camera via RTC without opening P2P", async () => {
    const { internal, rtc, p2p } = fixture();
    await internal.mediaProviderFor(cam).openReadable!();
    expect(rtc).toHaveBeenCalledWith(hub, "synthetic-admin", 3, undefined);
    expect(p2p).not.toHaveBeenCalled();
  });
  it.each([undefined, "3", -1, 256])("refuses an invalid camera channel %s", async (channel) => {
    const { internal, rtc } = fixture();
    (internal.registry.devices[1]!.raw as Record<string, unknown>).device_channel = channel;
    await expect(internal.mediaProviderFor(cam).openReadable!()).rejects.toThrow("unambiguous");
    expect(rtc).not.toHaveBeenCalled();
  });
  it("refuses two cameras claiming the same channel", async () => {
    const { internal, rtc } = fixture();
    internal.registry.devices.push({ ...internal.registry.devices[1]!, sn: "T8000P0000000002" });
    await expect(internal.mediaProviderFor(cam).openReadable!()).rejects.toThrow("unambiguous");
    expect(rtc).not.toHaveBeenCalled();
  });
  it("preserves the media path for other models", async () => {
    const { internal, rtc, p2p } = fixture("T9000");
    await internal.mediaProviderFor(cam).openReadable!();
    expect(rtc).not.toHaveBeenCalled();
    expect(p2p).toHaveBeenCalledOnce();
  });
});
