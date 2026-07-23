import type { ThreadSummary } from "@poc/shared";

type Props = {
  threads: ThreadSummary[];
  selectedId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onNewThread: () => void;
};

export function ThreadList({
  threads,
  selectedId,
  loading,
  onSelect,
  onNewThread,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="brand">Agent Edit</h1>
        <button type="button" className="btn btn-primary" onClick={onNewThread}>
          New thread
        </button>
      </div>
      <div className="thread-list">
        {loading && threads.length === 0 ? (
          <p className="muted">Loading threads…</p>
        ) : threads.length === 0 ? (
          <p className="muted">No threads yet. Send a prompt to create one.</p>
        ) : (
          threads.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`thread-item${selectedId === t.id ? " active" : ""}`}
              onClick={() => onSelect(t.id)}
            >
              <span className="thread-id">{shortId(t.id)}</span>
              <span className="thread-meta">
                {new Date(t.createdAt).toLocaleString()}
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
