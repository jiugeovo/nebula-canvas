#!/usr/bin/env node
import { runCli } from "../src/cli.js";

try {
  const exitCode = await runCli();
  process.exit(exitCode);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
