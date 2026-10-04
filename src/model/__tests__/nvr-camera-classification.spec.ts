import { describe, expect, it } from "vitest";
import { classify, codecForType, codecFromModel } from "../classify.js";
import { DeviceType } from "../device-types.js";
import { detectCapabilities } from "../capabilities/index.js";

describe("NVR and attached PoE camera classification", () => {
  it("provides the camera surface for the PoE camera with or without a numeric type", () => {
    expect(codecForType(DeviceType.CAMERA_POE_S4)).toBe("camera");
    expect(codecFromModel("T8E00")).toBe("camera");
    for (const deviceType of [undefined, DeviceType.CAMERA_POE_S4]) {
      const record = { model: "T8E00", deviceType, params: {} };
      const codec = classify(record);
      expect(codec).toBe("camera");
      expect(detectCapabilities(record, codec)).toContain("camera");
      expect(detectCapabilities(record, codec)).toContain("ptz");
    }
  });
  it("keeps the NVR on the station codec", () => {
    expect(classify({ model: "T8N00", deviceType: DeviceType.NVR_S4_MAX, params: {} })).toBe("station");
    expect(codecFromModel("T8N00")).toBe("station");
  });
});
