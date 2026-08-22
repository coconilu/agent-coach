// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDashboard } from "./api";
import { App } from "./App";
import { demoData } from "./demo-data";
import type { DashboardData } from "./types";

vi.mock("./api", () => ({
  loadDashboard: vi.fn(),
  applyCandidate: vi.fn(),
  previewCandidate: vi.fn(),
  privacyAction: vi.fn(),
  saveSettings: vi.fn(),
}));

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function clickNav(label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>("nav button")]
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing navigation button: ${label}`);
  button.click();
}

describe("empty first-run dashboard", () => {
  it("keeps integration and privacy controls reachable without any trace", async () => {
    const emptyData: DashboardData = {
      ...demoData,
      demo: false,
      traces: [],
      memories: [],
      candidates: [],
      pending_count: 0,
      counts: { preference: 0, fact: 0, experience: 0, procedure: 0 },
    };
    vi.mocked(loadDashboard).mockResolvedValue(emptyData);
    const container = document.createElement("div");
    container.id = "root";
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    expect(document.querySelector("main")?.textContent).toContain("还没有辅导 Trace");

    await act(async () => clickNav("隐私设置"));
    expect(document.querySelector("main")?.textContent).toContain("默认不保存原始 Prompt");
    expect(document.querySelector("main")?.textContent).toContain("重置本地状态");
    expect(document.querySelector("main")?.textContent).not.toContain("还没有辅导 Trace");

    await act(async () => clickNav("集成"));
    expect(document.querySelector("main")?.textContent).toContain("检测到");
    expect(document.querySelector("main")?.textContent).toContain("Kimi Code");
    expect(document.querySelector("main")?.textContent).not.toContain("还没有辅导 Trace");
  });
});
