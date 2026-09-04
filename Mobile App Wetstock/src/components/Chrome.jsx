import { T } from '../constants';

export function Header({ roleLabel, isAdmin, canTogglePreview, hasActive, activeLabel, onActivePill, onRoleToggle, onSignOut }) {
  return (
    <div style={{
      padding: 'calc(env(safe-area-inset-top) + 12px) 16px 12px', display: 'flex',
      alignItems: 'center', justifyContent: 'space-between', gap: 10,
      background: T.chrome, borderBottom: '1px solid rgba(233,233,237,.09)', zIndex: 5, flex: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: T.accent, boxShadow: '0 0 10px rgba(145,132,217,.8)', flex: 'none' }} />
        <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-.01em' }}>Wetstock</span>
        <span style={{
          fontSize: 10, fontWeight: 500, letterSpacing: '.06em', textTransform: 'uppercase',
          color: T.textMuted, paddingLeft: 6, borderLeft: '1px solid rgba(233,233,237,.12)',
        }}>{roleLabel}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
        {hasActive && (
          <div onClick={onActivePill} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 11px', borderRadius: 20,
            border: '1px solid rgba(145,132,217,.45)', background: 'rgba(145,132,217,.10)',
            fontSize: 11, color: T.accentLight, cursor: 'pointer', maxWidth: 140,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.accent, flex: 'none' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeLabel}</span>
          </div>
        )}
        {canTogglePreview && (
          <button onClick={onRoleToggle} title={isAdmin ? 'Preview staff view' : 'Back to manager view'} style={{
            width: 44, height: 44, borderRadius: 10,
            border: `1px solid ${isAdmin ? 'rgba(233,233,237,.16)' : 'rgba(145,132,217,.5)'}`,
            background: 'transparent', color: isAdmin ? T.textSecondary : T.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 17,
          }}>
            <i className={`ph ${isAdmin ? 'ph-eye' : 'ph-arrow-u-up-left'}`} />
          </button>
        )}
        <button onClick={onSignOut} title="Sign out" style={{
          width: 44, height: 44, borderRadius: 10, border: '1px solid rgba(233,233,237,.16)',
          background: 'transparent', color: T.textSecondary,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 17,
        }}>
          <i className="ph ph-sign-out" />
        </button>
      </div>
    </div>
  );
}

export function Banner({ text, onDismiss }) {
  if (!text) return null;
  return (
    <div style={{
      padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      background: 'rgba(216,162,79,.10)', borderBottom: '1px solid rgba(216,162,79,.35)',
      fontSize: 12, lineHeight: 1.45, color: T.warn, flex: 'none',
    }}>
      <span>{text}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 20, lineHeight: 1, cursor: 'pointer', flex: 'none', padding: '0 4px' }}>×</button>
    </div>
  );
}

export function TabBar({ tabs }) {
  return (
    <div style={{
      background: T.chrome, borderTop: '1px solid rgba(233,233,237,.09)', flex: 'none',
      display: 'grid', gridTemplateColumns: 'repeat(6,1fr)',
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {tabs.map((t, i) => (
        <button key={i} onClick={t.go} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: '9px 2px 8px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, color: t.tone,
        }}>
          <i className={`ph ${t.icon}`} style={{ fontSize: 21 }} />
          <span style={{ fontSize: 10, fontWeight: 500, lineHeight: 1 }}>{t.label}</span>
        </button>
      ))}
    </div>
  );
}
