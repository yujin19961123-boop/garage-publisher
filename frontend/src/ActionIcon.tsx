type Action = 'logout' | 'share' | 'external' | 'upload' | 'check' | 'next' | 'edit' | 'switch' | 'refresh' | 'more' | 'unpublish' | 'chevron-down';

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
    {name === 'edit' && <path d="m5 16-1 4 4-1L20 7l-3-3L5 16Zm10-10 3 3"/>}
    {name === 'switch' && <path d="M4 8h15m-4-4 4 4-4 4m5 4H5m4-4-4 4 4 4"/>}
    {name === 'refresh' && <path d="M20 4v5h-5m5 0a8 8 0 1 0 0 7"/>}
    {name === 'more' && <path d="M12 5v14m-7-7h14"/>}
    {name === 'unpublish' && <path d="m3 3 18 18M10 5.2c5.5-1.1 10 2.9 12 6.8-.6 1.2-1.4 2.3-2.4 3.3m-3.3 2.5A10.5 10.5 0 0 1 12 19c-4.2 0-7.8-2.7-10-7a16 16 0 0 1 4-4.8M10.6 10.6a2 2 0 0 0 2.8 2.8"/>}
    {name === 'chevron-down' && <path d="m6 9 6 6 6-6"/>}
  </svg>;
}
