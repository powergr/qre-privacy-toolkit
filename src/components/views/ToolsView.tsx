import { ChevronRight } from "lucide-react";
import { TOOL_GROUPS, toolsInGroup, groupHue } from "../layout/tools";
import "./ToolsView.css";

interface ToolsViewProps {
  setTab: (tab: string) => void;
}

/**
 * Every tool in its group, as large rows. This is the phone's counterpart of the sidebar:
 * the bottom bar only has room for five places, so the rest are listed here.
 */
export function ToolsView({ setTab }: ToolsViewProps) {
  return (
    <div className="tools-view">
      <h2 className="tools-view__title">Tools</h2>
      {TOOL_GROUPS.map((group) => (
        <section key={group.id} className="tools-view__group" aria-labelledby={`tools-group-${group.id}`}>
          <header className="tools-view__head" style={{ ["--hue" as string]: groupHue(group.id) }}>
            <i aria-hidden="true" />
            <h3 id={`tools-group-${group.id}`}>{group.label}</h3>
            <span>{group.blurb}</span>
          </header>
          {toolsInGroup(group.id).map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="tools-view__row"
              style={{ ["--hue" as string]: groupHue(group.id) }}
              onClick={() => setTab(tool.id)}
            >
              <span className="tools-view__icon" aria-hidden="true">
                <tool.Icon size={20} />
              </span>
              <span className="tools-view__text">
                <strong>{tool.label}</strong>
                <small>{tool.desc}</small>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
