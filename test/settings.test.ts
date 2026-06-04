import { describe, it, expect } from "vitest";
import { encodeSettings, decodeSettings, DEFAULT_SETTINGS } from "../src/settings";
import type { ThothSettings } from "../src/settings";

const SAMPLE_SETTINGS: ThothSettings = {
  endpoint: "https://example.r2.cloudflarestorage.com",
  region: "auto",
  accessKey: "abc123",
  secretKey: "secret456",
  bucket: "my-vault",
  pollInterval: 5,
  deviceId: "test-device",
  mergeStrategy: "auto-merge",
};

describe("encodeSettings / decodeSettings", () => {
  it("round-trips settings correctly", () => {
    const encoded = encodeSettings(SAMPLE_SETTINGS);
    const decoded = decodeSettings(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.endpoint).toBe(SAMPLE_SETTINGS.endpoint);
    expect(decoded!.region).toBe(SAMPLE_SETTINGS.region);
    expect(decoded!.accessKey).toBe(SAMPLE_SETTINGS.accessKey);
    expect(decoded!.secretKey).toBe(SAMPLE_SETTINGS.secretKey);
    expect(decoded!.bucket).toBe(SAMPLE_SETTINGS.bucket);
    expect(decoded!.pollInterval).toBe(SAMPLE_SETTINGS.pollInterval);
  });

  it("does not include deviceId in encoded output", () => {
    const encoded = encodeSettings(SAMPLE_SETTINGS);
    const decoded = decodeSettings(encoded);
    expect(decoded!).not.toHaveProperty("deviceId");
  });

  it("returns null for invalid base64", () => {
    expect(decodeSettings("not-valid-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    const encoded = btoa("not json at all");
    expect(decodeSettings(encoded)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeSettings("")).toBeNull();
  });

  it("handles whitespace around encoded string", () => {
    const encoded = encodeSettings(SAMPLE_SETTINGS);
    const decoded = decodeSettings(`  ${encoded}  \n`);
    expect(decoded).not.toBeNull();
    expect(decoded!.endpoint).toBe(SAMPLE_SETTINGS.endpoint);
  });

  it("handles special characters in values", () => {
    const special: ThothSettings = {
      ...SAMPLE_SETTINGS,
      endpoint: "https://example.com/path?key=val&other=1",
      secretKey: "abc+def/ghi=123",
    };
    const decoded = decodeSettings(encodeSettings(special));
    expect(decoded!.endpoint).toBe(special.endpoint);
    expect(decoded!.secretKey).toBe(special.secretKey);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("has all required fields", () => {
    expect(DEFAULT_SETTINGS.endpoint).toBe("");
    expect(DEFAULT_SETTINGS.region).toBe("auto");
    expect(DEFAULT_SETTINGS.accessKey).toBe("");
    expect(DEFAULT_SETTINGS.secretKey).toBe("");
    expect(DEFAULT_SETTINGS.bucket).toBe("");
    expect(DEFAULT_SETTINGS.pollInterval).toBe(30);
    expect(DEFAULT_SETTINGS.mergeStrategy).toBe("auto-merge");
  });

  it("generates a non-empty deviceId", () => {
    expect(DEFAULT_SETTINGS.deviceId.length).toBeGreaterThan(0);
  });
});
