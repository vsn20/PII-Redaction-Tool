"use client";
import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [redactionCount, setRedactionCount] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) return;

    setStatus("processing");
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/redact", { method: "POST", body: formData });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }

      setRedactionCount(res.headers.get("X-Redaction-Count"));

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `redacted_${file.name}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus("done");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  return (
    <main style={{ maxWidth: 560, margin: "80px auto", fontFamily: "sans-serif", padding: "0 20px" }}>
      <h1>PII Redaction Tool</h1>
      <p style={{ color: "#555" }}>
        Upload a .docx file. Names, emails, phone numbers, companies,
        addresses, SSNs, credit card numbers, dates of birth, and IP
        addresses are detected and replaced with fake values, then the
        redacted document downloads automatically.
      </p>

      <form onSubmit={handleSubmit} style={{ marginTop: 24 }}>
        <input
          type="file"
          accept=".docx"
          onChange={(e) => setFile(e.target.files[0])}
        />
        <br />
        <button
          type="submit"
          disabled={!file || status === "processing"}
          style={{ marginTop: 16, padding: "10px 20px", cursor: "pointer" }}
        >
          {status === "processing" ? "Redacting..." : "Redact & Download"}
        </button>
      </form>

      {status === "done" && (
        <p style={{ color: "green", marginTop: 16 }}>
          Done — {redactionCount} PII spans redacted. Download started.
        </p>
      )}
      {status === "error" && (
        <p style={{ color: "red", marginTop: 16 }}>Error: {error}</p>
      )}
    </main>
  );
}