// "Turns any <word> into a Shopify store": the word slides up and is replaced every couple of
// seconds, and the box resizes smoothly to fit it. Screen readers get the whole list once.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motionOff } from './motion';

export function RotatingWords({ words, interval = 2200 }: { words: string[]; interval?: number }) {
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState<number | null>(null);
  const measure = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (motionOff()) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % words.length), interval);
    return () => window.clearInterval(timer);
  }, [words.length, interval]);
  useLayoutEffect(() => { if (measure.current) setWidth(measure.current.offsetWidth); }, [index, words]);
  return (
    <span className="rw" style={width ? { width } : undefined} aria-label={words.join(', ')}>
      <span ref={measure} className="rw__measure" aria-hidden>{words[index]}</span>
      {words.map((word, i) => (
        <span key={word} aria-hidden className={`rw__word${i === index ? ' is-in' : i === (index - 1 + words.length) % words.length ? ' is-out' : ''}`}>{word}</span>
      ))}
    </span>
  );
}
