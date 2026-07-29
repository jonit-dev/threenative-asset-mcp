import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

interface JsonRpcResponse {
  id?: number;
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  error?: unknown;
}

const child = spawn(process.execPath, [resolve("dist/index.js")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    FAB_BROWSER_HEADLESS: "true",
    FAB_LOG_LEVEL: "error",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let nextId = 1;
const waiting = new Map<
  number,
  { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }
>();

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      throw new Error(`MCP emitted non-JSON stdout: ${line}`);
    }
    if (typeof message.id === "number") {
      waiting.get(message.id)?.resolve(message);
      waiting.delete(message.id);
    }
  }
});

function request(
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const id = nextId++;
  return new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 30_000);
    waiting.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolveResponse(value);
      },
      reject,
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array.");
  return value;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  expectError = false,
): Promise<Record<string, unknown>> {
  const response = await request("tools/call", {
    name,
    arguments: args,
  });
  if (response.error) {
    throw new Error(`${name} JSON-RPC error: ${JSON.stringify(response.error)}`);
  }
  const result = response.result;
  if (!result) throw new Error(`${name} returned no result.`);
  if (expectError) {
    if (!result.isError) throw new Error(`${name} unexpectedly succeeded.`);
    const text = result.content?.[0]?.text ?? "";
    return object(JSON.parse(text) as unknown);
  }
  if (result.isError) {
    throw new Error(
      `${name} failed: ${result.content?.[0]?.text ?? "unknown error"}`,
    );
  }
  return object(result.structuredContent);
}

async function main(): Promise<void> {
  const initialized = await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: "threenative-asset-mcp-live-probe",
      version: "1.0.0",
    },
  });
  if (initialized.error) throw new Error("MCP initialization failed.");
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })}\n`,
  );

  const ambientSearch = await callTool("ambientcg_search_assets", {
    query: "apple",
    type: "3d-model",
    limit: 2,
  });
  const ambientItems = array(ambientSearch.items);
  const ambientId = String(object(ambientItems[0]).id ?? "");
  if (!ambientId) throw new Error("ambientCG live search returned no asset.");
  await callTool("ambientcg_get_asset", { assetId: ambientId });
  const ambientFiles = await callTool("ambientcg_list_files", {
    assetId: ambientId,
    limit: 5,
  });
  if (array(ambientFiles.files).length === 0) {
    throw new Error("ambientCG live file list was empty.");
  }
  const ambientCategories = await callTool("ambientcg_list_categories", {
    type: "3d-model",
  });
  if (array(ambientCategories.categories).length === 0) {
    throw new Error("ambientCG live category list was empty.");
  }

  const smithsonianSearch = await callTool("smithsonian_search_assets", {
    query: "apollo",
    fileType: "glb",
    limit: 5,
  });
  const smithsonianItems = array(smithsonianSearch.items);
  const smithsonianId = String(object(smithsonianItems[0]).id ?? "");
  if (!smithsonianId) {
    throw new Error("Smithsonian live search returned no model.");
  }
  await callTool("smithsonian_get_asset", { modelId: smithsonianId });
  const smithsonianFiles = await callTool("smithsonian_list_files", {
    modelId: smithsonianId,
    limit: 5,
  });
  if (array(smithsonianFiles.files).length === 0) {
    throw new Error("Smithsonian live file list was empty.");
  }

  const sketchfabSearch = await callTool("sketchfab_search_models", {
    query: "chair",
    downloadable: true,
    limit: 2,
  });
  const sketchfabItems = array(sketchfabSearch.items);
  const sketchfabId = String(object(sketchfabItems[0]).id ?? "");
  if (!sketchfabId) throw new Error("Sketchfab live search returned no model.");
  await callTool("sketchfab_get_model", { modelId: sketchfabId });
  const sketchfabCategories = await callTool("sketchfab_list_categories", {});
  if (array(sketchfabCategories.categories).length === 0) {
    throw new Error("Sketchfab live category list was empty.");
  }
  if (process.env.SKETCHFAB_API_TOKEN?.trim()) {
    const downloads = await callTool("sketchfab_get_downloads", {
      modelId: sketchfabId,
    });
    if (array(downloads.downloads).length === 0) {
      throw new Error("Sketchfab authenticated download list was empty.");
    }
  } else {
    const authError = await callTool(
      "sketchfab_get_downloads",
      { modelId: sketchfabId },
      true,
    );
    if (authError.code !== "SKETCHFAB_AUTH_REQUIRED") {
      throw new Error("Sketchfab returned the wrong unauthenticated error.");
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ambientcg: {
        assetId: ambientId,
        filesChecked: array(ambientFiles.files).length,
      },
      smithsonian: {
        modelId: smithsonianId,
        filesChecked: array(smithsonianFiles.files).length,
      },
      sketchfab: {
        modelId: sketchfabId,
        authenticatedDownloads: Boolean(
          process.env.SKETCHFAB_API_TOKEN?.trim(),
        ),
      },
    })}\n`,
  );
}

try {
  await main();
} finally {
  child.stdin.end();
  if (child.exitCode === null) child.kill("SIGTERM");
  await once(child, "exit").catch(() => []);
}
