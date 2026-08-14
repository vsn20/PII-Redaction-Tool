/**
 * redactor.js
 * Core PII detection + consistent fake-replacement engine.
 *
 * Design:
 *  1. Run high-confidence REGEX patterns first (email, phone, SSN, credit
 *     card, IP, DOB) — these are precise and rarely false-positive.
 *  2. Run HEURISTIC detectors (names, companies, addresses) on the
 *     remaining, not-yet-redacted text — these are lower-precision by
 *     nature (no ML/NER available offline), so they run after and never
 *     re-match text already tagged as PII.
 *  3. Every detected value is replaced with a FAKE value, but the same
 *     real value always maps to the same fake value (a running Map),
 *     so "Rashi Patil" -> "John Doe" everywhere, not a new name each time.
 *
 * Extending to a new PII type:
 *   - Structured/patterned (like SSN)  -> add a regex to config.js PII_PATTERNS
 *   - Free-form (like "Job Title")     -> add a heuristic detector function
 *     below and call it from detectAll()
 */

import { faker } from "@faker-js/faker";
import {
  PII_PATTERNS,
  ADDRESS_KEYWORDS,
  PINCODE_PATTERN,
  NAME_TITLES,
  COMPANY_SUFFIXES,
  NAME_STOPWORDS,
  COMPANY_DETERMINERS,
  RANDOM_SEED,
} from "./config.js";

faker.seed(RANDOM_SEED);

// -----------------------------------------------------------------
// Mapping store: keeps real -> fake consistent across the whole document
// -----------------------------------------------------------------
export class PIIMapping {
  constructor() {
    this.map = new Map(); // key: `${type}::${normalizedRealValue}` -> fakeValue
  }

  _key(type, value) {
    return `${type}::${value.trim().toLowerCase()}`;
  }

  has(type, value) {
    return this.map.has(this._key(type, value));
  }

  get(type, value) {
    return this.map.get(this._key(type, value));
  }

  set(type, value, fakeValue) {
    this.map.set(this._key(type, value), fakeValue);
  }

  // Dump for the QA log (output/redaction-mapping.json)
  toJSON() {
    const out = {};
    for (const [key, fake] of this.map.entries()) {
      const [type, real] = key.split("::");
      out[key] = { type, real, fake };
    }
    return out;
  }
}

// -----------------------------------------------------------------
// Fake value generators — one per PII type
// -----------------------------------------------------------------
function generateFake(type, realValue) {
  switch (type) {
    case "EMAIL":
      return faker.internet.email({ provider: "example.com" }).toLowerCase();
    case "PHONE":
      // preserve rough shape: "+91 9876543210" vs "020 6652 3600"
      if (realValue.replace(/\D/g, "").length >= 10 && /\+?91/.test(realValue)) {
        return `+91 ${faker.string.numeric(10)}`;
      }
      return faker.string.numeric(realValue.replace(/\D/g, "").length || 10);
    case "SSN":
      return faker.string.numeric(3) + "-" + faker.string.numeric(2) + "-" + faker.string.numeric(4);
    case "CREDIT_CARD":
      return faker.finance.creditCardNumber("################").replace(/\s|-/g, "").match(/.{1,4}/g).join(" ");
    case "IP_ADDRESS":
      return faker.internet.ipv4();
    case "DOB":
      return faker.date.birthdate().toLocaleDateString("en-GB"); // DD/MM/YYYY
    case "NAME":
      return faker.person.fullName();
    case "COMPANY":
      return faker.company.name() + " Limited";
    case "ADDRESS":
      return faker.location.streetAddress() + ", " + faker.location.city();
    default:
      return "[REDACTED]";
  }
}

// Returns a fake value, reusing a previous one for the same real value
function fakeFor(type, realValue, mapping) {
  if (mapping.has(type, realValue)) return mapping.get(type, realValue);
  const fake = generateFake(type, realValue);
  mapping.set(type, realValue, fake);
  return fake;
}

// -----------------------------------------------------------------
// Span utilities — avoid double-tagging the same text twice
// -----------------------------------------------------------------
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function addSpanIfFree(spans, candidate) {
  if (!spans.some((s) => overlaps(s, candidate))) spans.push(candidate);
}

