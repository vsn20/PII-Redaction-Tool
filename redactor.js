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
 *  3. Run a KNOWN-ENTITY pass (optional, document-level): a first read-only
 *     scan over the whole document collects every NAME/COMPANY the context
 *     rules above are confident about — including SHORTENED forms of a
 *     multi-word name (first+last, surname alone), since real documents
 *     refer to a person by their full name once and a shortened form
 *     afterward (e.g. "Kushal Subbayya Hegde" the first time, then just
 *     "Hegde" or "Kushal Hegde" later). A second pass then also matches
 *     exact repeats of those confirmed entities — including the shortened
 *     forms — even where they appear with NO surrounding context, e.g. a
 *     person's name sitting alone in a table cell, with the role word
 *     ("Promoter") in a separate cell. Context-only detection misses
 *     these; the known-entity pass catches them because the entity was
 *     already proven real elsewhere in the doc.
 *     TRADEOFF: matching a bare surname raises false-positive risk very
 *     slightly if that exact word ever appears unrelated to the person
 *     elsewhere in the document. For a specific, uncommon surname this
 *     risk is low; documented here and in the README.
 *  4. Every detected value is replaced with a FAKE value, but the same
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
      // DOB may capture the date in group 1 (a cue word like "Date of
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
//    Four trigger patterns, since real documents use all of them:
//    (a) ROLE-FIRST, title: "Mr. Rajesh Sharma"
//    (b) ROLE-FIRST, role cue: "Director: Kushal Hegde"
//    (c) NAME-FIRST, inline role: table row "Kushal Hegde   Promoter   1,528.00"
//    (d) NAME-FIRST, list header: "OUR PROMOTERS: KUSHAL HEGDE, PUSHPA HEGDE, ..."
//    Matches BOTH Title Case and ALL CAPS, since this document uses both.
//    This is a precision/recall tradeoff — documented in README.
// -----------------------------------------------------------------
const NAME_ROLE_CUES = [
  "Director", "Promoter", "Company Secretary", "Compliance Officer",
  "Signed by", "Signature of", "Chief Financial Officer", "Managing Director",
  "Chairman", "Whole-time Director", "Contact Person",
];

// Words that can follow a name inline, table-row style
const TRAILING_ROLE_WORDS = ["Promoter", "Director", "Selling", "Chairman", "Secretary"];

// Headers that introduce a comma-separated list of names
const NAME_LIST_HEADERS = [
  "OUR PROMOTERS", "PROMOTERS", "OUR DIRECTORS", "DIRECTORS",
  "BOARD OF DIRECTORS", "KEY MANAGERIAL PERSONNEL",
];

// A run of 2-4 capitalized words. Matches Title Case ("Kushal Hegde") AND
// ALL CAPS ("KUSHAL HEGDE") — a plain [A-Z][a-z]+ pattern would silently
// miss every ALL CAPS occurrence, which this document uses throughout.
const CAP_NAME_RUN = "[A-Z][A-Za-z]*(?:\\s+[A-Z][A-Za-z]*){1,3}";

function containsStopword(value) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .some((w) => NAME_STOPWORDS.has(w));
}

function detectNames(text, existingSpans) {
  const spans = [];
  const tryAdd = (value, start) => {
    if (containsStopword(value)) return;
    const candidate = { type: "NAME", value, start, end: start + value.length };
    if (
      !existingSpans.some((s) => overlaps(s, candidate)) &&
      !spans.some((s) => overlaps(s, candidate))
    ) {
      spans.push(candidate);
    }
  };

  // --- (a) ROLE-FIRST: title word + name ---
  const titlePattern = new RegExp(
    `(?:${NAME_TITLES.map((t) => t.replace(".", "\\.")).join("|")})\\s+(${CAP_NAME_RUN})`,
    "g"
  );
  let match;
  while ((match = titlePattern.exec(text)) !== null) {
    tryAdd(match[1], match.index + match[0].indexOf(match[1]));
  }

  // --- (b) ROLE-FIRST: role cue + name ---
  for (const cue of NAME_ROLE_CUES) {
    const cuePattern = new RegExp(`${cue}\\s*[:\\-]?\\s*(${CAP_NAME_RUN})`, "g");
    while ((match = cuePattern.exec(text)) !== null) {
      tryAdd(match[1], match.index + match[0].lastIndexOf(match[1]));
    }
  }

  // --- (c) NAME-FIRST: name immediately followed by a role word (table rows) ---
  const trailingPattern = new RegExp(
    `(${CAP_NAME_RUN})\\s+(?:${TRAILING_ROLE_WORDS.join("|")})\\b`,
    "g"
  );
  while ((match = trailingPattern.exec(text)) !== null) {
    tryAdd(match[1], match.index);
  }

  // --- (d) NAME-FIRST: comma-separated list after a list header ---
  for (const header of NAME_LIST_HEADERS) {
    const headerPattern = new RegExp(`${header}\\s*:?\\s*([\\s\\S]{0,400})`, "g");
    while ((match = headerPattern.exec(text)) !== null) {
      const listText = match[1];
      const listStart = match.index + match[0].indexOf(listText);
      const items = listText.split(",");
      let cursor = 0;
      const nameOnly = new RegExp(`^${CAP_NAME_RUN}$`);
      for (const item of items) {
        const trimmed = item.trim();
        if (nameOnly.test(trimmed) && !/TRUST|LIMITED|PRIVATE|COMPANY/.test(trimmed)) {
          const itemStart = listStart + cursor + item.indexOf(trimmed);
          tryAdd(trimmed, itemStart);
        } else if (!nameOnly.test(trimmed)) {
          break; // list ended — hit a trust/company entry or unrelated prose
        }
        cursor += item.length + 1;
      }
    }
  }

  return spans;
}

