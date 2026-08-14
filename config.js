/**
 * config.js
 * Central place for all PII detection patterns and settings.
 * To add a new PII type: add one entry to PII_PATTERNS (or extend the
 * NAME/COMPANY heuristics in redactor.js). This is the main extension
 * point referenced in the README.
 */

// -----------------------------------------------------------------
// 1. REGEX-BASED PATTERNS (high precision, structured PII)
//    Order matters when spans could overlap — more specific patterns
//    are checked first (handled in redactor.js).
// -----------------------------------------------------------------
export const PII_PATTERNS = {
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  // Indian mobile (+91, optional spaces/hyphens) and generic
  // landline-style numbers e.g. "020 6652 3600"
  // NOTE: this regex is intentionally loose (catches PIN codes, reference
  // numbers, etc). redactor.js applies a digit-count filter (must reduce
  // to exactly 10 digits after stripping a leading "91") to keep only
  // phone-shaped matches. See detectRegexPII().
  PHONE: /(?:\+?91[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}\b/g,

  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,

  // 13-16 digit credit card, optionally grouped with spaces/hyphens
  CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/g,

  IP_ADDRESS: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,

  // DOB: only matches dates preceded by a birth-related cue within the
  // match itself, e.g. "Date of Birth: 10/12/1990" or "born on 10 December
  // 1990". Bare dates elsewhere (board meeting dates, listing dates, etc.)
  // are treated as ordinary corporate/document dates, NOT PII — a Red
  // Herring Prospectus is expected to contain many such dates, and
  // redacting all of them would be over-redaction. Capture group 1 is the
  // date itself; redactor.js uses group 1, not the whole match, so the
  // cue word ("Date of Birth:") is left in the output text.
  DOB: /(?:date of birth|d\.?o\.?b\.?|born on|born)\s*[:\-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi,
};

// -----------------------------------------------------------------
// 2. ADDRESS CUES — used by a heuristic block-matcher in redactor.js
//    (addresses in the prospectus span multiple lines/table cells)
// -----------------------------------------------------------------
export const ADDRESS_KEYWORDS = [
  "Road", "Street", "Village", "Taluka", "Farms", "Tower",
  "Business Centre", "Nagar", "Colony", "Industrial Area",
];
export const PINCODE_PATTERN = /\b\d{3}\s?\d{3}\b/g; // Indian PIN, e.g. "410 501"

// -----------------------------------------------------------------
// 3. NAME / COMPANY DETECTION SETTINGS
//    (see redactor.js for the heuristic + gazetteer approach)
// -----------------------------------------------------------------
export const NAME_TITLES = ["Mr.", "Mrs.", "Ms.", "Dr.", "Shri", "Smt."];
export const COMPANY_SUFFIXES = [
  "Limited", "Ltd", "Ltd.", "LLP", "Pvt", "Private", "Inc", "Inc.",
  "Corporation", "Corp", "Company",
];
// -----------------------------------------------------------------
// 3b. STOPWORDS — words that disqualify a NAME/COMPANY candidate.
//     Prospectuses use capitalized template/placeholder labels
//     ("Selling Shareholder", "Identification Number") and defined
//     terms ("Our Company", "the Company") that superficially match
//     the name/company heuristics but aren't actual PII.
// -----------------------------------------------------------------
export const NAME_STOPWORDS = new Set([
  "shareholder", "shareholders", "selling", "identification", "number",
  "website", "registration", "promoter", "director", "registrar",
  "auditor", "secretary", "signature", "signatory",
]);

export const COMPANY_DETERMINERS = ["our", "the", "such", "said", "this", "that", "any", "every"];

// -----------------------------------------------------------------
// 4. OUTPUT / RUN SETTINGS
// -----------------------------------------------------------------
export const RANDOM_SEED = 42; // for reproducible fake-value generation
export const MAPPING_LOG_PATH = "output/redaction-mapping.json"; // real → fake log (QA only)