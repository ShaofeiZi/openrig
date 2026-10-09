// R1（release-0.4.7）——C1：fetchRead 呈现类型化、可区分的失败。
//
// 共享文件读取器不再抛出不透明的 `new Error("HTTP <status>")`，而是抛出
// `FilesReadError`，以 `code` 携带后台服务的状态区分（absent | read_error | bad_path），
// 同时保持完全相同的 `message` 文本（"HTTP <status>"），这是架构要求的消息兼容锁定项。
// 通过公共 `useFilesRead` 钩子执行验证；react-query 在 `query.error` 上呈现抛出的错误，
// 因此无需新增内部导出。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useFilesRead, FilesReadError } from "../src/hooks/useFiles.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function readErrorFor(status: number): Promise<unknown> {
  fetchSpy.mockImplementation(async () => new Response("x", { status }));
  const { result } = renderHook(() => useFilesRead("ws", "some/file.md"), {
    wrapper: makeWrapper(),
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  return result.current.error;
}

describe("fetchRead typed failure (FilesReadError)", () => {
  it("404 → FilesReadError{code:'absent'} with message byte-same 'HTTP 404'", async () => {
    const err = await readErrorFor(404);
    expect(err).toBeInstanceOf(FilesReadError);
    expect((err as FilesReadError).code).toBe("absent");
    expect((err as FilesReadError).status).toBe(404);
    // 消息兼容锁定项：文本与拆分前的 `new Error("HTTP 404")` 完全一致。
    expect((err as Error).message).toBe("HTTP 404");
    // name 保持为 "Error"，使任何 `${err}` / err.name 渲染逐字节不变。
    expect((err as Error).name).toBe("Error");
  });

  it("500 → FilesReadError{code:'read_error'} (infra, not absence)", async () => {
    const err = await readErrorFor(500);
    expect(err).toBeInstanceOf(FilesReadError);
    expect((err as FilesReadError).code).toBe("read_error");
    expect((err as Error).message).toBe("HTTP 500");
  });

  it("400 → FilesReadError{code:'bad_path'} (the config/path-shape class)", async () => {
    const err = await readErrorFor(400);
    expect(err).toBeInstanceOf(FilesReadError);
    expect((err as FilesReadError).code).toBe("bad_path");
    expect((err as Error).message).toBe("HTTP 400");
  });

  it("a FilesReadError is still an Error (subclass — `read.error as Error` casts stay valid)", async () => {
    const err = await readErrorFor(404);
    expect(err).toBeInstanceOf(Error);
  });
});
