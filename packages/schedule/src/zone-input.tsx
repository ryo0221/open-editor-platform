/** A time zone field that finds zones by part of their name instead of a long fixed list. */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { canonicalZone, knownZones, olderZoneName } from './zone';

export function ZoneInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  /** Called with IANA's current name only. */
  onChange: (zone: string) => void;
}) {
  const list = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const zones = useMemo(() => knownZones(), []);
  const known = useMemo(() => new Set(zones), [zones]);
  // Typed text commits only when it names a zone: older names and other casing become the
  // current name, anything else goes back to the zone in use.
  const commit = () => {
    const zone = canonicalZone(text.trim());
    setText(zone ?? value);
    if (zone && zone !== value) onChange(zone);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && text !== value) {
      e.stopPropagation();
      setText(value);
    }
  };
  return (
    <>
      <input
        aria-label={label}
        list={list}
        value={text}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setText(e.target.value);
          // A suggestion picked from the list is a whole current name: take it at once.
          if (known.has(e.target.value) && e.target.value !== value) onChange(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={key}
      />
      <datalist id={list}>
        {zones.map((z) => {
          const older = olderZoneName(z);
          return <option key={z} value={z} label={older ? `${z} (${older})` : undefined} />;
        })}
      </datalist>
    </>
  );
}
