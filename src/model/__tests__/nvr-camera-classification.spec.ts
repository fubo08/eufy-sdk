import { describe, expect, it } from "vitest";
import { classify, codecForType, codecFromModel } from "../classify.js";
import { DeviceType } from "../device-types.js";
import { detectCapabilities } from "../capabilities/index.js";

describe("NVR and attached PoE camera classification", () => {
  it("classifies the numeric PoE S4 type as a camera", () => {
    expect(codecForType(DeviceType.CAMERA_POE_S4)).toBe("camera");
  });

  it.each(["T8E00", "t8e00", " T8E00 "])("recognises the exact S4 model %s", (model) => {
    expect(codecFromModel(model)).toBe("camera");
  });

  it.each([undefined, DeviceType.CAMERA_POE_S4])("provides the camera surface for device type %s", (deviceType) => {
    const record = { model: "T8E00", deviceType, params: {} };
    const codec = classify(record);
    expect(codec).toBe("camera");
    expect(detectCapabilities(record, codec)).toContain("camera");
  });

  it.each([undefined, DeviceType.NVR_S4_MAX])("keeps the NVR on the station codec for type %s", (deviceType) => {
    expect(classify({ model: "T8N00", deviceType, params: {} })).toBe("station");
  });

  it("keeps a reported station type authoritative over the model fallback", () => {
    expect(classify({ model: "T8E00", deviceType: DeviceType.NVR_S4_MAX, params: {} })).toBe("station");
  });

  it("does not widen the exact-model correction to other T8E0 models", () => {
    expect(codecFromModel("T8E01")).toBe("station");
  });
});
