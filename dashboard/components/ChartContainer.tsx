import { useRef, useEffect } from 'preact/hooks';
import echarts from '../../src/shared/echarts/register';
import '../../src/shared/echarts/theme';
import type { EChartsOption } from 'echarts';

interface Props {
  option: EChartsOption;
  height?: number;
  loading?: boolean;
}

export function ChartContainer({ option, height = 300, loading }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const instance = echarts.init(containerRef.current, 'bili-dark');
    instanceRef.current = instance;
    instance.setOption(option);

    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    if (instanceRef.current && !loading) {
      instanceRef.current.setOption(option, true);
    }
  }, [option, loading]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: `${height}px`,
        background: loading ? '#F6F7F8' : 'transparent',
      }}
    />
  );
}
