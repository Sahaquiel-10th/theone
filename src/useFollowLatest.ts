import {useLayoutEffect, useRef, useState} from 'react';

export function nearLatest(node: {scrollHeight: number; scrollTop: number; clientHeight: number}): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 60;
}

/** Follow streamed content, but never move a reader who deliberately scrolled up. */
export function useFollowLatest(conversationKey: string, visible: boolean) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [newMessages, setNewMessages] = useState(false);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !visible) return;
    follow.current = true;
    setNewMessages(false);
    let frame = 0;
    const latest = () => {
      if (follow.current) node.scrollTop = node.scrollHeight;
      else setNewMessages(true);
    };
    latest();
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(latest); };
    frame = requestAnimationFrame(latest);
    const mutations = new MutationObserver(schedule);
    mutations.observe(node, {childList: true, subtree: true, characterData: true});
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    node.addEventListener('load', schedule, true);
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect(); node.removeEventListener('load', schedule, true); };
  }, [conversationKey, visible]);
  return {scroll, newMessages, onScroll: () => {
    if (!scroll.current || !visible) return;
    follow.current = nearLatest(scroll.current);
    if (follow.current) setNewMessages(false);
  }, showLatest: () => {
    follow.current = true;
    scroll.current?.scrollTo({top: scroll.current.scrollHeight, behavior: 'smooth'});
    setNewMessages(false);
  }};
}
