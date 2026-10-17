import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ToolsView } from "./ToolsView";
import { TOOLS, TOOL_GROUPS, toolsInGroup } from "../layout/tools";

describe("ToolsView", () => {
  it("lists the four groups with what each is for", () => {
    render(<ToolsView setTab={() => {}} />);
    const groups = screen.getAllByRole("region");
    expect(groups.map((g) => g.querySelector("h3")!.textContent)).toEqual(TOOL_GROUPS.map((g) => g.label));
    for (const g of TOOL_GROUPS) expect(screen.getByText(g.blurb)).toBeInTheDocument();
  });

  it("puts every tool under its own group, in the sidebar's order", () => {
    render(<ToolsView setTab={() => {}} />);
    for (const group of TOOL_GROUPS) {
      const region = screen.getByRole("region", { name: group.label });
      const names = Array.from(region.querySelectorAll("button strong")).map((s) => s.textContent);
      expect(names).toEqual(toolsInGroup(group.id).map((t) => t.label));
    }
  });

  it("shows all twelve tools, each with its one-line description", () => {
    render(<ToolsView setTab={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(TOOLS.length);
    for (const t of TOOLS) {
      const row = screen.getByText(t.label, { selector: "strong" }).closest("button")!;
      expect(within(row).getByText(t.desc)).toBeInTheDocument();
    }
  });

  it("opens the tool that was pressed", () => {
    const setTab = jest.fn();
    render(<ToolsView setTab={setTab} />);
    fireEvent.click(screen.getByText("Shredder", { selector: "strong" }));
    expect(setTab).toHaveBeenCalledWith("shred");
    expect(setTab).toHaveBeenCalledTimes(1);
  });
});