// -----------------------------------------------------------------
// 3. Heuristic: company names
// -----------------------------------------------------------------
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
  // e.g. "Private Limited" alone.
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
//    "Genuine PIN code" = 6 digits immediately preceded by a dash-like
//    character (as in every real address here: "Pune – 410 501"),
//    which avoids false positives on unrelated 6-digit numbers.
// -----------------------------------------------------------------
const ADDRESS_MAX_LEN_WITH_PIN = 600;
const ADDRESS_MAX_LEN_KEYWORDS_ONLY = 300;

function hasGenuinePincode(seg) {
  const regex = new RegExp(PINCODE_PATTERN.source, "g");
  let m;
  while ((m = regex.exec(seg)) !== null) {
    const before = seg.slice(0, m.index);
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
// 5. Known-entity pass (document-level, two-pass redaction)
//    Pass 1 (collectKnownEntities): read-only scan over EVERY block's text,
//    using the context detectors above, to build a confirmed set of real
//    names/companies — including shortened forms of multi-word names
//    (first+last, surname alone), since later mentions of a person often
//    drop the middle name or use just the surname.
//    Pass 2 (detectKnownMatches): re-scan each block and also match exact
//    repeats of those confirmed entities (including shortened forms), even
//    with zero context — this is what catches a name sitting alone in a
//    table cell whose role word ("Promoter") lives in a separate cell the
//    context regexes never see together.
// -----------------------------------------------------------------
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function collectKnownEntities(blockTexts) {
  const names = new Set();
  const companies = new Set();
  for (const text of blockTexts) {
    for (const span of detectAll(text)) {
      if (span.type === "NAME") {
        const value = span.value.trim();
        names.add(value);

        // Also learn shortened forms of a multi-word name, since later
        // mentions in the document often drop the middle name or use just
        // the surname (e.g. "Kushal Subbayya Hegde" -> later referred to
        // as "Kushal Hegde" or just "Hegde"). TRADEOFF: a bare surname
        // carries a small false-positive risk if that exact word appears
        // unrelated to the person elsewhere — acceptable for a specific,
        // uncommon surname; documented in README.
        const words = value.split(/\s+/);
        if (words.length >= 3) {
          names.add(`${words[0]} ${words[words.length - 1]}`); // first + last
          names.add(words[words.length - 1]); // surname alone
        }
      }
      if (span.type === "COMPANY") companies.add(span.value.trim());
    }
  }
  return { names, companies };
}

function detectKnownMatches(text, knownEntities, existingSpans) {
  const spans = [];
  const tryMatch = (values, type) => {
    // Longest first, so "Kushal Subbayya Hegde" matches before bare "Hegde"
    const sorted = [...values].sort((a, b) => b.length - a.length);
    for (const value of sorted) {
      if (!value || value.length < 4) continue;
      const pattern = new RegExp(`\\b${escapeRegex(value)}\\b`, "gi");
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const candidate = { type, value: match[0], start: match.index, end: match.index + match[0].length };
        if (
          !existingSpans.some((s) => overlaps(s, candidate)) &&
          !spans.some((s) => overlaps(s, candidate))
        ) {
          spans.push(candidate);
        }
      }
    }
  };
  if (knownEntities?.names) tryMatch(knownEntities.names, "NAME");
  if (knownEntities?.companies) tryMatch(knownEntities.companies, "COMPANY");
  return spans;
}

// -----------------------------------------------------------------
// Master detector — combines all of the above.
//
// ORDER MATTERS: ADDRESS runs before NAME/COMPANY (address spans are
// whole-segment and would otherwise get rejected by smaller overlapping
// name/company spans). The known-entity pass runs LAST, and only if a
// knownEntities set is explicitly passed in (keeps detectAll usable
// standalone, e.g. during the pass-1 collection scan itself).
// -----------------------------------------------------------------
export function detectAll(text, knownEntities = null) {
  const regexSpans = detectRegexPII(text);
  const addressSpans = detectAddresses(text, regexSpans);
  const nameSpans = detectNames(text, [...regexSpans, ...addressSpans]);
  const companySpans = detectCompanies(text, [...regexSpans, ...addressSpans, ...nameSpans]);

  let all = [...regexSpans, ...addressSpans, ...nameSpans, ...companySpans];

  if (knownEntities) {
    const knownSpans = detectKnownMatches(text, knownEntities, all);
    all = [...all, ...knownSpans];
  }

  all.sort((a, b) => a.start - b.start);
  return all;
}

// -----------------------------------------------------------------
// Apply redaction to a single string, given a shared PIIMapping
// -----------------------------------------------------------------
export function redactText(text, mapping, knownEntities = null) {
  const spans = detectAll(text, knownEntities);
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