import { expect, test } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ApiPreparationStatus from "../src/components/ApiPreparationStatus";

test("a new request error remains visible alongside previously saved counts", () => {
  const html = renderToStaticMarkup(
    <ApiPreparationStatus
      error="새 작업 생성 실패"
      job={{
        apiJobs: [{ status: "completed" }],
        apiStatus: { state: "completed" },
        preparedQuestions: 2,
        preparedFlashcards: 3,
      }}
    />,
  );
  expect(html).not.toContain("학습 자료가 준비됐어요");
  expect(html).toContain("새 작업 생성 실패");
  expect(html).toContain('role="alert"');
  expect(html).toContain("문제 <strong>2</strong>");
  expect(html).toContain("암기 카드 <strong>3</strong>");
});

test("a saved job without a new error is ready for immediate study", () => {
  const html = renderToStaticMarkup(
    <ApiPreparationStatus
      job={{
        apiJobs: [{ status: "completed" }],
        apiStatus: { state: "completed" },
        preparedQuestions: 2,
      }}
    />,
  );
  expect(html).toContain("학습 자료가 준비됐어요");
  expect(html).not.toContain('role="alert"');
});

test("paused API attempts show failure and HTTP status without claiming saved content", () => {
  const html = renderToStaticMarkup(
    <ApiPreparationStatus
      job={{
        apiJobs: [{ status: "paused" }],
        apiStatus: { state: "paused", message: "다시 시도할 수 있습니다." },
        apiAttempts: [
          {
            model: "gemma-4-31b-it",
            success: false,
            http_status: 503,
            duration_ms: 56200,
            error: "provider_error",
            at: "2026-11-03T10:00:00Z",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("준비가 멈췄어요");
  expect(html).toContain("Gemma 4 · 31B");
  expect(html).toContain("56초");
  expect(html).toContain("HTTP 503");
  expect(html).not.toContain("응답을 확인하고 저장");
  expect(html).toContain('<details class="api-history">');
});

test("request diagnostics explain the rejected field category without displaying arbitrary provider values", () => {
  const job = {
    apiJobs: [{ status: "paused" }],
    apiStatus: { state: "paused" },
    apiAttempts: [
      {
        success: false,
        error: "request_invalid",
        diagnostic: "image_base64_invalid",
      },
      {
        success: false,
        error: "request_invalid",
        diagnostic: "private-upstream-value",
      },
    ],
  };
  const html = renderToStaticMarkup(<ApiPreparationStatus job={job} />);
  expect(html).toContain("Base64 형식이 올바르지 않습니다");
  expect(html).not.toContain("private-upstream-value");
});
