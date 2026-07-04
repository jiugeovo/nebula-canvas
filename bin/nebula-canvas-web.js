#!/usr/bin/env node
import { startWebServer } from "../src/web-server.js";

const args = parseArgs(process.argv.slice(2));

try {
  const server = await startWebServer({
    host: args.host || process.env.NEBULA_CANVAS_WEB_HOST || "127.0.0.1",
    port: Number(args.port || process.env.NEBULA_CANVAS_WEB_PORT || 8787),
  });

  console.log(`NebulaCanvas web UI: http://${server.host}:${server.port}`);
  console.log(`NebulaCanvas REST API: http://${server.host}:${server.port}/api`);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    result[key] = inlineValue ?? argv[++i];
  }
  return result;
}
