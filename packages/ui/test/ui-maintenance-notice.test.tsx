import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/routes.js", () => ({ router: {} }));

import {
  UI_MAINTENANCE_NOTICE_STORAGE_KEY,
  UiMaintenanceNotice,
} from "../src/App.js";

describe("UI maintenance notice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(cleanup);

  it("shows the supported-interface posture on first load", () => {
    render(<UiMaintenanceNotice />);

    expect(screen.getByTestId("ui-maintenance-notice").textContent).toContain(
      "目前处于维护模式",
    );
    expect(screen.getByTestId("ui-maintenance-notice").textContent).toContain(
      "CLI）才是官方主推的使用界面",
    );
  });

  it("dismisses without reserving layout space and stays dismissed after remount", () => {
    const first = render(<UiMaintenanceNotice />);
    const notice = screen.getByTestId("ui-maintenance-notice");

    expect(notice.className).toContain("fixed");
    fireEvent.click(screen.getByRole("button", { name: "关闭维护提示" }));

    expect(screen.queryByTestId("ui-maintenance-notice")).toBeNull();
    expect(localStorage.getItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY)).toBe("1");

    first.unmount();
    render(<UiMaintenanceNotice />);
    expect(screen.queryByTestId("ui-maintenance-notice")).toBeNull();
  });
});
