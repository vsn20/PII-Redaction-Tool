/**
 * evaluate.js
 * Scores the detector against data/test-set/ground-truth.json.
 * Computes per-type and overall precision / recall / F1 / accuracy,
 * and writes reports/evaluation-report.md.
 *
 * Matching rule: a predicted span counts as a hit if its [start,end)
 * overlaps a ground-truth span of the SAME type by at least 50% of
 * the shorter span's length. This tolerates off-by-a-few-chars
 * boundary differences (e.g. trailing punctuation) without being
 * so loose that it hides real misses.
 */

import fs from "fs";
import { detectAll } from "./redactor.js";

const GROUND_TRUTH_PATH = "data/test-set/ground-truth.json";
const REPORT_PATH = "reports/evaluation-report.md";

function overlapRatio(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  const overlap = Math.max(0, end - start);
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 ? overlap / shorter : 0;
}

function isMatch(pred, truth) {
  return pred.type === truth.type && overlapRatio(pred, truth) >= 0.5;
}

function scoreCase(text, groundTruth) {
  const predicted = detectAll(text); // [{type, value, start, end}, ...]
  const matchedTruth = new Set();
  const matchedPred = new Set();

  predicted.forEach((pred, pi) => {
    groundTruth.forEach((truth, ti) => {
      if (matchedTruth.has(ti)) return;
      if (isMatch(pred, truth)) {
        matchedTruth.add(ti);
        matchedPred.add(pi);
      }
    });
  });

  return {
    truePositives: predicted.filter((_, i) => matchedPred.has(i)),
    falsePositives: predicted.filter((_, i) => !matchedPred.has(i)),
    falseNegatives: groundTruth.filter((_, i) => !matchedTruth.has(i)),
  };
}

function main() {
  const { cases } = JSON.parse(fs.readFileSync(GROUND_TRUTH_PATH, "utf-8"));

  // per-type counters
  const stats = {}; // type -> {tp, fp, fn}
  const bump = (type, key) => {
    stats[type] = stats[type] || { tp: 0, fp: 0, fn: 0 };
    stats[type][key]++;
  };

  for (const { text, entities } of cases) {
    const { truePositives, falsePositives, falseNegatives } = scoreCase(text, entities);
    truePositives.forEach((p) => bump(p.type, "tp"));
    falsePositives.forEach((p) => bump(p.type, "fp"));
    falseNegatives.forEach((t) => bump(t.type, "fn"));
  }

  const rows = [];
  let totalTP = 0, totalFP = 0, totalFN = 0;

  for (const [type, { tp, fp, fn }] of Object.entries(stats).sort()) {
    const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    rows.push({ type, tp, fp, fn, precision, recall, f1 });
    totalTP += tp; totalFP += fp; totalFN += fn;
  }

  const overallPrecision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1;
  const overallRecall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 1;
  const overallF1 = overallPrecision + overallRecall > 0
    ? (2 * overallPrecision * overallRecall) / (overallPrecision + overallRecall) : 0;
  // "Accuracy" here = TP / (TP + FP + FN), since true negatives (correctly
  // NOT flagging non-PII text) aren't well-defined at the span level.
  const overallAccuracy = totalTP / (totalTP + totalFP + totalFN || 1);

  const pct = (n) => (n * 100).toFixed(1) + "%";

  let md = `# PII Redaction — Evaluation Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Test cases: ${cases.length}\n\n`;
  md += `## Per-type results\n\n`;
  md += `| Type | TP | FP | FN | Precision | Recall | F1 |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  rows.forEach((r) => {
    md += `| ${r.type} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} |\n`;
  });
  md += `\n## Overall\n\n`;
  md += `- **Precision:** ${pct(overallPrecision)}\n`;
  md += `- **Recall:** ${pct(overallRecall)}\n`;
  md += `- **F1:** ${pct(overallF1)}\n`;
  md += `- **Accuracy (TP/(TP+FP+FN)):** ${pct(overallAccuracy)}\n`;

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(REPORT_PATH, md);

  console.log(md);
  console.log(`\nReport written to ${REPORT_PATH}`);
}

main();