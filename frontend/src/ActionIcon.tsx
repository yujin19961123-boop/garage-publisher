type Action = 'logout' | 'share' | 'external' | 'upload' | 'check' | 'next';

// Operation icons describe an action. Diagonal arrows are reserved for opening
// another page; modal actions and copying do not use decorative exit arrows.
export function ActionIcon({name}: {name: Action}) {
  return <svg className="action-icon" data-icon={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'logout' && <><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M10 12h10m-4-4 4 4-4 4"/></>}
    {name === 'share' && <><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4m-6.8 7 6.8 4"/></>}
    {name === 'external' && <><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5M14 4h6v6m0-6L10 14"/></>}
    {name === 'upload' && <><path d="M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4M12 4v11m-4-7 4-4 4 4"/></>}
    {name === 'check' && <path d="m5 12 4 4L19 6"/>}
    {name === 'next' && <path d="m9 5 7 7-7 7"/>}
  </svg>;
}
