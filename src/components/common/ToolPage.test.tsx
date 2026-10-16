import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ToolPage, ToolScroll, ToolTabs } from "./ToolPage";

const body = () => screen.getByText("content").parentElement as HTMLElement;

describe("ToolPage", () => {
  it("shows the title as a heading with the subtitle under it", () => {
    render(
      <ToolPage title="My Tool" subtitle="Does a thing.">
        <span>content</span>
      </ToolPage>,
    );
    expect(screen.getByRole("heading", { name: "My Tool" })).toBeInTheDocument();
    expect(screen.getByText("Does a thing.")).toBeInTheDocument();
  });

  it("puts the header before the tabs and the tabs before the content", () => {
    render(
      <ToolPage title="My Tool" subtitle="Sub" tabs={<ToolTabs><button>Tab A</button></ToolTabs>}>
        <span>content</span>
      </ToolPage>,
    );
    const order = [
      screen.getByRole("heading", { name: "My Tool" }),
      screen.getByRole("button", { name: "Tab A" }),
      screen.getByText("content"),
    ];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts the content at the top by default", () => {
    render(
      <ToolPage title="T" subtitle="S">
        <span>content</span>
      </ToolPage>,
    );
    expect(body().style.justifyContent).toBe("flex-start");
  });

  it("centres the content when asked, and never moves the header", () => {
    render(
      <ToolPage title="T" subtitle="S" centered>
        <span>content</span>
      </ToolPage>,
    );
    expect(body().style.justifyContent).toBe("center");
    const header = screen.getByRole("heading", { name: "T" }).parentElement as HTMLElement;
    expect(header.parentElement!.firstElementChild).toBe(header);
  });

  it("renders a footer outside the scrolling area", () => {
    render(
      <ToolPage title="T" subtitle="S" footer={<button>Footer action</button>}>
        <span>content</span>
      </ToolPage>,
    );
    const footer = screen.getByRole("button", { name: "Footer action" });
    const scroller = body().parentElement as HTMLElement;
    expect(scroller.contains(footer)).toBe(false);
    expect(scroller.style.overflowY).toBe("auto");
  });
});

describe("ToolScroll", () => {
  it("gives every tool the same padding", () => {
    render(
      <ToolScroll title="T" subtitle="S">
        <span>content</span>
      </ToolScroll>,
    );
    expect((body().parentElement as HTMLElement).style.padding).toBe("30px");
  });
});
