import { NextResponse } from "next/server";
import { PIIMapping } from "@/redactor.js";
import { redactDocxBuffer } from "@/docxHandler.js";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const inputBuffer = Buffer.from(await file.arrayBuffer());
    const mapping = new PIIMapping();
    const { buffer: outputBuffer, spanCount } = await redactDocxBuffer(inputBuffer, mapping);

    return new NextResponse(outputBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="redacted_${file.name}"`,
        "X-Redaction-Count": String(spanCount),
      },
    });
  } catch (err) {
    console.error("Redaction failed:", err);
    return NextResponse.json({ error: "Redaction failed", detail: err.message }, { status: 500 });
  }
}