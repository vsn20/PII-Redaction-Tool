/**
 * main.js
 * CLI entrypoint. Wires config -> redactor -> docxHandler together.
 *
 * Usage:
 *   node main.js
 *   node main.js --input data/input/MyFile.docx --output output/MyFile_REDACTED.docx
 */

import fs from "fs";
import path from "path";
import { PIIMapping } from "./redactor.js";
import { redactDocx } from "./docxHandler.js";
import { MAPPING_LOG_PATH } from "./config.js";

// -----------------------------------------------------------------
// Tiny CLI arg parser (no extra dependency needed for two flags)
// -----------------------------------------------------------------
function parseArgs(argv) {
  const args = { input: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--output") args.output = argv[++i];
  }
  return args;
}

const DEFAULT_INPUT = "data/input/Red_Herring_Prospectus.docx";
const DEFAULT_OUTPUT = "output/Red_Herring_Prospectus_REDACTED.docx";

async function main() {
  const { input, output } = parseArgs(process.argv.slice(2));
  const inputPath = input || DEFAULT_INPUT;
  const outputPath = output || DEFAULT_OUTPUT;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    console.error(`Place your .docx there, or pass --input <path>.`);
    process.exit(1);
  }

  // Ensure output dir exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  console.log(`Reading:  ${inputPath}`);
  console.log(`Redacting PII...`);

  const mapping = new PIIMapping();
  const startTime = Date.now();

  const { blockCount, spanCount } = await redactDocx(inputPath, outputPath, mapping);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

  // Write the real->fake mapping log (QA / audit trail — NOT part of the
  // deliverable docx, kept separate so the redacted file itself never
  // contains a way to reverse the redaction)
  fs.mkdirSync(path.dirname(MAPPING_LOG_PATH), { recursive: true });
  fs.writeFileSync(MAPPING_LOG_PATH, JSON.stringify(mapping.toJSON(), null, 2));

  // Per-type summary count, printed to console for a quick sanity check
  const byType = {};
  for (const { type } of Object.values(mapping.toJSON())) {
    byType[type] = (byType[type] || 0) + 1;
  }

  console.log(`\nDone in ${elapsedSec}s`);
  console.log(`Blocks processed: ${blockCount}`);
  console.log(`PII spans redacted: ${spanCount}`);
  console.log(`Unique entities mapped: ${mapping.map.size}`);
  console.log(`\nBy type:`);
  for (const [type, count] of Object.entries(byType).sort()) {
    console.log(`  ${type.padEnd(14)} ${count}`);
  }
  console.log(`\nRedacted docx: ${outputPath}`);
  console.log(`Mapping log:   ${MAPPING_LOG_PATH}`);
}

main().catch((err) => {
  console.error("Redaction failed:", err);
  process.exit(1);
});