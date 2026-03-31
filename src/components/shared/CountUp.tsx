import { useEffect, useRef, useState } from 'react';

interface CountUpProps {
  end: number;
  duration?: number;
  formatFn?: (n: number) => string;
  className?: string;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export default function CountUp({
  end,
  duration = 1200,
  formatFn,
  className,
}: CountUpProps) {
  const [display, setDisplay] = useState('0');
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  const format = formatFn || ((n: number) => Math.round(n).toLocaleString());

  useEffect(() => {
    if (end === 0) {
      setDisplay(format(0));
      return;
    }

    startTimeRef.current = 0;

    function animate(timestamp: number) {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutCubic(progress);
      const current = easedProgress * end;

      setDisplay(format(current));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setDisplay(format(end));
      }
    }

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [end, duration]);

  return <span className={className}>{display}</span>;
}
