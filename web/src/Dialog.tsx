import { useEffect, useRef, useState, type ReactNode } from "react";

// 站内弹窗：替代 window.prompt / confirm / alert。
// 原生弹窗在移动端会被浏览器接管、样式不可控，prompt 还只能填一个字段。

export type Field = {
  name: string;
  label: string;
  placeholder?: string;
  value?: string;
  /** 多行输入（如粘贴链接） */
  textarea?: boolean;
  required?: boolean;
};

export type DialogState =
  | null
  | {
      kind: "form";
      title: string;
      desc?: string;
      fields: Field[];
      confirmText?: string;
      onSubmit: (values: Record<string, string>) => void | Promise<void>;
    }
  | {
      kind: "confirm";
      title: string;
      desc?: string;
      danger?: boolean;
      confirmText?: string;
      onConfirm: () => void | Promise<void>;
    }
  | {
      kind: "alert";
      title: string;
      desc?: string;
      /** 可复制的长文本，如直链 */
      copyText?: string;
    };

export function Modal({ state, onClose }: { state: DialogState; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // 每次打开都重置表单，并把焦点放到第一个输入框
  useEffect(() => {
    if (!state) return;
    if (state.kind === "form") {
      setValues(Object.fromEntries(state.fields.map((f) => [f.name, f.value ?? ""])));
    }
    const t = setTimeout(() => firstRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  if (!state) return null;

  const submit = async () => {
    if (state.kind !== "form") return;
    const missing = state.fields.find((f) => f.required && !values[f.name]?.trim());
    if (missing) return;
    setBusy(true);
    try {
      await state.onSubmit(values);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{state.title}</h3>
        {state.desc && <p className="modal-desc">{state.desc}</p>}

        {state.kind === "form" &&
          state.fields.map((f, i) => (
            <label key={f.name} className="modal-field">
              <span>{f.label}</span>
              {f.textarea ? (
                <textarea
                  ref={i === 0 ? (el) => void (firstRef.current = el) : undefined}
                  value={values[f.name] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  rows={3}
                />
              ) : (
                <input
                  ref={i === 0 ? (el) => void (firstRef.current = el) : undefined}
                  value={values[f.name] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                />
              )}
            </label>
          ))}

        {state.kind === "alert" && state.copyText && (
          <textarea className="modal-copy" readOnly value={state.copyText} rows={3} />
        )}

        <div className="modal-ops">
          {state.kind !== "alert" && (
            <button onClick={onClose} disabled={busy}>
              取消
            </button>
          )}
          {state.kind === "form" && (
            <button className="primary" onClick={submit} disabled={busy}>
              {busy ? "处理中…" : state.confirmText ?? "确定"}
            </button>
          )}
          {state.kind === "confirm" && (
            <button
              className={state.danger ? "danger" : "primary"}
              onClick={async () => {
                setBusy(true);
                try {
                  await state.onConfirm();
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              {busy ? "处理中…" : state.confirmText ?? "确定"}
            </button>
          )}
          {state.kind === "alert" && (
            <button className="primary" onClick={onClose}>
              知道了
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// 轻提示：右下角浮出，几秒后自动消失。用于「已复制」这类不需要打断的操作。
export type Toast = { id: number; text: string; tone: "ok" | "err" };

export function Toasts({ items }: { items: Toast[] }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
