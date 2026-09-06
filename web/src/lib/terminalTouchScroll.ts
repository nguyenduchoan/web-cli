import type { Terminal } from "@xterm/xterm";

/** Touch-only scrollback; leave wheel, selection and application mouse modes to xterm. */
export function installTerminalTouchScroll(terminal: Terminal, container: HTMLElement): { stop: () => void; dispose: () => void } {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let position = 0;
  let velocity = 0;
  let lastFrame = 0;
  let owned = false;
  let touch: { id: number; y: number; time: number; rowHeight: number; moved: boolean } | undefined;
  const canScroll = () => document.visibilityState !== "hidden" && terminal.buffer.active.type === "normal" && terminal.modes.mouseTrackingMode === "none" && !terminal.hasSelection();
  const stop = () => { cancelAnimationFrame(frame); frame = 0; velocity = 0; touch = undefined; };
  const draw = (now: number) => {
    frame = 0;
    if (!canScroll()) { stop(); return; }
    if (!touch) {
      const elapsed = Math.min(64, now - lastFrame);
      const decay = Math.exp(-elapsed / 220);
      position += velocity * 220 * (1 - decay);
      velocity *= decay;
    }
    lastFrame = now;
    const bounded = Math.max(0, Math.min(terminal.buffer.active.baseY, position));
    if (bounded !== position) velocity = 0;
    position = bounded;
    const line = Math.round(position);
    if (line !== terminal.buffer.active.viewportY) terminal.scrollToLine(line);
    if (!touch && Math.abs(velocity) > 0.002) frame = requestAnimationFrame(draw);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  const start = (event: TouchEvent) => {
    stop();
    if (event.touches.length !== 1) {
      if (owned) event.stopPropagation();
      return;
    }
    owned = canScroll() && terminal.buffer.active.baseY > 0;
    if (!owned) return;
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    const rowHeight = (screen?.clientHeight ?? 0) / terminal.rows;
    if (!rowHeight) { owned = false; return; }
    const point = event.touches[0];
    position = terminal.buffer.active.viewportY;
    touch = { id: point.identifier, y: point.clientY, time: performance.now(), rowHeight, moved: false };
    // Keep taps and long presses available, but avoid xterm's second touch scroller.
    event.stopPropagation();
  };
  const move = (event: TouchEvent) => {
    if (!owned) return;
    event.stopPropagation();
    if (event.touches.length !== 1 || !canScroll()) { stop(); return; }
    if (!touch) return;
    const point = event.touches[0];
    if (point.identifier !== touch.id) { stop(); return; }
    if (event.cancelable) event.preventDefault();
    const now = performance.now();
    const delta = (touch.y - point.clientY) / touch.rowHeight;
    const elapsed = Math.max(1, now - touch.time);
    const sample = Math.max(-0.15, Math.min(0.15, delta / elapsed));
    velocity = touch.moved ? 0.65 * sample + 0.35 * velocity : sample;
    position += delta;
    touch.y = point.clientY;
    touch.time = now;
    touch.moved = true;
    schedule();
  };
  const end = (event: TouchEvent) => {
    if (!owned) return;
    if (event.touches.length) { stop(); return; }
    owned = false;
    if (!touch) return;
    const now = performance.now();
    const moved = touch.moved;
    if (event.type === "touchcancel" || reducedMotion.matches || now - touch.time > 100) velocity = 0;
    touch = undefined;
    lastFrame = now;
    if (moved) {
      // A swipe must not become a click that opens the keyboard or resizes the PTY.
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      schedule();
    } else stop();
  };
  container.addEventListener("touchstart", start, { capture: true, passive: true });
  container.addEventListener("touchmove", move, { capture: true, passive: false });
  container.addEventListener("touchend", end, { capture: true, passive: false });
  container.addEventListener("touchcancel", end, { capture: true, passive: false });
  container.addEventListener("wheel", stop, { passive: true });
  container.addEventListener("keydown", stop);
  window.addEventListener("blur", stop);
  document.addEventListener("visibilitychange", stop);
  const input = terminal.onData(stop);
  const resize = terminal.onResize(stop);
  const buffer = terminal.buffer.onBufferChange(stop);
  return { stop, dispose: () => {
    stop(); input.dispose(); resize.dispose(); buffer.dispose();
    container.removeEventListener("touchstart", start, true);
    container.removeEventListener("touchmove", move, true);
    container.removeEventListener("touchend", end, true);
    container.removeEventListener("touchcancel", end, true);
    container.removeEventListener("wheel", stop);
    container.removeEventListener("keydown", stop);
    window.removeEventListener("blur", stop);
    document.removeEventListener("visibilitychange", stop);
  } };
}
