import type { CSSProperties, ReactNode } from 'react';
import { Card } from '@reference/ui';
import image from '@reference/product-image';
import '@reference/dependency-style';

/** Original Host implementation: default export, aliases, CSS, asset and Provider. */
export default function DependencyBadge({
  label,
  footer,
  onPress,
  className,
  style,
}: {
  label: string;
  footer?: ReactNode;
  onPress?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Card className={`${className ?? ''} dependency-badge`} style={style} footer={footer}>
      <img src={image} alt="Pinned dependency image" width={48} height={32} />
      <button onClick={onPress}>{label}</button>
    </Card>
  );
}
