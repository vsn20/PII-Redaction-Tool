# PII Redaction Tool
**Live demo:** https://pii-redaction-tool-xi.vercel.app/
(Upload a .docx file to redact it directly in the browser — see `app/` and
`app/api/redact/route.js` for the web wrapper around the same detection
logic described below.)
A Node.js command-line tool that reads a `.docx` document, detects personally
identifiable information (PII), and produces a redacted copy with every
detected entity replaced by a realistic **fake** value (via `@faker-js/faker`),
rather than a placeholder like `[REDACTED]`. The same real value always maps
to the same fake value throughout the document (e.g. every occurrence of a
given person's name becomes the same fake name), so the output document stays
internally consistent and readable.

Built and evaluated against a real SEBI Red Herring Prospectus.

## Approach

**Regex + rule-based heuristics — no ML/NER model.** Detection runs in two
layers:

1. **Regex patterns** (high precision, structured PII): `EMAIL`, `PHONE`,
   `SSN`, `CREDIT_CARD`, `IP_ADDRESS`, `DOB`. These match well-defined formats
   and are checked first so looser downstream matches can't swallow them.
2. **Heuristic detectors** (lower precision, free-form PII): `NAME`,
   `COMPANY`, `ADDRESS`. With no offline NER model available, these rely on
   structural cues — title words (`Mr.`/`Dr.`/`Shri`), role cues
   (`Director`, `Contact Person`, `Company Secretary`), company legal
   suffixes (`Limited`, `Pvt`, `LLP`), and a genuine Indian PIN code (a
   6-digit number directly preceded by a dash, e.g. `Pune – 411 045`) as the
   anchor for address blocks.

Detected spans are replaced with `fakeFor(type, value)`, which is backed by a
`Map` shared across the whole document — every unique real value gets one
consistent fake value, logged to `output/redaction-mapping.json` for QA/audit
purposes (kept separate from the deliverable docx, so the redacted file
itself contains no way to reverse the redaction).

### Why regex/heuristics over spaCy/Presidio

This was a scoped 24-hour assignment on a single Indian legal document with
no internet access assumed for model downloads. A rule-based approach is
fully offline, has zero inference latency, and — critically — is
**auditable**: every match is traceable to one specific pattern or heuristic,
which made it possible to iteratively find and fix false positives (see
below) by inspecting exactly *why* something matched. A production system
handling arbitrary documents across many countries/languages would benefit
from Presidio or a fine-tuned NER model instead, at the cost of that
auditability and offline-ability.

## Explicit scope decisions

- **Order/reference/registration numbers are NOT treated as PII.** The
  assignment explicitly allows either choice; this tool does not redact
  standalone numbers like registration numbers, peer-review numbers, or ISIN
  codes, since they don't identify a natural person on their own. Several
  detector iterations were spent specifically *preventing* these from being
  swallowed by the PHONE and ADDRESS regexes (see False Positives below).
- **Ordinary corporate/legal dates are NOT treated as DOB.** A prospectus is
  saturated with board-resolution dates, listing dates, and incorporation
  dates — none of which are a person's birthdate. `DOB` only fires when a
  birth-related cue word (`Date of Birth`, `DOB`, `born on`) appears
  immediately before the date; bare dates elsewhere are left alone.
- **Segment-level redaction for addresses.** When an address is detected, the
  *entire sentence/segment* containing it is replaced, not just the street
  address substring. This means a company name or person's name mentioned in
  the same sentence as an address gets swallowed into the address redaction
  rather than separately tagged — a deliberate precision/simplicity tradeoff
  (see Known Limitations).

## Extending to a new PII type

- **Structured/patterned** (like a passport number): add one regex to
  `PII_PATTERNS` in `config.js`. No other file needs to change.
- **Free-form** (like a job title): add a new heuristic detector function in
  `redactor.js` (following the pattern of `detectNames`/`detectCompanies`)
  and call it from `detectAll()`.

## Known false positives and false negatives

These were found by manually spot-checking `output/redaction-mapping.json`
after each detector run, not just from the formal evaluation set — this
document has far more real-world variety than any hand-built test set can
cover.

**Fixed during development** (documented here because they explain design
decisions still visible in the code):
- Bare dates (board meeting dates, listing dates) were being redacted as
  `DOB` before the cue-word requirement was added — every single early match
  was a false positive.
- 6-digit PIN codes and 9-digit registration numbers were matching the loose
  `PHONE` regex before a digit-count filter (must reduce to exactly 10 digits)
  was added.
- Generic sentences merely mentioning "Pune", "Maharashtra", or "India" were
  triggering `ADDRESS` before the keyword list was narrowed to terms that
  only appear in genuine street-address text (`Road`, `Village`, `Nagar`,
  `Industrial Area`, etc.) rather than general place names.
- `"Our Company"` / `"the Company"` — capitalized defined-term references
  used constantly throughout the prospectus — were matching `COMPANY` before
  a determiner+suffix-only filter was added.
- Template/table labels like `"Selling Shareholder"` and
  `"Identification Number"` were matching `NAME` via the role-cue heuristic
  before a stopword filter was added.

**Remaining, accepted false positives** (documented rather than chased
further, since fixing them risked losing real recall elsewhere):
- A handful of `COMPANY` matches are fragments of a longer real company name,
  broken by a lowercase connector word the capitalization-based regex can't
  cross (e.g. `"india limited"` instead of the full `"...India Private
  Limited"`; `"advisory private limited"` truncated from a longer name).
  Fixing this would require a fundamentally more permissive pattern with its
  own new false-positive risk.
- A few short generic noun phrases that happen to end in a suffix word still
  match `COMPANY` (e.g. `"banking financial company"`, `"practicing
  company"`) — these are single-digit-count occurrences out of 61 total
  matches.

**Known false negative, by design:**
- `NAME` detection only fires on a title word or a specific role cue
  (Director, Promoter, Company Secretary, Contact Person, etc — the roles
  that actually appear in this document type). A name introduced by any
  other phrasing (e.g. "Applicant John Smith") will be missed. This is a
  deliberate precision/recall tradeoff: broadening the cue list to catch
  more phrasings was tried and reliably introduced new false positives from
  unrelated capitalized phrases.

**Known interaction between detectors:**
- Address detection runs on whole segments (sentences), and runs *before*
  name/company detection specifically so that a company or person's name
  mentioned in the same sentence as a real address doesn't cause the address
  detection to be silently dropped (an earlier version had this bug: any
  overlap with a smaller name/company span caused the entire address
  candidate to be rejected). The consequence is that a company name sitting
  inside an address-bearing sentence is redacted as part of the ADDRESS span
  rather than being separately counted as a COMPANY match — it is still
  fully redacted, just categorized differently in the summary counts.

## Evaluation approach

**Test set** (`data/test-set/ground-truth.json`): 7 cases, 18 hand-labeled
entities total across all 9 required PII types. 6 cases are **real excerpts
copied verbatim from the source prospectus** (covering NAME, EMAIL, PHONE,
COMPANY, and ADDRESS as they actually appear in the document); 1 case is
synthetic, covering SSN, credit card number, and IP address — types this
particular legal document does not naturally contain, but which the
assignment requires evaluating.

**Matching rule** (`evaluate.js`): a predicted span counts as a match for a
ground-truth span if they have the same `type` and their character-offset
ranges overlap by at least 50% of the shorter span's length. This tolerates
minor boundary differences (e.g. trailing punctuation) without being so loose
that a near-miss silently counts as correct.

**Metrics computed per type and overall**: Precision (`TP / (TP + FP)`),
Recall (`TP / (TP + FN)`), F1, and an overall "Accuracy" defined as
`TP / (TP + FP + FN)` — true negatives aren't meaningfully defined at the
span level (there's no fixed universe of "non-PII spans" to count against),
so standard accuracy doesn't apply here; this ratio is used as a
single-number summary instead.

Run it with:
```
node evaluate
```
This regenerates `reports/evaluation-report.md`.

## Final evaluation results

*(Full report: `reports/evaluation-report.md`)*

| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| ADDRESS | 2 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| COMPANY | 1 | 0 | 1 | 100.0% | 50.0% | 66.7% |
| CREDIT_CARD | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| DOB | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| EMAIL | 4 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| IP_ADDRESS | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| NAME | 1 | 0 | 1 | 100.0% | 50.0% | 66.7% |
| PHONE | 3 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| SSN | 1 | 0 | 0 | 100.0% | 100.0% | 100.0% |

**Overall: Precision 100.0% · Recall 88.2% · F1 93.8% · Accuracy 88.2%**

Both recall misses are explained above (the COMPANY case is subsumed into a
correctly-redacted ADDRESS span rather than a true miss; the NAME case is a
known, deliberate cue-list scope limitation). 100% precision on the labeled
set reflects several iterative rounds of false-positive hunting against the
*full* document (not just the labeled test cases) — see "Known false
positives" above for the false-positive classes that were found and fixed
along the way.

**Full-document run summary** (`node main.js` against the complete 772-block
prospectus): 265 total PII spans redacted, 157 unique entities mapped —
ADDRESS: 37, COMPANY: 61, EMAIL: 35, NAME: 9, PHONE: 18. (No SSN, credit
card, or IP address instances exist in this document — expected, as those
types don't naturally appear in an Indian securities prospectus.)

## Project structure

pii-redaction-web/
├── app/
│   ├── api/
│   │   └── redact/
│   │       └── route.js      # API route: receives uploaded .docx, runs the
│   │                          # same detection/redaction pipeline, returns
│   │                          # the redacted .docx as a download
│   └── (page.js / layout.js) # Frontend upload UI
├── config.js                 # PII regex patterns, keyword lists, settings
├── redactor.js                # Detection logic + fake-value replacement engine
├── docxHandler.js             # .docx <-> structured blocks <-> redacted .docx
├── main.js                    # CLI entrypoint (still usable directly via `node main.js`)
├── evaluate.js                 # Precision/recall/F1 scorer
├── data/
│   ├── input/                  # Source .docx for CLI runs
│   └── test-set/
│       └── ground-truth.json
├── output/
│   ├── *_REDACTED.docx         # Deliverable (CLI runs)
│   └── redaction-mapping.json  # Real->fake audit log (QA only)
├── reports/
│   └── evaluation-report.md
├── public/                     # Next.js static assets
├── next.config.mjs
├── jsconfig.json
├── package.json
└── README.md
## Usage

```
npm install
node main.js --input data/input/Red_Herring_Prospectus.docx --output output/Red_Herring_Prospectus_REDACTED.docx
node evaluate

### Web app
Visit the live demo, upload a .docx, and download the redacted file directly — no install needed.
Or run locally: `npm run dev`, then open http://localhost:3000
```