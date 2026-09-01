import { Document } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import { attachPsaAnimations, parsePsa } from "../src/unreal/psa.js";

function name(target: Buffer, offset: number, value: string): void {
  target.write(value, offset, Math.min(Buffer.byteLength(value), 63), "utf8");
}

function chunk(id: string, dataSize: number, records: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(32);
  name(header, 0, id);
  header.writeUInt32LE(20_100_422, 20);
  header.writeInt32LE(dataSize, 24);
  header.writeInt32LE(records.length, 28);
  return Buffer.concat([header, ...records]);
}

function bone(boneName: string, parentIndex: number, position: readonly number[]): Buffer {
  const record = Buffer.alloc(120);
  name(record, 0, boneName);
  record.writeInt32LE(parentIndex, 72);
  record.writeFloatLE(1, 88); // quaternion W
  position.forEach((value, index) => record.writeFloatLE(value, 92 + index * 4));
  return record;
}

function key(position: readonly number[], quaternion: readonly number[]): Buffer {
  const record = Buffer.alloc(32);
  position.forEach((value, index) => record.writeFloatLE(value, index * 4));
  quaternion.forEach((value, index) => record.writeFloatLE(value, 12 + index * 4));
  record.writeFloatLE(1, 28);
  return record;
}

function fixture(): Buffer {
  const info = Buffer.alloc(168);
  name(info, 0, "Wave");
  name(info, 64, "None");
  info.writeInt32LE(2, 128);
  info.writeInt32LE(4, 140);
  info.writeFloatLE(2, 148);
  info.writeFloatLE(30, 152);
  info.writeInt32LE(0, 160);
  info.writeInt32LE(2, 164);
  return Buffer.concat([
    chunk("ANIMHEAD", 0, []),
    chunk("BONENAMES", 120, [bone("root", -1, [100, 200, 300]), bone("hand", 0, [0, 10, 20])]),
    chunk("ANIMINFO", 168, [info]),
    chunk("ANIMKEYS", 32, [
      key([0, 0, 0], [0, 0, 0, 1]),
      key([1, 2, 3], [0, 0, 0, 1]),
      key([100, 200, 300], [0, 0, 0, 1]),
      key([4, 5, 6], [0, 0, 0, -1]),
    ]),
    // Current UE Viewer writes this empty compatibility chunk; it is not evidence of scale keys.
    chunk("SCALEKEYS", 16, []),
  ]);
}

describe("ActorX PSA conversion", () => {
  it("parses frame-major keys with UE-to-glTF coordinates and seconds", () => {
    const parsed = parsePsa(fixture());
    expect(parsed.bones).toHaveLength(2);
    expect(parsed.bones[0]).toMatchObject({ name: "root", translation: [1, 3, 2] });
    expect(parsed.sequences).toHaveLength(1);
    expect(parsed.hasScaleKeys).toBe(false);
    expect(parsed.sequences[0]!.tracks[0]!.times[0]).toBe(0);
    expect(parsed.sequences[0]!.tracks[0]!.times[1]).toBeCloseTo(1 / 30, 7);
    expect([...parsed.sequences[0]!.tracks[0]!.translations]).toEqual([0, 0, 0, 1, 3, 2]);
    // Quaternion signs are made continuous, so a negative identity key does not cause a spin.
    expect([...parsed.sequences[0]!.tracks[1]!.rotations.slice(4)]).toEqual([0, 0, 0, 1]);
  });

  it("attaches a compatible clip to real skin joints", () => {
    const document = new Document();
    const rootJoint = document.createNode("root");
    const handJoint = document.createNode("hand");
    rootJoint.addChild(handJoint);
    document.createSkin("Rig").addJoint(rootJoint).addJoint(handJoint).setSkeleton(rootJoint);
    document.createScene().addChild(rootJoint);

    expect(attachPsaAnimations(document, [parsePsa(fixture())])).toEqual({
      attached: ["Wave"],
      existing: [],
      incompatible: [],
    });
    const animation = document.getRoot().listAnimations()[0];
    expect(animation?.getName()).toBe("Wave");
    expect(animation?.listChannels()).toHaveLength(4);
    expect(animation?.getExtras()).toMatchObject({ unreal: { sourceFormat: "ActorX PSA", boneCoverage: 1 } });
  });

  it("rejects truncated data and does not attach to an unrelated skeleton", () => {
    expect(() => parsePsa(fixture().subarray(0, -1))).toThrow(/truncated|exceeds the file boundary/);
    const document = new Document();
    const joint = document.createNode("unrelated");
    document.createSkin().addJoint(joint);
    expect(attachPsaAnimations(document, [parsePsa(fixture())])).toEqual({
      attached: [],
      existing: [],
      incompatible: ["Wave"],
    });
  });

  it("does not duplicate a clip already attached by UE Viewer", () => {
    const document = new Document();
    const joint = document.createNode("root");
    document.createSkin().addJoint(joint);
    document.createAnimation("wave");
    expect(attachPsaAnimations(document, [parsePsa(fixture())])).toEqual({
      attached: [],
      existing: ["Wave"],
      incompatible: [],
    });
    expect(document.getRoot().listAnimations()).toHaveLength(1);
  });

  it("rejects duplicate bone names and non-finite key data", () => {
    const duplicate = Buffer.from(fixture());
    const bonesAt = duplicate.indexOf("BONENAMES") + 32;
    duplicate.copy(duplicate, bonesAt + 120, bonesAt, bonesAt + 64);
    expect(() => parsePsa(duplicate)).toThrow(/duplicate bone name root/);

    const nonFinite = Buffer.from(fixture());
    const keysAt = nonFinite.indexOf("ANIMKEYS") + 32;
    nonFinite.writeFloatLE(Number.NaN, keysAt);
    expect(() => parsePsa(nonFinite)).toThrow(/non-finite translation/);
  });
});
