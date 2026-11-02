# Local PDF recognition correction and structure indexing

User's November 2 specification supersedes automatic API preparation after upload.
Keep login, learning/history, external restudy.v1 import and explicit AI actions.

## Confirmed defects

- Same uploaded textbook hash reproduced malformed UTF-16 on page 13; repaired before jsonb persistence. All 48 physical-page texts accepted by PostgreSQL locally. Production selected 46 pages completed.
- save_problem_regions had ambiguous JSON-minus precedence; additive migration applied and real authenticated RPC regression passed. Production workbook 55 pages completed.
- Recognition still wrong: workbook true markers are large standalone 3-digit numbers above the question stem; old code required same-line prose and accepted numbered historical passages instead. Actual page 56 true markers 270–275 were missed while 1/2/3/4 inside documents became candidates.
- Automatic prepareInitialContent runs external AI after CPU processing. Remove its automatic trigger for the new specification.

## Implementation and verification

- [x] Conservative marker/stem/style/column/sequence evidence, circled/leading-zero/explicit patterns, header/footer and choice suppression.
- [x] Validate real stored OCR coordinates against visually inspected workbook pages 50,54,55,56,57,60. Private fixtures stay in test-results only.
- [x] Retire only unmatched unconfirmed automatic candidates, preserving IDs, regions and histories; never delete manual/confirmed/history-linked originals.
- [x] Store OCR words/blocks and source/confidence normalized bbox plus structured document index separately from restudy.v1.
- [x] Parse/edit local TOC, retain printed-vs-physical page mapping and existing content/chapter IDs.
- [x] Expose page retry, cached reindex and existing region editor merge/split controls without loading management tools into ordinary study.
- [x] Local processing checkpoints and IndexedDB state; no external AI imports/calls in OCR/upload/outline pipeline.
- [x] Regression tests, production build, deployed service checks, actual workbook reindex and crop visual verification.

## Verified on November 2

- Full selected ranges completed in production: workbook 55 pages and textbook 46 pages. Raw originals, page checkpoints, old crops and learning IDs remain preserved.
- Production reindex v3: visually verified pages 50/54/55/56/57/60 have exactly 0/4/4/6/4/4 candidates (22 original numbers). Overlapping 2974/2975/270 false markers were retired without deleting rows.
- Real Korean scanned workbook coordinates and native textbook text were used; private PDFs and fixtures remain ignored under test-results.
- 181 Vitest regressions passed; final feedback/routing refinements have additional focused verification; typecheck, build and Deno checks passed. Do not claim every math/table/multipage layout has been validated on a real source: those cases currently include synthetic fixtures.
- Manual merge/split RPC migration applied; SQL rollback/history preservation and region geometry tests passed. Manual user content was not edited for testing.
- Local OCR/number mask/TOC/index paths do not call external AI. AI-generated learning content is a separate explicit action.

## Added review flow correction

Saved OCR crops can be solved before management confirmation; the review flag is preserved. On explicit answer check the session's original answer is revealed together with prepared concept data, memory notes, reviewed banks and related originals. Stored similarity and shared-concept overlap are labeled separately. Missing concept/answer data remain missing. Test sessions must not grade user answers or fabricate history.

Production review UI: the user-registered 381 original opened from Home → Review. Answer check revealed the review panel without grading or altering wrong-answer history. This original has zero concept mappings; its missing content is reported honestly.
