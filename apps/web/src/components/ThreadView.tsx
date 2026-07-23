import { useState } from "react";
import type { DisplayItem } from "../lib/display";

type Props = {
  items: DisplayItem[];
  running?: boolean;
  emptyHint?: string;
};

export function ThreadView({ items, running, emptyHint }: Props) {
  if (items.length === 0) {
    return (
      <div className="thread-view empty">
        <p className="muted">
          {emptyHint ?? "Select a thread or start a new one."}
        </p>
      </div>
    );
  }

  return (
    <div className="thread-view">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className="bubble user">
                <div className="bubble-label">You</div>
                <div className="bubble-body">{item.content}</div>
              </div>
            );
          case "assistant":
            return (
              <div key={item.id} className="bubble assistant">
                <div className="bubble-label">
                  Agent{item.streaming ? " · streaming" : ""}
                </div>
                <div className="bubble-body">
                  {item.content || (item.streaming ? "…" : "")}
                </div>
              </div>
            );
          case "tool":
            return <ToolRow key={item.id} item={item} />;
          case "error":
            return (
              <div key={item.id} className="bubble error">
                <div className="bubble-label">Error</div>
                <div className="bubble-body">{item.error}</div>
              </div>
            );
          default:
            return null;
        }
      })}
      {running && (
        <div className="run-status" aria-live="polite">
          Agent is working…
        </div>
      )}
    </div>
  );
}

function ToolRow({
  item,
}: {
  item: Extract<DisplayItem, { kind: "tool" }>;
}) {
  const [open, setOpen] = useState(item.open ?? false);
  const status = item.result != null ? "done" : "running";

  return (
    <div className={`tool-row ${status}`}>
      <button
        type="button"
        className="tool-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-status">{status}</span>
      </button>
      {open && (
        <div className="tool-details">
          <pre className="code-block">
            <code>{prettyJson(item.arguments)}</code>
          </pre>
          {item.result != null && (
            <>
              <div className="tool-result-label">Result</div>
              <pre className="code-block">
                <code>{prettyJson(item.result)}</code>
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
