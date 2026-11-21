import { useEffect, useRef } from 'react';

export function useKeyboardShortcuts({
  hasSong,
  onTogglePlay,
  onSeekBy,
  onPrev,
  onNext,
  onToggleMute,
  onToggleSearch,
  onToggleFullscreen,
  canToggleFullscreen,
  hasOpenVideoPopup,
  onEscape,
  hasOpenModal,
}) {
  const stateRef = useRef({});
  stateRef.current = {
    hasSong,
    onTogglePlay,
    onSeekBy,
    onPrev,
    onNext,
    onToggleMute,
    onToggleSearch,
    onToggleFullscreen,
    canToggleFullscreen,
    hasOpenVideoPopup,
    onEscape,
    hasOpenModal,
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      const s = stateRef.current;

      // Block browser F1-F11 shortcuts such as F5 reload while leaving DevTools F12 available
      if (/^F([1-9]|1[01])$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
      }

      const target = e.target;
      const tag = target?.tagName;
      const inputType = String(target?.type || '').toLowerCase();
      const isEditable =
        (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(inputType)) ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable;

      if (e.key === 'Escape') {
        if (isEditable) target.blur();
        s.onEscape?.();
        return;
      }

      if ((e.key === 'f' || e.key === 'F') && s.canToggleFullscreen && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!isEditable || s.hasOpenVideoPopup) {
          e.preventDefault();
          e.stopPropagation();
          if (isEditable) target.blur?.();
          s.onToggleFullscreen?.();
          return;
        }
      }

      if (isEditable) return;

      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && s.hasSong) {
          e.preventDefault();
          s.onSeekBy?.(e.key === 'ArrowRight' ? 5 : -5);
        }
        return;
      }

      if (s.hasOpenModal) return;

      switch (e.key) {
        case ' ':
        case 'Spacebar':
          if (s.hasSong) {
            e.preventDefault();
            s.onTogglePlay?.();
          }
          break;
        case 'ArrowRight':
          if (s.hasSong) {
            e.preventDefault();
            s.onSeekBy?.(5);
          }
          break;
        case 'ArrowLeft':
          if (s.hasSong) {
            e.preventDefault();
            s.onSeekBy?.(-5);
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          s.onPrev?.();
          break;
        case 'ArrowDown':
          e.preventDefault();
          s.onNext?.();
          break;
        case 'm':
        case 'M':
          s.onToggleMute?.();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          s.onToggleSearch?.();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          s.onToggleFullscreen?.();
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
