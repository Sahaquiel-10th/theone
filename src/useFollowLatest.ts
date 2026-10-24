import {useLayoutEffect, useRef, useState} from 'react';

export function nearLatest(node: {scrollHeight: number; scrollTop: number; clientHeight: number}): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 60;
}

/** Contour reflow has its own reading anchor; it is not a new message. */
export function followLatestOnResize(fluidLayoutManaged: boolean): boolean {
  return !fluidLayoutManaged;
}

/** Follow streamed content, but never move a reader who deliberately scrolled up. */
export function useFollowLatest<T extends HTMLElement = HTMLDivElement>(conversationKey: string, visible: boolean) {
  const scroll = useRef<T>(null);
  const follow = useRef(true);
  const userScrollUntil=useRef(0);
  const [newMessages, setNewMessages] = useState(false);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !visible) return;
    follow.current = true;
    userScrollUntil.current=0;
    node.dataset.followLatest='true';
    setNewMessages(false);
    let frame = 0;
    let contentChanged = false;
    const latest = (announce=false) => {
      if (follow.current) node.scrollTop = node.scrollHeight;
      else if(announce) setNewMessages(true);
    };
    latest();
    const schedule = (announce=false) => { contentChanged ||= announce;cancelAnimationFrame(frame); frame = requestAnimationFrame(()=>{latest(contentChanged);contentChanged=false;}); };
    frame = requestAnimationFrame(()=>latest());
    const resize = new ResizeObserver(()=>{
      // The fluid surface changes line wrapping as its sidebar and children
      // move. Following those height changes would move the text through the
      // contour again and create another height change. New content still
      // follows through the mutation/load handlers below.
      if(followLatestOnResize(node.dataset.fluidLayoutManaged==='true'))schedule();
    });
    const observeSizes = () => {
      resize.disconnect();
      resize.observe(node);
      for (const child of node.children) resize.observe(child);
    };
    observeSizes();
    const mutations = new MutationObserver(() => { observeSizes(); schedule(true); });
    mutations.observe(node, {childList: true, subtree: true, characterData: true});
    const loaded=()=>schedule();
    const scrollIntent=()=>{userScrollUntil.current=performance.now()+1500;};
    const keyIntent=(event:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))scrollIntent();};
    const scrollbarIntent=(event:PointerEvent)=>{if(event.clientX>=node.getBoundingClientRect().left+node.clientWidth)scrollIntent();};
    node.addEventListener('load', loaded, true);
    node.addEventListener('wheel',scrollIntent,{passive:true});node.addEventListener('touchmove',scrollIntent,{passive:true});node.addEventListener('keydown',keyIntent);node.addEventListener('pointerdown',scrollbarIntent);
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect(); node.removeEventListener('load', loaded, true);node.removeEventListener('wheel',scrollIntent);node.removeEventListener('touchmove',scrollIntent);node.removeEventListener('keydown',keyIntent);node.removeEventListener('pointerdown',scrollbarIntent); };
  }, [conversationKey, visible]);
  return {scroll, newMessages, onScroll: () => {
    if (!scroll.current || !visible) return;
    const near=nearLatest(scroll.current);
    // A layout/streaming scroll must not masquerade as the reader scrolling up.
    if(near||performance.now()<userScrollUntil.current)follow.current=near;
    scroll.current.dataset.followLatest=String(follow.current);
    if (follow.current) setNewMessages(false);
  }, showLatest: () => {
    follow.current = true;
    userScrollUntil.current=0;
    if(scroll.current)scroll.current.dataset.followLatest='true';
    scroll.current?.scrollTo({top: scroll.current.scrollHeight, behavior: 'smooth'});
    setNewMessages(false);
  }};
}
