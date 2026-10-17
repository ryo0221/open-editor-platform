import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  PanelLeft,
  PanelRight,
  Maximize2,
  X,
  MoreHorizontal,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react';
import './styles.css';
import { useEditorInput } from './inputs';
export * from './inputs';
export { PanelLeft, PanelRight, Maximize2, X, MoreHorizontal, ChevronDown };
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  reason,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  reason?: string;
}) {
  const title = [label, shortcut, props.disabled ? reason : undefined].filter(Boolean).join(' · ');
  return (
    <span className="ep-icon-wrap" data-tooltip={title}>
      <button
        {...props}
        className={`ep-icon-button ${props.className ?? ''}`}
        aria-label={label}
        title={title}
      >
        <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
        {children}
      </button>
    </span>
  );
}
export function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest('input,textarea,select,[contenteditable="true"],.ProseMirror')
  );
}
export const modKey = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
export function Toolbar({
  children,
  label = 'Editor toolbar',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      className="ep-toolbar"
      role="toolbar"
      aria-label={label}
      onKeyDown={(e) => {
        if (isTextInput(e.target) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
          return;
        const controls = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select,input'),
        ).filter((el) => el.offsetParent !== null);
        const i = controls.indexOf(document.activeElement as HTMLElement);
        const n =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? controls.length - 1
              : (i + (e.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
        controls[n]?.focus();
        e.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
export function Menu({
  label,
  icon = MoreHorizontal,
  children,
  align = 'left',
}: {
  label: string;
  icon?: LucideIcon;
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
      e.stopPropagation();
    };
    document.addEventListener('pointerdown', out);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', out);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <div
      className="ep-menu"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setOpen(false);
          trigger.current?.focus();
          e.stopPropagation();
        }
        if (
          open &&
          !isTextInput(e.target) &&
          ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)
        ) {
          const els = Array.from(
            root.current!.querySelectorAll<HTMLElement>(
              '.ep-menu-content button:not(:disabled),.ep-menu-content input,.ep-menu-content select',
            ),
          );
          const i = els.indexOf(document.activeElement as HTMLElement);
          els[
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? els.length - 1
                : (i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length
          ]?.focus();
          e.preventDefault();
        }
      }}
    >
      <span
        ref={(el) => {
          trigger.current = el?.querySelector('button') ?? null;
        }}
      >
        <IconButton
          icon={icon}
          label={label}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        />
      </span>
      {open && (
        <div
          id={id}
          className={`ep-menu-content ${align}`}
          data-editor-menu
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  exportScope = false,
}: {
  title: string;
  exportScope?: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => before?.focus();
  }, []);
  return (
    <dialog
      className="ep-dialog"
      data-editor-export-scope={exportScope || undefined}
      aria-label={title}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ep-dialog-heading">
        <h2>{title}</h2>
        <IconButton icon={X} label={`Close ${title}`} onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}
export interface PanelState {
  left: boolean;
  right: boolean;
  rightWidth: number;
  tab: string;
  focus: boolean;
}
export interface EditorLayoutProps {
  viewKey?: string;
  panels?: PanelState;
  defaultPanels?: Partial<PanelState>;
  onPanelsChange?: (state: PanelState) => void;
  toolbar?: ReactNode;
  left?: ReactNode;
  inspector?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  hideToolbar?: boolean;
  leftLabel?: string;
  inspectorLabel?: string;
}
const LayoutContext = createContext<{
  state: PanelState;
  set: (patch: Partial<PanelState>) => void;
} | null>(null);
export function useEditorPanels() {
  return useContext(LayoutContext);
}
export function EditorLayout({
  viewKey = 'surface',
  panels,
  defaultPanels,
  onPanelsChange,
  toolbar,
  left,
  inspector,
  status,
  children,
  hideToolbar,
  leftLabel = 'Navigator',
  inspectorLabel = 'Inspector',
}: EditorLayoutProps) {
  const [local, setLocal] = useState<PanelState>(() => {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(`ep-view:${viewKey}`) ?? '{}');
    } catch {
      /* unavailable view storage is nonfatal */
    }
    return {
      left: true,
      right: true,
      rightWidth: 300,
      tab: 'properties',
      focus: false,
      ...(window.matchMedia('(max-width: 800px)').matches ? { left: false, right: false } : {}),
      ...defaultPanels,
      ...saved,
    };
  });
  const state = panels ?? local;
  const { left: leftOpen, right: rightOpen, rightWidth, tab, focus } = state;
  const panelState = useMemo(
    () => ({ left: leftOpen, right: rightOpen, rightWidth, tab, focus }),
    [leftOpen, rightOpen, rightWidth, tab, focus],
  );
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(window.innerWidth <= 1100);
  const [narrow, setNarrow] = useState(window.innerWidth <= 800);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width <= 1100);
      setNarrow(entry.contentRect.width <= 800);
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const beforeFocus = useRef({ left: state.left, right: state.right });
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const set = useCallback(
    (patch: Partial<PanelState>) => {
      const next = { ...panelState, ...patch };
      setLocal(next);
      onPanelsChange?.(next);
      try {
        localStorage.setItem(`ep-view:${viewKey}`, JSON.stringify(next));
      } catch {
        /* view preference only */
      }
    },
    [panelState, onPanelsChange, viewKey],
  );
  // Native content changes do not change panel preferences. Keep the provider
  // stable so React need not propagate a context change through every canvas row.
  const panelContext = useMemo(() => ({ state: panelState, set }), [panelState, set]);
  const close = (side: 'left' | 'right') => {
    set({ [side]: false });
    drawerTrigger.current?.focus();
  };
  const toggle = (side: 'left' | 'right') => {
    drawerTrigger.current = document.activeElement as HTMLElement;
    set({
      [side]: !state[side],
      ...(narrow ? { [side === 'left' ? 'right' : 'left']: false } : {}),
    });
  };
  useEffect(() => {
    if (!narrow || state.focus || (!state.left && !state.right)) return;
    const panel = root.current?.querySelector<HTMLElement>('.ep-panel:not([hidden])');
    panel?.querySelector<HTMLElement>('button,input,select,[tabindex="0"]')?.focus();
  }, [state.left, state.right, state.focus, narrow]);
  return (
    <LayoutContext.Provider value={panelContext}>
      <section
        className={`ep-layout ${compact ? 'ep-compact' : ''} ${narrow ? 'ep-narrow' : ''}`}
        ref={root}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && narrow && !state.focus) {
            const panel = root.current?.querySelector<HTMLElement>('.ep-panel:not([hidden])');
            const controls = panel
              ? Array.from(
                  panel.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
                  ),
                ).filter((el) => el.offsetParent !== null)
              : [];
            if (
              controls.length &&
              (e.shiftKey
                ? document.activeElement === controls[0]
                : document.activeElement === controls.at(-1))
            ) {
              e.preventDefault();
              (e.shiftKey ? controls.at(-1) : controls[0])?.focus();
            }
          }
          if (e.key === 'Escape') {
            if (state.right) close('right');
            else if (state.left) close('left');
          }
        }}
      >
        {!hideToolbar && (
          <Toolbar>
            <IconButton
              icon={PanelLeft}
              label={`Toggle ${leftLabel}`}
              aria-pressed={state.left && !state.focus}
              onClick={() => toggle('left')}
            />
            {!compact && <div className="ep-main-tools">{toolbar}</div>}
            {compact && (
              <div className="ep-overflow-tools">
                <Menu label="More editor tools">
                  <div className="ep-overflow-body">{toolbar}</div>
                </Menu>
              </div>
            )}
            <span className="ep-spacer" />
            <IconButton
              icon={Maximize2}
              label="Focus mode"
              aria-pressed={state.focus}
              onClick={() => {
                if (state.focus) set({ focus: false, ...beforeFocus.current });
                else {
                  beforeFocus.current = { left: state.left, right: state.right };
                  set({ focus: true });
                }
              }}
            />
            <IconButton
              icon={PanelRight}
              label={`Toggle ${inspectorLabel}`}
              aria-pressed={state.right && !state.focus}
              onClick={() => toggle('right')}
            />
          </Toolbar>
        )}
        <div className="ep-layout-body">
          {!state.focus && (state.left || state.right) && (
            <button
              className="ep-drawer-backdrop"
              aria-label="Close panels"
              onClick={() => {
                set({ left: false, right: false });
                drawerTrigger.current?.focus();
              }}
            />
          )}
          <aside
            className="ep-panel ep-left"
            aria-label={leftLabel}
            hidden={!state.left || state.focus || !left}
          >
            <div className="ep-panel-heading">
              <strong>{leftLabel}</strong>
              <IconButton icon={X} label={`Close ${leftLabel}`} onClick={() => close('left')} />
            </div>
            <div className="ep-panel-content">{left}</div>
          </aside>
          <div className="ep-viewport" data-testid="editor-viewport">
            {children}
          </div>
          <aside
            className="ep-panel ep-right"
            aria-label={inspectorLabel}
            style={{ width: state.rightWidth }}
            hidden={!state.right || state.focus || !inspector}
          >
            <div
              className="ep-panel-resize"
              role="separator"
              aria-label="Inspector width"
              aria-orientation="vertical"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key.startsWith('Arrow'))
                  set({
                    rightWidth: Math.max(
                      240,
                      Math.min(480, state.rightWidth + (e.key === 'ArrowLeft' ? 10 : -10)),
                    ),
                  });
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  const box = root.current!.getBoundingClientRect();
                  set({ rightWidth: Math.max(240, Math.min(480, box.right - e.clientX)) });
                }
              }}
            />
            <div className="ep-panel-heading">
              <strong>{inspectorLabel}</strong>
              <IconButton
                icon={X}
                label={`Close ${inspectorLabel}`}
                onClick={() => close('right')}
              />
            </div>
            <div className="ep-panel-content">{inspector}</div>
          </aside>
        </div>
        <footer className="ep-status">{status}</footer>
      </section>
    </LayoutContext.Provider>
  );
}
export function Section({
  title,
  children,
  open = true,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="ep-section" open={open}>
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}
export function CommitInput({
  value,
  onCommit,
  label,
  type = 'text',
  min,
  max,
  step = 1,
  placeholder,
}: {
  value: string | number;
  onCommit: (value: string) => boolean | void;
  label: string;
  type?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  const incoming = String(value);
  const [draft, setDraft] = useState(incoming);
  const [observed, setObserved] = useState(incoming);
  const focused = useRef(false);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const lastCommitted = useRef(incoming);
  const [composing, setComposing] = useState(false);
  const [inputError, setInputError] = useState('');
  const valid = () =>
    type !== 'number' ||
    (draft.trim() !== '' &&
      Number.isFinite(Number(draft)) &&
      Number(draft) >= (min ?? -Infinity) &&
      Number(draft) <= (max ?? Infinity));
  const commit = () => {
    if (draft === lastCommitted.current) return;
    if (!valid()) throw new Error(`有効な${label}を入力してください。`);
    if (onCommit(draft) === false) return false;
    lastCommitted.current = draft;
    setInputError('');
  };
  useEditorInput({
    label,
    read: () => ({ dirty: draft !== incoming && draft !== lastCommitted.current, composing }),
    prepare: () => {
      if (!valid()) throw new Error(`有効な${label}を入力してください。`);
      return commit;
    },
    focus: () => input.current?.focus(),
  });
  // Reconcile a changed selection before committing this field to the DOM.
  // A passive effect can interfere with input selection; a layout effect forces
  // an extra commit/effect flush on every geometry update. A local render retry
  // avoids both, while retaining a focused private draft across remote changes.
  if (observed !== incoming) {
    const retained = draft !== lastCommitted.current || !!inputError;
    setObserved(incoming);
    lastCommitted.current = incoming;
    if (!focused.current && !retained && !composing) setDraft(incoming);
  }
  return (
    <label className="ep-field">
      {label}
      <input
        ref={input}
        aria-label={label}
        type={type}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={draft}
        onFocus={() => {
          focused.current = true;
          cancelled.current = false;
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setInputError('');
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onBlur={() => {
          focused.current = false;
          if (cancelled.current) {
            cancelled.current = false;
            return;
          }
          if (!composing && draft !== lastCommitted.current) {
            if (
              type === 'number' &&
              (draft.trim() === '' ||
                !Number.isFinite(Number(draft)) ||
                Number(draft) < (min ?? -Infinity) ||
                Number(draft) > (max ?? Infinity))
            ) {
              setInputError(`有効な${label}を入力してください。`);
              return;
            }
            try {
              if (commit() === false)
                setInputError(`${label}の変更が拒否されました。入力は保持されています。`);
            } catch (error) {
              setInputError(String(error instanceof Error ? error.message : error));
            }
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composing && !e.nativeEvent.isComposing) e.currentTarget.blur();
          if (e.key === 'Escape') {
            cancelled.current = true;
            setDraft(String(value));
            setInputError('');
            focused.current = false;
            e.currentTarget.blur();
            e.stopPropagation();
          }
        }}
      />
      {inputError && <small role="alert">{inputError}</small>}
    </label>
  );
}

/** Host may require confirmed content before a surface starts an ordinary export. */
export const EditorExportGuardContext = createContext<(() => void) | undefined>(undefined);
/** Private text editors register until their buffer is committed or explicitly cancelled. */
export const EditorUncommittedInputContext = createContext<Set<object> | undefined>(undefined);
