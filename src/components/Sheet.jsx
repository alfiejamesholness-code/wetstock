import { T } from '../constants';

export function Sheet({ title, onClose, onBackdrop, children }) {
  return (
    <div
      onClick={onBackdrop}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(10,11,18,.72)',
        display: 'flex', alignItems: 'flex-end', zIndex: 40,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ws-rise"
        style={{
          width: '100%', maxHeight: '88%', overflow: 'auto', background: T.chrome,
          borderTopLeftRadius: 14, borderTopRightRadius: 14,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
      >
        <div style={{
          position: 'sticky', top: 0, background: T.chrome, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '18px 16px 12px', zIndex: 1,
        }}>
          <div style={{ fontSize: 19, fontWeight: 500 }}>{title}</div>
          <button onClick={onClose} style={{
            width: 36, height: 36, borderRadius: 8, border: 'none', background: 'rgba(233,233,237,.08)',
            color: T.text, fontSize: 18, cursor: 'pointer',
          }}>×</button>
        </div>
        <div style={{ padding: '4px 16px 8px' }}>{children}</div>
      </div>
    </div>
  );
}
