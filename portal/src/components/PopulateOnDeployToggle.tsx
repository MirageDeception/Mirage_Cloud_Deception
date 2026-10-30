import React from 'react';
import { FileText } from 'lucide-react';

interface Props {
  populateOnDeploy: boolean;
  onChange: (value: boolean) => void;
}

export function PopulateOnDeployToggle({ populateOnDeploy, onChange }: Props) {
  return (
    <div className="glass-panel" style={{
      padding: '1rem',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '1.5rem',
      borderLeft: populateOnDeploy ? '4px solid var(--accent-red)' : '4px solid transparent',
      transition: 'all 0.3s ease'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <div style={{ background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '8px' }}>
          <FileText size={20} className={populateOnDeploy ? "accent-red" : "text-muted"} />
        </div>
        <div>
          <h4 style={{ margin: 0, fontSize: '1rem' }}>Populate on Deploy</h4>
          <p className="text-muted" style={{ margin: 0, fontSize: '0.85rem', marginTop: '4px' }}>
            {populateOnDeploy
              ? "Enabled: Seeds real content into supported resources immediately after they're created."
              : "Disabled: Resources deploy empty; seed them later with the Populate button."}
          </p>
        </div>
      </div>

      <div
        onClick={() => onChange(!populateOnDeploy)}
        style={{
          width: '50px',
          height: '26px',
          background: populateOnDeploy ? 'var(--accent-red)' : 'rgba(255,255,255,0.1)',
          borderRadius: '13px',
          position: 'relative',
          cursor: 'pointer',
          transition: 'background 0.3s'
        }}
      >
        <div style={{
          width: '22px',
          height: '22px',
          background: '#fff',
          borderRadius: '50%',
          position: 'absolute',
          top: '2px',
          left: populateOnDeploy ? '26px' : '2px',
          transition: 'left 0.3s'
        }}></div>
      </div>
    </div>
  );
}
