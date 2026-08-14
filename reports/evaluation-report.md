# PII Redaction — Evaluation Report

Generated: 2026-08-14T05:22:01.374Z

Test cases: 7

## Per-type results

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

## Overall

- **Precision:** 100.0%
- **Recall:** 88.2%
- **F1:** 93.8%
- **Accuracy (TP/(TP+FP+FN)):** 88.2%
