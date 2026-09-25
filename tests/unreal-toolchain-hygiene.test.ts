import { access, chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepStaleStaging } from "../src/unreal/importer.js";
import { ensureUmodel } from "../src/unreal/provision.js";

/** The 2022 upstream UE Viewer lists -psk in its help yet rejects it on the command line. */
const OLD_UMODEL = `#!/bin/sh
case " $* " in *" -psk "*) echo "UModel: bad command line: invalid option: -psk"; exit 1;; esac
printf 'UE Viewer (UModel)\\nCompiled Jan  7 2022 (build 1584)\\n'
`;
const CURRENT_UMODEL = `#!/bin/sh
printf 'UE Viewer (UModel)\\nCompiled Sep 24 2026 (build 1)\\n'
`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { cached: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "umodel-resolution-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "umodel"), OLD_UMODEL);
  await chmod(join(bin, "umodel"), 0o755);
  const toolchain = join(root, "toolchain");
  const cached = join(toolchain, "umodel", "umodel");
  if (options.cached) {
    await mkdir(join(toolchain, "umodel"), { recursive: true });
    await writeFile(cached, CURRENT_UMODEL);
    await chmod(cached, 0o755);
  }
  const environment = {
    PATH: bin,
    THREENATIVE_TOOLCHAIN_DIR: toolchain,
    THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
  };
  return { oldPath: join(bin, "umodel"), cached, environment };
}

describe("UE Viewer resolution", () => {
  it("skips a PATH umodel that rejects -psk in favour of the provisioned build", async () => {
    const { cached, environment } = await fixture({ cached: true });
    const tool = await ensureUmodel(environment);
    expect(tool.path).toBe(cached);
    expect(tool.version).toContain("Sep 24 2026");
  });

  it("does not fall back to an incapable PATH umodel when nothing better exists", async () => {
    const { environment } = await fixture({ cached: false });
    await expect(ensureUmodel(environment)).rejects.toMatchObject({ code: "UNREAL_TOOL_NOT_FOUND" });
  });

  it("names the -psk gap when an explicit override points at an old build", async () => {
    const { oldPath, environment } = await fixture({ cached: true });
    await expect(ensureUmodel({ ...environment, THREENATIVE_UMODEL_PATH: oldPath })).rejects.toMatchObject({
      code: "UNREAL_TOOL_UNUSABLE",
      message: expect.stringContaining("-psk"),
    });
  });
});

describe("stale import staging", () => {
  it("removes run directories older than a day and keeps fresh ones and cached results", async () => {
    const root = await mkdtemp(join(tmpdir(), "staging-sweep-"));
    roots.push(root);
    const stale = join(root, "key", "run-old");
    const fresh = join(root, "key", "run-new");
    const result = join(root, "key", "result");
    await Promise.all([stale, fresh, result].map((path) => mkdir(path, { recursive: true })));
    const dayAndABit = Date.now() - 25 * 60 * 60 * 1000;
    await utimes(stale, dayAndABit / 1000, dayAndABit / 1000);
    await utimes(result, dayAndABit / 1000, dayAndABit / 1000);

    await sweepStaleStaging(root);

    await expect(access(stale)).rejects.toThrow();
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(result)).resolves.toBeUndefined();
  });
});