// -----------------------------------------------------------------
// 1. Regex-based detectors (EMAIL, PHONE, SSN, CREDIT_CARD, IP, DOB)
// -----------------------------------------------------------------
function detectRegexPII(text) {
  const spans = [];
  // Priority order matters: EMAIL/SSN/CREDIT_CARD/IP before the looser PHONE
  // regex, so e.g. a credit card isn't partially swallowed by PHONE.
  const order = ["EMAIL", "SSN", "CREDIT_CARD", "IP_ADDRESS", "DOB", "PHONE"];
  for (const type of order) {
    const regex = PII_PATTERNS[type];
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      // DOB now captures the date in group 1 (the cue word like "Date of
      // Birth:" is part of match[0] but should NOT itself be redacted).
      const isGroupedDob = type === "DOB" && match[1];
      let value = isGroupedDob ? match[1] : match[0];
      let start = isGroupedDob
        ? match.index + match[0].lastIndexOf(match[1])
        : match.index;

      // PHONE: the base regex is intentionally loose and also catches PIN
      // codes (6 digits) and reference/registration numbers (9 digits with
      // leading zeros). Keep only matches that reduce to exactly 10 digits
      // after stripping a leading country code — i.e. actually phone-shaped.
      if (type === "PHONE") {
        const digits = value.replace(/\D/g, "");
        const core = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
        if (core.length !== 10) {
          if (match[0].length === 0) regex.lastIndex++;
          continue;
        }
      }

      addSpanIfFree(spans, {
        type,
        value,
        start,
        end: start + value.length,
      });
      if (match[0].length === 0) regex.lastIndex++; // avoid infinite loop
    }
  }
  return spans;
}

// -----------------------------------------------------------------
// 2. Heuristic: full names
//    Trigger: a title (Mr./Ms./Dr./Shri/Smt.) followed by 1-3
//    capitalized words, OR a capitalized 2-3 word sequence immediately
//    following a role cue word (Director, Promoter, Secretary, Signed by...).
//    This is a precision/recall tradeoff — documented in README.
// -----------------------------------------------------------------
const NAME_ROLE_CUES = [
  "Director", "Promoter", "Company Secretary", "Compliance Officer",
  "Signed by", "Signature of", "Chief Financial Officer", "Managing Director",
  "Chairman", "Whole-time Director", "Contact Person",
];

function containsStopword(value) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .some((w) => NAME_STOPWORDS.has(w));
}

function detectNames(text, existingSpans) {
  const spans = [];
  const titlePattern = new RegExp(
    `(?:${NAME_TITLES.map((t) => t.replace(".", "\\.")).join("|")})\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})`,
    "g"
  );
  let match;
  while ((match = titlePattern.exec(text)) !== null) {
    if (containsStopword(match[1])) continue;
    const nameStart = match.index + match[0].indexOf(match[1]);
    const candidate = { type: "NAME", value: match[1], start: nameStart, end: nameStart + match[1].length };
    if (!existingSpans.some((s) => overlaps(s, candidate))) spans.push(candidate);
  }

  for (const cue of NAME_ROLE_CUES) {
    const cuePattern = new RegExp(`${cue}\\s*[:\\-]?\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})`, "g");
    while ((match = cuePattern.exec(text)) !== null) {
      if (containsStopword(match[1])) continue;
      const nameStart = match.index + match[0].lastIndexOf(match[1]);
      const candidate = { type: "NAME", value: match[1], start: nameStart, end: nameStart + match[1].length };
      if (!existingSpans.some((s) => overlaps(s, candidate)) && !spans.some((s) => overlaps(s, candidate))) {
        spans.push(candidate);
      }
    }
  }
  return spans;
}
function isDeterminerOnlyCompany(value) {
  // Rejects "Our Company", "The Company", "Such Limited", etc — a single
  // determiner word followed directly by a generic suffix is a defined-term
  // reference ("Our Company" = this prospectus's issuer, referenced
  // constantly), not an actual named company.
  const words = value.trim().split(/\s+/);
  if (words.length < 2) return false;
  const first = words[0].toLowerCase();
  const rest = words.slice(1).join(" ").toLowerCase();
  const isGenericSuffixOnly = COMPANY_SUFFIXES.some(
    (s) => rest === s.toLowerCase() || rest === `private ${s.toLowerCase()}`
  );
  return COMPANY_DETERMINERS.includes(first) && isGenericSuffixOnly;
}

function isSuffixOnlyCompany(value) {
  // Rejects candidates made entirely of suffix words with nothing else,
  // e.g. "Private Limited" alone — "Private" satisfies the regex's
  // leading capitalized-word requirement, "Limited" satisfies the suffix
  // alternation, so two suffix words next to each other can otherwise
  // match themselves as if they were a company name.
  const suffixWordsLower = new Set(
    COMPANY_SUFFIXES.flatMap((s) => s.toLowerCase().replace(".", "").split(/\s+/))
  );
  const words = value.trim().toLowerCase().replace(/\./g, "").split(/\s+/);
  return words.every((w) => suffixWordsLower.has(w));
}

