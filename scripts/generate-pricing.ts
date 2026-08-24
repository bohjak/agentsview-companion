#!/usr/bin/env tsx
/** Generate the local runtime table from committed pricing ledgers. */
import { runGenerator } from "./pricing/generate.ts";

try {
  runGenerator(process.cwd(), process.argv.includes("--check"));
} catch (error) {
  console.error(`[generate-pricing] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
