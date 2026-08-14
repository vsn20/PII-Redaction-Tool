/**
 * docxHandler.js
 * Handles reading an input .docx and writing a redacted output .docx.
 *
 * Approach:
 *  1. mammoth converts the .docx to HTML — this is the most reliable way
 *     to get clean paragraph/heading/list/table structure out of a real
 *     Word file (raw word/document.xml has runs split unpredictably).
 *  2. node-html-parser walks that HTML into a simple array of "blocks"
 *     (paragraph, heading, list item, table).
 *  3. Each block's text is passed through redactor.js, using ONE shared
 *     PIIMapping so the same real value -> same fake value everywhere
 *     in the document.
 *  4. The `docx` (docx-js) library rebuilds a new .docx from the
 *     redacted blocks.
 *
 * Known tradeoff (documented in README): original styling (fonts, colors,
 * exact table borders, images) is NOT preserved — only structural content
 * (headings/paragraphs/lists/tables). Acceptable for a redaction tool
 * whose job is content safety, not visual fidelity.
 */

import fs from "fs";
import mammoth from "mammoth";
import { parse as parseHtml } from "node-html-parser";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  LevelFormat,
} from "docx";
import { redactText } from "./redactor.js";

// -----------------------------------------------------------------
// 1. Load .docx -> HTML
// -----------------------------------------------------------------
async function docxToHtml(inputPath) {
  const result = await mammoth.convertToHtml({ path: inputPath });
  return result.value; // ignore result.messages (formatting warnings, not needed here)
}

// -----------------------------------------------------------------
// 2. HTML -> simple block list
//    Each block: { type: 'heading'|'paragraph'|'listItem'|'table', ... }
// -----------------------------------------------------------------
function htmlToBlocks(html) {
  const root = parseHtml(html);
  const blocks = [];

  for (const node of root.childNodes) {
    if (node.nodeType !== 1) continue; // skip text/comment nodes at top level
    const tag = node.rawTagName?.toLowerCase();

    if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
      blocks.push({ type: "heading", level: Number(tag[1]), text: node.text.trim() });
    } else if (tag === "p") {
      const text = node.text.trim();
      if (text) blocks.push({ type: "paragraph", text });
    } else if (tag === "ul" || tag === "ol") {
      for (const li of node.querySelectorAll("li")) {
        const text = li.text.trim();
        if (text) blocks.push({ type: "listItem", text });
      }
    } else if (tag === "table") {
      const rows = [];
      for (const tr of node.querySelectorAll("tr")) {
        const cells = [...tr.querySelectorAll("td, th")].map((c) => c.text.trim());
        rows.push(cells);
      }
      if (rows.length) blocks.push({ type: "table", rows });
    }
  }
  return blocks;
}

// -----------------------------------------------------------------
// 3. Redact all text within blocks (in place), using one shared mapping
//    so entities are consistent document-wide.
// -----------------------------------------------------------------
function redactBlocks(blocks, mapping) {
  let totalSpans = 0;

  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph" || block.type === "listItem") {
      const { redacted, spans } = redactText(block.text, mapping);
      block.text = redacted;
      totalSpans += spans.length;
    } else if (block.type === "table") {
      block.rows = block.rows.map((row) =>
        row.map((cellText) => {
          const { redacted, spans } = redactText(cellText, mapping);
          totalSpans += spans.length;
          return redacted;
        })
      );
    }
  }
  return totalSpans;
}

// -----------------------------------------------------------------
// 4. Blocks -> new .docx (via docx-js)
// -----------------------------------------------------------------
const HEADING_MAP = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function buildTable(rows) {
  const numCols = Math.max(...rows.map((r) => r.length));
  const TABLE_WIDTH_DXA = 9000;
  const colWidth = Math.floor(TABLE_WIDTH_DXA / numCols);
  const columnWidths = Array(numCols).fill(colWidth);

  const tableRows = rows.map(
    (row) =>
      new TableRow({
        children: Array.from({ length: numCols }, (_, i) => {
          const text = row[i] ?? "";
          return new TableCell({
            width: { size: colWidth, type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun(text)] })],
          });
        }),
      })
  );

  return new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths,
    rows: tableRows,
  });
}

function blocksToDocxElements(blocks) {
  const elements = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      elements.push(
        new Paragraph({
          heading: HEADING_MAP[block.level] ?? HeadingLevel.HEADING_3,
          children: [new TextRun(block.text)],
        })
      );
    } else if (block.type === "paragraph") {
      elements.push(new Paragraph({ children: [new TextRun(block.text)] }));
    } else if (block.type === "listItem") {
      elements.push(
        new Paragraph({
          numbering: { reference: "redaction-bullets", level: 0 },
          children: [new TextRun(block.text)],
        })
      );
    } else if (block.type === "table") {
      elements.push(buildTable(block.rows));
      elements.push(new Paragraph({ text: "" })); // spacer after table
    }
  }
  return elements;
}

async function writeRedactedDocx(blocks, outputPath) {
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "redaction-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: "left",
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { size: { width: 12240, height: 15840 } }, // US Letter, DXA
        },
        children: blocksToDocxElements(blocks),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// -----------------------------------------------------------------
// Public entrypoint used by main.js
// -----------------------------------------------------------------
export async function redactDocx(inputPath, outputPath, mapping) {
  const html = await docxToHtml(inputPath);
  const blocks = htmlToBlocks(html);
  const spanCount = redactBlocks(blocks, mapping);
  await writeRedactedDocx(blocks, outputPath);
  return { blockCount: blocks.length, spanCount };
}
// -----------------------------------------------------------------
// Buffer-based entrypoint for serverless/web use (no disk I/O).
// Mirrors redactDocx() above but takes/returns Buffers directly,
// since a hosted API route has no writable filesystem for uploads.
// -----------------------------------------------------------------
export async function redactDocxBuffer(inputBuffer, mapping) {
  const result = await mammoth.convertToHtml({ buffer: inputBuffer });
  const html = result.value;
  const blocks = htmlToBlocks(html);
  const spanCount = redactBlocks(blocks, mapping);

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "redaction-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: "left",
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 } } },
        children: blocksToDocxElements(blocks),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return { buffer, blockCount: blocks.length, spanCount };
}