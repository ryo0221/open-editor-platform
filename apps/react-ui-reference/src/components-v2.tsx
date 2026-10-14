import type { CSSProperties } from 'react';
/** Real breaking public prop rename used to verify explicit revision mapping. */
export function Text({
  content,
  className,
  style,
}: {
  content: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <p className={className} style={style} data-component-version="2">
      {content}
    </p>
  );
}