function detectCompanies(text, existingSpans) {
  const spans = [];
  const suffixAlt = COMPANY_SUFFIXES.map((s) => s.replace(".", "\\.")).join("|");
  const pattern = new RegExp(
    `([A-Z][A-Za-z&]*(?:\\s+[A-Z][A-Za-z&]*){0,4}\\s+(?:${suffixAlt}))\\b`,
    "g"
  );
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (isDeterminerOnlyCompany(match[1]) || isSuffixOnlyCompany(match[1])) continue;
    const candidate = { type: "COMPANY", value: match[1], start: match.index, end: match.index + match[1].length };
    if (!existingSpans.some((s) => overlaps(s, candidate)) && !spans.some((s) => overlaps(s, candidate))) {
      spans.push(candidate);
    }
  }
  return spans;
}
// -----------------------------------------------------------------
// 4. Heuristic: addresses
//    Trigger: a line/segment containing a genuine Indian PIN code, OR
//    2+ narrow address keywords in a short-enough segment.
//    "Genuine PIN code" = 6 digits immediately preceded by a dash-like
//    character (as in every real address here: "Pune â€“ 410 501").
//    Without this check, any unrelated 6-digit number (a registration
//    number, a peer-review number, etc) was matching PINCODE_PATTERN
//    and causing false-positive ADDRESS spans.
// -----------------------------------------------------------------
const ADDRESS_MAX_LEN_WITH_PIN = 600;
const ADDRESS_MAX_LEN_KEYWORDS_ONLY = 300;

function hasGenuinePincode(seg) {
  const regex = new RegExp(PINCODE_PATTERN.source, "g");
  let m;
  while ((m = regex.exec(seg)) !== null) {
    const before = seg.slice(0, m.index);
    // Require the dash to be preceded by whitespace or start-of-segment —
    // NOT directly attached to a letter (e.g. "M-140388" is a registration
    // number, not a PIN code; real PIN codes always look like "Pune – 410 501"
    // with a space before the dash).
    if (/(?:^|\s)(?:[-–—]|â€“)\s{0,2}$/.test(before)) return true;
  }
  return false;
}
function detectAddresses(text, existingSpans) {
  const spans = [];
  const segments = text.split(/(?<=[.\n])/);
  let cursor = 0;
  for (const seg of segments) {
    const segStart = cursor;
    cursor += seg.length;

    const trimmed = seg.trim();
    if (!trimmed) continue;

    const hasPin = hasGenuinePincode(seg);
    const keywordHits = ADDRESS_KEYWORDS.filter((k) => seg.includes(k)).length;

    const qualifies =
      (hasPin && trimmed.length <= ADDRESS_MAX_LEN_WITH_PIN) ||
      (!hasPin && keywordHits >= 2 && trimmed.length <= ADDRESS_MAX_LEN_KEYWORDS_ONLY);

    if (qualifies) {
      const trimmedStart = segStart + seg.search(/\S/);
      const candidate = { type: "ADDRESS", value: trimmed, start: trimmedStart, end: trimmedStart + trimmed.length };
      if (!existingSpans.some((s) => overlaps(s, candidate)) && !spans.some((s) => overlaps(s, candidate))) {
        spans.push(candidate);
      }
    }
  }
  return spans;
}
// -----------------------------------------------------------------
// Master detector — combines all of the above.
//
// ORDER MATTERS: ADDRESS runs FIRST, before NAME/COMPANY. Address
// candidates are whole-segment spans (an entire sentence), and the
// segment they claim often also contains a company name or a person's
// name (e.g. "...our Company, KSH International Limited, at 11/3...
// Pune – 410501..."). If NAME/COMPANY ran first, their small span
// would sit inside the address segment and the overlap check would
// reject the ENTIRE address candidate because of that partial overlap
// — silently losing the whole address. Running ADDRESS first avoids
// that: the address claims the full sentence (which already includes
// and redacts any company/name text within it), and NAME/COMPANY then
// only look at whatever segments remain.
// -----------------------------------------------------------------
export function detectAll(text) {
  const regexSpans = detectRegexPII(text);
  const addressSpans = detectAddresses(text, regexSpans);
  const nameSpans = detectNames(text, [...regexSpans, ...addressSpans]);
  const companySpans = detectCompanies(text, [...regexSpans, ...addressSpans, ...nameSpans]);

  const all = [...regexSpans, ...addressSpans, ...nameSpans, ...companySpans];
  all.sort((a, b) => a.start - b.start);
  return all;
}

// -----------------------------------------------------------------
// Apply redaction to a single string, given a shared PIIMapping
// -----------------------------------------------------------------
export function redactText(text, mapping) {
  const spans = detectAll(text);
  if (spans.length === 0) return { redacted: text, spans };

  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start);
    result += fakeFor(span.type, span.value, mapping);
    cursor = span.end;
  }
  result += text.slice(cursor);
  return { redacted: result, spans };
}