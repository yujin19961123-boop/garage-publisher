import {useId} from 'react';

export function Brand(){
 return <div className="brand"><svg className="brand-symbol" aria-hidden="true" viewBox="0 0 32 32"><path d="m16 2 14 14-14 14L2 16Z" fill="none" stroke="currentColor" strokeWidth="2.4"/><path d="m16 10 6 6-6 6-6-6Z" fill="currentColor"/></svg><span className="brand-word">GARAGE</span></div>;
}
export function SignalMark(){
 const id='glass-'+useId().replace(/[^a-zA-Z0-9_-]/g,'');
 return <svg className="liquid-mark" viewBox="0 0 180 180" fill="none" aria-hidden="true">
  <defs>
   <linearGradient id={id+'-body'} x1="28" y1="19" x2="154" y2="164" gradientUnits="userSpaceOnUse"><stop stopColor="#fff" stopOpacity=".86"/><stop offset=".46" stopColor="#c8d6cb" stopOpacity=".48"/><stop offset="1" stopColor="#b2a9c0" stopOpacity=".62"/></linearGradient>
   <linearGradient id={id+'-edge'} x1="34" y1="16" x2="145" y2="164" gradientUnits="userSpaceOnUse"><stop stopColor="#fff"/><stop offset=".5" stopColor="#fff" stopOpacity=".12"/><stop offset="1" stopColor="#788d80" stopOpacity=".6"/></linearGradient>
   <radialGradient id={id+'-glow'} cx="0" cy="0" r="1" gradientTransform="translate(56 43) rotate(48) scale(112 86)" gradientUnits="userSpaceOnUse"><stop stopColor="#fff" stopOpacity=".8"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></radialGradient>
  </defs>
  <ellipse className="mark-shadow" cx="92" cy="160" rx="49" ry="7" fill="#66786c" fillOpacity=".12"/>
  <path className="mark-body" d="M91 17C126 13 157 41 161 78c4 37-15 72-52 81-35 8-74-7-87-40C8 84 17 45 48 27c13-7 28-8 43-10Z" fill={'url(#'+id+'-body)'} stroke={'url(#'+id+'-edge)'} strokeWidth="1.5"/>
  <path className="mark-glint" d="M91 17C126 13 157 41 161 78c4 37-15 72-52 81-35 8-74-7-87-40C8 84 17 45 48 27c13-7 28-8 43-10Z" fill={'url(#'+id+'-glow)'}/>
  <path className="mark-rim" d="M39 58C47 39 66 31 84 30" stroke="#fff" strokeOpacity=".88" strokeWidth="4" strokeLinecap="round"/>
  <g className="mark-core"><path d="m89 54 34 34-34 34-34-34Z" fill="#789285" fillOpacity=".1" stroke="#647d6e" strokeOpacity=".7" strokeWidth="1.3"/><path d="m76 101 25-25M76 76h25v25" stroke="#5b7568" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></g>
 </svg>;
}
