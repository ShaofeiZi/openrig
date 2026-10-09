// OPR.0.4.6.MH1 FR-5——仪表盘主机配置组件：一份注册表服务两个表面，一份选择存储服务
// 两个表面，空状态如实呈现，重命名走设置写入路径（FR-4）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HostConfigCard } from "../src/components/dashboard/HostConfigCard.js";

const mutateAsync = vi.fn(async () => ({}));

let settingsData: Record<string, { value: unknown }> = {};
let hostsData: { ownName: string; selected: string; hosts: unknown[] } = { ownName: "localhost", selected: "local", hosts: [] };

vi.mock("../src/hooks/useSettings.js", () => ({
  useSettings: () => ({ data: { settings: settingsData } }),
  useSetSetting: () => ({ mutateAsync }),
}));

vi.mock("../src/hooks/useHosts.js", () => ({
  useHosts: () => ({ data: hostsData, error: null }),
  usePairHost: () => ({ mutateAsync: vi.fn(), data: undefined, error: null, isPending: false, reset: vi.fn() }),
  usePairPoll: () => ({ data: undefined }),
}));

describe("HostConfigCard (OPR.0.4.6.MH1 FR-5)", () => {
  beforeEach(() => {
    mutateAsync.mockClear();
    settingsData = {};
    hostsData = { ownName: "localhost", selected: "local", hosts: [] };
  });

  // 本项目 Vitest 设置未启用 RTL 自动清理（无测试全局）；若不清理，容器会累积，
  // 每次渲染都存在的 testid（host-own-name）会在第二次查询时触发多重匹配。
  afterEach(() => cleanup());

  it("zero added hosts: own-host card + honest empty state + the add affordance (never blank)", () => {
    render(<HostConfigCard />);
    expect(screen.getByTestId("host-own-name").textContent).toBe("localhost");
    expect(screen.getByTestId("host-config-empty")).toBeTruthy();
    expect(screen.getByTestId("host-pair-input")).toBeTruthy();
    expect(screen.getByTestId("host-selected-marker-local")).toBeTruthy();
  });

  it("renders registry rows with address, transport, status and the selected marker", () => {
    settingsData = { "host.selected": { value: "vps-a" } };
    hostsData = {
      ownName: "localhost",
      selected: "vps-a",
      hosts: [
        { id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: true, status: "reachable" },
        { id: "vm-b", transport: "ssh", target: "vm-b.local", selected: false, status: "unreachable" },
      ],
    };
    render(<HostConfigCard />);
    const rows = screen.getByTestId("host-config-rows");
    expect(rows.textContent).toContain("vps-a");
    expect(rows.textContent).toContain("http://vps-a:7433");
    expect(rows.textContent).toContain("vm-b.local");
    expect(rows.textContent).toContain("unreachable");
    expect(screen.getByTestId("host-selected-marker-vps-a")).toBeTruthy();
    // 选择横幅如实呈现非本地状态（FR-5 处置：显示指针与选择结果，不重定向 UI 数据）。
    expect(screen.getByTestId("host-selection-banner").textContent).toContain("vps-a");
  });

  it("the switcher writes host.selected through the ONE settings store", () => {
    hostsData = {
      ownName: "localhost",
      selected: "local",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: false, status: "reachable" }],
    };
    render(<HostConfigCard />);
    fireEvent.click(screen.getByTestId("host-select-vps-a"));
    expect(mutateAsync).toHaveBeenCalledWith({ key: "host.selected", value: "vps-a" });
  });

  it("rename writes host.name through the settings store (FR-4, one stored name)", () => {
    settingsData = { "host.name": { value: "Mac mini 2" } };
    render(<HostConfigCard />);
    expect(screen.getByTestId("host-own-name").textContent).toBe("Mac mini 2");
    fireEvent.click(screen.getByTestId("host-rename-button"));
    const input = screen.getByTestId("host-rename-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Studio M4" } });
    fireEvent.submit(input.closest("form")!);
    expect(mutateAsync).toHaveBeenCalledWith({ key: "host.name", value: "Studio M4" });
  });
});
