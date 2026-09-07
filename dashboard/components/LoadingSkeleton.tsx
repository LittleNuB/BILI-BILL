interface Props {
  height?: number;
}

export function LoadingSkeleton({ height = 200 }: Props) {
  return (
    <div style={{
      width: '100%',
      height: `${height}px`,
      background: `linear-gradient(90deg, #FFFFFF 25%, #EDEFF1 50%, #FFFFFF 75%)`,
      backgroundSize: '200% 100%',
      animation: 'bdc-skeleton 1.5s ease-in-out infinite',
      borderRadius: '8px',
    }} />
  );
}
