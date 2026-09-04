import { T } from '../constants';

export function Toast({ message }) {
  if (!message) return null;
  return (
    <div
      className="ws-rise"
      style={{
        position: 'fixed', left: '50%', bottom: 84, transform: 'translateX(-50%)',
        background: T.elevated, border: '1px solid rgba(145,132,217,.5)',
        borderRadius: 20, padding: '10px 16px', fontSize: 13, fontWeight: 500,
        color: T.accentLight, boxShadow: '0 8px 24px rgba(0,0,0,.6)', zIndex: 50,
        whiteSpace: 'nowrap',
      }}
    >
      {message}
    </div>
  );
}

export function EmptyState({ title, body, action }) {
  return (
    <div style={{ padding: '44px 22px', textAlign: 'center', border: '1px dashed rgba(233,233,237,.14)', borderRadius: 8 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 5 }}>{title}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.55, color: T.textSecondary, marginBottom: action ? 16 : 0 }}>{body}</div>
      {action}
    </div>
  );
}

export function OutlineButton({ children, onClick, icon, disabled, style }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        width: '100%', padding: 15, borderRadius: 8, border: `1px solid ${T.accent}`,
        background: 'transparent', color: T.accent, fontSize: 15, fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {icon && <i className={`ph ${icon}`} style={{ fontSize: 17 }} />}
      {children}
    </button>
  );
}

export function FilledButton({ children, onClick, disabled, style }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', padding: 15, borderRadius: 8, border: 'none',
        background: 'rgba(145,132,217,.2)', color: T.accentLight, fontSize: 15, fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function SegmentedTabs({ options }) {
  // options: [{ name, pick, edge, bg, tone }]
  return (
    <div style={{ display: 'flex', gap: 8, padding: 4, background: T.card, border: '1px solid rgba(233,233,237,.1)', borderRadius: 8, marginBottom: 16 }}>
      {options.map((v, i) => (
        <button
          key={i}
          onClick={v.pick}
          style={{
            flex: 1, padding: '14px 4px', borderRadius: 6, border: `1px solid ${v.edge}`,
            background: v.bg, color: v.tone, fontSize: 12, lineHeight: 1.25, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {v.name}
        </button>
      ))}
    </div>
  );
}

export function FieldLabel({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 500, color: T.textMuted, marginBottom: 6 }}>{children}</div>;
}

export const inputStyle = {
  width: '100%', padding: '13px 14px', borderRadius: 8, border: '1px solid rgba(233,233,237,.16)',
  background: T.card, color: T.text, fontSize: 15, outline: 'none',
};

export function ErrorText({ children }) {
  if (!children) return null;
  return <div style={{ fontSize: 12.5, color: T.danger, marginTop: -6, marginBottom: 12 }}>{children}</div>;
}
