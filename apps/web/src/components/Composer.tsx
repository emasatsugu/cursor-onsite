import { useState, type FormEvent, type KeyboardEvent } from "react";

type Props = {
  disabled?: boolean;
  placeholder?: string;
  onSend: (prompt: string) => void | Promise<void>;
};

export function Composer({ disabled, placeholder, onSend }: Props) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  async function submit() {
    const prompt = value.trim();
    if (!prompt || disabled || sending) return;
    setSending(true);
    try {
      await onSend(prompt);
      setValue("");
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          placeholder ?? "Ask the agent to read or edit files…"
        }
        rows={3}
        disabled={disabled || sending}
      />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={disabled || sending || !value.trim()}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
