import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";

/**
 * Builds the exact artifact set UE Viewer produces for one static-mesh package: a glTF plus its
 * buffer, a `.mat`, a `.props.txt`, and the PNGs they name. Tests drive a fake `umodel` that copies
 * these into `-out=`, so every layer above the executable — classification, export orchestration,
 * material reconstruction, GLB packaging, validation, promotion — runs for real.
 *
 * The fakes are CommonJS on purpose: they have no file extension, which is how a resolved
 * executable on PATH looks, and Node reads an extensionless file as CommonJS.
 */
export interface MeshFixtureOptions {
  readonly name: string;
  readonly materialName: string;
  readonly mat: string;
  readonly props: string;
  readonly textures: readonly string[];
  /** Emits a tangent accessor whose every element is zero, as UE Viewer does for UE4 meshes. */
  readonly degenerateTangents?: boolean;
}

export async function writePng(
  path: string,
  rgba: readonly number[],
  size = 2,
): Promise<void> {
  const { default: sharp } = await import("sharp");
  const pixels = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    pixels[index * 4] = rgba[0] ?? 0;
    pixels[index * 4 + 1] = rgba[1] ?? 0;
    pixels[index * 4 + 2] = rgba[2] ?? 0;
    pixels[index * 4 + 3] = rgba[3] ?? 255;
  }
  await writeFile(
    path,
    await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer(),
  );
}

export async function writeMeshFixture(
  directory: string,
  options: MeshFixtureOptions,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor("POSITION")
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]))
    .setBuffer(buffer);
  const normal = document
    .createAccessor("NORMAL")
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const uv = document
    .createAccessor("TEXCOORD_0")
    .setType("VEC2")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const lightmapUv = document
    .createAccessor("TEXCOORD_1")
    .setType("VEC2")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  // UE Viewer writes a per-section debug colour and binds no textures at all.
  const material = document
    .createMaterial(options.materialName)
    .setBaseColorFactor([0.3, 0.9, 0.3, 1])
    .setMetallicFactor(0.1)
    .setRoughnessFactor(0.5);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setAttribute("TEXCOORD_0", uv)
    .setAttribute("TEXCOORD_1", lightmapUv)
    .setMaterial(material);
  if (options.degenerateTangents) {
    primitive.setAttribute(
      "TANGENT",
      document
        .createAccessor("TANGENT")
        .setType("VEC4")
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]))
        .setBuffer(buffer),
    );
  }
  const mesh = document.createMesh(options.name).addPrimitive(primitive);
  document.createScene().addChild(document.createNode(options.name).setMesh(mesh));

  await new NodeIO().write(join(directory, `${options.name}.gltf`), document);
  await writeFile(join(directory, `${options.materialName}.mat`), options.mat);
  await writeFile(join(directory, `${options.materialName}.props.txt`), options.props);
  for (const texture of options.textures) {
    await writePng(join(directory, `${texture}.png`), [200, 120, 60, 128]);
  }
}

export interface FakeUmodelOptions {
  /** Directory whose contents are copied into `-out=` on export. */
  readonly exportFrom?: string;
  /** `<packageName>` → the class list `-list` reports. */
  readonly classes: Readonly<Record<string, readonly string[]>>;
  readonly listExitCode?: number;
  readonly exportExitCode?: number;
  readonly version?: string;
  readonly argvLog?: string;
  /** Relative directory under `-out=` the fixture is written into. */
  readonly outputSubdirectory?: string;
  /** Truncates every copied `.bin`, so the glTF reader meets a corrupt buffer. */
  readonly corruptBuffer?: boolean;
}

export async function writeFakeUmodel(
  path: string,
  options: FakeUmodelOptions,
): Promise<void> {
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const options = ${JSON.stringify(options)};
if (options.argvLog) fs.appendFileSync(options.argvLog, JSON.stringify(argv) + "\\n");
if (argv.includes("-version")) {
  process.stdout.write("UE Viewer (UModel)\\nCompiled ${options.version ?? "Test 2026 (build 1)"}\\n");
  process.exit(0);
}
const target = argv.filter((entry) => !entry.startsWith("-")).pop();
if (argv.includes("-list")) {
  const classes = options.classes[target] || [];
  process.stdout.write("Found 1 game files (0 skipped) in 1 folders\\n");
  classes.forEach((className, index) => {
    process.stdout.write("   " + index + "    1000       10 " + className + " " + target + "\\n");
  });
  process.exit(options.listExitCode || 0);
}
if (argv.includes("-export")) {
  if (options.exportExitCode) process.exit(options.exportExitCode);
  if (!options.exportFrom) process.exit(0);
  const out = (argv.find((entry) => entry.indexOf("-out=") === 0) || "").slice("-out=".length);
  const destination = join(out, options.outputSubdirectory || "Group/Package");
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(options.exportFrom, destination, { recursive: true });
  if (options.corruptBuffer) {
    for (const name of fs.readdirSync(destination)) {
      if (name.endsWith(".bin")) fs.writeFileSync(join(destination, name), Buffer.alloc(4));
    }
  }
  process.exit(0);
}
process.exit(0);
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
}

export interface FakeFabCliOptions {
  readonly version?: string;
  readonly authStatus?: unknown;
  readonly formats?: unknown;
  readonly library?: unknown;
  /** Copied into `--output` when `download` runs. */
  readonly downloadInto?: string;
  readonly downloadExitCode?: number;
  readonly downloadStderr?: string;
  /** Fails a download that omits `--platform`, the way FabCLI does for a multi-platform artifact. */
  readonly requirePlatform?: boolean;
  readonly argvLog: string;
}

export async function writeFakeFabCli(
  path: string,
  options: FakeFabCliOptions,
): Promise<void> {
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const options = ${JSON.stringify(options)};
fs.appendFileSync(options.argvLog, JSON.stringify(argv) + "\\n");
if (argv[0] === "--version") { process.stdout.write("fabcli ${options.version ?? "0.1.0"}\\n"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(JSON.stringify(options.authStatus || { authenticated: true }) + "\\n");
  process.exit(0);
}
if (argv[0] === "formats") {
  process.stdout.write(JSON.stringify(options.formats || []) + "\\n");
  process.exit(0);
}
if (argv[0] === "library") {
  process.stdout.write(JSON.stringify(options.library || { results: [] }) + "\\n");
  process.exit(0);
}
if (argv[0] === "download") {
  if (options.requirePlatform && argv.indexOf("--platform") < 0) {
    process.stderr.write("selected version supports 2 platforms; specify --platform\\n");
    process.exit(6);
  }
  if (options.downloadExitCode) {
    process.stderr.write(options.downloadStderr || "download failed\\n");
    process.exit(options.downloadExitCode);
  }
  const out = argv[argv.indexOf("--output") + 1];
  fs.mkdirSync(out, { recursive: true });
  if (options.downloadInto) fs.cpSync(options.downloadInto, out, { recursive: true });
  fs.writeFileSync(join(out, ".fabcli-asset.json"), JSON.stringify({ listing_uid: "test" }));
  process.exit(0);
}
process.stderr.write(JSON.stringify({ error: { kind: "generic", message: "forbidden subcommand " + argv.join(" ") } }));
process.exit(70);
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
}
