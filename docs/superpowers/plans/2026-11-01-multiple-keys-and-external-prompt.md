# Multiple API keys and external workbook prompt implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Keep server/key routing, Settings UI and external JSON UI ownership separate.

**Goal:** Rotate explicitly registered encrypted keys and compatible models, diagnose unavailable NVIDIA defaults, and provide a complete copy/paste workbook analysis prompt.

**Architecture:** Add server-only credential slots/model health/quota cooldown tables while preserving legacy encrypted credentials. Metadata discovery intersects documented capabilities with actual returned model IDs. Route by provider mode then rotated key/model candidates, respecting shared quota groups and Retry-After. Keep external/API results on restudy.v1 validation and reviewed storage.

**Stack:** Existing React/TypeScript/Supabase/Deno/Zod.

**Spec:** User's latest message requests multiple keys/models, NVIDIA model error diagnosis, and explicit external PDF → detailed prompt → JSON classification/import.

## Constraints and contracts

- Existing keys/data/history stay intact; no plaintext key storage, output or logs. New UI shows aliases only.
- Same Gemini project does not gain quota from more keys. Default quota group is shared; propagate provider-indicated group/model cooldowns.
- Paid access stays disabled unless user enables it. Free eligibility is documented capability plus user account confirmation, never a quota guarantee.
- Status providers[].credentials includes safe id/label/access/enabled/status/models/selectedModels/quotaGroup and health flags. Empty selectedModels excludes that key from generation.
- credential.save without credentialId adds a key; with ID replaces only that owner key. Failed replacement preserves an existing working key. toggle/check/discover/delete target the owner credentialId.
- New failed connection can be stored encrypted with error status, without claiming connected. Public NVIDIA metadata does not authenticate a key. Minimal inference verifies NIM access only after free-account or paid confirmation.
- External prompt includes actual document/job IDs, PDF page mapping, targets, per-part quotas and the entire schema. Problem mapping is separate from crop extraction and binds after originals are registered.

## Tasks

- [x] Diagnose live NVIDIA catalog/default mismatch and per-model output token caps using primary sources.
- [x] Add migration and owner/service-only tests; preserve/copy legacy slots without deleting old keys.
- [x] Implement slot CRUD/discovery, safe diagnostics, quota groups and rotating compatible key/model routing with regression tests.
- [x] Extend Settings with multiple named keys, model selection, health and quota-group controls.
- [x] Extend workbook external analysis task and detailed copy/paste prompt with schema/ref tests.
- [x] Run full tests/type/build/Deno and actual configured-key checks without logging secrets or seeding user content.
- [x] Apply additive migration and deploy the authorized existing functions; publish checked source and verify Pages.

## Evidence so far

The live unauthenticated NIM model list omits meta/llama-3.3-70b-instruct although its older infer docs remain online. The old error mapping also mislabeled all non-auth 4xx as model unavailable. The old 16384-token request exceeded legacy Llama's documented4096 limit. Correct these causes separately; do not blame a key based on public metadata.

## Live findings and remaining verification

The original Gemini 3.8 requests timed out at about 40 seconds and saved zero questions. Real retry diagnostics also showed HTTP 400 from 3.6/3.5; the provider returned no specific rejected field. Treat the issue as unresolved until actual generation and persistence succeed; metadata discovery is not generation verification.

API units now use at most 3 source pages and 5 questions, prepare only the requested part, retain safe per-model attempts, and show stored-response counts separately from registered bank counts. Detailed conditional JSON schemas remain enforced by the application; Gemini restudy requests use JSON output mode with the complete contract in the prompt to avoid provider schema complexity. A provider budget reserves time for an alternative eligible provider.

The user subsequently registered NVIDIA and additional Gemini slots directly. Do not request or expose their values. Shared quota cooldowns remain enforced across keys; format-error health was reset only after the corresponding request fix, never to bypass a rate-limit response.

Unified external preparation includes original analyses, concepts, quizzes, practice/similar banks and flashcards. Both material and wrong-answer workspaces offer the same persistent API result panel. Content remains review-required.

The duplicated 21,694-character API prompt was replaced with a compact manifest/contract/source prompt (14,471 characters for the same real first split). API requests use JSON mode and application-side validation; external copy prompts retain the full detailed schema. Resumed-job polling now initializes its active ID after reload. Each model has a bounded wait within a 110-second router budget, below the two-minute DB lease and the documented free Edge Function wall-clock limit.

## Confirmed generation and persistence repair

Gemini 3.6 returned a valid source-based question in 4 seconds, but saving rejected the unchanged existing chapter because JSON.stringify compared property insertion order against PostgreSQL jsonb key order. A regression reproduced both chapter and concept false conflicts. Canonical object comparison fixes identity while preserving real content-conflict checks. Existing unchanged content-part hashes are retained for backward-compatible reimport. The preserved provider result was replayed without another generation call and stored successfully; a subsequent fresh split also generated and stored a second question and flashcard in review-required state. The live job now has 2/4 splits stored and 2 bank questions. NVIDIA has passed its minimal connection probe; longer generation still showed timeouts/one unavailable model and falls back to Gemini. Do not claim all NVIDIA models generated successfully.
