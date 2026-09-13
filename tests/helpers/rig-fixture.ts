import { Document, NodeIO } from "@gltf-transform/core";

export function bipedPositions(armAxis: "x" | "z" = "x"): number[] {
  const points: number[] = [];
  const put = (arm: number, y: number, other: number): void => {
    if (armAxis === "x") points.push(arm, y, other);
    else points.push(other, y, arm);
  };
  for (let y = -0.1; y <= 0.45; y += 0.05) put(0.01 * Math.sin(y * 10), y, 0.01 * Math.cos(y * 10));
  put(0, 0.5, 0);
  for (let arm = 0.05; arm <= 0.5; arm += 0.05) {
    put(arm, 0.3, 0);
    put(-arm, 0.3, 0);
  }
  for (let y = -0.1; y >= -0.5; y -= 0.05) {
    put(0.1, y, 0);
    put(-0.1, y, 0);
  }
  return points;
}

export async function unriggedBipedGlb(armAxis: "x" | "z" = "x"): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(new Float32Array(bipedPositions(armAxis)))
    .setBuffer(buffer);
  const vertexCount = positions.getCount();
  const indices = new Uint16Array(Math.floor(vertexCount / 3) * 3);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  const mesh = document.createMesh("Body").addPrimitive(
    document
      .createPrimitive()
      .setAttribute("POSITION", positions)
      .setIndices(document.createAccessor("indices").setType("SCALAR").setArray(indices).setBuffer(buffer)),
  );
  document.createScene("Scene").addChild(document.createNode("Body").setMesh(mesh));
  return await new NodeIO().writeBinary(document);
}
