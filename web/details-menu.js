import {useEffect,useRef,useState} from 'react';

export function useDetailsMenu(enabled=true) {
  const ref=useRef(null);
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    if(!enabled||!open)return;
    const details=ref.current;
    if(!details)return;
    // Safari clears focus when clicking a link. Dismiss on an actual move outside the menu.
    const dismiss=event=>{if(!details.contains(event.target))details.open=false;};
    document.addEventListener('pointerdown',dismiss,true);
    document.addEventListener('focusin',dismiss);
    return ()=>{
      document.removeEventListener('pointerdown',dismiss,true);
      document.removeEventListener('focusin',dismiss);
    };
  },[enabled,open]);
  return {
    ref,
    onToggle:event=>setOpen(event.currentTarget.open),
    onKeyDown:event=>{
      const details=event.currentTarget;
      if(event.key!=='Escape'||!details.open)return;
      event.stopPropagation();
      details.open=false;
      details.querySelector('summary')?.focus();
    }
  };
}
